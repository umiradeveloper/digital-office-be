import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { APPROVER_LIKE_ROLES, DEFAULT_ROLE_MATRIX, PERMISSIONS, ROLE_NAMES } from '../common/permissions';

/**
 * Sinkronisasi katalog permission saat aplikasi start: permission baru (mis. setelah upgrade modul)
 * otomatis dibuat dan diberikan ke role default sesuai matriks — tanpa perlu seed ulang.
 */
@Injectable()
export class PermissionSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionSyncService.name);
  constructor(private prisma: PrismaService) {}

  async onApplicationBootstrap() {
    try {
      const existing = new Set((await this.prisma.permission.findMany({ select: { code: true } })).map((p) => p.code));
      const missing = Object.entries(PERMISSIONS).filter(([code]) => !existing.has(code));
      if (!missing.length) return;
      const roles = await this.prisma.role.findMany({ where: { deletedAt: null } });
      for (const [code, meta] of missing) {
        const perm = await this.prisma.permission.create({ data: { code, module: meta.module, description: meta.description } });
        for (const role of roles) {
          const matrix = DEFAULT_ROLE_MATRIX[role.name] ?? (APPROVER_LIKE_ROLES.includes(role.name) ? DEFAULT_ROLE_MATRIX[ROLE_NAMES.APPROVER] : []);
          if ((matrix as string[]).includes(code)) {
            await this.prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } }).catch(() => undefined);
          }
        }
      }
      this.logger.log(`Permission baru disinkronkan: ${missing.map(([c]) => c).join(', ')}`);
    } catch (e) {
      this.logger.warn(`Sinkronisasi permission dilewati: ${(e as Error).message}`);
    }
  }
}
