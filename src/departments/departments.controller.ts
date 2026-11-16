import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { optBigInt, toBigInt } from '../common/utils';

class DeptDto {
  @IsString() @MinLength(2) @MaxLength(150) name: string;
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsOptional() @IsEnum(['department', 'division', 'unit']) kind?: 'department' | 'division' | 'unit';
  @IsOptional() @IsString() parentDeptId?: string | null;
  @IsOptional() @IsString() headUserId?: string | null;
}
class PartialDeptDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsEnum(['department', 'division', 'unit']) kind?: 'department' | 'division' | 'unit';
  @IsOptional() @IsString() parentDeptId?: string | null;
  @IsOptional() @IsString() headUserId?: string | null;
}

@Controller('departments')
export class DepartmentsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  async list() {
    const rows = await this.prisma.department.findMany({
      where: { deletedAt: null }, orderBy: { name: 'asc' },
      include: { head: { select: { id: true, fullName: true } }, _count: { select: { members: { where: { deletedAt: null } } } } },
    });
    return rows.map((d) => ({ ...d, memberCount: d._count.members }));
  }

  @Post() @RequirePermissions('DEPT_MANAGE')
  async create(@Body() dto: DeptDto, @CurrentUser() u: AuthUser) {
    const d = await this.prisma.department.create({
      data: { name: dto.name, code: dto.code.toUpperCase(), kind: dto.kind, parentDeptId: optBigInt(dto.parentDeptId), headUserId: optBigInt(dto.headUserId) },
    });
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'department_created', entityType: 'department', entityId: d.id, payload: dto });
    return d;
  }

  @Patch(':id') @RequirePermissions('DEPT_MANAGE')
  async update(@Param('id') id: string, @Body() dto: PartialDeptDto, @CurrentUser() u: AuthUser) {
    const deptId = toBigInt(id);
    if (dto.parentDeptId && BigInt(dto.parentDeptId) === deptId) throw new BadRequestException('Departemen tidak boleh menjadi induk dirinya sendiri');
    const d = await this.prisma.department.update({
      where: { id: deptId },
      data: {
        name: dto.name, code: dto.code?.toUpperCase(), kind: dto.kind,
        parentDeptId: dto.parentDeptId === null ? null : optBigInt(dto.parentDeptId),
        headUserId: dto.headUserId === null ? null : optBigInt(dto.headUserId),
      },
    });
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'department_updated', entityType: 'department', entityId: d.id, payload: dto });
    return d;
  }

  @Delete(':id') @RequirePermissions('DEPT_MANAGE')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const deptId = toBigInt(id);
    const [members, children] = await Promise.all([
      this.prisma.user.count({ where: { departmentId: deptId, deletedAt: null } }),
      this.prisma.department.count({ where: { parentDeptId: deptId, deletedAt: null } }),
    ]);
    if (members || children) throw new BadRequestException('Departemen masih memiliki anggota atau sub-unit');
    await this.prisma.department.update({ where: { id: deptId }, data: { deletedAt: new Date(), code: `DEL${deptId}` } });
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'department_deleted', entityType: 'department', entityId: deptId });
    return { ok: true };
  }
}
