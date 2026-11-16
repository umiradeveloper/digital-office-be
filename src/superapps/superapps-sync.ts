/**
 * Logika sinkronisasi user & role SuperApps → Digital Office.
 * Dipakai bersama oleh: skrip CLI (prisma/import-superapps.ts) dan SuperappsService (koneksi DB langsung).
 */
import type { PrismaClient } from '@prisma/client';
import { APPROVER_LIKE_ROLES, DEFAULT_ROLE_MATRIX, PERMISSIONS, ROLE_NAMES } from '../common/permissions';

export const SOURCE = 'superapps';

export type SaRow = Record<string, string | number | null>;
export type Tier = 'it' | 'direksi' | 'manajer' | 'lead' | 'staff' | 'vendor' | 'kandidat';
export interface SaRole { id: string; name: string; kode: string | null }
export interface Plan {
  externalId: string; fullName: string; email: string; username: string | null; phone: string | null;
  passwordHash: string; roleName: string; tier: Tier; dept: string; active: boolean;
}
export interface SyncOptions {
  includeVendor?: boolean;
  /** Isi kepala unit yang masih kosong (hanya untuk sinkron penuh). */
  setDeptHeads?: boolean;
  /** Nonaktifkan user SuperApps lokal yang tidak ada lagi di sumber (hanya untuk sinkron penuh). */
  disableMissing?: boolean;
  log?: (msg: string) => void;
}
export interface SyncStats { created: number; updated: number; disabled: number; active: number; total: number; warnings: string[] }

