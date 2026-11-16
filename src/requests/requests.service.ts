import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma, Priority, RequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService, PRIORITY_LABEL } from '../approvals/approvals.service';
import { DocumentsService } from '../documents/documents.service';
import { AuthUser } from '../common/types';
import { can, optBigInt, pageParams, paginated, parseDate } from '../common/utils';

export const STATUS_API: Record<RequestStatus, string> = {
  draft: 'draft', submitted: 'submitted', in_progress: 'in-progress', pending_approval: 'pending-approval',
  approved: 'approved', rejected: 'rejected', closed: 'closed',
};
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', submitted: 'Submitted', in_progress: 'In-Progress', pending_approval: 'Pending Approval',
  approved: 'Approved', rejected: 'Rejected', closed: 'Closed',
};
export function parseStatus(s?: string): RequestStatus | undefined {
  if (!s) return undefined;
  const k = s.replace('-', '_') as RequestStatus;
  return k in STATUS_API ? k : undefined;
}

export interface CustomField {
  key: string; label: string; type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'currency';
  required?: boolean; options?: string[];
}

export interface CreateRequestInput {
  title: string; description?: string; typeId: string; priority?: Priority; dueDate?: string;
  assigneeUserId?: string; amount?: number; customValues?: Record<string, unknown>;
  attachmentFileIds?: string[]; submit?: boolean;
}

/** Kategori tipe request untuk naskah dinas — dibuat & dikirim hanya lewat modul Naskah dinas. */
export const NASKAH_CATEGORY = 'naskah';
const NASKAH_ONLY = 'Request naskah dinas dibuat dan dikirim dari menu Naskah dinas';

const listInclude = {
  type: { select: { id: true, name: true, code: true, category: true } },
  requester: { select: { id: true, fullName: true, photoUrl: true, departmentId: true } },
  assignee: { select: { id: true, fullName: true, photoUrl: true } },
  instances: { orderBy: { id: 'desc' }, take: 1, select: { id: true, status: true, currentLevel: true, planJson: true } },
  _count: { select: { attachments: true, comments: true } },
} satisfies Prisma.RequestInclude;

/** Transisi status manual yang diizinkan (FR-WF-03/04). Approval mengubah status lewat ApprovalsService. */
const MANUAL_TRANSITIONS: Partial<Record<RequestStatus, RequestStatus[]>> = {
  submitted: ['in_progress', 'closed'],
  in_progress: ['submitted', 'closed'],
  approved: ['in_progress', 'closed'],
  rejected: ['closed'],
};

