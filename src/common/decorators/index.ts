import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { PermissionCode } from '../permissions';
import { AuthUser } from '../types';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMS_KEY = 'permissions';
/** Lolos bila user memiliki SALAH SATU permission yang disebut (super admin selalu lolos). */
export const RequirePermissions = (...perms: PermissionCode[]) => SetMetadata(PERMS_KEY, perms);

export const SUPER_ADMIN_KEY = 'superAdminOnly';
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  const req = ctx.switchToHttp().getRequest();
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : undefined) ?? req.ip;
});
