import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { pageParams, paginated } from '../common/utils';
import { auditWhere } from './audit.where';
import { ExportsService } from '../exports/exports.service';
import { AuthUser } from '../common/types';

@Controller()
export class AuditController {
  constructor(private prisma: PrismaService, private exports: ExportsService) {}

  /** Read-only query audit trail (actor, module, entity, range). */
  @Get('audit-logs')
  @RequirePermissions('AUDIT_VIEW')
  async list(@Query() q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q, 200);
    const where = auditWhere(q);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, fullName: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginated(rows, total, page, perPage);
  }

  @Get('audit-logs/modules')
  @RequirePermissions('AUDIT_VIEW')
  async modules() {
    const rows = await this.prisma.auditLog.groupBy({ by: ['module'], _count: { _all: true } });
    return rows.map((r) => ({ module: r.module, count: r._count._all }));
  }

  /** Ekspor audit trail ke .xlsx (BR-09: hanya yang berhak; tidak ada hapus). */
  @Get('audit-logs.xlsx')
  @RequirePermissions('AUDIT_VIEW')
  async exportXlsx(@Query() q: Record<string, string>, @CurrentUser() user: AuthUser): Promise<StreamableFile> {
    return this.exports.auditXlsx(q, user);
  }
}
