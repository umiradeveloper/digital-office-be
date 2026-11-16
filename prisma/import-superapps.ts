/**
 * Impor / sinkron role & user SuperApps ke Digital Office dari baris perintah.
 *
 *   # dari database SuperApps langsung (SUPERAPPS_DATABASE_URL di .env)
 *   npm run import:superapps -- --db [--dry-run] [--include-vendor]
 *   # dari file dump SQL (tabel `role` + `users`)
 *   npm run import:superapps -- <path/superapps_user_role.sql> [--dry-run] [--include-vendor]
 *
 * Saat API berjalan dengan SUPERAPPS_DATABASE_URL, sinkron juga berjalan otomatis (lihat SuperappsService).
 * Pemetaan role/unit & aturan aktif-nonaktif: src/superapps/superapps-sync.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { applyPlans, buildPlans, parseInserts, SaRow, summarize, toRoles } from '../src/superapps/superapps-sync';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const DRY = flag('--dry-run');
const FROM_DB = flag('--db');
const INCLUDE_VENDOR = flag('--include-vendor') || process.env.SUPERAPPS_INCLUDE_VENDOR === 'true';

async function loadFromDb() {
  const url = process.env.SUPERAPPS_DATABASE_URL;
  if (!url) throw new Error('SUPERAPPS_DATABASE_URL belum diatur di backend/.env');
  const { createConnection } = await import('mysql2/promise');
  const conn = await createConnection({ uri: url, connectTimeout: 10000, dateStrings: true, charset: 'utf8mb4' });
  try {
    const t = (v: string) => { if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`Nama tabel tidak valid: ${v}`); return '`' + v + '`'; };
    const [roles] = await conn.query(`SELECT id_role, nama_role, kode_role FROM ${t(process.env.SUPERAPPS_ROLE_TABLE ?? 'role')}`);
    const [users] = await conn.query(
      `SELECT id_user, id_role, nama, username, password, email, no_hp, isApproval FROM ${t(process.env.SUPERAPPS_USERS_TABLE ?? 'users')}`,
    );
    return { roles: roles as SaRow[], users: users as SaRow[], from: url.replace(/\/\/[^@]*@/, '//***@') };
  } finally {
    await conn.end();
  }
}

function loadFromFile() {
  const fileArg = args.find((a) => !a.startsWith('--')) ?? process.env.SUPERAPPS_SQL;
  if (!fileArg) {
    console.error('Pakai: npm run import:superapps -- --db | <path/superapps_user_role.sql>  [--dry-run] [--include-vendor]');
    process.exit(1);
  }
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), fileArg);
  const sql = readFileSync(file, 'utf8');
  return { roles: parseInserts(sql, 'role'), users: parseInserts(sql, 'users'), from: file };
}

async function main() {
  const src = FROM_DB ? await loadFromDb() : loadFromFile();
  console.log(`› Sumber: ${src.roles.length} role, ${src.users.length} user (${src.from})`);
  if (!src.users.length) throw new Error('Tidak ada data user');

  const roles = toRoles(src.roles);
  const { plans, warnings } = buildPlans(roles, src.users, { includeVendor: INCLUDE_VENDOR });
  console.log('› Ringkasan per jabatan (aktif/total → role Digital Office):');
  for (const [name, s] of summarize(plans)) console.log(`   ${name.padEnd(28)} ${String(s.active).padStart(3)}/${s.total}  → ${s.base}`);
  warnings.forEach((w) => console.warn('  ! ' + w));
  if (DRY) {
    console.log(`\n(dry-run) ${plans.length} user siap diimpor, ${plans.filter((p) => p.active).length} aktif. Tidak ada yang ditulis.`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    const stats = await applyPlans(prisma, roles, plans, {
      includeVendor: INCLUDE_VENDOR, setDeptHeads: true, disableMissing: FROM_DB, log: (m) => console.warn('  ! ' + m),
    });
    console.log(`\n✓ Selesai: ${stats.created} baru, ${stats.updated} berubah, ${stats.disabled} dinonaktifkan, ${stats.active} aktif dari ${stats.total}.`);
    console.log('  User login dengan email atau username SuperApps + password SuperApps.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
