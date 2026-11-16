import 'dotenv/config';
/**
 * Seed data uji Digital Office (PRD 18.1): departemen, role, alur approval, 500 dokumen uji, request contoh.
 * Jalankan: npm run db:seed   (SEED_DOCS=500 dapat diubah)
 * Semua akun demo memakai kata sandi: Password123!
 */
import { PrismaClient, Prisma, Priority, RequestStatus, ApprovalLevel } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { PERMISSIONS, DEFAULT_ROLE_MATRIX, ROLE_NAMES, PRIORITY_RANK } from '../src/common/permissions';
import { DEFAULT_TEMPLATES } from '../src/notifications/templates';

const prisma = new PrismaClient();
const STORAGE = resolve(process.env.STORAGE_DIR ?? './storage');
const DOC_COUNT = Number(process.env.SEED_DOCS ?? 500);
const PASSWORD = 'Password123!';

const daysAgo = (d: number, h = 0) => new Date(Date.now() - d * 86400_000 - h * 3600_000);
const daysAhead = (d: number) => new Date(Date.now() + d * 86400_000);
const pick = <T>(arr: T[], i: number) => arr[i % arr.length];

/** PDF minimal yang valid (satu halaman teks). */
function makePdf(title: string, lines: string[]) {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7E]/g, '?');
  const text = [`BT /F1 18 Tf 56 770 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 11 Tf 56 ${735 - i * 18} Td (${esc(l)}) Tj ET`)].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

