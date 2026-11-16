import { Prisma } from '@prisma/client';
import { optBigInt, parseDate } from '../common/utils';

/** Filter audit trail (dipakai controller & ekspor; file terpisah agar tidak ada import melingkar). */
export function auditWhere(q: Record<string, string | undefined>): Prisma.AuditLogWhereInput {
  const from = parseDate(q.from); const to = parseDate(q.to, true);
  return {
    actorUserId: optBigInt(q.actor),
    module: q.module || undefined,
    entityType: q.entity || undefined,
    entityId: q.entityId || undefined,
    action: q.action ? { contains: q.action } : undefined,
    createdAt: from || to ? { gte: from, lte: to } : undefined,
  };
}
