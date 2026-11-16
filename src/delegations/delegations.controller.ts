import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsDateString, IsOptional, IsString } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { can, parseDate, toBigInt } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';

class DelegationDto {
  @IsString() delegateUserId: string;
  @IsOptional() @IsString() delegatorUserId?: string; // hanya admin
  @IsDateString({}, { message: 'Tanggal mulai tidak valid' }) fromDate: string;
  @IsDateString({}, { message: 'Tanggal selesai tidak valid' }) toDate: string;
  @IsOptional() @IsString() reason?: string;
}

const include = {
  delegator: { select: { id: true, fullName: true, email: true } },
  delegate: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.DelegationInclude;

@Controller('delegations')
export class DelegationsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private notif: NotificationsService) {}

  /** Daftar delegasi (milik sendiri; admin dapat melihat semua dengan ?all=1). */
  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) {
    const all = q.all === '1' && can(u, 'DELEGATION_MANAGE');
    const from = parseDate(q.from); const to = parseDate(q.to, true);
    return this.prisma.delegation.findMany({
      where: {
        deletedAt: null,
        status: (q.status as any) || undefined,
        ...(all ? {} : { OR: [{ delegatorUserId: u.id }, { delegateUserId: u.id }] }),
        ...(from ? { toDate: { gte: from } } : {}),
        ...(to ? { fromDate: { lte: to } } : {}),
      },
      include, orderBy: { fromDate: 'desc' },
    });
  }

  @Post() @RequirePermissions('DELEGATION_CREATE', 'DELEGATION_MANAGE')
  async create(@Body() dto: DelegationDto, @CurrentUser() u: AuthUser) {
    const delegatorId = dto.delegatorUserId && can(u, 'DELEGATION_MANAGE') ? toBigInt(dto.delegatorUserId) : u.id;
    const delegateId = toBigInt(dto.delegateUserId);
    if (delegatorId === delegateId) throw new BadRequestException('Tidak dapat mendelegasikan ke diri sendiri');
    const fromDate = new Date(dto.fromDate); const toDate = new Date(dto.toDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dto.toDate)) toDate.setHours(23, 59, 59, 999);
    if (toDate <= fromDate) throw new BadRequestException('Tanggal selesai harus setelah tanggal mulai');
    const delegate = await this.prisma.user.findFirst({ where: { id: delegateId, deletedAt: null, status: 'active' } });
    if (!delegate) throw new BadRequestException('Penerima delegasi tidak aktif');
    const overlap = await this.prisma.delegation.findFirst({
      where: { delegatorUserId: delegatorId, status: 'active', deletedAt: null, fromDate: { lte: toDate }, toDate: { gte: fromDate } },
    });
    if (overlap) throw new BadRequestException('Sudah ada delegasi aktif pada periode yang beririsan');

    const d = await this.prisma.delegation.create({
      data: { delegatorUserId: delegatorId, delegateUserId: delegateId, fromDate, toDate, reason: dto.reason, createdBy: u.id },
      include,
    });
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'delegation_created', entityType: 'delegation', entityId: d.id, payload: dto });
    await this.notif.notify('delegated', delegateId, {
      vars: { delegator: d.delegator.fullName, periode: `${fromDate.toLocaleDateString('id-ID')} – ${toDate.toLocaleDateString('id-ID')}`, judul: 'Delegasi hak approval', ref: `DLG-${d.id}` },
    });
    return d;
  }

  @Post(':id/end') @HttpCode(200)
  async end(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const d = await this.prisma.delegation.findFirstOrThrow({ where: { id: toBigInt(id), deletedAt: null } });
    if (d.delegatorUserId !== u.id && !can(u, 'DELEGATION_MANAGE')) throw new ForbiddenException('Hanya pemberi delegasi yang dapat mengakhiri');
    const res = await this.prisma.delegation.update({ where: { id: d.id }, data: { status: 'ended', toDate: d.toDate > new Date() ? new Date() : d.toDate }, include });
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'delegation_ended', entityType: 'delegation', entityId: d.id });
    return res;
  }
}
