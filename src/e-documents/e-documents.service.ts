import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Priority, SignerRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DocumentsService } from '../documents/documents.service';
import { AuthUser } from '../common/types';
import { can, pageParams, paginated } from '../common/utils';
import { fillPlaceholders, htmlToText, sanitizeHtml } from './html';
import { EDocPdfService, fmtLongDate, PdfSigner } from './e-doc-pdf.service';
import { ApprovalHook, ApprovalsService, DecisionContext, PlanLevel } from '../approvals/approvals.service';
import { NASKAH_CATEGORY, RequestsService } from '../requests/requests.service';

/** Kode tipe request yang menjadi jalur approval naskah dinas. */
export const NASKAH_TYPE_CODE = 'NSK';
type Tx = Prisma.TransactionClient;

export interface SignerInput { userId: string; role: 'sign' | 'paraf' }
export interface EDocInput {
  title: string; subject?: string; recipient?: string; attachmentNote?: string; place?: string; docDate?: string;
  bodyHtml: string; templateId?: string | null;
  /** @deprecated paraf/tanda tangan kini mengikuti alur approval request; diabaikan. */
  signers?: SignerInput[];
}
export interface SubmitInput { priority?: Priority; dueDate?: string | null }

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const ROLE_LABEL: Record<SignerRole, string> = { sign: 'tanda tangan', paraf: 'paraf' };

const detailInclude = {
  template: { select: { id: true, name: true, code: true, category: true } },
  department: { select: { id: true, name: true, code: true } },
  creator: { select: { id: true, fullName: true, position: true, photoUrl: true, email: true } },
  file: { select: { id: true, originalName: true, sizeBytes: true, folderId: true } },
  signers: {
    orderBy: { order: 'asc' },
    include: { user: { select: { id: true, fullName: true, position: true, photoUrl: true, email: true } } },
  },
  logs: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { id: true, fullName: true } } } },
  request: {
    select: {
      id: true, refCode: true, status: true, priority: true, dueDate: true, requesterUserId: true, assigneeUserId: true, departmentId: true, deletedAt: true,
      instances: { orderBy: { id: 'desc' }, take: 1, select: { id: true, status: true } },
    },
  },
} satisfies Prisma.EDocumentInclude;

type DocFull = Prisma.EDocumentGetPayload<{ include: typeof detailInclude }>;

/**
 * Naskah dinas. Sejak v1.1 paraf & tanda tangan mengikuti ALUR APPROVAL REQUEST:
 * naskah dikirim → request tipe "Naskah Dinas" dibuat & masuk approval → setiap level yang menyetujui
 * (dengan kata sandi) langsung mendapat QR paraf, level terakhir QR tanda tangan → PDF final.
 * Alur lama (daftar penanda tangan manual) tetap dilayani untuk naskah yang sudah berjalan sebelum pembaruan.
 */
