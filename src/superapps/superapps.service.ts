import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { applyPlans, buildPlans, SaRow, SOURCE, summarize, SyncStats, toRoles } from './superapps-sync';

export type LoginSyncResult = 'synced' | 'not-found' | 'unavailable' | 'disabled';

/**
 * Koneksi langsung (read-only) ke database SuperApps.
 * - Sinkron penuh user & role: saat start + tiap SUPERAPPS_SYNC_MINUTES menit + manual dari menu admin.
 * - Saat login: data user dicek langsung ke SuperApps, jadi perubahan password/role/status di SuperApps
 *   langsung berlaku tanpa menunggu jadwal sinkron.
 * Hanya SELECT yang dijalankan ke SuperApps — sebaiknya pakai user MySQL read-only.
 */
@Injectable()
export class SuperappsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SuperApps');
  private pool?: Pool;
  private timer?: NodeJS.Timeout;
  private running = false;
  private last: { at: Date; ok: boolean; message: string; stats?: Omit<SyncStats, 'warnings'> & { warnings: number } } | null = null;

  private readonly usersTable: string;
  private readonly roleTable: string;
  private readonly includeVendor: boolean;

  constructor(private config: ConfigService, private prisma: PrismaService, private audit: AuditService) {
    const ident = (v: string) => {
      if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`Nama tabel SuperApps tidak valid: ${v}`);
      return '`' + v + '`';
    };
    this.usersTable = ident(this.config.get('SUPERAPPS_USERS_TABLE', 'users'));
    this.roleTable = ident(this.config.get('SUPERAPPS_ROLE_TABLE', 'role'));
    this.includeVendor = this.config.get('SUPERAPPS_INCLUDE_VENDOR', 'false') === 'true';
  }

  get enabled() { return !!this.pool; }

  onModuleInit() {
    const url = this.config.get<string>('SUPERAPPS_DATABASE_URL');
    if (!url) return;
    this.pool = createPool({
      uri: url, connectionLimit: 3, connectTimeout: 5000, dateStrings: true, charset: 'utf8mb4',
      ...(this.config.get('SUPERAPPS_DB_SSL') === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    this.logger.log('Terhubung ke database SuperApps (mode baca)');
    const minutes = Number(this.config.get('SUPERAPPS_SYNC_MINUTES', '30'));
    if (this.config.get('SUPERAPPS_SYNC_ON_START', 'true') !== 'false') {
      setTimeout(() => this.syncAll('startup').catch(() => undefined), 3000);
    }
    if (minutes > 0) {
      this.timer = setInterval(() => this.syncAll('jadwal').catch(() => undefined), minutes * 60_000);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.pool?.end().catch(() => undefined);
  }

  private async query(sql: string, params: unknown[] = []): Promise<SaRow[]> {
    const [rows] = await this.pool!.query<RowDataPacket[]>(sql, params);
    return rows as SaRow[];
  }

  private userCols = 'u.id_user, u.id_role, u.nama, u.username, u.password, u.email, u.no_hp, u.isApproval';

  private async fetchRoles() {
    return toRoles(await this.query(`SELECT id_role, nama_role, kode_role FROM ${this.roleTable}`));
  }

  /** Sinkron penuh semua user & role. */
  async syncAll(trigger: string, actorUserId?: bigint) {
    if (!this.pool) throw new Error('SUPERAPPS_DATABASE_URL belum diatur');
    if (this.running) return { skipped: true, message: 'Sinkronisasi sedang berjalan' };
    this.running = true;
    try {
      const roles = await this.fetchRoles();
      const users = await this.query(`SELECT ${this.userCols} FROM ${this.usersTable} u`);
      const { plans, warnings } = buildPlans(roles, users, { includeVendor: this.includeVendor });
      const stats = await applyPlans(this.prisma, roles, plans, {
        includeVendor: this.includeVendor, setDeptHeads: true, disableMissing: true,
      });
      const allWarnings = [...warnings, ...stats.warnings];
      const message = `${stats.total} user (${stats.active} aktif): ${stats.created} baru, ${stats.updated} berubah, ${stats.disabled} dinonaktifkan`;
      this.last = { at: new Date(), ok: true, message, stats: { ...stats, warnings: allWarnings.length } };
      this.logger.log(`Sinkron ${trigger}: ${message}`);
      if (stats.created || stats.updated || stats.disabled || actorUserId) {
        await this.audit.log({ actorUserId, module: 'account', action: 'superapps_sync', payload: { trigger, ...stats, warnings: allWarnings.slice(0, 20) } });
      }
      return { ...this.last, warnings: allWarnings, roles: summarize(plans).map(([name, s]) => ({ name, ...s })) };
    } catch (e) {
      const message = (e as Error).message;
      this.last = { at: new Date(), ok: false, message };
      this.logger.warn(`Sinkron ${trigger} gagal: ${message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  /**
   * Dipanggil sebelum verifikasi password: ambil data terbaru user dari SuperApps lalu upsert ke lokal.
   * Jika SuperApps tidak dapat dihubungi, login tetap memakai data lokal hasil sinkron terakhir.
   */
  async syncForLogin(identifier: string): Promise<LoginSyncResult> {
    if (!this.pool) return 'unavailable';
    try {
      const id = identifier.trim();
      const users = await this.query(
        `SELECT ${this.userCols} FROM ${this.usersTable} u WHERE LOWER(u.email) = LOWER(?) OR u.username = ?`, [id, id],
      );
      if (!users.length) {
        // user SuperApps yang sudah dihapus di sumber → nonaktifkan salinan lokal
        const local = await this.prisma.user.findFirst({
          where: { externalSource: SOURCE, status: 'active', OR: [{ email: id.toLowerCase() }, { username: id }] },
        });
        if (local) {
          await this.prisma.user.update({ where: { id: local.id }, data: { status: 'disabled', tokenVersion: { increment: 1 } } });
          return 'disabled';
        }
        return 'not-found';
      }
      // sertakan user lain dengan email sama agar aturan "email ganda" konsisten dengan sinkron penuh
      const emails = [...new Set(users.map((u) => String(u.email ?? '').trim().toLowerCase()).filter(Boolean))];
      const siblings = emails.length
        ? await this.query(`SELECT ${this.userCols} FROM ${this.usersTable} u WHERE LOWER(TRIM(u.email)) IN (?)`, [emails])
        : [];
      const all = new Map([...users, ...siblings].map((u) => [String(u.id_user), u]));
      const roles = await this.fetchRoles();
      const { plans } = buildPlans(roles, [...all.values()], { includeVendor: this.includeVendor });
      // username yang sama dipakai >1 user → buildPlans mengosongkannya; cocok dengan perilaku sinkron penuh
      await applyPlans(this.prisma, roles, plans, { includeVendor: this.includeVendor });
      return 'synced';
    } catch (e) {
      this.logger.warn(`SuperApps tidak dapat dihubungi saat login, memakai data lokal: ${(e as Error).message}`);
      return 'unavailable';
    }
  }

  async status() {
    let reachable: boolean | null = null;
    let error: string | undefined;
    let sourceUsers: number | undefined;
    if (this.pool) {
      try {
        const [r] = await this.query(`SELECT COUNT(*) AS n FROM ${this.usersTable}`);
        sourceUsers = Number(r.n);
        reachable = true;
      } catch (e) { reachable = false; error = (e as Error).message; }
    }
    const [local, localActive] = await Promise.all([
      this.prisma.user.count({ where: { externalSource: SOURCE, deletedAt: null } }),
      this.prisma.user.count({ where: { externalSource: SOURCE, deletedAt: null, status: 'active' } }),
    ]);
    return {
      enabled: this.enabled, reachable, error, sourceUsers, localUsers: local, localActive,
      includeVendor: this.includeVendor, syncMinutes: Number(this.config.get('SUPERAPPS_SYNC_MINUTES', '30')),
      running: this.running, last: this.last,
    };
  }
}
