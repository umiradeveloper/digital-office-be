import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto, UpdateMeDto, UpdateUserDto } from './users.dto';
import { optBigInt, pageParams, paginated, toBigInt } from '../common/utils';
import { AuthUser } from '../common/types';

export const userPublicSelect = {
  id: true, fullName: true, email: true, username: true, externalSource: true, photoUrl: true, phone: true, position: true,
  status: true, isSuperAdmin: true, departmentId: true, lastLoginAt: true, createdAt: true,
  department: { select: { id: true, name: true, code: true } },
  userRoles: { select: { role: { select: { id: true, name: true } } } },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async list(q: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(q, 500);
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      departmentId: optBigInt(q.dept),
      status: q.status === 'active' || q.status === 'disabled' ? q.status : undefined,
      userRoles: q.role ? { some: { roleId: optBigInt(q.role) } } : undefined,
      OR: q.search
        ? [{ fullName: { contains: q.search } }, { email: { contains: q.search } }, { username: { contains: q.search } }, { position: { contains: q.search } }]
        : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, skip, take, select: userPublicSelect, orderBy: { fullName: 'asc' } }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(rows, total, page, perPage);
  }

  async get(id: bigint) {
    const u = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: userPublicSelect });
    if (!u) throw new NotFoundException('Pengguna tidak ditemukan');
    return u;
  }

  async me(user: AuthUser) {
    const u = await this.get(user.id);
    return { ...u, roles: user.roles, permissions: user.permissions };
  }

  async create(dto: CreateUserDto, actor: AuthUser) {
    const email = dto.email.toLowerCase().trim();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Email sudah terdaftar');
    const tempPassword = dto.password ?? this.tempPassword();
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          fullName: dto.fullName, email, phone: dto.phone, position: dto.position,
          passwordHash: await bcrypt.hash(tempPassword, 10),
          departmentId: optBigInt(dto.departmentId) ?? null,
          isSuperAdmin: actor.isSuperAdmin ? !!dto.isSuperAdmin : false,
        },
      });
      if (dto.roleIds?.length) {
        await tx.userRole.createMany({
          data: dto.roleIds.map((r) => ({ userId: u.id, roleId: toBigInt(r, 'roleId'), grantedBy: actor.id })),
        });
      }
      await this.audit.log({ actorUserId: actor.id, module: 'account', action: 'user_created', entityType: 'user', entityId: u.id, payload: { email, roleIds: dto.roleIds } }, tx);
      return u;
    });
    return { user: await this.get(user.id), tempPassword: dto.password ? undefined : tempPassword };
  }

  async update(id: bigint, dto: UpdateUserDto, actor: AuthUser) {
    const existing = await this.get(id);
    if (dto.email && dto.email.toLowerCase() !== existing.email) {
      if (await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } })) throw new ConflictException('Email sudah terdaftar');
    }
    if (id === actor.id && dto.status === 'disabled') throw new BadRequestException('Tidak dapat menonaktifkan akun sendiri');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          fullName: dto.fullName, email: dto.email?.toLowerCase(), phone: dto.phone, position: dto.position,
          departmentId: dto.departmentId === null ? null : optBigInt(dto.departmentId),
          isSuperAdmin: actor.isSuperAdmin && dto.isSuperAdmin !== undefined ? dto.isSuperAdmin : undefined,
          status: dto.status,
          tokenVersion: dto.status === 'disabled' ? { increment: 1 } : undefined,
        },
      });
      if (dto.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (dto.roleIds.length) {
          await tx.userRole.createMany({ data: dto.roleIds.map((r) => ({ userId: id, roleId: toBigInt(r, 'roleId'), grantedBy: actor.id })) });
        }
      }
      await this.audit.log({ actorUserId: actor.id, module: 'account', action: 'user_updated', entityType: 'user', entityId: id, payload: dto }, tx);
    });
    return this.get(id);
  }

  async setStatus(id: bigint, status: 'active' | 'disabled', actor: AuthUser) {
    return this.update(id, { status }, actor);
  }

  async resetPassword(id: bigint, newPassword: string | undefined, actor: AuthUser) {
    await this.get(id);
    const pwd = newPassword ?? this.tempPassword();
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(pwd, 10), tokenVersion: { increment: 1 } } });
    await this.audit.log({ actorUserId: actor.id, module: 'account', action: 'password_reset', entityType: 'user', entityId: id });
    return { tempPassword: newPassword ? undefined : pwd };
  }

  async softDelete(id: bigint, actor: AuthUser) {
    if (id === actor.id) throw new BadRequestException('Tidak dapat menghapus akun sendiri');
    const u = await this.get(id);
    await this.prisma.user.update({
      where: { id },
      // email dibebaskan agar bisa dipakai ulang; jejak audit tetap
      data: { deletedAt: new Date(), status: 'disabled', email: `deleted+${id}+${u.email}`.slice(0, 190), tokenVersion: { increment: 1 } },
    });
    await this.audit.log({ actorUserId: actor.id, module: 'account', action: 'user_deleted', entityType: 'user', entityId: id, payload: { email: u.email } });
    return { ok: true };
  }

  async updateMe(user: AuthUser, dto: UpdateMeDto) {
    await this.prisma.user.update({ where: { id: user.id }, data: dto });
    await this.audit.log({ actorUserId: user.id, module: 'account', action: 'profile_updated', entityType: 'user', entityId: user.id, payload: dto });
    return this.me(user);
  }

  async setPhoto(user: AuthUser, url: string) {
    await this.prisma.user.update({ where: { id: user.id }, data: { photoUrl: url } });
    return this.me(user);
  }

  private tempPassword() {
    return 'Do-' + randomBytes(6).toString('base64url');
  }
}
