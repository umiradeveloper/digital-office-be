import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC, PERMS_KEY, SUPER_ADMIN_KEY } from '../decorators';
import { AuthService } from '../../auth/auth.service';
import { PermissionCode } from '../permissions';
import { AuditService } from '../../audit/audit.service';

/** Guard global: verifikasi JWT Bearer, muat user + permission, cek RBAC. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
    private config: ConfigService,
    private auth: AuthService,
    private audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const queryToken: string | undefined = req.query?.access_token; // untuk link unduh/preview
    const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;
    if (!token) throw new UnauthorizedException('Token tidak ditemukan');

    let payload: { sub: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.config.get('JWT_ACCESS_SECRET') });
    } catch {
      throw new UnauthorizedException('Token tidak valid atau kedaluwarsa');
    }
    if (payload.typ !== 'access') throw new UnauthorizedException('Jenis token salah');

    const user = await this.auth.loadAuthUser(BigInt(payload.sub));
    if (!user) throw new UnauthorizedException('Akun tidak aktif');
    req.user = user;

    const superOnly = this.reflector.getAllAndOverride<boolean>(SUPER_ADMIN_KEY, targets);
    const perms = this.reflector.getAllAndOverride<PermissionCode[]>(PERMS_KEY, targets);
    const allowed =
      user.isSuperAdmin ||
      (!superOnly && (!perms || perms.length === 0 || perms.some((p) => user.permissions.includes(p))));

    if (!allowed) {
      // UAT-10: penolakan akses dicatat di audit log
      await this.audit.log({
        actorUserId: user.id, module: 'security', action: 'access_denied',
        payload: { method: req.method, path: req.originalUrl, required: perms ?? 'SUPER_ADMIN' }, ip: req.ip,
      });
      throw new ForbiddenException('Anda tidak memiliki izin untuk aksi ini');
    }
    return true;
  }
}
