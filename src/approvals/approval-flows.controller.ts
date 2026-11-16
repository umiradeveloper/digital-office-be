import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from './approvals.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { can, optBigInt, toBigInt } from '../common/utils';

const PRI = ['low', 'med', 'high', 'crit'] as const;

class RuleDto {
  @IsOptional() @IsEnum(PRI) min_priority?: (typeof PRI)[number];
  @IsOptional() @IsNumber() @Min(0) threshold_value?: number;
}

class LevelDto {
  @IsString() @MinLength(1, { message: 'Nama level wajib diisi' }) name: string;
  @IsEnum(['user', 'role', 'dept_head'], { message: 'Tipe approver tidak valid' }) approverType: 'user' | 'role' | 'dept_head';
  @IsOptional() @IsString() approverRoleId?: string | null;
  @IsOptional() @IsString() approverUserId?: string | null;
  @IsOptional() @IsBoolean() sameDeptOnly?: boolean;
  @IsOptional() @IsBoolean() delegateOn?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(720) slaHours?: number;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RuleDto) condition?: RuleDto | null;
}

class FlowDto {
  @IsString() @MinLength(3) @MaxLength(150) name: string;
  @IsString() @MinLength(2) @MaxLength(60) code: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() triggerTypeId?: string | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RuleDto) thresholdRule?: RuleDto | null;
  @IsOptional() @IsEnum(['revise', 'close']) rejectAction?: 'revise' | 'close';
  @IsOptional() @IsEnum(['draft', 'active', 'archived']) status?: 'draft' | 'active' | 'archived';
  @IsArray() @ArrayMinSize(1, { message: 'Minimal satu level approval' }) @ValidateNested({ each: true }) @Type(() => LevelDto) levels: LevelDto[];
}

class PartialFlowDto {
  @IsOptional() @IsString() @MinLength(3) name?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() triggerTypeId?: string | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RuleDto) thresholdRule?: RuleDto | null;
  @IsOptional() @IsEnum(['revise', 'close']) rejectAction?: 'revise' | 'close';
  @IsOptional() @IsEnum(['draft', 'active', 'archived']) status?: 'draft' | 'active' | 'archived';
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LevelDto) levels?: LevelDto[];
}

class DuplicateDto {
  @IsString() @MinLength(3) name: string;
  @IsString() @MinLength(2) code: string;
  @IsOptional() @IsString() departmentId?: string | null;
}

class PreviewDto {
  @IsString() typeId: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsEnum(PRI) priority: (typeof PRI)[number];
  @IsOptional() @IsNumber() amount?: number;
  @IsOptional() @IsString() requesterUserId?: string;
}

const flowInclude = {
  department: { select: { id: true, name: true, code: true } },
  triggerType: { select: { id: true, name: true, code: true } },
  creator: { select: { id: true, fullName: true } },
  levels: {
    orderBy: { levelOrder: 'asc' },
    include: { approverRole: { select: { id: true, name: true } }, approverUser: { select: { id: true, fullName: true } } },
  },
  _count: { select: { instances: true } },
} satisfies Prisma.ApprovalFlowInclude;

