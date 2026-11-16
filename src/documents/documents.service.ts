import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccessLevel, FileAccessAction, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from './storage.service';
import { AuthUser } from '../common/types';
import { can, optBigInt, pageParams, paginated } from '../common/utils';

export type DocAccess = 'owner' | 'write' | 'comment' | 'read';
const RANK: Record<DocAccess, number> = { read: 1, comment: 2, write: 3, owner: 4 };
const maxAccess = (a: DocAccess | null, b: DocAccess | null) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

export const ATTACHMENT_FOLDER = 'Lampiran Request';

export const fileListSelect = {
  id: true, docUid: true, folderId: true, originalName: true, title: true, description: true, category: true,
  mimeType: true, sizeBytes: true, version: true, createdAt: true, updatedAt: true, metadataJson: true,
  uploader: { select: { id: true, fullName: true } },
  folder: { select: { id: true, name: true, departmentId: true } },
  taggings: { select: { tag: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.FileSelect;

@Injectable()
export class DocumentsService {
  /** Diisi RequestsModule: apakah user boleh melihat request (untuk akses lampiran). */
  requestViewChecker?: (user: AuthUser, requestId: bigint) => Promise<boolean>;

  constructor(private prisma: PrismaService, private audit: AuditService, private storage: StorageService) {}

  // ───────── Folder ─────────

  folderVisibleWhere(user: AuthUser): Prisma.FolderWhereInput {
    if (user.isSuperAdmin || can(user, 'DOC_VIEW_ALL')) return { deletedAt: null };
    return { deletedAt: null, isSystem: false, OR: [{ departmentId: null }, { departmentId: user.departmentId ?? BigInt(-1) }] };
  }

  async canWriteFolder(user: AuthUser, folderId: bigint) {
    const f = await this.prisma.folder.findFirst({ where: { id: folderId, deletedAt: null } });
    if (!f) throw new NotFoundException('Folder tidak ditemukan');
    if (user.isSuperAdmin) return f;
    if (f.isSystem && can(user, 'REQUEST_CREATE', 'DOC_UPLOAD')) return f; // folder lampiran request
    if (!can(user, 'DOC_UPLOAD', 'DOC_MANAGE')) throw new ForbiddenException('Anda tidak memiliki izin unggah');
    const sameDept = f.departmentId !== null && f.departmentId === user.departmentId;
    if (f.departmentId === null || sameDept) return f;
    throw new ForbiddenException('Anda tidak memiliki akses tulis ke folder ini');
  }

  async listFolders(user: AuthUser) {
    const folders = await this.prisma.folder.findMany({
      where: this.folderVisibleWhere(user), orderBy: { name: 'asc' },
      include: {
        department: { select: { id: true, name: true, code: true } },
        _count: { select: { files: { where: { isActive: true, deletedAt: null } } } },
      },
    });
    return folders.map((f) => ({ ...f, fileCount: f._count.files }));
  }

  async createFolder(user: AuthUser, dto: { name: string; parentFolderId?: string; departmentId?: string }) {
    const parentId = optBigInt(dto.parentFolderId);
    let deptId = optBigInt(dto.departmentId) ?? null;
    if (parentId) {
      const parent = await this.canWriteFolder(user, parentId);
      deptId = parent.departmentId; // sub-folder mewarisi unit induk
    } else if (!user.isSuperAdmin && !can(user, 'DOC_MANAGE')) {
      throw new ForbiddenException('Hanya admin yang dapat membuat folder tingkat atas');
    } else if (!user.isSuperAdmin && deptId && deptId !== user.departmentId) {
      throw new ForbiddenException('Folder hanya dapat dibuat untuk unit Anda');
    }
    const f = await this.prisma.folder.create({ data: { name: dto.name.trim(), parentFolderId: parentId, departmentId: deptId, createdBy: user.id } });
    await this.audit.log({ actorUserId: user.id, module: 'document', action: 'folder_created', entityType: 'folder', entityId: f.id, payload: dto });
    return f;
  }

  async updateFolder(user: AuthUser, id: bigint, dto: { name?: string; parentFolderId?: string | null }) {
    const f = await this.canWriteFolder(user, id);
    if (f.isSystem) throw new BadRequestException('Folder sistem tidak dapat diubah');
    if (dto.parentFolderId) {
      // cegah siklus
      let cur: bigint | null = BigInt(dto.parentFolderId);
      while (cur) {
        if (cur === id) throw new BadRequestException('Folder tidak dapat dipindah ke dalam dirinya sendiri');
        const p: { parentFolderId: bigint | null } | null = await this.prisma.folder.findUnique({ where: { id: cur }, select: { parentFolderId: true } });
        cur = p?.parentFolderId ?? null;
      }
    }
    const res = await this.prisma.folder.update({
      where: { id },
      data: { name: dto.name?.trim(), parentFolderId: dto.parentFolderId === null ? null : optBigInt(dto.parentFolderId) },
    });
    await this.audit.log({ actorUserId: user.id, module: 'document', action: 'folder_updated', entityType: 'folder', entityId: id, payload: dto });
    return res;
  }

  async deleteFolder(user: AuthUser, id: bigint) {
    const f = await this.canWriteFolder(user, id);
    if (f.isSystem) throw new BadRequestException('Folder sistem tidak dapat dihapus');
    if (!user.isSuperAdmin && !can(user, 'DOC_MANAGE')) throw new ForbiddenException('Hanya admin yang dapat menghapus folder');
    const [files, children] = await Promise.all([
      this.prisma.file.count({ where: { folderId: id, deletedAt: null } }),
      this.prisma.folder.count({ where: { parentFolderId: id, deletedAt: null } }),
    ]);
    if (files || children) throw new BadRequestException('Folder tidak kosong');
    await this.prisma.folder.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({ actorUserId: user.id, module: 'document', action: 'folder_deleted', entityType: 'folder', entityId: id });
    return { ok: true };
  }

  // ───────── Akses file ─────────

  async accessFor(user: AuthUser, file: { id: bigint; docUid: string; folderId: bigint }): Promise<DocAccess | null> {
    if (user.isSuperAdmin) return 'owner';
    const folder = await this.prisma.folder.findUnique({ where: { id: file.folderId } });
    const first = await this.prisma.file.findFirst({ where: { docUid: file.docUid }, orderBy: { version: 'asc' }, select: { userId: true } });
    if (first?.userId === user.id) return 'owner';
    const sameDept = !!folder?.departmentId && folder.departmentId === user.departmentId;
    if (can(user, 'DOC_MANAGE') && folder && !folder.isSystem && (sameDept || folder.departmentId === null)) return 'owner';

    let access: DocAccess | null = null;
    if (folder && !folder.isSystem && sameDept && can(user, 'DOC_UPLOAD')) access = 'write';
    if (folder && !folder.isSystem && (folder.departmentId === null || sameDept)) access = maxAccess(access, 'read');
    if (can(user, 'DOC_VIEW_ALL')) access = maxAccess(access, 'read');

    const now = new Date();
    const docIds = (await this.prisma.file.findMany({ where: { docUid: file.docUid }, select: { id: true } })).map((f) => f.id);
    const shares = await this.prisma.fileShare.findMany({
      where: {
        fileId: { in: docIds },
        OR: [{ shareToUserId: user.id }, ...(user.departmentId ? [{ shareToDeptId: user.departmentId }] : [])],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
    });
    for (const s of shares) access = maxAccess(access, s.accessLevel as DocAccess);

    if (!access && this.requestViewChecker) {
      const att = await this.prisma.requestAttachment.findMany({ where: { fileId: { in: docIds } }, select: { requestId: true } });
      for (const a of att) if (await this.requestViewChecker(user, a.requestId)) { access = 'read'; break; }
    }
    return access;
  }

  async requireAccess(user: AuthUser, id: bigint, min: DocAccess) {
    const file = await this.prisma.file.findFirst({ where: { id, deletedAt: null } });
    if (!file) throw new NotFoundException('Dokumen tidak ditemukan');
    const access = await this.accessFor(user, file);
    if (!access || RANK[access] < RANK[min]) {
      await this.audit.log({ actorUserId: user.id, module: 'document', action: 'access_denied', entityType: 'file', entityId: id, payload: { required: min } });
      throw new ForbiddenException(min === 'read' ? 'Anda tidak memiliki akses ke dokumen ini' : 'Akses Anda ke dokumen ini hanya baca');
    }
    return { file, access };
  }

  async logAccess(fileId: bigint, userId: bigint, action: FileAccessAction, ip?: string) {
    await this.prisma.fileAccessLog.create({ data: { fileId, userId, action, ipAddress: ip } });
  }

  // ───────── Daftar & pencarian (FR-DOC-04) ─────────

  visibleFilesWhere(user: AuthUser): Prisma.FileWhereInput {
    if (user.isSuperAdmin || can(user, 'DOC_VIEW_ALL')) return {};
    const now = new Date();
    const shareCond: Prisma.FileShareWhereInput = {
      OR: [{ shareToUserId: user.id }, ...(user.departmentId ? [{ shareToDeptId: user.departmentId }] : [])],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    };
    return {
      OR: [
        { userId: user.id },
        { folder: { isSystem: false, OR: [{ departmentId: null }, { departmentId: user.departmentId ?? BigInt(-1) }] } },
        { shares: { some: shareCond } },
      ],
    };
  }

  async listFiles(user: AuthUser, q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q, 100);
    const and: Prisma.FileWhereInput[] = [{ deletedAt: null, isActive: true }, this.visibleFilesWhere(user)];
    if (q.folder) {
      const ids = [BigInt(q.folder)];
      if (q.recursive === '1') {
        const all = await this.prisma.folder.findMany({ where: { deletedAt: null }, select: { id: true, parentFolderId: true } });
        for (let i = 0; i < ids.length; i++) for (const f of all) if (f.parentFolderId === ids[i]) ids.push(f.id);
      }
      and.push({ folderId: { in: ids } });
    }
    if (q.tag) and.push({ taggings: { some: { tagId: { in: q.tag.split(',').map((t) => BigInt(t)) } } } });
    if (q.category) and.push({ category: q.category });
    if (q.mine === '1') and.push({ userId: user.id });
    if (q.shared === '1') {
      and.push({ shares: { some: { OR: [{ shareToUserId: user.id }, ...(user.departmentId ? [{ shareToDeptId: user.departmentId }] : [])] } } });
    }
    if (q.type) {
      const map: Record<string, Prisma.FileWhereInput> = {
        pdf: { mimeType: 'application/pdf' },
        image: { mimeType: { startsWith: 'image/' } },
        office: { OR: [{ mimeType: { contains: 'officedocument' } }, { mimeType: { contains: 'msword' } }, { mimeType: { contains: 'ms-excel' } }, { mimeType: { contains: 'ms-powerpoint' } }] },
        other: { NOT: [{ mimeType: 'application/pdf' }, { mimeType: { startsWith: 'image/' } }, { mimeType: { contains: 'officedocument' } }] },
      };
      if (map[q.type]) and.push(map[q.type]);
    }
    if (q.search) {
      const s = q.search.trim();
      and.push({
        OR: [
          { originalName: { contains: s } }, { title: { contains: s } }, { description: { contains: s } },
          { category: { contains: s } }, { taggings: { some: { tag: { name: { contains: s } } } } },
        ],
      });
    }
    const sortMap: Record<string, string> = { name: 'originalName', date: 'updatedAt', size: 'sizeBytes', title: 'title' };
    const orderBy = { [sortMap[q.sort] ?? 'updatedAt']: q.order === 'asc' ? 'asc' : 'desc' } as Prisma.FileOrderByWithRelationInput;
    const where = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.file.findMany({ where, skip, take, orderBy, select: fileListSelect }),
      this.prisma.file.count({ where }),
    ]);
    return paginated(rows, total, page, perPage);
  }

  // ───────── Upload & versioning (FR-DOC-01/03, BR-08) ─────────

  async upload(
    user: AuthUser,
    file: Express.Multer.File,
    dto: { folderId?: string; docUid?: string; title?: string; description?: string; category?: string; tags?: string; metadata?: string; purpose?: string },
    ip?: string,
  ) {
    if (!file) throw new BadRequestException('File wajib diunggah');
    let folderId: bigint;
    let docUid: string;
    let version = 1;
    let inheritTags: bigint[] = [];
    let prev: { title: string | null; description: string | null; category: string | null; metadataJson: Prisma.JsonValue } | null = null;

    if (dto.docUid) {
      const latest = await this.prisma.file.findFirst({ where: { docUid: dto.docUid, deletedAt: null }, orderBy: { version: 'desc' }, include: { taggings: true } });
      if (!latest) throw new NotFoundException('Dokumen asal tidak ditemukan');
      await this.requireAccess(user, latest.id, 'write');
      folderId = latest.folderId; docUid = latest.docUid; version = latest.version + 1;
      inheritTags = latest.taggings.map((t) => t.tagId);
      prev = latest;
    } else if (dto.purpose === 'attachment') {
      // lampiran request → folder sistem (tidak tampil di repositori umum)
      const sys = (await this.prisma.folder.findFirst({ where: { name: ATTACHMENT_FOLDER, isSystem: true, deletedAt: null } }))
        ?? (await this.prisma.folder.create({ data: { name: ATTACHMENT_FOLDER, isSystem: true, createdBy: user.id } }));
      folderId = sys.id;
      await this.canWriteFolder(user, folderId);
      docUid = randomUUID();
    } else {
      if (!dto.folderId) throw new BadRequestException('Folder wajib dipilih');
      folderId = BigInt(dto.folderId);
      await this.canWriteFolder(user, folderId);
      docUid = randomUUID();
    }

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const now = new Date();
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-120);
    const key = `docs/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${docUid}/v${version}-${safeName}`;
    await this.storage.save(key, file.buffer);

    let metadata: Prisma.InputJsonValue | undefined;
    if (dto.metadata) {
      try { metadata = JSON.parse(dto.metadata); } catch { throw new BadRequestException('Metadata harus JSON valid'); }
    }
    const tagIds = dto.tags !== undefined ? await this.resolveTags(dto.tags) : inheritTags;

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.file.updateMany({ where: { docUid, isActive: true }, data: { isActive: false } });
      const f = await tx.file.create({
        data: {
          docUid, folderId, userId: user.id, version, isActive: true,
          originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
          title: dto.title ?? prev?.title ?? null,
          description: dto.description ?? prev?.description ?? null,
          category: dto.category ?? prev?.category ?? null,
          metadataJson: metadata ?? ((prev?.metadataJson ?? undefined) as Prisma.InputJsonValue | undefined),
          mimeType: file.mimetype || 'application/octet-stream',
          sizeBytes: BigInt(file.size), storagePath: key, checksumSha256: checksum,
        },
      });
      if (tagIds.length) await tx.fileTagging.createMany({ data: tagIds.map((tagId) => ({ fileId: f.id, tagId })), skipDuplicates: true });
      // share ikut ke versi baru
      if (version > 1) {
        const oldShares = await tx.fileShare.findMany({ where: { file: { docUid }, fileId: { not: f.id } } });
        const seen = new Set<string>();
        for (const s of oldShares) {
          const k = `${s.shareToUserId}-${s.shareToDeptId}`;
          if (seen.has(k)) continue; seen.add(k);
          await tx.fileShare.create({ data: { fileId: f.id, shareToUserId: s.shareToUserId, shareToDeptId: s.shareToDeptId, accessLevel: s.accessLevel, sharedBy: s.sharedBy, expiresAt: s.expiresAt } });
        }
        await tx.fileShare.deleteMany({ where: { file: { docUid }, fileId: { not: f.id } } });
      }
      await tx.fileAccessLog.create({ data: { fileId: f.id, userId: user.id, action: 'uploaded', ipAddress: ip } });
      await this.audit.log({ actorUserId: user.id, module: 'document', action: version > 1 ? 'file_new_version' : 'file_uploaded', entityType: 'file', entityId: f.id, payload: { docUid, version, name: f.originalName, size: file.size }, ip }, tx);
      return f;
    });
    return this.prisma.file.findUnique({ where: { id: created.id }, select: fileListSelect });
  }

  /**
   * Simpan file yang dihasilkan sistem (mis. PDF naskah bertanda tangan) sebagai dokumen baru,
   * lalu bagikan baca ke pengguna terkait. Dipanggil oleh modul lain — tanpa cek izin unggah.
   */
  async saveGenerated(actorId: bigint, o: {
    folderId: bigint; fileName: string; buffer: Buffer; mimeType: string; title?: string; description?: string;
    category?: string; tagNames?: string[]; metadata?: Prisma.InputJsonValue; shareUserIds?: bigint[];
  }) {
    const docUid = randomUUID();
    const safeName = o.fileName.replace(/[^\w.\-]+/g, '_').slice(-120);
    const now = new Date();
    const key = `docs/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${docUid}/v1-${safeName}`;
    await this.storage.save(key, o.buffer);
    const tagIds = o.tagNames?.length ? await this.resolveTags(o.tagNames.join(',')) : [];
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.file.create({
        data: {
          docUid, folderId: o.folderId, userId: actorId, version: 1, isActive: true, originalName: o.fileName,
          title: o.title, description: o.description, category: o.category, metadataJson: o.metadata,
          mimeType: o.mimeType, sizeBytes: BigInt(o.buffer.length), storagePath: key,
          checksumSha256: createHash('sha256').update(o.buffer).digest('hex'),
        },
      });
      if (tagIds.length) await tx.fileTagging.createMany({ data: tagIds.map((tagId) => ({ fileId: f.id, tagId })), skipDuplicates: true });
      const shareTo = [...new Set((o.shareUserIds ?? []).filter((u) => u !== actorId).map(String))].map((s) => BigInt(s));
      if (shareTo.length) await tx.fileShare.createMany({ data: shareTo.map((u) => ({ fileId: f.id, shareToUserId: u, accessLevel: 'read' as const, sharedBy: actorId })) });
      await tx.fileAccessLog.create({ data: { fileId: f.id, userId: actorId, action: 'uploaded' } });
      await this.audit.log({ actorUserId: actorId, module: 'document', action: 'file_generated', entityType: 'file', entityId: f.id, payload: { name: o.fileName, size: o.buffer.length } }, tx);
      return f;
    });
  }

  /** Folder tingkat atas bernama `name` milik unit (dibuat bila belum ada). */
  async ensureFolder(name: string, departmentId: bigint | null, actorId: bigint) {
    const found = await this.prisma.folder.findFirst({ where: { name, departmentId, parentFolderId: null, deletedAt: null, isSystem: false } });
    return found ?? this.prisma.folder.create({ data: { name, departmentId, createdBy: actorId } });
  }

  async resolveTags(input: string): Promise<bigint[]> {
    const names = input.split(',').map((t) => t.trim()).filter(Boolean);
    const ids: bigint[] = [];
    for (const n of names) {
      if (/^\d+$/.test(n)) { ids.push(BigInt(n)); continue; }
      const t = await this.prisma.fileTag.upsert({ where: { name: n }, update: {}, create: { name: n } });
      ids.push(t.id);
    }
    return [...new Set(ids.map(String))].map((s) => BigInt(s));
  }

  async detail(user: AuthUser, id: bigint, ip?: string) {
    const { access } = await this.requireAccess(user, id, 'read');
    const file = await this.prisma.file.findUniqueOrThrow({
      where: { id },
      select: {
        ...fileListSelect, checksumSha256: true, isActive: true,
        attachments: { select: { request: { select: { id: true, refCode: true, title: true } } } },
      },
    });
    const [versions, shares] = await Promise.all([
      this.prisma.file.findMany({
        where: { docUid: file.docUid, deletedAt: null }, orderBy: { version: 'desc' },
        select: { id: true, version: true, originalName: true, sizeBytes: true, mimeType: true, createdAt: true, isActive: true, checksumSha256: true, uploader: { select: { id: true, fullName: true } } },
      }),
      this.prisma.fileShare.findMany({
        where: { file: { docUid: file.docUid } },
        include: { toUser: { select: { id: true, fullName: true, email: true } }, toDept: { select: { id: true, name: true } }, sharedByMe: { select: { id: true, fullName: true } } },
      }),
    ]);
    await this.logAccess(id, user.id, 'viewed', ip);
    return { ...file, access, canDelete: access === 'owner', canShare: (access === 'owner' || access === 'write') && can(user, 'DOC_SHARE', 'DOC_MANAGE'), versions, shares };
  }

  async updateMeta(user: AuthUser, id: bigint, dto: { title?: string; description?: string; category?: string; tags?: string; folderId?: string }) {
    const { file } = await this.requireAccess(user, id, 'write');
    if (dto.folderId) await this.canWriteFolder(user, BigInt(dto.folderId));
    await this.prisma.$transaction(async (tx) => {
      await tx.file.updateMany({
        where: { docUid: file.docUid },
        data: { folderId: dto.folderId ? BigInt(dto.folderId) : undefined },
      });
      await tx.file.update({ where: { id }, data: { title: dto.title, description: dto.description, category: dto.category } });
      if (dto.tags !== undefined) {
        const tagIds = await this.resolveTags(dto.tags);
        await tx.fileTagging.deleteMany({ where: { fileId: id } });
        if (tagIds.length) await tx.fileTagging.createMany({ data: tagIds.map((tagId) => ({ fileId: id, tagId })) });
      }
      await this.audit.log({ actorUserId: user.id, module: 'document', action: 'file_updated', entityType: 'file', entityId: id, payload: dto }, tx);
    });
    return this.prisma.file.findUnique({ where: { id }, select: fileListSelect });
  }

  /** BR-07: hanya owner/admin yang dapat menghapus (soft delete seluruh versi). */
  async remove(user: AuthUser, id: bigint, ip?: string) {
    const { file } = await this.requireAccess(user, id, 'owner');
    await this.prisma.$transaction(async (tx) => {
      await tx.file.updateMany({ where: { docUid: file.docUid }, data: { deletedAt: new Date(), isActive: false } });
      await tx.fileAccessLog.create({ data: { fileId: id, userId: user.id, action: 'deleted', ipAddress: ip } });
      await this.audit.log({ actorUserId: user.id, module: 'document', action: 'file_deleted', entityType: 'file', entityId: id, payload: { docUid: file.docUid, name: file.originalName }, ip }, tx);
    });
    return { ok: true };
  }

  async share(
    user: AuthUser, id: bigint,
    dto: { userIds?: string[]; deptIds?: string[]; accessLevel: AccessLevel; expiresAt?: string },
    ip?: string,
  ) {
    if (!can(user, 'DOC_SHARE', 'DOC_MANAGE')) throw new ForbiddenException('Anda tidak memiliki izin berbagi dokumen');
    await this.requireAccess(user, id, 'write');
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const targets = [
      ...(dto.userIds ?? []).map((u) => ({ shareToUserId: BigInt(u), shareToDeptId: null })),
      ...(dto.deptIds ?? []).map((d) => ({ shareToUserId: null, shareToDeptId: BigInt(d) })),
    ];
    if (!targets.length) throw new BadRequestException('Pilih minimal satu pengguna atau departemen');
    await this.prisma.$transaction(async (tx) => {
      for (const t of targets) {
        await tx.fileShare.deleteMany({ where: { fileId: id, shareToUserId: t.shareToUserId, shareToDeptId: t.shareToDeptId } });
        await tx.fileShare.create({ data: { fileId: id, ...t, accessLevel: dto.accessLevel, sharedBy: user.id, expiresAt } });
      }
      await tx.fileAccessLog.create({ data: { fileId: id, userId: user.id, action: 'shared', ipAddress: ip } });
      await this.audit.log({ actorUserId: user.id, module: 'document', action: 'file_shared', entityType: 'file', entityId: id, payload: dto, ip }, tx);
    });
    return this.prisma.fileShare.findMany({
      where: { fileId: id },
      include: { toUser: { select: { id: true, fullName: true, email: true } }, toDept: { select: { id: true, name: true } }, sharedByMe: { select: { id: true, fullName: true } } },
    });
  }

  async unshare(user: AuthUser, id: bigint, shareId: bigint) {
    await this.requireAccess(user, id, 'write');
    await this.prisma.fileShare.deleteMany({ where: { id: shareId, fileId: id } });
    await this.audit.log({ actorUserId: user.id, module: 'document', action: 'file_unshared', entityType: 'file', entityId: id, payload: { shareId } });
    return { ok: true };
  }

  async accessLogs(user: AuthUser, id: bigint) {
    const { file, access } = await this.requireAccess(user, id, 'read');
    if (access !== 'owner' && !can(user, 'AUDIT_VIEW')) throw new ForbiddenException('Hanya pemilik/auditor yang dapat melihat log akses');
    return this.prisma.fileAccessLog.findMany({
      where: { file: { docUid: file.docUid } }, orderBy: { createdAt: 'desc' }, take: 300,
      include: { user: { select: { id: true, fullName: true, email: true } }, file: { select: { version: true } } },
    });
  }
}
