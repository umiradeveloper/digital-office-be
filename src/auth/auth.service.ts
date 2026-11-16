import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types';
import { PermissionCode } from '../common/permissions';
import { AuditService } from '../audit/audit.service';
import { SuperappsService } from '../superapps/superapps.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private audit: AuditService,
    private superapps: SuperappsService,
  ) {}

  async loadAuthUser(id: bigint): Promise<AuthUser | null> {
    const u = await this.prisma.user.findFirst({
      where: { id, deletedAt: null, status: 'active' },
      include: {
        userRoles: {
          where: { role: { deletedAt: null } },
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
        },
      },
    });
    if (!u) return null;
    const perms = new Set<PermissionCode>();
    for (const ur of u.userRoles) for (const rp of ur.role.rolePermissions) perms.add(rp.permission.code as PermissionCode);
    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      departmentId: u.departmentId,
      isSuperAdmin: u.isSuperAdmin,
      roles: u.userRoles.map((r) => r.role.name),
      roleIds: u.userRoles.map((r) => r.roleId),
      permissions: [...perms],
    };
  }

  private async issueTokens(userId: bigint, tokenVersion: number) {
    const sub = userId.toString();
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync({ sub, typ: 'access' }, {
        secret: this.config.get('JWT_ACCESS_SECRET'), expiresIn: this.config.get('JWT_ACCESS_TTL', '15m') as any,
      }),
      this.jwt.signAsync({ sub, typ: 'refresh', ver: tokenVersion }, {
        secret: this.config.get('JWT_REFRESH_SECRET'), expiresIn: this.config.get('JWT_REFRESH_TTL', '7d') as any,
      }),
    ]);
    return { accessToken, refreshToken, tokenType: 'Bearer' };
  }

  async login(identifier: string, password: string, ip?: string) {
    const id = identifier.trim();
    // SuperApps terhubung → ambil data terbaru user ini (password/role/status) sebelum verifikasi
    if (this.superapps.enabled) await this.superapps.syncForLogin(id);
    const user = await this.prisma.user.findFirst({
      where: { deletedAt: null, OR: [{ email: id.toLowerCase() }, { username: id }] },
    });
    // hash bcrypt PHP ($2y$) dari sistem lama → setara $2b$
    const ok = user && (await bcrypt.compare(password, user.passwordHash.replace(/^\$2y\$/, () => '$2b$')));
    if (!user || !ok) {
      await this.audit.log({ actorUserId: user?.id, module: 'auth', action: 'login_failed', payload: { identifier: id }, ip });
      throw new UnauthorizedException('Email/username atau kata sandi salah');
    }
    if (user.status !== 'active') throw new UnauthorizedException('Akun Anda dinonaktifkan. Hubungi admin.');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ actorUserId: user.id, module: 'auth', action: 'login', entityType: 'user', entityId: user.id, ip });
    const tokens = await this.issueTokens(user.id, user.tokenVersion);
    return { ...tokens, user: await this.loadAuthUser(user.id) };
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; typ: string; ver: number };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, { secret: this.config.get('JWT_REFRESH_SECRET') });
    } catch {
      throw new UnauthorizedException('Refresh token tidak valid');
    }
    if (payload.typ !== 'refresh') throw new UnauthorizedException('Jenis token salah');
    const user = await this.prisma.user.findFirst({ where: { id: BigInt(payload.sub), deletedAt: null, status: 'active' } });
    if (!user || user.tokenVersion !== payload.ver) throw new UnauthorizedException('Sesi berakhir, silakan login ulang');
    return this.issueTokens(user.id, user.tokenVersion);
  }

  /** Logout semua sesi: naikkan tokenVersion → refresh token lama tidak berlaku. */
  async logoutAll(userId: bigint) {
    await this.prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    await this.audit.log({ actorUserId: userId, module: 'auth', action: 'logout_all', entityType: 'user', entityId: userId });
    return { ok: true };
  }

  async changePassword(userId: bigint, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(current, user.passwordHash))) throw new UnauthorizedException('Kata sandi saat ini salah');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(next, 10), tokenVersion: { increment: 1 } },
    });
    await this.audit.log({ actorUserId: userId, module: 'auth', action: 'password_changed', entityType: 'user', entityId: userId });
    return { ok: true };
  }
}