// ───────────────────────── Parser dump SQL ─────────────────────────
/** Ambil semua baris INSERT INTO `table` (mendukung multi-tuple & escape MySQL). */
export function parseInserts(sql: string, table: string): SaRow[] {
  const rows: SaRow[] = [];
  const head = new RegExp('INSERT INTO `' + table + '`\\s*\\(([^)]*)\\)\\s*VALUES\\s*', 'g');
  let m: RegExpExecArray | null;
  while ((m = head.exec(sql))) {
    const cols = m[1].split(',').map((c) => c.trim().replace(/`/g, ''));
    let i = head.lastIndex;
    while (i < sql.length) {
      while (/\s|,/.test(sql[i])) i++;
      if (sql[i] === ';') break;
      if (sql[i] !== '(') throw new Error(`Format INSERT tidak dikenal di posisi ${i}`);
      i++;
      const vals: (string | null)[] = [];
      while (true) {
        while (/\s/.test(sql[i])) i++;
        if (sql[i] === "'") {
          let s = '';
          i++;
          while (true) {
            const c = sql[i];
            if (c === '\\') {
              const n = sql[i + 1];
              s += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === '0' ? '\0' : n;
              i += 2;
            } else if (c === "'" && sql[i + 1] === "'") { s += "'"; i += 2; }
            else if (c === "'") { i++; break; }
            else { s += c; i++; }
            if (i >= sql.length) throw new Error('String SQL tidak tertutup');
          }
          vals.push(s);
        } else {
          let j = i;
          while (sql[j] !== ',' && sql[j] !== ')') j++;
          const tok = sql.slice(i, j).trim();
          vals.push(tok.toUpperCase() === 'NULL' ? null : tok);
          i = j;
        }
        while (sql[i] === ' ') i++;
        if (sql[i] === ',') { i++; continue; }
        if (sql[i] === ')') { i++; break; }
        throw new Error(`Tuple tidak valid di posisi ${i}`);
      }
      rows.push(Object.fromEntries(cols.map((c, k) => [c, vals[k] ?? null])));
    }
    head.lastIndex = i;
  }
  return rows;
}

// ───────────────────────── Pemetaan role & unit ─────────────────────────
export function tierOf(roleName: string): Tier {
  const n = roleName.trim().toLowerCase();
  if (['admin', 'chief it', 'it engineer'].includes(n)) return 'it';
  if (['ceo', 'cfo', 'coo', 'cto', 'cmo'].includes(n)) return 'direksi';
  if (n.startsWith('gm ') || n === 'general manager' || n.startsWith('chief ')) return 'manajer';
  if (n.startsWith('manager') || n === 'project manager' || n.startsWith('kordinator')) return 'lead';
  if (n === 'vendor') return 'vendor';
  if (n === 'kandidat') return 'kandidat';
  return 'staff';
}

/** Role dasar Digital Office yang membawa permission. */
export const BASE_ROLES: Record<Tier, string[]> = {
  it: [ROLE_NAMES.SUPER_ADMIN],
  direksi: ['Direktur'],
  manajer: ['Manajer', ROLE_NAMES.DEPT_ADMIN],
  lead: ['Team Lead'],
  staff: [ROLE_NAMES.STAFF],
  vendor: [ROLE_NAMES.STAFF],
  kandidat: [ROLE_NAMES.STAFF],
};

const DEPTS: { code: string; name: string; match: (n: string) => boolean }[] = [
  { code: 'DIR', name: 'Direksi', match: (n) => ['ceo', 'cfo', 'coo', 'cto', 'cmo'].includes(n) },
  { code: 'ITS', name: 'Teknologi Informasi', match: (n) => ['admin', 'chief it', 'it engineer'].includes(n) },
  { code: 'FAT', name: 'Finance, Accounting & Tax', match: (n) => /fat|finance|cost control|checklist pembayaran/.test(n) },
  { code: 'PROC', name: 'Procurement & SCM', match: (n) => /procurement|scm/.test(n) },
  { code: 'ENG', name: 'Engineering & Konstruksi', match: (n) => /engineering|construction|project manager|quality surveyor|research/.test(n) },
  { code: 'BD', name: 'Business Development', match: (n) => /busdev|sam/.test(n) },
  { code: 'HRGA', name: 'HR & GA', match: (n) => /hr & ga|management trainee|kandidat/.test(n) },
  { code: 'AST', name: 'Asset & Gudang', match: (n) => /asset|gudang/.test(n) },
  { code: 'QHSE', name: 'QHSE', match: (n) => /qhse/.test(n) },
  { code: 'VND', name: 'Vendor & Mitra', match: (n) => n === 'vendor' },
  { code: 'UMUM', name: 'Umum', match: () => false },
];
const deptOf = (roleName: string) => DEPTS.find((d) => d.match(roleName.trim().toLowerCase()))?.code ?? 'UMUM';

const HEAD_RANK: Record<Tier, number> = { direksi: 5, manajer: 4, lead: 3, it: 2, staff: 1, vendor: 0, kandidat: 0 };

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const clean = (v: string | number | null | undefined) => str(v).replace(/\s+/g, ' ').trim();
export const normalizeHash = (h: string) => h.replace(/^\$2y\$/, () => '$2b$'); // PHP bcrypt → kompatibel bcryptjs

export function toRoles(rows: SaRow[]): SaRole[] {
  return rows.map((r) => ({ id: str(r.id_role), name: clean(r.nama_role), kode: r.kode_role === null ? null : str(r.kode_role) }));
}

// ───────────────────────── Rencana (tanpa menulis DB) ─────────────────────────
export function buildPlans(roles: SaRole[], users: SaRow[], opt: SyncOptions = {}) {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const plans: Plan[] = [];
  const warnings: string[] = [];
  for (const u of users) {
    const role = u.id_role ? roleById.get(str(u.id_role)) : undefined;
    const roleName = role?.name || ROLE_NAMES.STAFF;
    const tier = role ? tierOf(roleName) : 'staff';
    const email = clean(u.email).toLowerCase();
    const hash = str(u.password);
    if (!email) { warnings.push(`Lewati ${str(u.id_user)}: email kosong`); continue; }
    if (!/^\$2[aby]\$\d\d\$/.test(hash)) { warnings.push(`Lewati ${email}: format password bukan bcrypt`); continue; }
    let active = str(u.isApproval) === '1' && !!role;
    if (tier === 'kandidat') active = false;
    if (tier === 'vendor' && !opt.includeVendor) active = false;
    // Kolom `nama` user internal SuperApps berisi nama perusahaan; nama orangnya ada di `username`.
    const isCompanyName = /^(pt|cv)\b/i.test(clean(u.nama));
    const uname = clean(u.username);
    const fullName = tier !== 'vendor' && uname && (isCompanyName || !clean(u.nama)) ? uname : clean(u.nama) || email;
    plans.push({
      externalId: str(u.id_user), fullName, email, username: uname || null, phone: clean(u.no_hp) || null,
      passwordHash: normalizeHash(hash), roleName, tier, dept: deptOf(roleName), active,
    });
  }
  // email ganda → pertahankan yang aktif / internal
  const byEmail = new Map<string, Plan>();
  const score = (p: Plan) => (p.active ? 10 : 0) + HEAD_RANK[p.tier];
  for (const p of plans) {
    const cur = byEmail.get(p.email);
    if (!cur) { byEmail.set(p.email, p); continue; }
    const [keep, drop] = score(p) > score(cur) ? [p, cur] : [cur, p];
    byEmail.set(p.email, keep);
    warnings.push(`Email ganda ${p.email}: dipakai "${keep.fullName}" (${keep.roleName}), dilewati "${drop.fullName}" (${drop.roleName})`);
  }
  const finalPlans = [...byEmail.values()];
  // username ganda → dikosongkan (login tetap via email)
  const count = new Map<string, number>();
  for (const p of finalPlans) if (p.username) count.set(p.username.toLowerCase(), (count.get(p.username.toLowerCase()) ?? 0) + 1);
  for (const p of finalPlans) {
    if (p.username && (count.get(p.username.toLowerCase()) ?? 0) > 1) {
      warnings.push(`Username ganda "${p.username}" (${p.email}) dikosongkan — login pakai email`);
      p.username = null;
    }
  }
  return { plans: finalPlans, warnings };
}

export function summarize(plans: Plan[]) {
  const summary = new Map<string, { total: number; active: number; base: string }>();
  for (const p of plans) {
    const s = summary.get(p.roleName) ?? { total: 0, active: 0, base: BASE_ROLES[p.tier].join(' + ') };
    s.total++; if (p.active) s.active++;
    summary.set(p.roleName, s);
  }
  return [...summary].sort((a, b) => b[1].total - a[1].total);
}

// ───────────────────────── Tulis ke DB Digital Office ─────────────────────────
type Db = Pick<PrismaClient, 'permission' | 'role' | 'rolePermission' | 'department' | 'user' | 'userRole'>;

export async function applyPlans(db: Db, roles: SaRole[], plans: Plan[], opt: SyncOptions = {}): Promise<SyncStats> {
  const log = opt.log ?? (() => undefined);
  const warnings: string[] = [];

  // permission & role dasar (jaga-jaga jika DB belum di-seed)
  const existingPerms = new Set((await db.permission.findMany({ select: { code: true } })).map((p) => p.code));
  const missingPerms = Object.entries(PERMISSIONS).filter(([c]) => !existingPerms.has(c));
  if (missingPerms.length) {
    await db.permission.createMany({ data: missingPerms.map(([code, m]) => ({ code, module: m.module, description: m.description })), skipDuplicates: true });
  }
  const perms = new Map((await db.permission.findMany()).map((p) => [p.code, p.id]));
  const roleId = new Map((await db.role.findMany({ where: { deletedAt: null } })).map((r) => [r.name, r.id]));
  const ensureRole = async (name: string, description: string, codes: string[], isSystem: boolean) => {
    if (!name || roleId.has(name)) return;
    const r = await db.role.upsert({ where: { name }, update: { deletedAt: null }, create: { name, description, isSystem } });
    if (codes.length) {
      await db.rolePermission.createMany({ data: codes.map((c) => ({ roleId: r.id, permissionId: perms.get(c)! })), skipDuplicates: true });
    }
    roleId.set(name, r.id);
  };
  for (const name of Object.values(ROLE_NAMES)) await ensureRole(name, name, DEFAULT_ROLE_MATRIX[name], true);
  for (const name of APPROVER_LIKE_ROLES) await ensureRole(name, `Jenjang approval ${name}`, DEFAULT_ROLE_MATRIX[ROLE_NAMES.APPROVER], true);
  const kodeByName = new Map(roles.map((r) => [r.name, r.kode]));
  for (const name of new Set(plans.map((p) => p.roleName))) {
    await ensureRole(name, `Jabatan SuperApps (kode ${kodeByName.get(name) ?? '-'})`, [], false);
  }

  // unit kerja (hanya yang dipakai)
  const deptId = new Map<string, bigint>();
  const dir = await db.department.upsert({ where: { code: 'DIR' }, update: {}, create: { code: 'DIR', name: 'Direksi' } });
  deptId.set('DIR', dir.id);
  for (const code of new Set(plans.map((p) => p.dept))) {
    if (deptId.has(code)) continue;
    const d = DEPTS.find((x) => x.code === code)!;
    const row = await db.department.upsert({
      where: { code }, update: { deletedAt: null },
      create: { code, name: d.name, parentDeptId: code === 'VND' ? null : dir.id },
    });
    deptId.set(code, row.id);
  }

  // user
  let created = 0, updated = 0, disabled = 0;
  const userIdByExt = new Map<string, bigint>();
  for (const p of plans) {
    const existing =
      (await db.user.findUnique({ where: { externalId: p.externalId } })) ??
      (await db.user.findUnique({ where: { email: p.email } }));
    let username = p.username;
    if (username) {
      const clash = await db.user.findUnique({ where: { username } });
      if (clash && clash.id !== existing?.id) { warnings.push(`Username "${username}" sudah dipakai user lain — dilewati`); username = null; }
    }
    const data = {
      fullName: p.fullName.slice(0, 150), email: p.email, username, phone: p.phone?.slice(0, 40) ?? null,
      position: p.roleName.slice(0, 120), departmentId: deptId.get(p.dept) ?? null,
      passwordHash: p.passwordHash, status: p.active ? ('active' as const) : ('disabled' as const),
      isSuperAdmin: p.tier === 'it' && p.active, externalId: p.externalId, externalSource: SOURCE, deletedAt: null,
    };
    let id: bigint;
    if (existing) {
      const changed =
        existing.passwordHash !== data.passwordHash || existing.status !== data.status || existing.fullName !== data.fullName ||
        existing.email !== data.email || existing.username !== data.username || existing.position !== data.position ||
        existing.phone !== data.phone || existing.isSuperAdmin !== data.isSuperAdmin || existing.externalId !== data.externalId ||
        existing.departmentId !== data.departmentId || existing.deletedAt !== null;
      if (changed) {
        // password berubah / dinonaktifkan → sesi lama dipaksa logout
        const bump = existing.passwordHash !== data.passwordHash || data.status !== 'active' ? { tokenVersion: { increment: 1 } } : {};
        await db.user.update({ where: { id: existing.id }, data: { ...data, ...bump } });
        updated++;
      }
      id = existing.id;
    } else {
      id = (await db.user.create({ data })).id;
      created++;
    }
    userIdByExt.set(p.externalId, id);
    const wanted = [...BASE_ROLES[p.tier], p.roleName].map((n) => roleId.get(n)).filter((x): x is bigint => !!x);
    await db.userRole.createMany({ data: wanted.map((rid) => ({ userId: id, roleId: rid })), skipDuplicates: true });
  }

  // user SuperApps yang sudah dihapus di sumber → nonaktif
  if (opt.disableMissing) {
    const keep = plans.map((p) => p.externalId);
    const r = await db.user.updateMany({
      where: { externalSource: SOURCE, status: 'active', deletedAt: null, externalId: { notIn: keep.length ? keep : ['-'] } },
      data: { status: 'disabled', tokenVersion: { increment: 1 } },
    });
    disabled = r.count;
  }

  // kepala unit (hanya jika belum diisi)
  if (opt.setDeptHeads) {
    for (const [code, id] of deptId) {
      if (code === 'VND') continue;
      const dept = await db.department.findUnique({ where: { id } });
      if (!dept || dept.headUserId) continue;
      const cand = plans.filter((p) => p.dept === code && p.active).sort((a, b) => HEAD_RANK[b.tier] - HEAD_RANK[a.tier])[0];
      if (cand && HEAD_RANK[cand.tier] >= 3) await db.department.update({ where: { id }, data: { headUserId: userIdByExt.get(cand.externalId) } });
    }
  }

  warnings.forEach((w) => log(w));
  return { created, updated, disabled, active: plans.filter((p) => p.active).length, total: plans.length, warnings };
}