@Injectable()
export class RequestsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notif: NotificationsService,
    private approvals: ApprovalsService,
    private docs: DocumentsService,
  ) {}

  onModuleInit() {
    // lampiran request dapat diakses oleh siapa pun yang boleh melihat request-nya
    this.docs.requestViewChecker = async (user, requestId) => {
      const r = await this.prisma.request.findUnique({ where: { id: requestId } });
      return !!r && (await this.canView(user, r));
    };
  }

  // ───────── Visibilitas & otorisasi (BR-01) ─────────

  visibilityWhere(user: AuthUser): Prisma.RequestWhereInput {
    if (user.isSuperAdmin || can(user, 'REQUEST_VIEW_ALL')) return {};
    const or: Prisma.RequestWhereInput[] = [
      { requesterUserId: user.id },
      { assigneeUserId: user.id },
      { instances: { some: { decisions: { some: { approverUserId: user.id } } } } },
      { instances: { some: { currentDelegateUserId: user.id } } },
    ];
    if (can(user, 'REQUEST_VIEW_DEPT') && user.departmentId) or.push({ departmentId: user.departmentId });
    return { OR: or };
  }

  async canView(user: AuthUser, r: { id: bigint; requesterUserId: bigint; assigneeUserId: bigint | null; departmentId: bigint | null }) {
    if (user.isSuperAdmin || can(user, 'REQUEST_VIEW_ALL')) return true;
    if (r.requesterUserId === user.id || r.assigneeUserId === user.id) return true;
    if (can(user, 'REQUEST_VIEW_DEPT') && user.departmentId && r.departmentId === user.departmentId) return true;
    return this.approvals.isInvolved(user, r.id);
  }

  private async getOrThrow(id: bigint) {
    const r = await this.prisma.request.findFirst({ where: { id, deletedAt: null }, include: { type: true, requester: true, assignee: true } });
    if (!r) throw new NotFoundException('Request tidak ditemukan');
    return r;
  }

  private async denyIfReadOnly(user: AuthUser, action = 'write', entityId?: bigint) {
    // Auditor / viewer: tidak dapat mengubah apa pun (BR-01) — percobaan dicatat (UAT-10)
    if (!user.isSuperAdmin && !can(user, 'REQUEST_CREATE', 'REQUEST_MANAGE')) {
      await this.audit.log({ actorUserId: user.id, module: 'security', action: 'access_denied', entityType: 'request', entityId, payload: { attempted: action, reason: 'read-only role' } });
      throw new ForbiddenException('Peran Anda hanya dapat melihat (read-only)');
    }
  }

  // ───────── Daftar (filter: type, status, priority, mine, dept, due) ─────────

  buildWhere(user: AuthUser, q: Record<string, string>): Prisma.RequestWhereInput {
    const and: Prisma.RequestWhereInput[] = [{ deletedAt: null }, this.visibilityWhere(user)];
    if (q.type) and.push({ typeId: BigInt(q.type) });
    if (q.status) {
      const sts = q.status.split(',').map(parseStatus).filter(Boolean) as RequestStatus[];
      if (sts.length) and.push({ status: { in: sts } });
    }
    if (q.priority) and.push({ priority: { in: q.priority.split(',') as Priority[] } });
    if (q.dept) and.push({ departmentId: BigInt(q.dept) });
    if (q.mine === 'created') and.push({ requesterUserId: user.id });
    if (q.mine === 'assigned') and.push({ assigneeUserId: user.id });
    if (q.mine === '1') and.push({ OR: [{ requesterUserId: user.id }, { assigneeUserId: user.id }] });
    if (q.due === 'overdue') and.push({ dueDate: { lt: new Date() }, status: { notIn: ['closed', 'approved', 'rejected'] } });
    if (q.due === 'week') and.push({ dueDate: { gte: new Date(), lte: new Date(Date.now() + 7 * 86400_000) } });
    const from = parseDate(q.from); const to = parseDate(q.to, true);
    if (from || to) and.push({ createdAt: { gte: from, lte: to } });
    if (q.search) and.push({ OR: [{ title: { contains: q.search } }, { refCode: { contains: q.search } }, { description: { contains: q.search } }] });
    return { AND: and };
  }

  async list(user: AuthUser, q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q);
    const where = this.buildWhere(user, q);
    const sortable: Record<string, string> = { created: 'createdAt', due: 'dueDate', priority: 'priority', title: 'title', status: 'status', updated: 'updatedAt' };
    const orderBy = { [sortable[q.sort] ?? 'createdAt']: q.order === 'asc' ? 'asc' : 'desc' } as Prisma.RequestOrderByWithRelationInput;
    const [rows, total] = await Promise.all([
      this.prisma.request.findMany({ where, skip, take, orderBy, include: listInclude }),
      this.prisma.request.count({ where }),
    ]);
    return paginated(rows.map((r) => ({ ...r, statusCode: STATUS_API[r.status] })), total, page, perPage);
  }

  // ───────── Buat (FR-WF-01/02) ─────────

  private validateCustom(fields: CustomField[] | null, values: Record<string, unknown> = {}) {
    const out: Record<string, unknown> = {};
    for (const f of fields ?? []) {
      const v = values[f.key];
      const empty = v === undefined || v === null || v === '';
      if (f.required && empty) throw new BadRequestException(`Kolom "${f.label}" wajib diisi`);
      if (empty) continue;
      if ((f.type === 'number' || f.type === 'currency') && isNaN(Number(v))) throw new BadRequestException(`Kolom "${f.label}" harus angka`);
      if (f.type === 'select' && f.options && !f.options.includes(String(v))) throw new BadRequestException(`Pilihan "${f.label}" tidak valid`);
      if (f.type === 'date' && isNaN(new Date(String(v)).getTime())) throw new BadRequestException(`Tanggal "${f.label}" tidak valid`);
      out[f.key] = f.type === 'number' || f.type === 'currency' ? Number(v) : v;
    }
    return out;
  }

  private async nextRefCode(tx: Prisma.TransactionClient, typeCode: string) {
    const now = new Date();
    const prefix = `${typeCode}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`;
    const last = await tx.request.findFirst({ where: { refCode: { startsWith: prefix } }, orderBy: { refCode: 'desc' }, select: { refCode: true } });
    const n = last ? parseInt(last.refCode.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(n).padStart(4, '0');
  }

  async create(user: AuthUser, dto: CreateRequestInput, ip?: string, opts: { internal?: boolean } = {}) {
    if (!opts.internal) await this.denyIfReadOnly(user, 'create');
    const type = await this.prisma.requestType.findFirst({ where: { id: BigInt(dto.typeId), enabled: true, deletedAt: null } });
    if (!type) throw new BadRequestException('Tipe request tidak tersedia');
    if (type.category === NASKAH_CATEGORY && !opts.internal) throw new BadRequestException(NASKAH_ONLY);
    const customValues = this.validateCustom(type.customFieldsJson as unknown as CustomField[], dto.customValues);
    const fileIds = (dto.attachmentFileIds ?? []).map((f) => BigInt(f));
    for (const fid of fileIds) await this.docs.requireAccess(user, fid, 'read');
    const assigneeId = optBigInt(dto.assigneeUserId);
    // nilai threshold: field amount eksplisit atau custom field bertipe currency
    const currencyField = (type.customFieldsJson as unknown as CustomField[] | null)?.find((f) => f.type === 'currency');
    const amount = dto.amount ?? (currencyField ? (customValues[currencyField.key] as number | undefined) : undefined);

    const created = await this.prisma.$transaction(async (tx) => {
      // retry ringan untuk tabrakan ref_code paralel
      let refCode = await this.nextRefCode(tx, type.code);
      if (await tx.request.findUnique({ where: { refCode } })) refCode = `${refCode}-${Date.now() % 1000}`;
      const r = await tx.request.create({
        data: {
          refCode, title: dto.title.trim(), description: dto.description, typeId: type.id,
          requesterUserId: user.id, assigneeUserId: assigneeId, departmentId: user.departmentId,
          priority: dto.priority ?? 'med', amount: amount != null ? new Prisma.Decimal(amount) : null,
          customValuesJson: customValues as Prisma.InputJsonValue,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null, status: 'draft',
        },
      });
      if (fileIds.length) await tx.requestAttachment.createMany({ data: fileIds.map((fileId) => ({ requestId: r.id, fileId })), skipDuplicates: true });
      await tx.requestLog.create({ data: { requestId: r.id, actorUserId: user.id, action: 'created', toStatus: 'draft', comment: fileIds.length ? `${fileIds.length} lampiran` : null } });
      await this.audit.log({ actorUserId: user.id, module: 'workflow', action: 'request_created', entityType: 'request', entityId: r.id, payload: { refCode, title: r.title, typeId: type.id }, ip }, tx);
      return r;
    });

    if (assigneeId && assigneeId !== user.id) {
      await this.notif.notify('assigned', assigneeId, {
        requestId: created.id, priority: created.priority,
        vars: { ref: created.refCode, judul: created.title, aktor: user.fullName, due: created.dueDate?.toLocaleDateString('id-ID') ?? '-' },
      });
    }
    if (dto.submit !== false) return this.submit(user, created.id, ip, opts);
    return this.detail(user, created.id);
  }

  // ───────── Submit / re-submit (draft|rejected → submitted → pending-approval) ─────────

  async submit(user: AuthUser, id: bigint, ip?: string, opts: { internal?: boolean } = {}) {
    const r = await this.getOrThrow(id);
    if (r.type.category === NASKAH_CATEGORY && !opts.internal) throw new BadRequestException(NASKAH_ONLY);
    if (r.requesterUserId !== user.id && !user.isSuperAdmin) throw new ForbiddenException('Hanya pengaju yang dapat mengirim request');
    if (!['draft', 'rejected'].includes(r.status)) throw new BadRequestException(`Request berstatus ${STATUS_LABEL[r.status]} tidak dapat dikirim`);
    const resubmit = r.status === 'rejected';

    const started = await this.prisma.$transaction(async (tx) => {
      await tx.request.update({ where: { id }, data: { status: 'submitted', submittedAt: new Date() } });
      await tx.requestLog.create({ data: { requestId: id, actorUserId: user.id, action: resubmit ? 'resubmitted' : 'submitted', fromStatus: STATUS_API[r.status], toStatus: 'submitted' } });
      const s = await this.approvals.startIfApplicable(r, user.id, tx);
      if (s) await tx.request.update({ where: { id }, data: { status: 'pending_approval' } });
      await this.audit.log({ actorUserId: user.id, module: 'workflow', action: resubmit ? 'request_resubmitted' : 'request_submitted', entityType: 'request', entityId: id, payload: { flowId: s?.flow.id ?? null }, ip }, tx);
      return s;
    });

    await this.notif.notify('submitted', r.requesterUserId, {
      requestId: id, priority: r.priority,
      vars: { ref: r.refCode, judul: r.title, status: started ? 'Pending Approval' : 'Submitted', prioritas: PRIORITY_LABEL[r.priority] },
    });
    if (started) await this.approvals.notifyCurrentApprovers(started.instance.id);
    return this.detail(user, id);
  }

  // ───────── Detail (FR-WF-05) ─────────

  async detail(user: AuthUser, id: bigint) {
    const r = await this.prisma.request.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...listInclude,
        type: true,
        requester: { select: { id: true, fullName: true, email: true, photoUrl: true, position: true, department: { select: { id: true, name: true } } } },
        attachments: {
          include: { file: { select: { id: true, docUid: true, originalName: true, mimeType: true, sizeBytes: true, version: true, createdAt: true, deletedAt: true } } },
        },
        comments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, include: { user: { select: { id: true, fullName: true, photoUrl: true } } } },
        logs: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { id: true, fullName: true, photoUrl: true } } } },
        instances: { orderBy: { id: 'desc' }, select: { id: true, status: true, startedAt: true, finishedAt: true } },
        eDocument: { select: { id: true, number: true, title: true, subject: true, status: true, deletedAt: true } },
      },
    });
    if (!r) throw new NotFoundException('Request tidak ditemukan');
    if (!(await this.canView(user, r))) {
      await this.audit.log({ actorUserId: user.id, module: 'security', action: 'access_denied', entityType: 'request', entityId: id });
      throw new ForbiddenException('Anda tidak memiliki akses ke request ini');
    }
    const approval = r.instances[0] ? await this.approvals.detail(r.instances[0].id) : null;
    const isRequester = r.requesterUserId === user.id;
    const isAssignee = r.assigneeUserId === user.id;
    const manage = user.isSuperAdmin || can(user, 'REQUEST_MANAGE');
    const readOnly = !user.isSuperAdmin && !can(user, 'REQUEST_CREATE', 'REQUEST_MANAGE');
    const myTurn = approval?.status === 'in_progress'
      ? approval.levels.find((l) => l.state === 'current')?.currentApprovers.some((a) => a.id === user.id) ?? false
      : false;
    const naskah = r.type.category === NASKAH_CATEGORY;
    const eDocument = r.eDocument && !r.eDocument.deletedAt ? r.eDocument : null;
    return {
      ...r,
      eDocument,
      statusCode: STATUS_API[r.status],
      approval,
      // naskah dinas: persetujuan menerbitkan QR → wajib kata sandi
      requiresPassword: !!eDocument,
      permissions: {
        // isi request naskah diubah/dikirim ulang lewat halaman naskah
        canEdit: !naskah && !readOnly && (isRequester || manage) && ['draft', 'rejected'].includes(r.status),
        canSubmit: !naskah && !readOnly && isRequester && ['draft', 'rejected'].includes(r.status),
        canChangeStatus: !readOnly && (isAssignee || isRequester || manage) ? MANUAL_TRANSITIONS[r.status] ?? [] : [],
        canClose: !readOnly && (isRequester || manage) && !['closed', 'pending_approval', 'draft'].includes(r.status),
        canComment: !readOnly,
        canRemind: !readOnly && ['pending_approval', 'submitted', 'in_progress'].includes(r.status),
        canDecide: myTurn && can(user, 'APPROVAL_DECIDE'),
        canDelete: !naskah && !readOnly && isRequester && r.status === 'draft',
      },
    };
  }

  // ───────── Ubah (status by role, due, assignee) ─────────

  async update(user: AuthUser, id: bigint, dto: Partial<CreateRequestInput> & { status?: string }, ip?: string) {
    await this.denyIfReadOnly(user, 'update', id);
    const r = await this.getOrThrow(id);
    const isRequester = r.requesterUserId === user.id;
    const isAssignee = r.assigneeUserId === user.id;
    const manage = user.isSuperAdmin || can(user, 'REQUEST_MANAGE');
    if (!isRequester && !isAssignee && !manage) throw new ForbiddenException('Anda tidak dapat mengubah request ini');

    const data: Prisma.RequestUncheckedUpdateInput = {};
    const changes: string[] = [];
    const editableContent = ['draft', 'rejected'].includes(r.status) && (isRequester || manage);

    if (dto.title !== undefined || dto.description !== undefined || dto.customValues !== undefined || dto.amount !== undefined || dto.priority !== undefined || dto.typeId !== undefined) {
      if (!editableContent) throw new BadRequestException('Isi request hanya dapat diubah saat Draft atau setelah ditolak (revisi)');
      if (dto.title !== undefined) { data.title = dto.title.trim(); changes.push('judul'); }
      if (dto.description !== undefined) { data.description = dto.description; changes.push('deskripsi'); }
      if (dto.priority !== undefined) { data.priority = dto.priority; changes.push(`prioritas → ${PRIORITY_LABEL[dto.priority]}`); }
      if (dto.amount !== undefined) { data.amount = new Prisma.Decimal(dto.amount); changes.push('nilai'); }
      if (dto.customValues !== undefined) {
        const type = await this.prisma.requestType.findUniqueOrThrow({ where: { id: dto.typeId ? BigInt(dto.typeId) : r.typeId } });
        data.customValuesJson = this.validateCustom(type.customFieldsJson as unknown as CustomField[], dto.customValues) as Prisma.InputJsonValue;
        if (dto.typeId) data.typeId = type.id;
        changes.push('field tambahan');
      }
    }
    if (dto.dueDate !== undefined) {
      if (!isRequester && !manage) throw new ForbiddenException('Hanya pengaju/admin yang dapat mengubah due date');
      data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null; changes.push('due date');
    }
    let newAssignee: bigint | null | undefined;
    if (dto.assigneeUserId !== undefined) {
      if (!isRequester && !manage) throw new ForbiddenException('Hanya pengaju/admin yang dapat mengganti penanggung jawab');
      newAssignee = dto.assigneeUserId ? BigInt(dto.assigneeUserId) : null;
      data.assigneeUserId = newAssignee; changes.push('penanggung jawab');
    }
    let toStatus: RequestStatus | undefined;
    if (dto.status) {
      toStatus = parseStatus(dto.status);
      if (!toStatus) throw new BadRequestException('Status tidak valid');
      const allowed = MANUAL_TRANSITIONS[r.status] ?? [];
      if (!allowed.includes(toStatus)) throw new BadRequestException(`Tidak dapat mengubah status dari ${STATUS_LABEL[r.status]} ke ${STATUS_LABEL[toStatus]}`);
      if (toStatus === 'in_progress' && !isAssignee && !manage && !(isRequester && !r.assigneeUserId)) {
        throw new ForbiddenException('Hanya penanggung jawab yang dapat memulai pengerjaan');
      }
      data.status = toStatus;
      if (toStatus === 'closed') data.closedAt = new Date();
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.request.update({ where: { id }, data });
      if (changes.length) await tx.requestLog.create({ data: { requestId: id, actorUserId: user.id, action: 'updated', comment: `Mengubah ${changes.join(', ')}` } });
      if (toStatus) await tx.requestLog.create({ data: { requestId: id, actorUserId: user.id, action: 'status_changed', fromStatus: STATUS_API[r.status], toStatus: STATUS_API[toStatus] } });
      if (dto.attachmentFileIds) {
        const ids = dto.attachmentFileIds.map((f) => BigInt(f));
        for (const fid of ids) await this.docs.requireAccess(user, fid, 'read');
        await tx.requestAttachment.deleteMany({ where: { requestId: id, fileId: { notIn: ids } } });
        await tx.requestAttachment.createMany({ data: ids.map((fileId) => ({ requestId: id, fileId })), skipDuplicates: true });
        await tx.requestLog.create({ data: { requestId: id, actorUserId: user.id, action: 'attachments_updated', comment: `${ids.length} lampiran` } });
      }
      await this.audit.log({ actorUserId: user.id, module: 'workflow', action: 'request_updated', entityType: 'request', entityId: id, payload: dto, ip }, tx);
    });

    if (newAssignee && newAssignee !== user.id) {
      await this.notif.notify('assigned', newAssignee, { requestId: id, priority: r.priority, vars: { ref: r.refCode, judul: r.title, aktor: user.fullName, due: r.dueDate?.toLocaleDateString('id-ID') ?? '-' } });
    }
    return this.detail(user, id);
  }

  async close(user: AuthUser, id: bigint, comment?: string, ip?: string) {
    await this.denyIfReadOnly(user, 'close', id);
    const r = await this.getOrThrow(id);
    if (r.requesterUserId !== user.id && !user.isSuperAdmin && !can(user, 'REQUEST_MANAGE')) throw new ForbiddenException('Hanya pengaju/admin yang dapat menutup request');
    if (r.status === 'closed') throw new BadRequestException('Request sudah ditutup');
    if (r.status === 'pending_approval') throw new BadRequestException('Request masih dalam proses approval');
    await this.prisma.$transaction(async (tx) => {
      await tx.request.update({ where: { id }, data: { status: 'closed', closedAt: new Date() } });
      await tx.requestLog.create({ data: { requestId: id, actorUserId: user.id, action: 'closed', fromStatus: STATUS_API[r.status], toStatus: 'closed', comment } });
      await this.audit.log({ actorUserId: user.id, module: 'workflow', action: 'request_closed', entityType: 'request', entityId: id, ip }, tx);
    });
    return this.detail(user, id);
  }

  async remove(user: AuthUser, id: bigint, ip?: string) {
    const r = await this.getOrThrow(id);
    if (r.requesterUserId !== user.id && !user.isSuperAdmin) throw new ForbiddenException();
    if (r.status !== 'draft') throw new BadRequestException('Hanya draft yang dapat dihapus');
    await this.prisma.request.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({ actorUserId: user.id, module: 'workflow', action: 'request_deleted', entityType: 'request', entityId: id, ip });
    return { ok: true };
  }

  async comment(user: AuthUser, id: bigint, body: string) {
    await this.denyIfReadOnly(user, 'comment', id);
    const r = await this.getOrThrow(id);
    if (!(await this.canView(user, r))) throw new ForbiddenException('Anda tidak memiliki akses ke request ini');
    const c = await this.prisma.$transaction(async (tx) => {
      const c = await tx.requestComment.create({ data: { requestId: id, userId: user.id, body: body.trim() } });
      await tx.requestLog.create({ data: { requestId: id, actorUserId: user.id, action: 'commented', comment: body.trim().slice(0, 500) } });
      return c;
    });
    const recipients = [r.requesterUserId, r.assigneeUserId].filter((x): x is bigint => !!x && x !== user.id);
    await this.notif.notifyMany('commented', recipients, { requestId: id, priority: r.priority, vars: { ref: r.refCode, judul: r.title, aktor: user.fullName, alasan: body.slice(0, 300) } });
    return this.prisma.requestComment.findUnique({ where: { id: c.id }, include: { user: { select: { id: true, fullName: true, photoUrl: true } } } });
  }

  /** Menagih (FR-WF-04): kirim pengingat ke approver saat ini atau penanggung jawab. */
  async remind(user: AuthUser, id: bigint, message?: string) {
    await this.denyIfReadOnly(user, 'remind', id);
    const r = await this.getOrThrow(id);
    if (!(await this.canView(user, r))) throw new ForbiddenException();
    if (r.lastRemindedAt && Date.now() - r.lastRemindedAt.getTime() < 15 * 60_000) {
      throw new BadRequestException('Pengingat sudah dikirim dalam 15 menit terakhir');
    }
    let targets: bigint[] = [];
    if (r.status === 'pending_approval') {
      const inst = await this.prisma.approvalInstance.findFirst({ where: { requestId: id, status: 'in_progress' } });
      if (inst) targets = (await this.approvals.currentActors(inst, r)).actors.map((a) => a.userId);
    } else if (r.assigneeUserId) targets = [r.assigneeUserId];
    targets = targets.filter((t) => t !== user.id);
    if (!targets.length) throw new BadRequestException('Tidak ada penerima pengingat');
    await this.notif.notifyMany('remind', targets, { requestId: id, vars: { ref: r.refCode, judul: r.title, aktor: user.fullName, alasan: message ?? '' } });
    await this.prisma.$transaction([
      this.prisma.request.update({ where: { id }, data: { lastRemindedAt: new Date() } }),
      this.prisma.requestLog.create({ data: { requestId: id, actorUserId: user.id, action: 'reminded', comment: `Pengingat dikirim ke ${targets.length} orang${message ? ': ' + message : ''}` } }),
    ]);
    return { sentTo: targets.length };
  }
}