@Controller('approval-flows')
export class ApprovalFlowsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private approvals: ApprovalsService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.prisma.approvalFlow.findMany({
      where: { deletedAt: null, departmentId: q.dept === 'global' ? null : optBigInt(q.dept), status: (q.status as any) || undefined },
      include: flowInclude, orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const f = await this.prisma.approvalFlow.findFirst({ where: { id: toBigInt(id), deletedAt: null }, include: flowInclude });
    if (!f) throw new NotFoundException('Alur tidak ditemukan');
    return f;
  }

  /** Simulasi routing: alur & approver mana yang akan dipakai (preview untuk admin & pengaju). */
  @Post('preview')
  preview(@Body() dto: PreviewDto) { return this.approvals.preview(dto); }

  @Post() @RequirePermissions('APPROVAL_FLOW_MANAGE')
  async create(@Body() dto: FlowDto, @CurrentUser() u: AuthUser) {
    this.validateLevels(dto.levels);
    const deptId = this.scopeDept(u, dto.departmentId);
    const flow = await this.prisma.$transaction(async (tx) => {
      const f = await tx.approvalFlow.create({
        data: {
          name: dto.name, code: dto.code.toUpperCase(), description: dto.description, departmentId: deptId,
          triggerTypeId: optBigInt(dto.triggerTypeId) ?? null, thresholdRuleJson: this.cleanRule(dto.thresholdRule),
          rejectAction: dto.rejectAction ?? 'revise', status: dto.status ?? 'draft', createdBy: u.id,
        },
      });
      await tx.approvalLevel.createMany({ data: this.levelRows(f.id, dto.levels) });
      await this.audit.log({ actorUserId: u.id, module: 'approval', action: 'flow_created', entityType: 'approval_flow', entityId: f.id, payload: dto }, tx);
      return f;
    });
    return this.get(flow.id.toString());
  }

  /** Ubah / aktifkan / arsipkan. Instance berjalan aman karena memakai snapshot plan. */
  @Patch(':id') @RequirePermissions('APPROVAL_FLOW_MANAGE')
  async update(@Param('id') id: string, @Body() dto: PartialFlowDto, @CurrentUser() u: AuthUser) {
    const flowId = toBigInt(id);
    const existing = await this.prisma.approvalFlow.findFirstOrThrow({ where: { id: flowId, deletedAt: null } });
    if (!u.isSuperAdmin && existing.departmentId !== u.departmentId) throw new BadRequestException('Anda hanya dapat mengubah alur di unit Anda');
    if (dto.levels) this.validateLevels(dto.levels);
    await this.prisma.$transaction(async (tx) => {
      await tx.approvalFlow.update({
        where: { id: flowId },
        data: {
          name: dto.name, code: dto.code?.toUpperCase(), description: dto.description, status: dto.status, rejectAction: dto.rejectAction,
          departmentId: dto.departmentId === undefined ? undefined : this.scopeDept(u, dto.departmentId),
          triggerTypeId: dto.triggerTypeId === undefined ? undefined : optBigInt(dto.triggerTypeId) ?? null,
          thresholdRuleJson: dto.thresholdRule === undefined ? undefined : this.cleanRule(dto.thresholdRule),
        },
      });
      if (dto.levels) {
        await tx.approvalLevel.deleteMany({ where: { flowId } });
        await tx.approvalLevel.createMany({ data: this.levelRows(flowId, dto.levels) });
      }
      await this.audit.log({ actorUserId: u.id, module: 'approval', action: dto.status && Object.keys(dto).length === 1 ? `flow_${dto.status}` : 'flow_updated', entityType: 'approval_flow', entityId: flowId, payload: dto }, tx);
    });
    return this.get(id);
  }

  /** Replikasi alur ke departemen lain (FR-APR-02). */
  @Post(':id/duplicate') @RequirePermissions('APPROVAL_FLOW_MANAGE')
  async duplicate(@Param('id') id: string, @Body() dto: DuplicateDto, @CurrentUser() u: AuthUser) {
    const src = await this.get(id);
    const f = await this.prisma.$transaction(async (tx) => {
      const nf = await tx.approvalFlow.create({
        data: {
          name: dto.name, code: dto.code.toUpperCase(), description: src.description, departmentId: this.scopeDept(u, dto.departmentId),
          triggerTypeId: src.triggerTypeId, thresholdRuleJson: (src.thresholdRuleJson ?? Prisma.DbNull) as any,
          rejectAction: src.rejectAction, status: 'draft', createdBy: u.id,
        },
      });
      await tx.approvalLevel.createMany({
        data: src.levels.map((l) => ({
          flowId: nf.id, levelOrder: l.levelOrder, name: l.name, approverType: l.approverType, approverRoleId: l.approverRoleId,
          approverUserId: l.approverUserId, sameDeptOnly: l.sameDeptOnly, delegateOn: l.delegateOn, slaHours: l.slaHours,
          conditionJson: (l.conditionJson ?? Prisma.DbNull) as any,
        })),
      });
      await this.audit.log({ actorUserId: u.id, module: 'approval', action: 'flow_duplicated', entityType: 'approval_flow', entityId: nf.id, payload: { from: src.id, ...dto } }, tx);
      return nf;
    });
    return this.get(f.id.toString());
  }

  private scopeDept(u: AuthUser, dept?: string | null) {
    const d = optBigInt(dept) ?? null;
    if (u.isSuperAdmin) return d;
    if (!can(u, 'APPROVAL_FLOW_MANAGE')) throw new BadRequestException();
    // Admin departemen hanya untuk unitnya
    if (d === null || d !== u.departmentId) {
      if (!u.departmentId) throw new BadRequestException('Akun Anda tidak terhubung ke unit');
      return u.departmentId;
    }
    return d;
  }

  private cleanRule(rule?: { min_priority?: string; threshold_value?: number } | null) {
    if (!rule) return Prisma.DbNull;
    const out: Record<string, unknown> = {};
    if (rule.min_priority) out.min_priority = rule.min_priority;
    if (rule.threshold_value != null) out.threshold_value = rule.threshold_value;
    return Object.keys(out).length ? (out as Prisma.InputJsonValue) : Prisma.DbNull;
  }

  private validateLevels(levels: LevelDto[]) {
    levels.forEach((l, i) => {
      if (l.approverType === 'user' && !l.approverUserId) throw new BadRequestException(`Level ${i + 1}: pilih pengguna approver`);
      if (l.approverType === 'role' && !l.approverRoleId) throw new BadRequestException(`Level ${i + 1}: pilih role approver`);
    });
  }

  private levelRows(flowId: bigint, levels: LevelDto[]): Prisma.ApprovalLevelCreateManyInput[] {
    return levels.map((l, i) => ({
      flowId, levelOrder: i + 1, name: l.name, approverType: l.approverType,
      approverRoleId: l.approverType === 'role' ? optBigInt(l.approverRoleId) ?? null : null,
      approverUserId: l.approverType === 'user' ? optBigInt(l.approverUserId) ?? null : null,
      sameDeptOnly: l.sameDeptOnly ?? true, delegateOn: l.delegateOn ?? true, slaHours: l.slaHours ?? 24,
      conditionJson: this.cleanRule(l.condition) as any,
    }));
  }
}
