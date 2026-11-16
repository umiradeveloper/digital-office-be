import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { ApprovalFlow, ApprovalLevel, Prisma, Priority, Request } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthUser } from '../common/types';
import { PRIORITY_RANK } from '../common/permissions';
import { activeDelegationWhere, can } from '../common/utils';

/** Snapshot level yang berlaku untuk satu request (disimpan di approval_instances.plan_json). */
export interface PlanLevel {
  levelOrder: number;
  name: string;
  approverType: 'user' | 'role' | 'dept_head';
  approverRoleId: string | null;
  approverUserId: string | null;
  sameDeptOnly: boolean;
  delegateOn: boolean;
  slaHours: number;
}

export interface ThresholdRule {
  min_priority?: Priority;
  threshold_value?: number;
}

type ReqLike = Pick<Request, 'id' | 'typeId' | 'departmentId' | 'priority' | 'amount' | 'requesterUserId'>;
type Tx = Prisma.TransactionClient;

export const PRIORITY_LABEL: Record<string, string> = { low: 'Rendah', med: 'Sedang', high: 'Tinggi', crit: 'Kritis' };

/** Konteks satu keputusan approval yang diteruskan ke modul lain (mis. naskah dinas → QR per level). */
export interface DecisionContext {
  requestId: bigint;
  instanceId: bigint;
  levelOrder: number;
  levelName: string;
  levelIndex: number; // 0-based posisi level dalam plan
  totalLevels: number;
  isFinal: boolean; // approve pada level terakhir
  userId: bigint; // yang memutuskan
  onBehalfOf: bigint | null; // delegator bila diputuskan delegat
  at: Date;
  comment: string | null;
  ip?: string;
}

/**
 * Pengait keputusan approval. onApproved/onRejected berjalan DI DALAM transaksi keputusan
 * (lempar error → keputusan dibatalkan); afterDecision berjalan setelah commit.
 */
export interface ApprovalHook {
  onApproved?(tx: Tx, ctx: DecisionContext): Promise<void>;
  onRejected?(tx: Tx, ctx: DecisionContext): Promise<void>;
  afterDecision?(ctx: DecisionContext & { decision: 'approve' | 'reject' | 'delegate' }): Promise<void>;
}

