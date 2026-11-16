import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { toBigInt } from '../common/utils';

class RoleDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() permissionCodes?: string[];
}
class PartialRoleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() description?: string;
}
class MatrixDto { @IsArray() permissionCodes: string[]; }

@Controller()
export class RolesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get('permissions')
  permissions() { return this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] }); }

  @Get('roles')
  async list() {
    const roles = await this.prisma.role.findMany({
      where: { deletedAt: null }, orderBy: { id: 'asc' },
      include: { rolePermissions: { include: { permission: true } }, _count: { select: { userRoles: true } } },
    });
    return roles.map((r) => ({
      id: r.id, name: r.name, description: r.description, isSystem: r.isSystem, userCount: r._count.userRoles,
      permissionCodes: r.rolePermissions.map((rp) => rp.permission.code),
    }));
  }

  @Post('roles') @RequirePermissions('ROLE_MANAGE')
  async create(@Body() dto: RoleDto, @CurrentUser() u: AuthUser) {
    const role = await this.prisma.role.create({ data: { name: dto.name, description: dto.description } });
    if (dto.permissionCodes?.length) await this.setMatrix(role.id, dto.permissionCodes);
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'role_created', entityType: 'role', entityId: role.id, payload: dto });
    return role;
  }

  @Patch('roles/:id') @RequirePermissions('ROLE_MANAGE')
  async update(@Param('id') id: string, @Body() dto: PartialRoleDto, @CurrentUser() u: AuthUser) {
    const role = await this.prisma.role.update({ where: { id: toBigInt(id) }, data: dto });
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'role_updated', entityType: 'role', entityId: role.id, payload: dto });
    return role;
  }

  /** Simpan matriks RBAC untuk satu role. */
  @Put('roles/:id/permissions') @RequirePermissions('ROLE_MANAGE')
  async matrix(@Param('id') id: string, @Body() dto: MatrixDto, @CurrentUser() u: AuthUser) {
    const roleId = toBigInt(id);
    await this.setMatrix(roleId, dto.permissionCodes);
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'role_permissions_updated', entityType: 'role', entityId: roleId, payload: dto });
    return { ok: true };
  }

  @Delete('roles/:id') @RequirePermissions('ROLE_MANAGE')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: toBigInt(id) }, include: { _count: { select: { userRoles: true } } } });
    if (role.isSystem) throw new BadRequestException('Role sistem tidak dapat dihapus');
    if (role._count.userRoles > 0) throw new BadRequestException('Role masih dipakai pengguna');
    await this.prisma.role.update({ where: { id: role.id }, data: { deletedAt: new Date(), name: `${role.name}#deleted${role.id}` } });
    await this.audit.log({ actorUserId: u.id, module: 'account', action: 'role_deleted', entityType: 'role', entityId: role.id });
    return { ok: true };
  }

  private async setMatrix(roleId: bigint, codes: string[]) {
    const perms = await this.prisma.permission.findMany({ where: { code: { in: codes } } });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) }),
    ]);
  }
}
