import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SignerRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DocumentsService } from '../documents/documents.service';
import { AuthUser } from '../common/types';
import { can, pageParams, paginated } from '../common/utils';
import { fillPlaceholders, htmlToText, sanitizeHtml } from './html';
import { EDocPdfService, fmtLongDate } from './e-doc-pdf.service';

export interface SignerInput { userId: string; role: 'sign' | 'paraf' }
export interface EDocInput {
  title: string; subject?: string; recipient?: string; attachmentNote?: string; place?: string; docDate?: string;
  bodyHtml: string; templateId?: string | null; signers?: SignerInput[];
}

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
} satisfies Prisma.EDocumentInclude;

type DocFull = Prisma.EDocumentGetPayload<{ include: typeof detailInclude }>;

@Injectable()
export class EDocumentsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notif: NotificationsService,
    private docs: DocumentsService,
    private pdf: EDocPdfService,
    private config: ConfigService,
  ) {}

  get org() { return this.pdf.org; }

  private get secret() {
    return this.config.get<string>('SIGNATURE_SECRET') ?? this.config.get<string>('JWT_ACCESS_SECRET') ?? 'digital-office-signature';
  }

  // ───────── Akses ─────────

  private visibleWhere(user: AuthUser): Prisma.EDocumentWhereInput {
    if (user.isSuperAdmin || can(user, 'EDOC_VIEW_ALL')) return {};
    const or: Prisma.EDocumentWhereInput[] = [
      { creatorUserId: user.id },
      // penanda tangan melihat naskah setelah dikirim (bukan draft pembuat)
      { signers: { some: { userId: user.id } }, status: { not: 'draft' } },
    ];
    if (can(user, 'DOC_MANAGE') && user.departmentId) or.push({ departmentId: user.departmentId, status: { not: 'draft' } });
    return { OR: or };
  }

  private async load(id: bigint) {
    const d = await this.prisma.eDocument.findFirst({ where: { id, deletedAt: null }, include: detailInclude });
    if (!d) throw new NotFoundException('Naskah tidak ditemukan');
    return d;
  }

  private canView(user: AuthUser, d: DocFull) {
    if (user.isSuperAdmin || can(user, 'EDOC_VIEW_ALL') || d.creatorUserId === user.id) return true;
    if (d.status !== 'draft' && d.signers.some((s) => s.userId === user.id)) return true;
    return can(user, 'DOC_MANAGE') && !!user.departmentId && d.departmentId === user.departmentId && d.status !== 'draft';
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
      signers: d.signers.map((s) => ({ u: s.userId.toString(), r: s.role, o: s.order })),
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private hmac(token: string, docId: bigint, userId: bigint, contentHash: string, signedAt: Date) {
    return createHmac('sha256', this.secret).update(`${token}|${docId}|${userId}|${contentHash}|${signedAt.toISOString()}`).digest('hex');
  }

  // ───────── Daftar ─────────

  async list(user: AuthUser, q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q);
    const and: Prisma.EDocumentWhereInput[] = [{ deletedAt: null }, this.visibleWhere(user)];
    if (q.scope === 'mine') and.push({ creatorUserId: user.id });
    if (q.scope === 'tosign') and.push({ status: 'signing', signers: { some: { userId: user.id, status: 'pending' } } });
    if (q.scope === 'signed-by-me') and.push({ signers: { some: { userId: user.id, status: 'signed' } } });
    if (q.status) and.push({ status: q.status as any });
    if (q.search) and.push({ OR: [{ title: { contains: q.search } }, { number: { contains: q.search } }, { subject: { contains: q.search } }] });
    const where = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.eDocument.findMany({
        where, skip, take, orderBy: { updatedAt: 'desc' },
        select: {
          id: true, number: true, title: true, subject: true, status: true, createdAt: true, updatedAt: true, submittedAt: true, completedAt: true,
          template: { select: { name: true, category: true } }, creator: { select: { id: true, fullName: true, photoUrl: true } },
          signers: { orderBy: { order: 'asc' }, select: { order: true, role: true, status: true, user: { select: { id: true, fullName: true } } } },
        },
      }),
      this.prisma.eDocument.count({ where }),
    ]);
    return paginated(rows, total, page, perPage);
  }

  countToSign(user: AuthUser) {
    return this.prisma.eDocument.count({ where: { deletedAt: null, status: 'signing', signers: { some: { userId: user.id, status: 'pending' } } } });
  }

  // ───────── Detail ─────────

  async detail(user: AuthUser, id: bigint) {
    const d = await this.load(id);
    if (!this.canView(user, d)) {
      await this.audit.log({ actorUserId: user.id, module: 'security', action: 'access_denied', entityType: 'e_document', entityId: id });
      throw new ForbiddenException('Anda tidak memiliki akses ke naskah ini');
    }
    const signers = await Promise.all(d.signers.map(async (s) => ({
      id: s.id, order: s.order, role: s.role, status: s.status, positionTitle: s.positionTitle ?? s.user.position, signedAt: s.signedAt,
      comment: s.comment, user: s.user, verifyUrl: s.token && s.status === 'signed' ? this.pdf.verifyUrl(s.token) : null,
      qrDataUrl: s.token && s.status === 'signed' ? await this.pdf.qrDataUrl(s.token) : null,
    })));
    const mine = d.signers.find((s) => s.userId === user.id);
    const isCreator = d.creatorUserId === user.id;
    const intact = d.status !== 'signed' || !d.contentHash || this.hashContent(d) === d.contentHash;
    return {
      id: d.id, number: d.number, title: d.title, subject: d.subject, recipient: d.recipient, attachmentNote: d.attachmentNote,
      place: d.place, docDate: d.docDate, status: d.status, contentHash: d.contentHash, intact,
      bodyHtml: d.bodyHtml, renderedHtml: this.renderedBody(d),
      template: d.template, department: d.department, creator: d.creator, file: d.file,
      submittedAt: d.submittedAt, completedAt: d.completedAt, createdAt: d.createdAt, updatedAt: d.updatedAt,
      signers, logs: d.logs, org: this.pdf.org,
      permissions: {
        canEdit: isCreator && ['draft', 'rejected'].includes(d.status) && can(user, 'EDOC_CREATE'),
        canSubmit: isCreator && ['draft', 'rejected'].includes(d.status) && can(user, 'EDOC_CREATE'),
        canCancel: isCreator && d.status === 'signing',
        canDelete: isCreator && d.status === 'draft',
        canSign: d.status === 'signing' && mine?.status === 'pending',
        myRole: mine?.role ?? null,
      },
    };
  }

  // ───────── Buat / ubah draft ─────────

  private async validateSigners(signers: SignerInput[] | undefined, creatorId: bigint) {
    const list = signers ?? [];
    const ids = list.map((s) => s.userId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Penanda tangan tidak boleh duplikat');
    if (list.length > 10) throw new BadRequestException('Maksimal 10 penanda tangan/paraf');
    const users = await this.prisma.user.findMany({ where: { id: { in: ids.map((i) => BigInt(i)) }, deletedAt: null, status: 'active' }, select: { id: true } });
    if (users.length !== ids.length) throw new BadRequestException('Ada penanda tangan yang tidak aktif atau tidak ditemukan');
    return list.map((s, i) => ({ userId: BigInt(s.userId), role: s.role === 'paraf' ? ('paraf' as const) : ('sign' as const), order: i + 1 }));
  }

  async create(user: AuthUser, dto: EDocInput) {
    if (!can(user, 'EDOC_CREATE')) throw new ForbiddenException('Peran Anda tidak dapat membuat naskah');
    const signers = await this.validateSigners(dto.signers, user.id);
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
      if (signers.length) await tx.eDocumentSigner.createMany({ data: signers.map((s) => ({ ...s, documentId: doc.id })) });
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
    const signers = dto.signers ? await this.validateSigners(dto.signers, user.id) : null;
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
      if (signers) {
        await tx.eDocumentSigner.deleteMany({ where: { documentId: id } });
        if (signers.length) await tx.eDocumentSigner.createMany({ data: signers.map((s) => ({ ...s, documentId: id })) });
      }
      await this.log(id, user.id, 'updated', null, tx);
    });
    return this.detail(user, id);
  }

  async remove(user: AuthUser, id: bigint) {
    const d = await this.load(id);
    if (d.creatorUserId !== user.id || d.status !== 'draft') throw new ForbiddenException('Hanya draft milik Anda yang dapat dihapus');
    await this.prisma.eDocument.update({ where: { id }, data: { deletedAt: new Date() } });
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

  // ───────── Kirim untuk ditandatangani ─────────

  async submit(user: AuthUser, id: bigint, ip?: string) {
    const d = await this.load(id);
    if (d.creatorUserId !== user.id) throw new ForbiddenException('Hanya pembuat yang dapat mengirim naskah');
    if (!['draft', 'rejected'].includes(d.status)) throw new BadRequestException('Naskah sudah dikirim');
    if (!d.signers.some((s) => s.role === 'sign')) throw new BadRequestException('Tambahkan minimal satu penanda tangan');
    if (!htmlToText(d.bodyHtml)) throw new BadRequestException('Isi naskah masih kosong');

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.assignNumber(tx, d);
          await tx.eDocumentSigner.updateMany({
            where: { documentId: id },
            data: { status: 'waiting', token: null, signatureHmac: null, contentHash: null, signedAt: null, comment: null, ipAddress: null },
          });
          const first = d.signers[0];
          await tx.eDocumentSigner.update({ where: { id: first.id }, data: { status: 'pending' } });
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
    await this.prisma.eDocument.update({ where: { id }, data: { contentHash: this.hashContent(fresh) } });
    await this.audit.log({ actorUserId: user.id, module: 'edoc', action: 'edoc_submitted', entityType: 'e_document', entityId: id, payload: { number: fresh.number }, ip });
    await this.notifyPending(id, user.fullName);
    return this.detail(user, id);
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
    if (d.creatorUserId !== user.id || d.status !== 'signing') throw new ForbiddenException('Hanya pembuat yang dapat menarik naskah yang sedang ditandatangani');
    await this.prisma.$transaction(async (tx) => {
      await tx.eDocument.update({ where: { id }, data: { status: 'draft' } });
      await tx.eDocumentSigner.updateMany({ where: { documentId: id }, data: { status: 'waiting', token: null, signatureHmac: null, contentHash: null, signedAt: null } });
      await this.log(id, user.id, 'withdrawn', 'Ditarik kembali menjadi draft', tx);
    });
    return this.detail(user, id);
  }

  // ───────── PDF ─────────

  async buildPdf(d: DocFull, draft: boolean) {
    return this.pdf.render({
      number: d.number, title: d.title, subject: d.subject, recipient: d.recipient, attachmentNote: d.attachmentNote,
      place: d.place, docDate: d.docDate, departmentName: d.department?.name ?? null, contentHash: d.contentHash,
      bodyHtml: this.renderedBody(d), draft,
      signers: d.signers.map((s) => ({
        order: s.order, role: s.role, status: s.status, name: s.user.fullName, position: s.positionTitle ?? s.user.position,
        token: s.token, signedAt: s.signedAt,
      })),
    });
  }

  async pdfFor(user: AuthUser, id: bigint) {
    const d = await this.load(id);
    if (!this.canView(user, d)) throw new ForbiddenException('Anda tidak memiliki akses ke naskah ini');
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