@Injectable()
export class ApprovalsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notif: NotificationsService,
  ) {}

  private hooks: ApprovalHook[] = [];
  registerHook(h: ApprovalHook) { this.hooks.push(h); }

  /** Request yang terhubung ke naskah dinas: persetujuan = paraf/tanda tangan → wajib kata sandi. */
  async linkedDocumentId(requestId: bigint) {
    const d = await this.prisma.eDocument.findFirst({ where: { requestId, deletedAt: null }, select: { id: true } });
    return d?.id ?? null;
  }

  // ─────────────────── Routing (BR-05, FR-APR-03) ───────────────────

  private ruleMatches(rule: ThresholdRule | null | undefined, req: ReqLike) {
    if (!rule) return true;
    if (rule.min_priority && PRIORITY_RANK[req.priority] < PRIORITY_RANK[rule.min_priority]) return false;
    if (rule.threshold_value !== undefined && rule.threshold_value !== null) {
      if (req.amount === null || Number(req.amount) < Number(rule.threshold_value)) return false;
    }
    return true;
  }

  private specificity(flow: ApprovalFlow) {
    const rule = (flow.thresholdRuleJson ?? {}) as ThresholdRule;
    return (
      (flow.departmentId ? 100 : 0) +
      (flow.triggerTypeId ? 50 : 0) +
      (rule.threshold_value != null ? 10 : 0) +
      (rule.min_priority ? PRIORITY_RANK[rule.min_priority] : 0)
    );
  }

  /** Cari alur aktif paling spesifik yang cocok dengan request. */
  async matchFlow(req: ReqLike, db: Tx | PrismaService = this.prisma) {
    const flows = await db.approvalFlow.findMany({
      where: {
        status: 'active', deletedAt: null,
        AND: [
          { OR: [{ triggerTypeId: null }, { triggerTypeId: req.typeId }] },
          { OR: [{ departmentId: null }, ...(req.departmentId ? [{ departmentId: req.departmentId }] : [])] },
        ],
      },
      include: { levels: { orderBy: { levelOrder: 'asc' } } },
    });
    const candidates = flows
      .filter((f) => this.ruleMatches(f.thresholdRuleJson as ThresholdRule, req))
      .sort((a, b) => this.specificity(b) - this.specificity(a) || Number(a.id - b.id));
    return candidates[0] ?? null;
  }

  /** Level yang berlaku setelah evaluasi kondisi branch per level. */
  buildPlan(levels: ApprovalLevel[], req: ReqLike): PlanLevel[] {
    return levels
      .filter((l) => this.ruleMatches(l.conditionJson as ThresholdRule, req))
      .sort((a, b) => a.levelOrder - b.levelOrder)
      .map((l) => ({
        levelOrder: l.levelOrder, name: l.name, approverType: l.approverType,
        approverRoleId: l.approverRoleId?.toString() ?? null, approverUserId: l.approverUserId?.toString() ?? null,
        sameDeptOnly: l.sameDeptOnly, delegateOn: l.delegateOn, slaHours: l.slaHours,
      }));
  }

  /** Mulai approval bila ada alur cocok. Dipanggil di dalam transaksi submit. */
  async startIfApplicable(req: ReqLike, actorId: bigint, tx: Tx) {
    const flow = await this.matchFlow(req, tx);
    if (!flow) return null;
    const plan = this.buildPlan(flow.levels, req);
    if (!plan.length) return null;
    const instance = await tx.approvalInstance.create({
      data: {
        requestId: req.id, flowId: flow.id, currentLevel: plan[0].levelOrder,
        planJson: plan as unknown as Prisma.InputJsonValue, status: 'in_progress', levelStartedAt: new Date(),
      },
    });
    await tx.requestLog.create({
      data: {
        requestId: req.id, actorUserId: actorId, action: 'approval_started', fromStatus: 'submitted', toStatus: 'pending-approval',
        comment: `Masuk alur "${flow.name}" — ${plan.length} level: ${plan.map((p) => p.name).join(' → ')}`,
      },
    });
    await this.audit.log({ actorUserId: actorId, module: 'approval', action: 'instance_started', entityType: 'approval_instance', entityId: instance.id, payload: { requestId: req.id, flowId: flow.id, plan } }, tx);
    return { instance, flow, plan };
  }

  // ─────────────────── Resolusi approver ───────────────────

  private async deptChain(deptId: bigint | null) {
    const chain: { id: bigint; headUserId: bigint | null }[] = [];
    let cur = deptId;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.toString())) {
      guard.add(cur.toString());
      const d = await this.prisma.department.findFirst({ where: { id: cur, deletedAt: null }, select: { id: true, headUserId: true, parentDeptId: true } });
      if (!d) break;
      chain.push({ id: d.id, headUserId: d.headUserId });
      cur = d.parentDeptId;
    }
    return chain;
  }

  /**
   * Approver dasar untuk satu level (tanpa delegasi). Pengaju tidak boleh menyetujui request sendiri.
   * Fallback agar alur tidak macet: kepala unit (naik hierarki) → Super Admin.
   */
  async baseApprovers(level: PlanLevel, req: ReqLike): Promise<bigint[]> {
    const primary = await this.resolveLevel(level, req);
    if (primary.length) return primary;
    const chain = await this.deptChain(req.departmentId);
    for (const d of chain) if (d.headUserId && d.headUserId !== req.requesterUserId) return [d.headUserId];
    const admins = await this.prisma.user.findMany({ where: { isSuperAdmin: true, deletedAt: null, status: 'active', id: { not: req.requesterUserId } }, select: { id: true } });
    return admins.map((a) => a.id);
  }

  private async resolveLevel(level: PlanLevel, req: ReqLike): Promise<bigint[]> {
    const active = { deletedAt: null, status: 'active' as const };
    if (level.approverType === 'user' && level.approverUserId) {
      const u = await this.prisma.user.findFirst({ where: { id: BigInt(level.approverUserId), ...active } });
      return u ? [u.id] : [];
    }
    const chain = await this.deptChain(req.departmentId);
    if (level.approverType === 'dept_head') {
      for (const d of chain) if (d.headUserId && d.headUserId !== req.requesterUserId) return [d.headUserId];
      return [];
    }
    if (level.approverType === 'role' && level.approverRoleId) {
      const roleId = BigInt(level.approverRoleId);
      if (!level.sameDeptOnly) {
        const users = await this.prisma.user.findMany({ where: { ...active, userRoles: { some: { roleId } }, id: { not: req.requesterUserId } }, select: { id: true } });
        return users.map((u) => u.id);
      }
      // naik ke unit induk bila di unit pengaju tidak ada pemegang role
      for (const d of chain) {
        const users = await this.prisma.user.findMany({
          where: { ...active, departmentId: d.id, userRoles: { some: { roleId } }, id: { not: req.requesterUserId } }, select: { id: true },
        });
        if (users.length) return users.map((u) => u.id);
      }
      return [];
    }
    return [];
  }

  /** Daftar aktor yang berhak memutuskan level saat ini: {userId, onBehalfOf}. */
  async currentActors(instance: { id: bigint; currentLevel: number; planJson: Prisma.JsonValue; currentDelegateUserId: bigint | null }, req: ReqLike) {
    const plan = instance.planJson as unknown as PlanLevel[];
    const level = plan.find((p) => p.levelOrder === instance.currentLevel);
    if (!level) return { level: null, actors: [] as { userId: bigint; onBehalfOf: bigint | null }[] };

    if (instance.currentDelegateUserId) {
      const last = await this.prisma.approvalDecision.findFirst({
        where: { instanceId: instance.id, levelOrder: instance.currentLevel, decision: 'delegate' }, orderBy: { decidedAt: 'desc' },
      });
      return { level, actors: [{ userId: instance.currentDelegateUserId, onBehalfOf: last?.onBehalfOfUserId ?? last?.approverUserId ?? null }] };
    }
    const base = await this.baseApprovers(level, req);
    const actors: { userId: bigint; onBehalfOf: bigint | null }[] = base.map((b) => ({ userId: b, onBehalfOf: null }));
    if (level.delegateOn && base.length) {
      const dels = await this.prisma.delegation.findMany({ where: { ...activeDelegationWhere(), delegatorUserId: { in: base } } });
      for (const d of dels) if (d.delegateUserId !== req.requesterUserId) actors.push({ userId: d.delegateUserId, onBehalfOf: d.delegatorUserId });
    }
    return { level, actors };
  }

  async notifyCurrentApprovers(instanceId: bigint) {
    const inst = await this.prisma.approvalInstance.findUniqueOrThrow({ where: { id: instanceId }, include: { request: { include: { requester: true } } } });
    if (inst.status !== 'in_progress') return;
    const { level, actors } = await this.currentActors(inst, inst.request);
    const r = inst.request;
    await this.notif.notifyMany('pending_approval', actors.map((a) => a.userId), {
      requestId: r.id, priority: r.priority, path: `/approvals?focus=${inst.id}`,
      vars: { ref: r.refCode, judul: r.title, pengaju: r.requester.fullName, level: level?.name ?? '', prioritas: PRIORITY_LABEL[r.priority], due: r.dueDate?.toLocaleDateString('id-ID') ?? '-' },
    });
  }

  // ─────────────────── Inbox (FR-APR-08, BR-06) ───────────────────

  async inbox(user: AuthUser) {
    const instances = await this.prisma.approvalInstance.findMany({
      where: { status: 'in_progress', request: { deletedAt: null } },
      include: {
        flow: { select: { id: true, name: true } },
        request: {
          include: {
            requester: { select: { id: true, fullName: true, photoUrl: true } },
            type: { select: { id: true, name: true, category: true } },
            attachments: { select: { id: true } },
            eDocument: { select: { id: true, number: true, deletedAt: true } },
          },
        },
      },
    });
    const items = [];
    for (const inst of instances) {
      const { level, actors } = await this.currentActors(inst, inst.request);
      const mine = actors.find((a) => a.userId === user.id);
      if (!mine || !level) continue;
      const plan = inst.planJson as unknown as PlanLevel[];
      const slaDue = new Date(inst.levelStartedAt.getTime() + level.slaHours * 3600_000);
      let onBehalfOfName: string | null = null;
      if (mine.onBehalfOf) {
        onBehalfOfName = (await this.prisma.user.findUnique({ where: { id: mine.onBehalfOf }, select: { fullName: true } }))?.fullName ?? null;
      }
      items.push({
        instanceId: inst.id, flow: inst.flow,
        level: { order: level.levelOrder, name: level.name, index: plan.findIndex((p) => p.levelOrder === level.levelOrder) + 1, total: plan.length, slaHours: level.slaHours },
        levelStartedAt: inst.levelStartedAt, slaDue, slaBreached: slaDue < new Date(),
        onBehalfOf: mine.onBehalfOf ? { id: mine.onBehalfOf, fullName: onBehalfOfName } : null,
        canDelegate: level.delegateOn,
        // naskah dinas: persetujuan menerbitkan QR paraf/tanda tangan → wajib kata sandi
        requiresPassword: !!inst.request.eDocument && !inst.request.eDocument.deletedAt,
        eDocument: inst.request.eDocument && !inst.request.eDocument.deletedAt
          ? { id: inst.request.eDocument.id, number: inst.request.eDocument.number, role: plan.findIndex((p) => p.levelOrder === level.levelOrder) === plan.length - 1 ? 'sign' : 'paraf' }
          : null,
        request: {
          id: inst.request.id, refCode: inst.request.refCode, title: inst.request.title, priority: inst.request.priority,
          dueDate: inst.request.dueDate, amount: inst.request.amount, submittedAt: inst.request.submittedAt,
          requester: inst.request.requester, type: inst.request.type, attachmentCount: inst.request.attachments.length,
        },
      });
    }
    // urut prioritas tertinggi → due date terdekat → paling lama menunggu
    items.sort((a, b) =>
      PRIORITY_RANK[b.request.priority] - PRIORITY_RANK[a.request.priority] ||
      (a.request.dueDate?.getTime() ?? Infinity) - (b.request.dueDate?.getTime() ?? Infinity) ||
      a.levelStartedAt.getTime() - b.levelStartedAt.getTime(),
    );
    return items;
  }

  async countInbox(user: AuthUser) {
    return (await this.inbox(user)).length;
  }

  /** Apakah user terlibat sebagai approver (pernah memutuskan atau approver saat ini). */
  async isInvolved(user: AuthUser, requestId: bigint) {
    const decided = await this.prisma.approvalDecision.count({ where: { approverUserId: user.id, instance: { requestId } } });
    if (decided) return true;
    const inst = await this.prisma.approvalInstance.findFirst({ where: { requestId, status: 'in_progress' }, include: { request: true } });
    if (!inst) return false;
    const { actors } = await this.currentActors(inst, inst.request);
    return actors.some((a) => a.userId === user.id);
  }

  // ─────────────────── Keputusan (FR-APR-04/05/07, BR-02/03/04) ───────────────────

  async decide(user: AuthUser, instanceId: bigint, dto: { decision: 'approve' | 'reject' | 'delegate'; comment?: string; toUserId?: string; password?: string }, ip?: string) {
    if (!can(user, 'APPROVAL_DECIDE')) {
      await this.audit.log({ actorUserId: user.id, module: 'security', action: 'access_denied', entityType: 'approval_instance', entityId: instanceId, payload: { reason: 'no APPROVAL_DECIDE' }, ip });
      throw new ForbiddenException('Peran Anda tidak dapat memberikan keputusan approval');
    }
    const inst = await this.prisma.approvalInstance.findUnique({
      where: { id: instanceId }, include: { flow: true, request: { include: { requester: true, assignee: true } } },
    });
    if (!inst) throw new NotFoundException('Instance approval tidak ditemukan');
    if (inst.status !== 'in_progress') throw new ConflictException('Approval ini sudah selesai diproses');

    const { level, actors } = await this.currentActors(inst, inst.request);
    const me = actors.find((a) => a.userId === user.id);
    if (!me || !level) {
      await this.audit.log({ actorUserId: user.id, module: 'security', action: 'access_denied', entityType: 'approval_instance', entityId: instanceId, payload: { reason: 'not current approver', level: inst.currentLevel }, ip });
      throw new ForbiddenException('Anda bukan approver pada level saat ini');
    }
    if (dto.decision === 'reject' && !dto.comment?.trim()) throw new BadRequestException('Alasan penolakan wajib diisi');

    // Naskah dinas: menyetujui = membubuhkan paraf/tanda tangan QR → konfirmasi kata sandi
    if (dto.decision === 'approve' && (await this.linkedDocumentId(inst.requestId))) {
      const account = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
      const ok = !!dto.password && (await bcrypt.compare(dto.password, account.passwordHash.replace(/^\$2y\$/, () => '$2b$')));
      if (!ok) {
        await this.audit.log({ actorUserId: user.id, module: 'approval', action: 'decision_password_failed', entityType: 'approval_instance', entityId: instanceId, payload: { requestId: inst.requestId }, ip });
        throw new UnauthorizedException(dto.password ? 'Kata sandi salah — persetujuan dibatalkan' : 'Masukkan kata sandi untuk menyetujui naskah dinas');
      }
    }

    const r = inst.request;
    const plan = inst.planJson as unknown as PlanLevel[];
    const idx = plan.findIndex((p) => p.levelOrder === inst.currentLevel);
    const next = plan[idx + 1];
    const now = new Date();
    const vars = { ref: r.refCode, judul: r.title, aktor: user.fullName, level: level.name, alasan: dto.comment ?? '', prioritas: PRIORITY_LABEL[r.priority] };
    let delegateTo: bigint | null = null;
    const ctx: DecisionContext = {
      requestId: r.id, instanceId: inst.id, levelOrder: inst.currentLevel, levelName: level.name, levelIndex: idx, totalLevels: plan.length,
      isFinal: dto.decision === 'approve' && !next, userId: user.id, onBehalfOf: me.onBehalfOf, at: now, comment: dto.comment?.trim() || null, ip,
    };

    if (dto.decision === 'delegate') {
      if (!level.delegateOn) throw new BadRequestException('Level ini tidak mengizinkan delegasi');
      if (!dto.toUserId) throw new BadRequestException('Pilih penerima delegasi');
      delegateTo = BigInt(dto.toUserId);
      if (delegateTo === user.id) throw new BadRequestException('Tidak dapat mendelegasikan ke diri sendiri');
      if (delegateTo === r.requesterUserId) throw new BadRequestException('Tidak dapat mendelegasikan ke pengaju');
      const target = await this.prisma.user.findFirst({ where: { id: delegateTo, deletedAt: null, status: 'active' } });
      if (!target) throw new BadRequestException('Penerima delegasi tidak aktif');
    }

    await this.prisma.$transaction(async (tx) => {
      // kunci optimistik: level & status belum berubah oleh approver lain
      const lock = await tx.approvalInstance.updateMany({
        where: { id: inst.id, status: 'in_progress', currentLevel: inst.currentLevel, updatedAt: inst.updatedAt },
        data: { updatedAt: now },
      });
      if (lock.count === 0) throw new ConflictException('Approval telah diproses oleh pengguna lain. Muat ulang halaman.');

      await tx.approvalDecision.create({
        data: {
          instanceId: inst.id, levelOrder: inst.currentLevel, approverUserId: user.id,
          onBehalfOfUserId: me.onBehalfOf, decision: dto.decision, comment: dto.comment?.trim() || null,
          decidedAt: now, delegatedToUserId: delegateTo,
        },
      });

      if (dto.decision === 'approve' && next) {
        await tx.approvalInstance.update({ where: { id: inst.id }, data: { currentLevel: next.levelOrder, levelStartedAt: now, currentDelegateUserId: null } });
        await tx.requestLog.create({ data: { requestId: r.id, actorUserId: user.id, action: 'approved_level', fromStatus: 'pending-approval', toStatus: 'pending-approval', comment: `${level.name} disetujui${me.onBehalfOf ? ' (sebagai delegat)' : ''}${dto.comment ? ': ' + dto.comment : ''} → lanjut ke ${next.name}` } });
      } else if (dto.decision === 'approve') {
        await tx.approvalInstance.update({ where: { id: inst.id }, data: { status: 'approved', finishedAt: now, currentDelegateUserId: null } });
        await tx.request.update({ where: { id: r.id }, data: { status: 'approved' } });
        await tx.requestLog.create({ data: { requestId: r.id, actorUserId: user.id, action: 'approved', fromStatus: 'pending-approval', toStatus: 'approved', comment: `${level.name} disetujui — approval selesai${dto.comment ? ': ' + dto.comment : ''}` } });
      } else if (dto.decision === 'reject') {
        const close = inst.flow.rejectAction === 'close';
        await tx.approvalInstance.update({ where: { id: inst.id }, data: { status: 'rejected', finishedAt: now, currentDelegateUserId: null } });
        await tx.request.update({ where: { id: r.id }, data: { status: close ? 'closed' : 'rejected', closedAt: close ? now : undefined } });
        await tx.requestLog.create({ data: { requestId: r.id, actorUserId: user.id, action: 'rejected', fromStatus: 'pending-approval', toStatus: close ? 'closed' : 'rejected', comment: `${level.name} ditolak: ${dto.comment}` } });
      } else {
        await tx.approvalInstance.update({ where: { id: inst.id }, data: { currentDelegateUserId: delegateTo, levelStartedAt: now } });
        const target = await tx.user.findUnique({ where: { id: delegateTo! }, select: { fullName: true } });
        await tx.requestLog.create({ data: { requestId: r.id, actorUserId: user.id, action: 'delegated', fromStatus: 'pending-approval', toStatus: 'pending-approval', comment: `${level.name} didelegasikan ke ${target?.fullName}${dto.comment ? ': ' + dto.comment : ''}` } });
      }
      for (const h of this.hooks) {
        if (dto.decision === 'approve' && h.onApproved) await h.onApproved(tx, ctx);
        if (dto.decision === 'reject' && h.onRejected) await h.onRejected(tx, ctx);
      }
      await this.audit.log({
        actorUserId: user.id, module: 'approval', action: `decision_${dto.decision}`, entityType: 'approval_instance', entityId: inst.id,
        payload: { requestId: r.id, ref: r.refCode, level: inst.currentLevel, onBehalfOf: me.onBehalfOf, comment: dto.comment, delegatedTo: delegateTo }, ip,
      }, tx);
    });

    // notifikasi di luar transaksi
    if (dto.decision === 'approve' && next) await this.notifyCurrentApprovers(inst.id);
    else if (dto.decision === 'approve') {
      await this.notif.notifyMany('approved', [r.requesterUserId, ...(r.assigneeUserId ? [r.assigneeUserId] : [])], { requestId: r.id, vars });
    } else if (dto.decision === 'reject') {
      await this.notif.notify('rejected', r.requesterUserId, { requestId: r.id, vars });
    } else if (delegateTo) {
      await this.notif.notify('delegated', delegateTo, {
        requestId: r.id, path: `/approvals?focus=${inst.id}`,
        vars: { ...vars, delegator: user.fullName, periode: `Untuk request ${r.refCode} pada ${level.name}.` },
      });
    }
    for (const h of this.hooks) {
      // kegagalan pasca-commit (mis. pembuatan PDF) tidak membatalkan keputusan yang sudah tersimpan
      if (h.afterDecision) await h.afterDecision({ ...ctx, decision: dto.decision }).catch((e) => console.error('[approval hook]', e));
    }
    return this.detail(inst.id);
  }

  // ─────────────────── Detail / tracker (FR-APR-06) ───────────────────

  async detail(instanceId: bigint) {
    const inst = await this.prisma.approvalInstance.findUnique({
      where: { id: instanceId },
      include: {
        flow: { select: { id: true, name: true, code: true } },
        request: true,
        decisions: {
          orderBy: { decidedAt: 'asc' },
          include: {
            approver: { select: { id: true, fullName: true, position: true, photoUrl: true } },
            onBehalfOf: { select: { id: true, fullName: true } },
            delegatedToUser: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    if (!inst) throw new NotFoundException('Instance approval tidak ditemukan');
    const plan = inst.planJson as unknown as PlanLevel[];
    const { actors } = inst.status === 'in_progress' ? await this.currentActors(inst, inst.request) : { actors: [] };
    const actorUsers = actors.length
      ? await this.prisma.user.findMany({ where: { id: { in: actors.map((a) => a.userId) } }, select: { id: true, fullName: true, position: true } })
      : [];

    let prevEnd = inst.startedAt;
    const levels = plan.map((p) => {
      const decisions = inst.decisions.filter((d) => d.levelOrder === p.levelOrder);
      const final = [...decisions].reverse().find((d) => d.decision !== 'delegate');
      const isCurrent = inst.status === 'in_progress' && inst.currentLevel === p.levelOrder;
      const passed = final?.decision === 'approve';
      const state = final?.decision === 'reject' ? 'rejected' : passed ? 'approved' : isCurrent ? 'current' : 'waiting';
      const startedAt = state === 'waiting' ? null : prevEnd;
      const endedAt = final?.decidedAt ?? null;
      if (endedAt) prevEnd = endedAt;
      const durationMs = startedAt ? (endedAt ?? new Date()).getTime() - startedAt.getTime() : null;
      return {
        ...p, state, startedAt, endedAt, durationMs,
        slaBreached: durationMs !== null && durationMs > p.slaHours * 3600_000,
        decisions,
        currentApprovers: isCurrent ? actors.map((a) => ({ ...actorUsers.find((u) => u.id === a.userId), viaDelegationFrom: a.onBehalfOf })) : [],
      };
    });
    return {
      id: inst.id, status: inst.status, flow: inst.flow, currentLevel: inst.currentLevel,
      startedAt: inst.startedAt, finishedAt: inst.finishedAt, levelStartedAt: inst.levelStartedAt,
      requestId: inst.requestId, levels,
    };
  }

  // ─────────────────── Preview alur (mitigasi R-02) ───────────────────

  async preview(dto: { typeId: string; departmentId?: string; priority: Priority; amount?: number; requesterUserId?: string }) {
    const req: ReqLike = {
      id: BigInt(0), typeId: BigInt(dto.typeId), departmentId: dto.departmentId ? BigInt(dto.departmentId) : null,
      priority: dto.priority, amount: dto.amount != null ? (new Prisma.Decimal(dto.amount) as any) : null,
      requesterUserId: dto.requesterUserId ? BigInt(dto.requesterUserId) : BigInt(0),
    };
    const flow = await this.matchFlow(req);
    if (!flow) return { flow: null, levels: [] };
    const plan = this.buildPlan(flow.levels, req);
    const levels = [];
    for (const p of plan) {
      const ids = await this.baseApprovers(p, req);
      const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, position: true } });
      levels.push({ ...p, approvers: users });
    }
    return { flow: { id: flow.id, name: flow.name, code: flow.code }, levels };
  }
}