@Injectable()
export class EDocumentsService implements OnModuleInit, ApprovalHook {
  private readonly logger = new Logger('Naskah');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notif: NotificationsService,
    private docs: DocumentsService,
    private pdf: EDocPdfService,
    private config: ConfigService,
    private approvals: ApprovalsService,
    private requests: RequestsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHook(this);
    this.naskahType().catch((e) => this.logger.warn(`Gagal menyiapkan tipe request Naskah Dinas: ${(e as Error).message}`));
  }

  /** Tipe request "Naskah Dinas" (+ alur approval bawaan saat pertama kali dibuat). */
  async naskahType() {
    const existing = await this.prisma.requestType.findUnique({ where: { code: NASKAH_TYPE_CODE } });
    if (existing) {
      if (existing.deletedAt || existing.category !== NASKAH_CATEGORY) {
        return this.prisma.requestType.update({ where: { id: existing.id }, data: { deletedAt: null, category: NASKAH_CATEGORY } });
      }
      return existing;
    }
    const type = await this.prisma.requestType.create({
      data: {
        name: 'Naskah Dinas', code: NASKAH_TYPE_CODE, category: NASKAH_CATEGORY, customFieldsJson: [],
        description: 'Persetujuan, paraf & tanda tangan QR naskah dinas — dibuat dari menu Naskah dinas',
      },
    });
    const hasFlow = await this.prisma.approvalFlow.count({ where: { triggerTypeId: type.id, deletedAt: null } });
    if (!hasFlow) {
      const direktur = await this.prisma.role.findFirst({ where: { name: 'Direktur', deletedAt: null } });
      let code = 'NASKAH-DINAS';
      if (await this.prisma.approvalFlow.findUnique({ where: { code } })) code = `NASKAH-DINAS-${Date.now() % 100000}`;
      await this.prisma.approvalFlow.create({
        data: {
          name: 'Naskah Dinas', code, triggerTypeId: type.id, status: 'active', rejectAction: 'revise',
          description: 'Level awal = paraf, level terakhir = tanda tangan. Ubah sesuai kebutuhan.',
          levels: {
            create: [
              { levelOrder: 1, name: 'Paraf — Kepala Unit', approverType: 'dept_head', slaHours: 24 },
              ...(direktur ? [{ levelOrder: 2, name: 'Tanda tangan — Direktur', approverType: 'role' as const, approverRoleId: direktur.id, sameDeptOnly: false, slaHours: 48 }] : []),
            ],
          },
        },
      });
      this.logger.log('Tipe request & alur approval "Naskah Dinas" dibuat');
    }
    return type;
  }

  /** Naskah lama: penanda tangan dipilih manual (sebelum terhubung ke approval request). */
  private isLegacy(d: { requestId: bigint | null; status: string }) {
    return !d.requestId && (d.status === 'signing' || d.status === 'signed');
  }

  get org() { return this.pdf.org; }

  private get secret() {
    return this.config.get<string>('SIGNATURE_SECRET') ?? this.config.get<string>('JWT_ACCESS_SECRET') ?? 'digital-office-signature';
  }

  // ───────── Akses ─────────

  /** Naskah yang menunggu persetujuan user ini di inbox approval. */
  private async awaitingMyApproval(user: AuthUser): Promise<bigint[]> {
    const items = await this.approvals.inbox(user);
    return items.filter((i) => i.eDocument).map((i) => i.eDocument!.id);
  }

  private visibleWhere(user: AuthUser, awaiting: bigint[] = []): Prisma.EDocumentWhereInput {
    if (user.isSuperAdmin || can(user, 'EDOC_VIEW_ALL')) return {};
    const or: Prisma.EDocumentWhereInput[] = [
      { creatorUserId: user.id },
      // penanda tangan / approver melihat naskah setelah dikirim (bukan draft pembuat)
      { signers: { some: { userId: user.id } }, status: { not: 'draft' } },
      { request: { instances: { some: { decisions: { some: { approverUserId: user.id } } } } }, status: { not: 'draft' } },
    ];
    if (awaiting.length) or.push({ id: { in: awaiting } });
    if (can(user, 'DOC_MANAGE') && user.departmentId) or.push({ departmentId: user.departmentId, status: { not: 'draft' } });
    return { OR: or };
  }

  private async load(id: bigint) {
    const d = await this.prisma.eDocument.findFirst({ where: { id, deletedAt: null }, include: detailInclude });
    if (!d) throw new NotFoundException('Naskah tidak ditemukan');
    return d;
  }

  private async canView(user: AuthUser, d: DocFull) {
    if (user.isSuperAdmin || can(user, 'EDOC_VIEW_ALL') || d.creatorUserId === user.id) return true;
    if (d.status === 'draft') return false;
    if (d.signers.some((s) => s.userId === user.id)) return true;
    if (can(user, 'DOC_MANAGE') && !!user.departmentId && d.departmentId === user.departmentId) return true;
    // approver (saat ini / sebelumnya), penanggung jawab, atau unit yang boleh melihat request-nya
    return !!d.request && !d.request.deletedAt && (await this.requests.canView(user, d.request));
  }

  private async log(documentId: bigint, actorUserId: bigint | null, action: string, comment?: string | null, tx?: Prisma.TransactionClient) {
    await (tx ?? this.prisma).eDocumentLog.create({ data: { documentId, actorUserId, action, comment: comment ?? null } });
  }

  // ───────── Render isi ─────────

  /** Nilai placeholder yang dapat dipakai di template: {{nomor}}, {{tanggal}}, dst. */
  vars(d: Pick<DocFull, 'number' | 'subject' | 'recipient' | 'attachmentNote' | 'place' | 'docDate' | 'title'> & { creator: { fullName: string; position: string | null }; department: { name: string } | null }) {
    return {
      nomor: d.number ?? '(nomor terbit saat dikirim)',
      tanggal: fmtLongDate(d.docDate ?? new Date()),
      tempat: d.place,
      perihal: d.subject ?? d.title,
      judul: d.title,
      kepada: d.recipient ?? '',
      lampiran: d.attachmentNote || '-',
      pembuat: d.creator.fullName,
      jabatan_pembuat: d.creator.position ?? '',
      unit: d.department?.name ?? '',
      organisasi: this.pdf.org.name,
    };
  }

  renderedBody(d: DocFull) {
    return fillPlaceholders(d.bodyHtml, this.vars(d));
  }

  /** Hash isi final: berubah bila judul, nomor, perihal, penerima, tanggal, atau isi berubah. */
  private hashContent(d: DocFull) {
    const payload = JSON.stringify({
      number: d.number, title: d.title, subject: d.subject, recipient: d.recipient, attachmentNote: d.attachmentNote,
      place: d.place, docDate: d.docDate?.toISOString().slice(0, 10) ?? null, body: this.renderedBody(d),
      // naskah lama: daftar penanda tangan ditetapkan sebelum dikirim → ikut di-hash.
      // naskah via approval: penanda tangan baru diketahui saat tiap level menyetujui → diikat lewat HMAC per QR.
      ...(d.requestId ? {} : { signers: d.signers.map((s) => ({ u: s.userId.toString(), r: s.role, o: s.order })) }),
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private hmac(token: string, docId: bigint, userId: bigint, contentHash: string, signedAt: Date) {
    return createHmac('sha256', this.secret).update(`${token}|${docId}|${userId}|${contentHash}|${signedAt.toISOString()}`).digest('hex');
  }

  // ───────── Daftar ─────────

  async list(user: AuthUser, q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q);
    const awaiting = await this.awaitingMyApproval(user);
    const and: Prisma.EDocumentWhereInput[] = [{ deletedAt: null }, this.visibleWhere(user, awaiting)];
    if (q.scope === 'mine') and.push({ creatorUserId: user.id });
    if (q.scope === 'tosign') {
      and.push({ OR: [{ id: { in: awaiting } }, { requestId: null, status: 'signing', signers: { some: { userId: user.id, status: 'pending' } } }] });
    }
    if (q.scope === 'signed-by-me') and.push({ signers: { some: { userId: user.id, status: 'signed' } } });
    if (q.status) and.push({ status: q.status as any });
    if (q.search) and.push({ OR: [{ title: { contains: q.search } }, { number: { contains: q.search } }, { subject: { contains: q.search } }] });
    const where = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.eDocument.findMany({
        where, skip, take, orderBy: { updatedAt: 'desc' },
        select: {
          id: true, number: true, title: true, subject: true, status: true, createdAt: true, updatedAt: true, submittedAt: true, completedAt: true,
          request: { select: { id: true, refCode: true, status: true } },
          template: { select: { name: true, category: true } }, creator: { select: { id: true, fullName: true, photoUrl: true } },
          signers: { orderBy: { order: 'asc' }, select: { order: true, role: true, status: true, user: { select: { id: true, fullName: true } } } },
        },
      }),
      this.prisma.eDocument.count({ where }),
    ]);
    return paginated(rows, total, page, perPage);
  }

  async countToSign(user: AuthUser) {
    const legacy = await this.prisma.eDocument.count({ where: { deletedAt: null, requestId: null, status: 'signing', signers: { some: { userId: user.id, status: 'pending' } } } });
    return legacy + (await this.awaitingMyApproval(user)).length;
  }

  // ───────── Detail ─────────

  async detail(user: AuthUser, id: bigint) {
    const d = await this.load(id);
    if (!(await this.canView(user, d))) {
      await this.audit.log({ actorUserId: user.id, module: 'security', action: 'access_denied', entityType: 'e_document', entityId: id });
      throw new ForbiddenException('Anda tidak memiliki akses ke naskah ini');
    }
    const legacy = this.isLegacy(d);
    // naskah via approval: tampilkan QR putaran yang sedang berjalan/selesai (bukan sisa putaran yang ditolak)
    const rows = legacy || d.status === 'signing' || d.status === 'signed' ? d.signers : d.signers.filter((s) => s.status === 'signed');
    const signers = await Promise.all(rows.map(async (s) => ({
      id: s.id, order: s.order, role: s.role, status: s.status, positionTitle: s.positionTitle ?? s.user.position, signedAt: s.signedAt,
      levelName: s.levelName, onBehalfOf: s.onBehalfOf,
      comment: s.comment, user: s.user, verifyUrl: s.token && s.status === 'signed' ? this.pdf.verifyUrl(s.token) : null,
      qrDataUrl: s.token && s.status === 'signed' ? await this.pdf.qrDataUrl(s.token) : null,
    })));
    const mine = d.signers.find((s) => s.userId === user.id);
    const isCreator = d.creatorUserId === user.id;
    const intact = d.status !== 'signed' || !d.contentHash || this.hashContent(d) === d.contentHash;
    const inst = d.request && !d.request.deletedAt ? d.request.instances[0] : undefined;
    const approval = inst ? await this.approvals.detail(inst.id) : null;
    const current = approval?.status === 'in_progress' ? approval.levels.find((l) => l.state === 'current') : undefined;
    const myTurn = !!current?.currentApprovers.some((a) => a.id === user.id) && can(user, 'APPROVAL_DECIDE') && d.status === 'signing';
    const levelIdx = current ? approval!.levels.indexOf(current) : -1;
    return {
      id: d.id, number: d.number, title: d.title, subject: d.subject, recipient: d.recipient, attachmentNote: d.attachmentNote,
      place: d.place, docDate: d.docDate, status: d.status, contentHash: d.contentHash, intact,
      bodyHtml: d.bodyHtml, renderedHtml: this.renderedBody(d),
      template: d.template, department: d.department, creator: d.creator, file: d.file,
      submittedAt: d.submittedAt, completedAt: d.completedAt, createdAt: d.createdAt, updatedAt: d.updatedAt,
      signers, logs: d.logs, org: this.pdf.org,
      legacy,
      request: d.request && !d.request.deletedAt
        ? { id: d.request.id, refCode: d.request.refCode, status: d.request.status, statusCode: d.request.status.replace('_', '-'), priority: d.request.priority, dueDate: d.request.dueDate }
        : null,
      approval,
      plannedSigners: d.status === 'signed' ? [] : await this.plannedSigners(d),
      permissions: {
        canEdit: isCreator && ['draft', 'rejected'].includes(d.status) && can(user, 'EDOC_CREATE'),
        canSubmit: isCreator && ['draft', 'rejected'].includes(d.status) && can(user, 'EDOC_CREATE'),
        canCancel: legacy && isCreator && d.status === 'signing',
        canDelete: isCreator && d.status === 'draft',
        // naskah lama: tanda tangan manual
        canSign: legacy && d.status === 'signing' && mine?.status === 'pending',
        // naskah via approval: setujui (paraf/tanda tangan) atau tolak di level saat ini
        canDecide: myTurn,
        canDelegate: myTurn && !!current?.delegateOn,
        instanceId: myTurn ? approval!.id : null,
        requiresPassword: true,
        myRole: myTurn ? (levelIdx === approval!.levels.length - 1 ? 'sign' : 'paraf') : legacy ? (mine?.role ?? null) : null,
        myLevelName: myTurn ? current!.name : null,
      },
    };
  }

  // ───────── Buat / ubah draft ─────────

  async create(user: AuthUser, dto: EDocInput) {
    if (!can(user, 'EDOC_CREATE')) throw new ForbiddenException('Peran Anda tidak dapat membuat naskah');
    let templateId: bigint | null = null;
    if (dto.templateId) {
      const t = await this.prisma.docTemplate.findFirst({ where: { id: BigInt(dto.templateId), deletedAt: null } });
      if (!t) throw new BadRequestException('Template tidak ditemukan');
      templateId = t.id;
    }
    const d = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.eDocument.create({
        data: {
          title: dto.title.trim(), subject: dto.subject?.trim() || null, recipient: dto.recipient?.trim() || null,
          attachmentNote: dto.attachmentNote?.trim() || null, place: dto.place?.trim() || 'Jakarta',
          docDate: dto.docDate ? new Date(dto.docDate) : null, bodyHtml: sanitizeHtml(dto.bodyHtml),
          templateId, departmentId: user.departmentId, creatorUserId: user.id,
        },
      });
      await this.log(doc.id, user.id, 'created', null, tx);
      await this.audit.log({ actorUserId: user.id, module: 'edoc', action: 'edoc_created', entityType: 'e_document', entityId: doc.id, payload: { title: doc.title } }, tx);
      return doc;
    });
    return this.detail(user, d.id);
  }

  async update(user: AuthUser, id: bigint, dto: Partial<EDocInput>) {
    const d = await this.load(id);
    if (d.creatorUserId !== user.id) throw new ForbiddenException('Hanya pembuat yang dapat mengubah naskah');
    if (!['draft', 'rejected'].includes(d.status)) throw new BadRequestException('Naskah yang sedang/selesai ditandatangani tidak dapat diubah');
    await this.prisma.$transaction(async (tx) => {
      await tx.eDocument.update({
        where: { id },
        data: {
          title: dto.title?.trim(), subject: dto.subject === undefined ? undefined : dto.subject.trim() || null,
          recipient: dto.recipient === undefined ? undefined : dto.recipient.trim() || null,
          attachmentNote: dto.attachmentNote === undefined ? undefined : dto.attachmentNote.trim() || null,
          place: dto.place?.trim() || undefined, docDate: dto.docDate === undefined ? undefined : dto.docDate ? new Date(dto.docDate) : null,
          bodyHtml: dto.bodyHtml === undefined ? undefined : sanitizeHtml(dto.bodyHtml),
        },
      });
      await this.log(id, user.id, 'updated', null, tx);
    });
    return this.detail(user, id);
  }

  async remove(user: AuthUser, id: bigint) {
    const d = await this.load(id);
    if (d.creatorUserId !== user.id || d.status !== 'draft') throw new ForbiddenException('Hanya draft milik Anda yang dapat dihapus');
    await this.prisma.eDocument.update({ where: { id }, data: { deletedAt: new Date() } });
    // request draft yang terhubung (dari pengiriman yang gagal) ikut dihapus
    if (d.requestId) await this.prisma.request.updateMany({ where: { id: d.requestId, status: 'draft' }, data: { deletedAt: new Date() } });
    await this.audit.log({ actorUserId: user.id, module: 'edoc', action: 'edoc_deleted', entityType: 'e_document', entityId: id });
    return { ok: true };
  }

  // ───────── Penomoran ─────────

  private async assignNumber(tx: Prisma.TransactionClient, d: DocFull) {
    if (d.number) return d.number;
    const now = d.docDate ?? new Date();
    const year = now.getFullYear();
    const tpl = d.templateId ? await tx.docTemplate.findUnique({ where: { id: d.templateId } }) : null;
    const format = tpl?.numberFormat ?? '{seq}/ND/{dept}/{month_roman}/{year}';
    const start = new Date(year, 0, 1); const end = new Date(year + 1, 0, 1);
    const last = await tx.eDocument.aggregate({
      _max: { seq: true },
      where: {
        number: { not: null }, submittedAt: { gte: start, lt: end },
        ...(format.includes('{code}') ? { templateId: d.templateId } : {}),
        ...(format.includes('{dept}') ? { departmentId: d.departmentId } : {}),
      },
    });
    const build = (n: number) => format
      .replace('{seq}', String(n).padStart(3, '0'))
      .replace('{code}', tpl?.code ?? 'ND')
      .replace('{dept}', d.department?.code ?? 'UMUM')
      .replace('{month_roman}', ROMAN[now.getMonth()])
      .replace('{month}', String(now.getMonth() + 1).padStart(2, '0'))
      .replace('{year}', String(year));
    let seq = (last._max.seq ?? 0) + 1;
    let number = build(seq);
    // jaga keunikan bila format tidak memuat {seq} lengkap atau ada nomor manual yang bentrok
    for (let i = 0; i < 50 && (await tx.eDocument.findUnique({ where: { number }, select: { id: true } })); i++) number = build(++seq);
    await tx.eDocument.update({ where: { id: d.id }, data: { number, seq } });
    return number;
  }

  // ───────── Kirim untuk approval (request "Naskah Dinas") ─────────

  async submit(user: AuthUser, id: bigint, input: SubmitInput = {}, ip?: string) {
    const d = await this.load(id);
    if (d.creatorUserId !== user.id) throw new ForbiddenException('Hanya pembuat yang dapat mengirim naskah');
    if (!can(user, 'EDOC_CREATE')) throw new ForbiddenException('Peran Anda tidak dapat mengirim naskah');
    if (!['draft', 'rejected'].includes(d.status)) throw new BadRequestException('Naskah sudah dikirim');
    if (!htmlToText(d.bodyHtml)) throw new BadRequestException('Isi naskah masih kosong');

    const type = await this.naskahType();
    if (!type.enabled) throw new BadRequestException('Tipe request "Naskah Dinas" sedang dinonaktifkan admin');
    const priority: Priority = input.priority ?? d.request?.priority ?? 'med';
    const dueDate = input.dueDate !== undefined ? (input.dueDate ? new Date(input.dueDate) : null) : d.request?.dueDate ?? null;
    const probe = { id: BigInt(0), typeId: type.id, departmentId: user.departmentId, priority, amount: null, requesterUserId: user.id };
    const flow = await this.approvals.matchFlow(probe);
    if (!flow || !this.approvals.buildPlan(flow.levels, probe).length) {
      throw new BadRequestException('Belum ada alur approval aktif untuk Naskah Dinas. Minta admin mengaturnya di Administrasi → Alur approval.');
    }

    const prev = { status: d.status, submittedAt: d.submittedAt };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.assignNumber(tx, d);
          // putaran baru: QR putaran sebelumnya (bila pernah ditolak) tidak berlaku lagi
          await tx.eDocumentSigner.deleteMany({ where: { documentId: id } });
          await tx.eDocument.update({ where: { id }, data: { status: 'signing', submittedAt: new Date(), completedAt: null, contentHash: null, fileId: null } });
          await this.log(id, user.id, d.status === 'rejected' ? 'resubmitted' : 'submitted', null, tx);
        });
        break;
      } catch (e) {
        // tabrakan nomor surat paralel → ulangi dengan nomor berikutnya
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt < 2) continue;
        throw e;
      }
    }
    // hash isi setelah nomor terbit (nomor ikut ditandatangani)
    const fresh = await this.load(id);

    // request approval: pakai ulang request yang ditolak/draft, selain itu buat baru
    const title = `${fresh.number ? fresh.number + ' — ' : ''}${fresh.title}`.slice(0, 200);
    const description = [
      `Naskah dinas${fresh.template ? ` (${fresh.template.name})` : ''}: ${fresh.subject ?? fresh.title}`,
      fresh.recipient ? `Kepada: ${fresh.recipient}` : null,
      `Nomor: ${fresh.number ?? '-'}`,
      'Persetujuan pada request ini menerbitkan QR paraf (level awal) dan QR tanda tangan (level terakhir) pada naskah.',
    ].filter(Boolean).join('\n');
    let requestId = fresh.requestId;
    try {
      const linked = requestId ? await this.prisma.request.findUnique({ where: { id: requestId } }) : null;
      if (linked && !linked.deletedAt && ['draft', 'rejected'].includes(linked.status)) {
        await this.prisma.request.update({ where: { id: linked.id }, data: { title, description, priority, dueDate } });
      } else {
        const r = await this.requests.create(user, { title, description, typeId: type.id.toString(), priority, dueDate: dueDate?.toISOString(), submit: false }, ip, { internal: true });
        requestId = r.id;
        await this.prisma.eDocument.update({ where: { id }, data: { requestId } });
      }
      // hash ulang bila request baru saja ditautkan (hash naskah via approval tidak memuat daftar penanda tangan)
      const linkedDoc = await this.load(id);
      await this.prisma.eDocument.update({ where: { id }, data: { contentHash: this.hashContent(linkedDoc) } });
      await this.requests.submit(user, requestId!, ip, { internal: true });
      const after = await this.prisma.request.findUniqueOrThrow({ where: { id: requestId! } });
      if (after.status !== 'pending_approval') throw new BadRequestException('Alur approval Naskah Dinas tidak dapat dimulai. Hubungi admin.');
    } catch (e) {
      // kembalikan naskah agar dapat diperbaiki & dikirim ulang
      await this.prisma.eDocument.update({ where: { id }, data: { status: prev.status, submittedAt: prev.submittedAt, contentHash: null } });
      if (requestId) await this.prisma.request.updateMany({ where: { id: requestId, status: 'submitted' }, data: { status: 'draft' } });
      await this.log(id, user.id, 'submit_failed', (e as Error).message);
      throw e;
    }
    await this.audit.log({ actorUserId: user.id, module: 'edoc', action: 'edoc_submitted', entityType: 'e_document', entityId: id, payload: { number: fresh.number, requestId }, ip });
    return this.detail(user, id);
  }

  // ───────── Pengait approval: setiap level yang menyetujui → QR ─────────

  async onApproved(tx: Tx, ctx: DecisionContext) {
    const d = await tx.eDocument.findFirst({ where: { requestId: ctx.requestId, deletedAt: null }, include: detailInclude });
    if (!d) return;
    if (d.status !== 'signing') throw new ConflictException('Naskah tidak sedang menunggu persetujuan');
    if (!d.contentHash || this.hashContent(d) !== d.contentHash) throw new ConflictException('Isi naskah berubah sejak dikirim. Tolak request ini agar pembuat mengirim ulang.');
    const account = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { position: true } });
    const delegator = ctx.onBehalfOf ? await tx.user.findUnique({ where: { id: ctx.onBehalfOf }, select: { fullName: true, position: true } }) : null;
    const role: SignerRole = ctx.isFinal ? 'sign' : 'paraf';
    const order = ctx.levelIndex + 1;
    const token = randomBytes(18).toString('base64url');
    await tx.eDocumentSigner.deleteMany({ where: { documentId: d.id, order } });
    await tx.eDocumentSigner.create({
      data: {
        documentId: d.id, userId: ctx.userId, order, role, status: 'signed', token, signedAt: ctx.at, contentHash: d.contentHash,
        ipAddress: ctx.ip ?? null, comment: ctx.comment, positionTitle: account.position, levelName: ctx.levelName.slice(0, 120),
        onBehalfOf: delegator ? `${delegator.fullName}${delegator.position ? ', ' + delegator.position : ''}`.slice(0, 150) : null,
        signatureHmac: this.hmac(token, d.id, ctx.userId, d.contentHash, ctx.at),
      },
    });
    if (ctx.isFinal) await tx.eDocument.update({ where: { id: d.id }, data: { status: 'signed', completedAt: ctx.at } });
    await this.log(d.id, ctx.userId, role === 'paraf' ? 'paraf' : 'signed', `${ctx.levelName}${ctx.comment ? ': ' + ctx.comment : ''}`, tx);
    await this.audit.log({
      actorUserId: ctx.userId, module: 'edoc', action: `edoc_${role === 'paraf' ? 'paraf' : 'signed'}`, entityType: 'e_document', entityId: d.id,
      payload: { number: d.number, level: ctx.levelName, requestId: ctx.requestId, contentHash: d.contentHash }, ip: ctx.ip,
    }, tx);
  }

  async onRejected(tx: Tx, ctx: DecisionContext) {
    const d = await tx.eDocument.findFirst({ where: { requestId: ctx.requestId, deletedAt: null }, select: { id: true, status: true } });
    if (!d || d.status !== 'signing') return;
    await tx.eDocument.update({ where: { id: d.id }, data: { status: 'rejected' } });
    await this.log(d.id, ctx.userId, 'rejected', `${ctx.levelName}: ${ctx.comment ?? ''}`, tx);
  }

  async afterDecision(ctx: DecisionContext & { decision: string }) {
    if (ctx.decision !== 'approve' || !ctx.isFinal) return;
    const d = await this.prisma.eDocument.findFirst({ where: { requestId: ctx.requestId, deletedAt: null, status: 'signed' }, select: { id: true } });
    if (d) await this.finalize(d.id);
  }

  private async notifyPending(id: bigint, actorName: string) {
    const d = await this.load(id);
    const p = d.signers.find((s) => s.status === 'pending');
    if (!p) return;
    await this.notif.notify('sign_request', p.userId, {
      path: `/e-docs/${id}`,
      vars: { ref: d.number ?? d.title, judul: d.title, perihal: d.subject ?? d.title, aktor: actorName, peran: ROLE_LABEL[p.role] },
    });
  }

  // ───────── Tanda tangan / paraf ─────────

  async sign(user: AuthUser, id: bigint, password: string, comment?: string, ip?: string) {
    const account = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(password ?? '', account.passwordHash))) {
      await this.audit.log({ actorUserId: user.id, module: 'edoc', action: 'edoc_sign_failed', entityType: 'e_document', entityId: id, payload: { reason: 'wrong password' }, ip });
      throw new UnauthorizedException('Kata sandi salah — tanda tangan dibatalkan');
    }
    const d = await this.load(id);
    if (d.requestId) throw new BadRequestException('Naskah ini disetujui lewat approval (Setujui + kata sandi)');
    const me = d.signers.find((s) => s.userId === user.id);
    if (d.status !== 'signing' || !me || me.status !== 'pending') throw new ForbiddenException('Belum giliran Anda atau naskah tidak sedang menunggu tanda tangan');
    if (!d.contentHash || this.hashContent(d) !== d.contentHash) throw new ConflictException('Isi naskah berubah sejak dikirim. Hubungi pembuat.');

    const signedAt = new Date();
    const token = randomBytes(18).toString('base64url');
    const next = d.signers.find((s) => s.order > me.order);
    await this.prisma.$transaction(async (tx) => {
      const lock = await tx.eDocumentSigner.updateMany({
        where: { id: me.id, status: 'pending' },
        data: {
          status: 'signed', token, signedAt, contentHash: d.contentHash, ipAddress: ip ?? null, comment: comment?.trim() || null,
          positionTitle: account.position, signatureHmac: this.hmac(token, d.id, user.id, d.contentHash!, signedAt),
        },
      });
      if (lock.count === 0) throw new ConflictException('Tanda tangan sudah diproses');
      if (next) await tx.eDocumentSigner.update({ where: { id: next.id }, data: { status: 'pending' } });
      else await tx.eDocument.update({ where: { id }, data: { status: 'signed', completedAt: signedAt } });
      await this.log(id, user.id, me.role === 'paraf' ? 'paraf' : 'signed', comment, tx);
      await this.audit.log({ actorUserId: user.id, module: 'edoc', action: `edoc_${me.role === 'paraf' ? 'paraf' : 'signed'}`, entityType: 'e_document', entityId: id, payload: { number: d.number, contentHash: d.contentHash }, ip }, tx);
    });

    if (next) await this.notifyPending(id, user.fullName);
    else await this.finalize(id);
    return this.detail(user, id);
  }

  /** Semua sudah tanda tangan → PDF final + QR disimpan ke Document Management & dibagikan ke penanda tangan. */
  private async finalize(id: bigint) {
    const d = await this.load(id);
    const pdf = await this.buildPdf(d, false);
    const folder = await this.docs.ensureFolder('Naskah Dinas', d.departmentId, d.creatorUserId);
    const fileName = `${(d.number ?? 'naskah').replace(/[\\/]+/g, '-')}_${d.title}`.replace(/[^\w.\- ]+/g, '').slice(0, 120) + '.pdf';
    const file = await this.docs.saveGenerated(d.creatorUserId, {
      folderId: folder.id, fileName, buffer: pdf, mimeType: 'application/pdf', title: d.title, category: 'Naskah Dinas',
      description: `${d.subject ?? d.title} — ditandatangani elektronik (QR) oleh ${d.signers.filter((s) => s.role === 'sign').map((s) => s.user.fullName).join(', ')}`,
      tagNames: ['Naskah Dinas', 'Bertanda tangan'], metadata: { nomor: d.number, contentHash: d.contentHash, eDocumentId: d.id.toString() },
      shareUserIds: d.signers.map((s) => s.userId),
    });
    await this.prisma.eDocument.update({ where: { id }, data: { fileId: file.id } });
    await this.log(id, null, 'finalized', `PDF final tersimpan di folder ${folder.name}`);
    await this.notif.notifyMany('doc_signed', [d.creatorUserId, ...d.signers.map((s) => s.userId)], {
      path: `/e-docs/${id}`, vars: { ref: d.number ?? d.title, judul: d.title },
    });
  }

  async reject(user: AuthUser, id: bigint, reason: string, ip?: string) {
    if (!reason?.trim() || reason.trim().length < 5) throw new BadRequestException('Tuliskan alasan minimal 5 karakter');
    const d = await this.load(id);
    if (d.requestId) throw new BadRequestException('Naskah ini dikembalikan lewat tombol Tolak pada approval');
    const me = d.signers.find((s) => s.userId === user.id);
    if (d.status !== 'signing' || !me || me.status !== 'pending') throw new ForbiddenException('Belum giliran Anda');
    await this.prisma.$transaction(async (tx) => {
      await tx.eDocumentSigner.update({ where: { id: me.id }, data: { status: 'rejected', comment: reason.trim() } });
      await tx.eDocument.update({ where: { id }, data: { status: 'rejected' } });
      await this.log(id, user.id, 'rejected', reason.trim(), tx);
      await this.audit.log({ actorUserId: user.id, module: 'edoc', action: 'edoc_rejected', entityType: 'e_document', entityId: id, payload: { reason }, ip }, tx);
    });
    await this.notif.notify('doc_rejected', d.creatorUserId, { path: `/e-docs/${id}`, vars: { ref: d.number ?? d.title, judul: d.title, aktor: user.fullName, alasan: reason.trim() } });
    return this.detail(user, id);
  }

  async cancel(user: AuthUser, id: bigint) {
    const d = await this.load(id);
    if (d.requestId) throw new BadRequestException('Naskah yang sedang dalam approval tidak dapat ditarik. Minta approver menolak agar dapat direvisi.');
    if (d.creatorUserId !== user.id || d.status !== 'signing') throw new ForbiddenException('Hanya pembuat yang dapat menarik naskah yang sedang ditandatangani');
    await this.prisma.$transaction(async (tx) => {
      await tx.eDocument.update({ where: { id }, data: { status: 'draft' } });
      await tx.eDocumentSigner.updateMany({ where: { documentId: id }, data: { status: 'waiting', token: null, signatureHmac: null, contentHash: null, signedAt: null } });
      await this.log(id, user.id, 'withdrawn', 'Ditarik kembali menjadi draft', tx);
    });
    return this.detail(user, id);
  }

  // ───────── PDF ─────────

  /** Kotak paraf/tanda tangan yang belum terisi: level approval yang belum menyetujui (beserta approver yang dituju). */
  private async plannedSigners(d: DocFull): Promise<{ order: number; role: SignerRole; levelName: string; approverName: string | null }[]> {
    if (this.isLegacy(d) || d.status === 'signed') return [];
    let levels: PlanLevel[] = [];
    let names: (string | null)[] = [];
    const inst = d.status === 'signing' && d.requestId
      ? await this.prisma.approvalInstance.findFirst({ where: { requestId: d.requestId, status: 'in_progress' }, orderBy: { id: 'desc' }, include: { request: true } })
      : null;
    if (inst) {
      levels = inst.planJson as unknown as PlanLevel[];
      names = await Promise.all(levels.map(async (l) => {
        const ids = await this.approvals.baseApprovers(l, inst.request);
        return ids.length ? (await this.prisma.user.findUnique({ where: { id: ids[0] }, select: { fullName: true } }))?.fullName ?? null : null;
      }));
    } else {
      // belum dikirim / dikembalikan: pratinjau alur yang akan dipakai
      const type = await this.prisma.requestType.findUnique({ where: { code: NASKAH_TYPE_CODE } });
      if (!type) return [];
      const pv = await this.approvals.preview({
        typeId: type.id.toString(), departmentId: d.departmentId?.toString(), priority: d.request?.priority ?? 'med', requesterUserId: d.creatorUserId.toString(),
      });
      levels = pv.levels;
      names = pv.levels.map((l) => l.approvers[0]?.fullName ?? null);
    }
    const signedOrders = new Set(d.status === 'signing' ? d.signers.filter((s) => s.status === 'signed').map((s) => s.order) : []);
    return levels
      .map((l, i) => ({ order: i + 1, role: (i === levels.length - 1 ? 'sign' : 'paraf') as SignerRole, levelName: l.name, approverName: names[i] }))
      .filter((p) => !signedOrders.has(p.order));
  }

  async buildPdf(d: DocFull, draft: boolean) {
    const legacy = this.isLegacy(d);
    const signed = legacy || d.status === 'signing' || d.status === 'signed' ? d.signers : [];
    const rows: PdfSigner[] = signed
      .filter((s) => legacy || s.status === 'signed')
      .map((s) => ({
        order: s.order, role: s.role, status: s.status, name: s.user.fullName,
        position: s.onBehalfOf ? `a.n. ${s.onBehalfOf}` : s.positionTitle ?? s.user.position,
        token: s.token, signedAt: s.signedAt,
      }));
    const planned = (await this.plannedSigners(d)).map((p) => ({
      order: p.order, role: p.role, status: 'waiting', name: p.approverName ?? `(${p.levelName})`, position: p.levelName, token: null, signedAt: null,
    }));
    return this.pdf.render({
      number: d.number, title: d.title, subject: d.subject, recipient: d.recipient, attachmentNote: d.attachmentNote,
      place: d.place, docDate: d.docDate, departmentName: d.department?.name ?? null, contentHash: d.contentHash,
      bodyHtml: this.renderedBody(d), draft,
      signers: [...rows, ...planned].sort((a, b) => a.order - b.order),
    });
  }

  async pdfFor(user: AuthUser, id: bigint) {
    const d = await this.load(id);
    if (!(await this.canView(user, d))) throw new ForbiddenException('Anda tidak memiliki akses ke naskah ini');
    if (d.status === 'signed' && d.fileId) return { fileId: d.fileId, buffer: null as Buffer | null, name: d.file?.originalName ?? 'naskah.pdf' };
    const buffer = await this.buildPdf(d, true);
    return { fileId: null, buffer, name: `DRAF-${d.title.replace(/[^\w\- ]+/g, '').slice(0, 80)}.pdf` };
  }

  // ───────── Verifikasi publik QR ─────────

  async verify(token: string, ip?: string) {
    const s = await this.prisma.eDocumentSigner.findUnique({
      where: { token },
      include: {
        user: { select: { fullName: true } },
        document: { include: { ...detailInclude } },
      },
    });
    if (!s || !s.signedAt || !s.contentHash || !s.signatureHmac) {
      await this.audit.log({ module: 'edoc', action: 'edoc_verify_unknown', payload: { token: token.slice(0, 8) }, ip });
      return { valid: false, reason: 'QR code tidak dikenal. Dokumen ini tidak diterbitkan melalui Digital Office atau tanda tangannya telah dibatalkan.' };
    }
    const d = s.document;
    const expected = this.hmac(token, d.id, s.userId, s.contentHash, s.signedAt);
    const sigOk = expected.length === s.signatureHmac.length && timingSafeEqual(Buffer.from(expected), Buffer.from(s.signatureHmac));
    const contentOk = !!d.contentHash && d.contentHash === s.contentHash && this.hashContent(d) === d.contentHash;
    const notCancelled = !d.deletedAt && d.status !== 'cancelled';
    const valid = sigOk && contentOk && notCancelled;
    await this.prisma.eDocumentSigner.update({ where: { id: s.id }, data: { verifyCount: { increment: 1 } } });
    await this.audit.log({ module: 'edoc', action: 'edoc_verified', entityType: 'e_document', entityId: d.id, payload: { signer: s.userId, valid }, ip });
    return {
      valid,
      reason: valid ? null : !sigOk ? 'Data tanda tangan tidak cocok (kemungkinan dimanipulasi).' : !contentOk ? 'Isi dokumen telah berubah setelah ditandatangani.' : 'Dokumen telah dibatalkan.',
      org: this.pdf.org.name,
      document: {
        number: d.number, title: d.title, subject: d.subject, status: d.status, docDate: d.docDate, completedAt: d.completedAt,
        department: d.department?.name ?? null, creator: d.creator.fullName, hashPrefix: d.contentHash?.slice(0, 16) ?? null,
      },
      signer: { name: s.user.fullName, position: s.positionTitle, role: s.role, signedAt: s.signedAt, verifyCount: s.verifyCount + 1 },
      signers: d.signers.map((x) => ({ name: x.user.fullName, position: x.positionTitle ?? x.user.position, role: x.role, status: x.status, signedAt: x.signedAt })),
    };
  }
}
