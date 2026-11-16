import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestsService } from '../requests/requests.service';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApprovalsService } from './approvals.service';
import { ClientIp, CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/types';
import { toBigInt } from '../common/utils';

class DecideDto {
  @IsEnum(['approve', 'reject', 'delegate'], { message: 'Keputusan tidak valid' }) decision: 'approve' | 'reject' | 'delegate';
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
  @IsOptional() @IsString() toUserId?: string;
}

@Controller('approvals')
export class ApprovalsController {
  constructor(private approvals: ApprovalsService, private requests: RequestsService, private prisma: PrismaService) {}

  @Get('inbox') inbox(@CurrentUser() u: AuthUser) { return this.approvals.inbox(u); }

  @Get(':instanceId')
  async detail(@Param('instanceId') id: string, @CurrentUser() u: AuthUser) {
    const inst = await this.prisma.approvalInstance.findUniqueOrThrow({ where: { id: toBigInt(id) }, include: { request: true } });
    if (!(await this.requests.canView(u, inst.request))) throw new ForbiddenException('Anda tidak memiliki akses ke approval ini');
    return this.approvals.detail(inst.id);
  }

  /** RBAC dicek di service agar penolakan tercatat di audit (UAT-10). */
  @Post(':instanceId/decide') @HttpCode(200)
  decide(@Param('instanceId') id: string, @Body() dto: DecideDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.approvals.decide(u, toBigInt(id), dto, ip);
  }
}
