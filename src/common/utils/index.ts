import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuthUser } from '../types';
import { PermissionCode } from '../permissions';

export function toBigInt(v: unknown, name = 'id'): bigint {
  try {
    if (v === null || v === undefined || v === '') throw new Error();
    return BigInt(v as string);
  } catch {
    throw new BadRequestException(`${name} tidak valid`);
  }
}

export function optBigInt(v: unknown): bigint | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  try { return BigInt(v as string); } catch { return undefined; }
}

export function pageParams(q: { page?: any; perPage?: any }, maxPer = 100) {
  const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
  const perPage = Math.min(maxPer, Math.max(1, parseInt(q.perPage ?? '20', 10) || 20));
  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}

export function paginated<T>(data: T[], total: number, page: number, perPage: number) {
  return { __paginated: true, data, meta: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) } };
}

export function can(user: AuthUser, ...perms: PermissionCode[]) {
  return user.isSuperAdmin || perms.some((p) => user.permissions.includes(p));
}

export function parseDate(v?: string, endOfDay = false): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v)) d.setHours(23, 59, 59, 999);
  return d;
}

export function renderTemplate(tpl: string, vars: Record<string, string | number | undefined | null>) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? '').toString());
}

/** Delegasi yang sedang berlaku saat ini (BR-04). */
export function activeDelegationWhere(now = new Date()): Prisma.DelegationWhereInput {
  return { status: 'active', deletedAt: null, fromDate: { lte: now }, toDate: { gte: now } };
}