function saveFile(key: string, buf: Buffer) {
  const p = resolve(STORAGE, key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
}

async function reset() {
  await prisma.eDocumentLog.deleteMany();
  await prisma.eDocumentSigner.deleteMany();
  await prisma.eDocument.deleteMany();
  await prisma.docTemplate.deleteMany();
  // Hapus berurutan (anak → induk) memakai deleteMany. Tidak memakai TRUNCATE + SET FOREIGN_KEY_CHECKS
  // karena Prisma memakai connection pool: SET hanya berlaku di satu koneksi sehingga TRUNCATE bisa gagal.
  await prisma.approvalDecision.deleteMany();
  await prisma.approvalInstance.deleteMany();
  await prisma.approvalLevel.deleteMany();
  await prisma.approvalFlow.deleteMany();
  await prisma.requestAttachment.deleteMany();
  await prisma.requestComment.deleteMany();
  await prisma.requestLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.request.deleteMany();
  await prisma.requestType.deleteMany();
  await prisma.fileAccessLog.deleteMany();
  await prisma.fileShare.deleteMany();
  await prisma.fileTagging.deleteMany();
  await prisma.fileTag.deleteMany();
  await prisma.file.deleteMany();
  await prisma.folder.updateMany({ data: { parentFolderId: null } });
  await prisma.folder.deleteMany();
  await prisma.delegation.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.exportJob.deleteMany();
  await prisma.notificationTemplate.deleteMany();
  await prisma.department.updateMany({ data: { headUserId: null, parentDeptId: null } });
  await prisma.user.deleteMany();
  await prisma.department.deleteMany();
}

async function main() {
  console.log('› Reset data…');
  await reset();

  // ─── Permission & role ───
  console.log('› Role & permission');
  for (const [code, p] of Object.entries(PERMISSIONS)) {
    await prisma.permission.create({ data: { code, module: p.module, description: p.description } });
  }
  const perms = await prisma.permission.findMany();
  const permId = (c: string) => perms.find((p) => p.code === c)!.id;

  const roleDefs: [string, string, string[]][] = [
    [ROLE_NAMES.SUPER_ADMIN, 'Admin sistem / IT', DEFAULT_ROLE_MATRIX[ROLE_NAMES.SUPER_ADMIN]],
    [ROLE_NAMES.DEPT_ADMIN, 'Pengelola alur & dokumen di level unit', DEFAULT_ROLE_MATRIX[ROLE_NAMES.DEPT_ADMIN]],
    [ROLE_NAMES.APPROVER, 'Pegawai yang memiliki hak approval', DEFAULT_ROLE_MATRIX[ROLE_NAMES.APPROVER]],
    [ROLE_NAMES.STAFF, 'Pemohon & pelaksana', DEFAULT_ROLE_MATRIX[ROLE_NAMES.STAFF]],
    [ROLE_NAMES.AUDITOR, 'Lihat-saja untuk kepatuhan', DEFAULT_ROLE_MATRIX[ROLE_NAMES.AUDITOR]],
    // role jenjang approval (configurable) — dipakai sebagai approver per level
    ['Team Lead', 'Approver level 1 di unit', DEFAULT_ROLE_MATRIX[ROLE_NAMES.APPROVER]],
    ['Manajer', 'Approver level 2 / kepala unit', DEFAULT_ROLE_MATRIX[ROLE_NAMES.APPROVER]],
    ['Direktur', 'Approver level 3 / direksi', DEFAULT_ROLE_MATRIX[ROLE_NAMES.APPROVER]],
  ];
  const roles: Record<string, bigint> = {};
  for (const [name, description, codes] of roleDefs) {
    const r = await prisma.role.create({ data: { name, description, isSystem: true } });
    roles[name] = r.id;
    await prisma.rolePermission.createMany({ data: codes.map((c) => ({ roleId: r.id, permissionId: permId(c) })) });
  }

  // ─── Organisasi ───
  console.log('› Departemen & pengguna');
  const dir = await prisma.department.create({ data: { name: 'Direksi', code: 'DIR', kind: 'department' } });
  const keu = await prisma.department.create({ data: { name: 'Keuangan', code: 'KEU', kind: 'department', parentDeptId: dir.id } });
  const ops = await prisma.department.create({ data: { name: 'Operasional', code: 'OPS', kind: 'department', parentDeptId: dir.id } });
  const its = await prisma.department.create({ data: { name: 'Teknologi Informasi', code: 'ITS', kind: 'department', parentDeptId: dir.id } });
  const ops2 = await prisma.department.create({ data: { name: 'Divisi Event & Acara', code: 'OPS-EVT', kind: 'division', parentDeptId: ops.id } });

  const hash = await bcrypt.hash(PASSWORD, 10);
  const userDefs: { key: string; name: string; email: string; position: string; dept: bigint; roles: string[]; superAdmin?: boolean }[] = [
    { key: 'admin', name: 'Arya Pratama', email: 'admin@digital-office.local', position: 'IT System Administrator', dept: its.id, roles: [ROLE_NAMES.SUPER_ADMIN], superAdmin: true },
    { key: 'direktur', name: 'Hendra Wijaya', email: 'direktur@digital-office.local', position: 'Direktur Utama', dept: dir.id, roles: ['Direktur'] },
    { key: 'mgrKeu', name: 'Sari Lestari', email: 'manajer.keu@digital-office.local', position: 'Manajer Keuangan', dept: keu.id, roles: ['Manajer'] },
    { key: 'leadKeu', name: 'Budi Santoso', email: 'lead.keu@digital-office.local', position: 'Team Lead Akuntansi', dept: keu.id, roles: ['Team Lead'] },
    { key: 'staffKeu', name: 'Rina Anggraini', email: 'staff.keu@digital-office.local', position: 'Staf Akuntansi', dept: keu.id, roles: [ROLE_NAMES.STAFF] },
    { key: 'staffKeu2', name: 'Dimas Saputra', email: 'staff2.keu@digital-office.local', position: 'Staf Pajak', dept: keu.id, roles: [ROLE_NAMES.STAFF] },
    { key: 'mgrOps', name: 'Teguh Ramadhan', email: 'manajer.ops@digital-office.local', position: 'Manajer Operasional', dept: ops.id, roles: ['Manajer'] },
    { key: 'leadOps', name: 'Maya Putri', email: 'lead.ops@digital-office.local', position: 'Team Lead Operasional', dept: ops.id, roles: ['Team Lead'] },
    { key: 'adminOps', name: 'Fajar Nugroho', email: 'admin.ops@digital-office.local', position: 'Admin Operasional', dept: ops.id, roles: [ROLE_NAMES.DEPT_ADMIN] },
    { key: 'staffOps', name: 'Lina Marlina', email: 'staff.ops@digital-office.local', position: 'Koordinator Acara', dept: ops2.id, roles: [ROLE_NAMES.STAFF] },
    { key: 'mgrIt', name: 'Yoga Firmansyah', email: 'manajer.it@digital-office.local', position: 'Manajer TI', dept: its.id, roles: ['Manajer'] },
    { key: 'staffIt', name: 'Nadia Kusuma', email: 'staff.it@digital-office.local', position: 'Software Engineer', dept: its.id, roles: [ROLE_NAMES.STAFF] },
    { key: 'auditor', name: 'Wulan Sari', email: 'auditor@digital-office.local', position: 'Internal Auditor', dept: dir.id, roles: [ROLE_NAMES.AUDITOR] },
  ];
  const U: Record<string, bigint> = {};
  for (const d of userDefs) {
    const u = await prisma.user.create({
      data: { fullName: d.name, email: d.email, passwordHash: hash, position: d.position, departmentId: d.dept, isSuperAdmin: !!d.superAdmin, phone: '+62 812-0000-' + String(1000 + Object.keys(U).length) },
    });
    U[d.key] = u.id;
    await prisma.userRole.createMany({ data: d.roles.map((r) => ({ userId: u.id, roleId: roles[r], grantedBy: null })) });
  }
  await prisma.department.update({ where: { id: dir.id }, data: { headUserId: U.direktur } });
  await prisma.department.update({ where: { id: keu.id }, data: { headUserId: U.mgrKeu } });
  await prisma.department.update({ where: { id: ops.id }, data: { headUserId: U.mgrOps } });
  await prisma.department.update({ where: { id: its.id }, data: { headUserId: U.mgrIt } });
  await prisma.department.update({ where: { id: ops2.id }, data: { headUserId: U.leadOps } });

  // ─── Template notifikasi ───
  for (const [eventType, t] of Object.entries(DEFAULT_TEMPLATES)) {
    await prisma.notificationTemplate.create({ data: { eventType, name: t.name, subject: t.subject, body: t.body, minPriority: t.minPriority ?? 'low' } });
  }

  // ─── Tipe request ───
  console.log('› Tipe request & alur approval');
  const tTask = await prisma.requestType.create({ data: { name: 'Tugas', code: 'TGS', category: 'tugas', description: 'Penugasan pekerjaan antar-pegawai', customFieldsJson: [] } });
  const tBuy = await prisma.requestType.create({
    data: {
      name: 'Pengajuan Pembelian', code: 'PBL', category: 'pengajuan', description: 'Pengadaan barang/jasa',
      customFieldsJson: [
        { key: 'vendor', label: 'Vendor', type: 'text', required: true },
        { key: 'nilai', label: 'Nilai pengadaan (Rp)', type: 'currency', required: true },
        { key: 'kategori', label: 'Kategori', type: 'select', options: ['Perangkat TI', 'ATK', 'Jasa', 'Lainnya'], required: true },
      ],
    },
  });
  const tDoc = await prisma.requestType.create({
    data: {
      name: 'Persetujuan Dokumen / Rundown', code: 'DOK', category: 'pengajuan', description: 'Persetujuan dokumen resmi, rundown acara',
      customFieldsJson: [
        { key: 'jenis', label: 'Jenis dokumen', type: 'select', options: ['Rundown Acara', 'Surat Keluar', 'Kebijakan', 'Kontrak'], required: true },
        { key: 'tanggal_acara', label: 'Tanggal pelaksanaan', type: 'date' },
      ],
    },
  });
  const tFup = await prisma.requestType.create({ data: { name: 'Follow-up', code: 'FUP', category: 'follow-up', description: 'Tindak lanjut hasil rapat/temuan', customFieldsJson: [{ key: 'sumber', label: 'Sumber tindak lanjut', type: 'text' }] } });

  // ─── Alur approval (3+ flow — PRD 18.1) ───
  const flow = async (data: Prisma.ApprovalFlowUncheckedCreateInput, levels: Omit<Prisma.ApprovalLevelUncheckedCreateInput, 'flowId' | 'levelOrder'>[]) => {
    const f = await prisma.approvalFlow.create({ data: { ...data, status: data.status ?? 'active', createdBy: U.admin } });
    await prisma.approvalLevel.createMany({ data: levels.map((l, i) => ({ ...l, flowId: f.id, levelOrder: i + 1 })) });
    return prisma.approvalFlow.findUniqueOrThrow({ where: { id: f.id }, include: { levels: true } });
  };
  const L1 = { name: 'L1 · Team Lead', approverType: 'role' as const, approverRoleId: roles['Team Lead'], sameDeptOnly: true, slaHours: 24 };
  const L2 = { name: 'L2 · Manajer', approverType: 'role' as const, approverRoleId: roles['Manajer'], sameDeptOnly: true, slaHours: 48 };
  const L3 = { name: 'L3 · Direktur', approverType: 'role' as const, approverRoleId: roles['Direktur'], sameDeptOnly: true, slaHours: 72 };

  const fBuyStd = await flow({ name: 'Pembelian — Standar', code: 'PBL-STD', triggerTypeId: tBuy.id, description: 'Pengajuan pembelian prioritas rendah/sedang' }, [L1, L2]);
  const fBuyHigh = await flow({ name: 'Pembelian — Prioritas Tinggi', code: 'PBL-HIGH', triggerTypeId: tBuy.id, thresholdRuleJson: { min_priority: 'high' }, description: 'Prioritas High/Critical wajib sampai Direktur' }, [L1, L2, L3]);
  const fBuyBig = await flow({ name: 'Pembelian — Nilai ≥ Rp50 jt', code: 'PBL-BIG', triggerTypeId: tBuy.id, thresholdRuleJson: { threshold_value: 50_000_000 }, description: 'Nilai pengadaan besar' }, [L1, L2, L3]);
  const fDoc = await flow({ name: 'Persetujuan Dokumen & Rundown', code: 'DOK-STD', triggerTypeId: tDoc.id, description: 'Kepala unit, lalu Direktur bila kritis' }, [
    { name: 'Kepala Unit', approverType: 'dept_head', sameDeptOnly: true, slaHours: 24 },
    { name: 'Direktur (kritis)', approverType: 'role', approverRoleId: roles['Direktur'], sameDeptOnly: true, slaHours: 48, conditionJson: { min_priority: 'crit' } },
  ]);
  // Naskah dinas: dikirim dari menu Naskah dinas → request tipe NSK. Level awal = QR paraf, level terakhir = QR tanda tangan.
  const tNsk = await prisma.requestType.create({ data: { name: 'Naskah Dinas', code: 'NSK', category: 'naskah', description: 'Persetujuan, paraf & tanda tangan QR naskah dinas — dibuat dari menu Naskah dinas', customFieldsJson: [] } });
  await flow({ name: 'Naskah Dinas', code: 'NASKAH-DINAS', triggerTypeId: tNsk.id, description: 'Paraf Team Lead, lalu tanda tangan Manajer unit pembuat' }, [
    { ...L1, name: 'Paraf · Team Lead' },
    { ...L2, name: 'Tanda tangan · Manajer' },
  ]);
  await flow({ name: 'Follow-up Operasional', code: 'FUP-OPS', triggerTypeId: tFup.id, departmentId: ops.id, description: 'Replika khusus unit Operasional' }, [{ ...L1, name: 'Team Lead OPS' }]);
  await flow({ name: 'Follow-up Keuangan (draf)', code: 'FUP-KEU', triggerTypeId: tFup.id, departmentId: keu.id, status: 'draft' }, [{ ...L2, name: 'Manajer KEU' }]);

  // ─── Folder & tag ───
  console.log(`› Folder, tag & ${DOC_COUNT} dokumen uji`);
  const folder = (name: string, departmentId: bigint | null, parentFolderId: bigint | null = null, isSystem = false) =>
    prisma.folder.create({ data: { name, departmentId, parentFolderId, isSystem, createdBy: U.admin } });
  const fAttach = await folder('Lampiran Request', null, null, true);
  const fUmum = await folder('Umum', null);
  const fSop = await folder('Kebijakan & SOP', null, fUmum.id);
  const fTpl = await folder('Template', null, fUmum.id);
  const fKeu = await folder('Keuangan', keu.id);
  const fKeuLap = await folder('Laporan Bulanan', keu.id, fKeu.id);
  const fKeuInv = await folder('Invoice & Faktur', keu.id, fKeu.id);
  const fOps = await folder('Operasional', ops.id);
  const fOpsRun = await folder('Rundown Acara', ops.id, fOps.id);
  const fOpsKon = await folder('Kontrak Vendor', ops.id, fOps.id);
  const fIt = await folder('Teknologi Informasi', its.id);
  const fItArs = await folder('Arsitektur Sistem', its.id, fIt.id);
  const fDir = await folder('Direksi', dir.id);

  const tagDefs: [string, string][] = [
    ['Rahasia', '#C53030'], ['Final', '#1D8A5A'], ['Draft', '#B7791F'], ['Kontrak', '#9D521F'], ['Laporan', '#075F78'],
    ['SOP', '#2F6EA3'], ['Keuangan', '#5C3203'], ['2026', '#6F8790'], ['Event', '#7A55B0'], ['Audit', '#024558'],
  ];
  const tags: Record<string, bigint> = {};
  for (const [name, color] of tagDefs) tags[name] = (await prisma.fileTag.create({ data: { name, color } })).id;

  const docPlan: { folder: bigint; owner: string; names: string[]; tags: string[]; category: string }[] = [
    { folder: fSop.id, owner: 'admin', names: ['SOP Pengadaan Barang', 'Kebijakan Keamanan Informasi', 'SOP Arsip Dokumen', 'Pedoman Etika Kerja', 'Kebijakan Kerja Hybrid'], tags: ['SOP', 'Final'], category: 'Kebijakan' },
    { folder: fTpl.id, owner: 'admin', names: ['Template Surat Keluar', 'Template Notulen Rapat', 'Template Berita Acara', 'Template Memo Internal'], tags: ['Final'], category: 'Template' },
    { folder: fKeuLap.id, owner: 'staffKeu', names: ['Laporan Keuangan', 'Rekap Kas Kecil', 'Laporan Arus Kas', 'Rekonsiliasi Bank'], tags: ['Laporan', 'Keuangan', '2026'], category: 'Laporan' },
    { folder: fKeuInv.id, owner: 'staffKeu2', names: ['Invoice Vendor', 'Faktur Pajak', 'Bukti Potong PPh'], tags: ['Keuangan', 'Rahasia'], category: 'Invoice' },
    { folder: fOpsRun.id, owner: 'staffOps', names: ['Rundown Rapat Kerja', 'Rundown Gathering Karyawan', 'Rundown Peluncuran Produk', 'Rundown Town Hall'], tags: ['Event', 'Draft'], category: 'Rundown' },
    { folder: fOpsKon.id, owner: 'adminOps', names: ['Kontrak Catering', 'Kontrak Sewa Venue', 'Kontrak Logistik', 'Perjanjian Kerahasiaan Vendor'], tags: ['Kontrak', 'Rahasia'], category: 'Kontrak' },
    { folder: fItArs.id, owner: 'staffIt', names: ['Diagram Arsitektur', 'Rencana Backup & DR', 'Hasil Pen-test', 'Inventaris Server'], tags: ['Final', '2026'], category: 'Teknis' },
    { folder: fDir.id, owner: 'direktur', names: ['Notulen Rapat Direksi', 'Rencana Strategis', 'Laporan Audit Internal'], tags: ['Rahasia', 'Audit'], category: 'Direksi' },
  ];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt'];
  const viewers = Object.keys(U);
  let made = 0;
  const createdDocs: { id: bigint; owner: bigint }[] = [];
  while (made < DOC_COUNT) {
    const plan = pick(docPlan, made);
    const base = pick(plan.names, Math.floor(made / docPlan.length));
    const title = `${base} ${pick(months, made)} 2026${made >= docPlan.length * 10 ? ` #${made}` : ''}`;
    const docUid = randomUUID();
    const versions = made % 9 === 0 ? 3 : made % 4 === 0 ? 2 : 1;
    const created = daysAgo(120 - (made % 115), made % 24);
    let lastId: bigint = 0n;
    for (let v = 1; v <= versions; v++) {
      const buf = makePdf(title, [`Versi ${v}`, `Kategori: ${plan.category}`, `Dibuat oleh seed data uji Digital Office.`, `Dokumen ke-${made + 1} dari ${DOC_COUNT}.`]);
      const name = `${title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_')}.pdf`;
      const key = `docs/seed/${docUid}/v${v}-${name}`;
      saveFile(key, buf);
      const f = await prisma.file.create({
        data: {
          docUid, folderId: plan.folder, userId: U[plan.owner], originalName: name, title, category: plan.category,
          description: `${base} periode ${pick(months, made)} 2026. ${v > 1 ? 'Revisi ' + (v - 1) + '.' : ''}`.trim(),
          mimeType: 'application/pdf', sizeBytes: BigInt(buf.length), storagePath: key,
          checksumSha256: createHash('sha256').update(buf).digest('hex'), version: v, isActive: v === versions,
          createdAt: new Date(created.getTime() + (v - 1) * 2 * 86400_000), metadataJson: { periode: `${pick(months, made)} 2026`, nomor: `DOC/${2026}/${String(made + 1).padStart(4, '0')}` },
        },
      });
      lastId = f.id;
      await prisma.fileAccessLog.create({ data: { fileId: f.id, userId: U[plan.owner], action: 'uploaded', createdAt: f.createdAt, ipAddress: '10.0.0.' + (made % 200) } });
    }
    await prisma.fileTagging.createMany({ data: plan.tags.map((t) => ({ fileId: lastId, tagId: tags[t] })) });
    if (made % 3 === 0) {
      await prisma.fileAccessLog.createMany({
        data: [0, 1, 2].map((k) => ({ fileId: lastId, userId: U[pick(viewers, made + k)], action: k === 2 ? 'downloaded' : 'viewed', createdAt: daysAgo(made % 30, k), ipAddress: '10.0.1.' + k })) as any,
      });
    }
    createdDocs.push({ id: lastId, owner: U[plan.owner] });
    made++;
  }
  // share contoh: dokumen keuangan dibagikan read ke Operasional & ke auditor
  await prisma.fileShare.create({ data: { fileId: createdDocs[2].id, shareToDeptId: ops.id, accessLevel: 'read', sharedBy: U.staffKeu } });
  await prisma.fileShare.create({ data: { fileId: createdDocs[5].id, shareToUserId: U.staffKeu, accessLevel: 'write', sharedBy: U.adminOps } });
  await prisma.fileShare.create({ data: { fileId: createdDocs[4].id, shareToUserId: U.staffIt, accessLevel: 'read', sharedBy: U.staffOps, expiresAt: daysAhead(14) } });

  // ─── Request contoh (berbagai status) ───
  console.log('› Request contoh & riwayat approval');
  const plan = (levels: ApprovalLevel[], priority: Priority, amount?: number) =>
    levels
      .filter((l) => {
        const c = l.conditionJson as { min_priority?: Priority; threshold_value?: number } | null;
        if (!c) return true;
        if (c.min_priority && PRIORITY_RANK[priority] < PRIORITY_RANK[c.min_priority]) return false;
        if (c.threshold_value != null && (amount ?? 0) < c.threshold_value) return false;
        return true;
      })
      .sort((a, b) => a.levelOrder - b.levelOrder)
      .map((l) => ({
        levelOrder: l.levelOrder, name: l.name, approverType: l.approverType, approverRoleId: l.approverRoleId?.toString() ?? null,
        approverUserId: l.approverUserId?.toString() ?? null, sameDeptOnly: l.sameDeptOnly, delegateOn: l.delegateOn, slaHours: l.slaHours,
      }));

  let seq = 0;
  const mkReq = async (o: {
    type: { id: bigint; code: string }; title: string; desc: string; requester: string; dept: bigint; priority: Priority; status: RequestStatus;
    ageDays: number; due?: number | null; amount?: number; custom?: Record<string, unknown>; assignee?: string;
    flow?: { id: bigint; levels: ApprovalLevel[] }; approvers?: string[]; reject?: { by: string; reason: string }; attach?: number[];
    delegateAt?: { by: string; to: string };
  }) => {
    seq++;
    const created = daysAgo(o.ageDays, 3);
    const ym = `${created.getFullYear()}${String(created.getMonth() + 1).padStart(2, '0')}`;
    const r = await prisma.request.create({
      data: {
        refCode: `${o.type.code}-${ym}-${String(seq).padStart(4, '0')}`, title: o.title, description: o.desc, typeId: o.type.id,
        requesterUserId: U[o.requester], assigneeUserId: o.assignee ? U[o.assignee] : null, departmentId: o.dept, priority: o.priority,
        amount: o.amount != null ? new Prisma.Decimal(o.amount) : null, customValuesJson: (o.custom ?? {}) as Prisma.InputJsonValue,
        dueDate: o.due === undefined ? daysAhead(5) : o.due === null ? null : daysAhead(o.due), status: o.status,
        submittedAt: o.status === 'draft' ? null : created, closedAt: o.status === 'closed' ? daysAgo(Math.max(0, o.ageDays - 3)) : null,
        createdAt: created,
      },
    });
    let t = created.getTime();
    const log = (action: string, actor: string, from: string | null, to: string | null, comment?: string) =>
      prisma.requestLog.create({ data: { requestId: r.id, actorUserId: U[actor], action, fromStatus: from, toStatus: to, comment, createdAt: new Date((t += 3600_000)) } });
    await log('created', o.requester, null, 'draft');
    for (const fid of o.attach ?? []) await prisma.requestAttachment.create({ data: { requestId: r.id, fileId: createdDocs[fid].id, caption: 'Dokumen pendukung' } });
    if (o.status === 'draft') return r;
    await log('submitted', o.requester, 'draft', 'submitted');

    if (o.flow) {
      const p = plan(o.flow.levels, o.priority, o.amount);
      const approvers = o.approvers ?? [];
      const decidedCount = o.reject ? approvers.length + 1 : approvers.length;
      const finished = o.status === 'approved' || o.status === 'closed' || !!o.reject;
      const inst = await prisma.approvalInstance.create({
        data: {
          requestId: r.id, flowId: o.flow.id, planJson: p as unknown as Prisma.InputJsonValue,
          currentLevel: p[Math.min(decidedCount, p.length - 1)].levelOrder,
          status: o.reject ? 'rejected' : finished ? 'approved' : 'in_progress',
          startedAt: new Date(t), levelStartedAt: new Date(t + approvers.length * 5 * 3600_000), finishedAt: finished ? new Date(t + decidedCount * 5 * 3600_000) : null,
          currentDelegateUserId: o.delegateAt ? U[o.delegateAt.to] : null,
        },
      });
      await log('approval_started', o.requester, 'submitted', 'pending-approval', `Masuk alur — ${p.length} level: ${p.map((x) => x.name).join(' → ')}`);
      for (let i = 0; i < approvers.length; i++) {
        t += 5 * 3600_000;
        await prisma.approvalDecision.create({ data: { instanceId: inst.id, levelOrder: p[i].levelOrder, approverUserId: U[approvers[i]], decision: 'approve', comment: i === 0 ? 'Sesuai kebutuhan, lanjut.' : 'Disetujui.', decidedAt: new Date(t) } });
        const last = i === p.length - 1;
        await log(last ? 'approved' : 'approved_level', approvers[i], 'pending-approval', last ? 'approved' : 'pending-approval', `${p[i].name} disetujui`);
      }
      if (o.reject) {
        t += 5 * 3600_000;
        await prisma.approvalDecision.create({ data: { instanceId: inst.id, levelOrder: p[approvers.length].levelOrder, approverUserId: U[o.reject.by], decision: 'reject', comment: o.reject.reason, decidedAt: new Date(t) } });
        await log('rejected', o.reject.by, 'pending-approval', 'rejected', `${p[approvers.length].name} ditolak: ${o.reject.reason}`);
      }
      if (o.delegateAt) {
        await prisma.approvalDecision.create({ data: { instanceId: inst.id, levelOrder: p[approvers.length].levelOrder, approverUserId: U[o.delegateAt.by], decision: 'delegate', delegatedToUserId: U[o.delegateAt.to], comment: 'Sedang dinas luar kota', decidedAt: new Date((t += 3600_000)) } });
        await log('delegated', o.delegateAt.by, 'pending-approval', 'pending-approval', `${p[approvers.length].name} didelegasikan`);
      }
    } else if (o.status === 'in_progress' || o.status === 'closed') {
      await log('status_changed', o.assignee ?? o.requester, 'submitted', 'in-progress');
    }
    if (o.status === 'closed') await log('closed', o.requester, 'approved', 'closed', 'Selesai dikerjakan');
    return r;
  };

  await mkReq({ type: tBuy, title: 'Pembelian 10 unit laptop untuk tim akuntansi', desc: 'Penggantian laptop yang sudah berusia >5 tahun.', requester: 'staffKeu', dept: keu.id, priority: 'high', status: 'pending_approval', ageDays: 2, due: 1, amount: 185_000_000, custom: { vendor: 'PT Sinar Komputindo', nilai: 185_000_000, kategori: 'Perangkat TI' }, flow: fBuyBig, approvers: ['leadKeu'], attach: [2, 3] });
  await mkReq({ type: tBuy, title: 'Pengadaan ATK kuartal IV', desc: 'Kertas, toner, dan alat tulis untuk Q4.', requester: 'staffKeu2', dept: keu.id, priority: 'med', status: 'pending_approval', ageDays: 1, due: 6, amount: 7_500_000, custom: { vendor: 'CV Berkah ATK', nilai: 7_500_000, kategori: 'ATK' }, flow: fBuyStd, approvers: [] });
  await mkReq({ type: tBuy, title: 'Langganan lisensi software audit', desc: 'Perpanjangan lisensi tahunan.', requester: 'staffKeu', dept: keu.id, priority: 'crit', status: 'pending_approval', ageDays: 4, due: -1, amount: 42_000_000, custom: { vendor: 'PT Audit Digital', nilai: 42_000_000, kategori: 'Jasa' }, flow: fBuyHigh, approvers: ['leadKeu', 'mgrKeu'] });
  await mkReq({ type: tBuy, title: 'Sewa sound system gathering', desc: 'Untuk acara gathering karyawan akhir tahun.', requester: 'staffOps', dept: ops2.id, priority: 'med', status: 'approved', ageDays: 12, due: 10, amount: 12_000_000, custom: { vendor: 'Gema Audio', nilai: 12_000_000, kategori: 'Jasa' }, flow: fBuyStd, approvers: ['leadOps', 'mgrOps'], assignee: 'adminOps' });
  await mkReq({ type: tBuy, title: 'Server cadangan untuk DR site', desc: 'Kebutuhan NFR-10 backup offsite.', requester: 'staffIt', dept: its.id, priority: 'high', status: 'rejected', ageDays: 9, amount: 320_000_000, custom: { vendor: 'PT Data Prima', nilai: 320_000_000, kategori: 'Perangkat TI' }, flow: fBuyBig, approvers: [], reject: { by: 'mgrIt', reason: 'Spesifikasi belum dibandingkan minimal 3 vendor. Mohon lengkapi perbandingan harga.' } });
  await mkReq({ type: tDoc, title: 'Persetujuan rundown Town Hall November', desc: 'Rundown acara town hall bulanan.', requester: 'staffOps', dept: ops2.id, priority: 'crit', status: 'pending_approval', ageDays: 1, due: 3, custom: { jenis: 'Rundown Acara', tanggal_acara: daysAhead(12).toISOString().slice(0, 10) }, flow: fDoc, approvers: ['leadOps'], attach: [4] });
  await mkReq({ type: tDoc, title: 'Surat edaran jam kerja libur nasional', desc: 'Draft surat edaran untuk seluruh karyawan.', requester: 'adminOps', dept: ops.id, priority: 'med', status: 'pending_approval', ageDays: 2, due: 2, custom: { jenis: 'Surat Keluar' }, flow: fDoc, approvers: [], delegateAt: { by: 'mgrOps', to: 'leadOps' } });
  await mkReq({ type: tDoc, title: 'Kebijakan retensi arsip digital', desc: 'Kebijakan baru retensi dokumen 10 tahun.', requester: 'staffIt', dept: its.id, priority: 'high', status: 'closed', ageDays: 25, custom: { jenis: 'Kebijakan' }, flow: fDoc, approvers: ['mgrIt'], attach: [1] });
  await mkReq({ type: tTask, title: 'Rekap realisasi anggaran Q3', desc: 'Siapkan rekap untuk rapat direksi.', requester: 'mgrKeu', dept: keu.id, priority: 'high', status: 'in_progress', ageDays: 3, due: 2, assignee: 'staffKeu' });
  await mkReq({ type: tTask, title: 'Migrasi folder arsip ke Digital Office', desc: 'Pindahkan arsip lama unit TI.', requester: 'mgrIt', dept: its.id, priority: 'med', status: 'submitted', ageDays: 1, due: 14, assignee: 'staffIt' });
  await mkReq({ type: tFup, title: 'Tindak lanjut temuan audit stok gudang', desc: 'Temuan audit internal Q3 poin 4.', requester: 'staffOps', dept: ops2.id, priority: 'high', status: 'pending_approval', ageDays: 1, due: 4, custom: { sumber: 'Laporan Audit Internal Q3' }, flow: await prisma.approvalFlow.findUniqueOrThrow({ where: { code: 'FUP-OPS' }, include: { levels: true } }), approvers: [] });
  await mkReq({ type: tTask, title: 'Draft notulen rapat koordinasi', desc: 'Belum dikirim.', requester: 'staffKeu', dept: keu.id, priority: 'low', status: 'draft', ageDays: 0, due: null });
  for (let i = 0; i < 24; i++) {
    const st: RequestStatus[] = ['closed', 'approved', 'closed', 'in_progress', 'submitted', 'closed'];
    await mkReq({ type: tTask, title: `Tugas rutin minggu ke-${i + 1}`, desc: 'Data historis untuk statistik dashboard.', requester: pick(['mgrKeu', 'mgrOps', 'mgrIt'], i), dept: pick([keu.id, ops.id, its.id], i), priority: pick<Priority>(['low', 'med', 'high', 'med'], i), status: pick(st, i), ageDays: 10 + i * 6, due: -(i * 5), assignee: pick(['staffKeu', 'staffOps', 'staffIt'], i) });
  }

  // ─── Template naskah dinas & draft contoh ───
  console.log('› Template naskah dinas');
  const tplDefs = [
    {
      code: 'SRT', name: 'Surat Keluar', category: 'Surat', description: 'Surat resmi ke pihak luar/internal dengan kepala surat',
      bodyHtml: '<p>Dengan hormat,</p><p style="text-align:justify">Sehubungan dengan [jelaskan latar belakang], bersama ini kami sampaikan bahwa [isi pokok surat].</p><p style="text-align:justify">Demikian surat ini kami sampaikan. Atas perhatian dan kerja sama Bapak/Ibu, kami ucapkan terima kasih.</p>',
    },
    {
      code: 'UND', name: 'Undangan Rapat', category: 'Surat', description: 'Undangan rapat/kegiatan',
      bodyHtml: '<p>Dengan hormat,</p><p style="text-align:justify">Mengharap kehadiran Bapak/Ibu pada kegiatan yang akan diselenggarakan pada:</p><ul><li><strong>Hari/tanggal:</strong> [hari], [tanggal]</li><li><strong>Waktu:</strong> 09.00 WIB – selesai</li><li><strong>Tempat:</strong> Ruang Rapat Lt. 3</li><li><strong>Acara:</strong> {{perihal}}</li></ul><p style="text-align:justify">Mengingat pentingnya acara tersebut, kami mohon Bapak/Ibu hadir tepat waktu. Atas perhatiannya kami ucapkan terima kasih.</p>',
    },
    {
      code: 'MEMO', name: 'Memo Internal', category: 'Memo', description: 'Nota dinas antar-unit tanpa kepala surat',
      bodyHtml: '<p><strong>Dari:</strong> {{pembuat}}, {{jabatan_pembuat}} — {{unit}}</p><p style="text-align:justify">Menindaklanjuti [rujukan], dengan ini disampaikan hal-hal sebagai berikut:</p><ol><li>[poin pertama]</li><li>[poin kedua]</li></ol><p>Demikian disampaikan untuk dapat dilaksanakan.</p>',
    },
    {
      code: 'BA', name: 'Berita Acara', category: 'Berita Acara', description: 'Berita acara serah terima / pemeriksaan',
      bodyHtml: '<p style="text-align:justify">Pada hari ini, {{tanggal}}, bertempat di {{tempat}}, kami yang bertanda tangan di bawah ini telah melaksanakan [kegiatan] dengan hasil sebagai berikut:</p><ol><li>[hasil pertama]</li><li>[hasil kedua]</li></ol><p style="text-align:justify">Demikian berita acara ini dibuat dengan sebenarnya untuk dipergunakan sebagaimana mestinya.</p>',
    },
    {
      code: 'ST', name: 'Surat Tugas', category: 'Surat Tugas', description: 'Penugasan pegawai',
      bodyHtml: '<p style="text-align:justify">Yang bertanda tangan di bawah ini menugaskan kepada:</p><ul><li><strong>Nama:</strong> [nama pegawai]</li><li><strong>Jabatan:</strong> [jabatan]</li></ul><p style="text-align:justify">Untuk melaksanakan [uraian tugas] pada [tanggal pelaksanaan] di [lokasi].</p><p style="text-align:justify">Demikian surat tugas ini dibuat untuk dilaksanakan dengan penuh tanggung jawab.</p>',
    },
  ];
  const tpl: Record<string, bigint> = {};
  for (const t of tplDefs) tpl[t.code] = (await prisma.docTemplate.create({ data: { ...t, numberFormat: '{seq}/{code}/{dept}/{month_roman}/{year}' } })).id;

  const draft1 = await prisma.eDocument.create({
    data: {
      title: 'Undangan Rapat Koordinasi Anggaran 2027', subject: 'Rapat Koordinasi Anggaran 2027', recipient: 'Seluruh Kepala Unit\nDi tempat',
      attachmentNote: '1 berkas', place: 'Jakarta', templateId: tpl.UND, departmentId: keu.id, creatorUserId: U.staffKeu,
      bodyHtml: tplDefs[1].bodyHtml.replace('[hari], [tanggal]', 'Senin, 2 November 2026'),
    },
  });
  await prisma.eDocumentLog.create({ data: { documentId: draft1.id, actorUserId: U.staffKeu, action: 'created' } });
  const draft2 = await prisma.eDocument.create({
    data: {
      title: 'Berita Acara Serah Terima Laptop', subject: 'Serah terima 10 unit laptop', place: 'Jakarta', templateId: tpl.BA,
      departmentId: keu.id, creatorUserId: U.staffKeu, bodyHtml: tplDefs[3].bodyHtml.replace('[kegiatan]', 'serah terima 10 unit laptop dari PT Sinar Komputindo'),
    },
  });
  await prisma.eDocumentLog.create({ data: { documentId: draft2.id, actorUserId: U.staffKeu, action: 'created' } });

  // delegasi aktif contoh
  await prisma.delegation.create({ data: { delegatorUserId: U.mgrKeu, delegateUserId: U.leadKeu, fromDate: daysAgo(1), toDate: daysAhead(5), reason: 'Cuti tahunan', createdBy: U.mgrKeu } });

  await prisma.auditLog.create({ data: { actorUserId: U.admin, module: 'system', action: 'seed_completed', payloadJson: { docs: DOC_COUNT } } });
  console.log('\n✓ Seed selesai. Login dengan salah satu akun berikut (kata sandi: Password123!):');
  for (const d of userDefs) console.log(`  ${d.email.padEnd(36)} ${d.roles.join(', ')}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
