import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { pageParams, paginated, toBigInt } from '../common/utils';
import { DEFAULT_TEMPLATES } from './templates';

class TemplateDto {
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsEnum(['low', 'med', 'high', 'crit']) minPriority?: 'low' | 'med' | 'high' | 'crit';
}

@Controller('notifications')
export class NotificationsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Notifikasi milik user (juga berfungsi sebagai inbox in-app). */
  @Get()
  async mine(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q);
    const where = { userId: u.id, readAt: q.unread === '1' ? null : undefined };
    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        select: { id: true, eventType: true, subject: true, body: true, status: true, sentAt: true, readAt: true, createdAt: true, requestId: true },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: u.id, readAt: null } }),
    ]);
    const res = paginated(rows, total, page, perPage);
    return { ...res, meta: { ...res.meta, unread } };
  }

  @Post('mark-all-read') @HttpCode(200)
  async markAll(@CurrentUser() u: AuthUser) {
    const r = await this.prisma.notification.updateMany({ where: { userId: u.id, readAt: null }, data: { readAt: new Date() } });
    return { updated: r.count };
  }

  @Post(':id/mark-read') @HttpCode(200)
  async markRead(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    await this.prisma.notification.updateMany({ where: { id: toBigInt(id), userId: u.id }, data: { readAt: new Date() } });
    return { ok: true };
  }

  // ── Admin: log pengiriman & template ──

  @Get('admin/logs') @RequirePermissions('NOTIF_MANAGE')
  async logs(@Query() q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q, 200);
    const where = { status: (q.status as any) || undefined, eventType: q.event || undefined };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, fullName: true, email: true } } },
      }),
      this.prisma.notification.count({ where }),
    ]);
    return paginated(rows, total, page, perPage);
  }

  @Post('admin/:id/retry') @HttpCode(200) @RequirePermissions('NOTIF_MANAGE')
  async retry(@Param('id') id: string) {
    await this.prisma.notification.update({ where: { id: toBigInt(id) }, data: { status: 'pending', attempts: 0, error: null } });
    return { ok: true };
  }

  @Get('admin/templates') @RequirePermissions('NOTIF_MANAGE')
  async templates() {
    const rows = await this.prisma.notificationTemplate.findMany({ orderBy: { id: 'asc' } });
    const have = new Set(rows.map((r) => r.eventType));
    const missing = Object.entries(DEFAULT_TEMPLATES).filter(([k]) => !have.has(k));
    for (const [eventType, t] of missing) {
      rows.push(await this.prisma.notificationTemplate.create({ data: { eventType, name: t.name, subject: t.subject, body: t.body, minPriority: t.minPriority ?? 'low' } }));
    }
    return rows;
  }

  @Patch('admin/templates/:eventType') @RequirePermissions('NOTIF_MANAGE')
  async updateTemplate(@Param('eventType') eventType: string, @Body() dto: TemplateDto, @CurrentUser() u: AuthUser) {
    const t = await this.prisma.notificationTemplate.update({ where: { eventType }, data: dto });
    await this.audit.log({ actorUserId: u.id, module: 'notification', action: 'template_updated', entityType: 'notification_template', entityId: t.id, payload: dto });
    return t;
  }
}
