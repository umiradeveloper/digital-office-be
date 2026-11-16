import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { serialize } from '../common/interceptors/transform.interceptor';

export interface AuditEntry {
  actorUserId?: bigint | null;
  module: string;
  action: string;
  entityType?: string;
  entityId?: bigint | string | null;
  payload?: unknown;
  ip?: string | null;
}

/** Audit trail global — append-only (BR-09, NFR-06). Tidak ada endpoint update/delete. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private prisma: PrismaService) {}

  async log(e: AuditEntry, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    try {
      await db.auditLog.create({
        data: {
          actorUserId: e.actorUserId ?? null,
          module: e.module,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId != null ? e.entityId.toString() : null,
          payloadJson: e.payload == null ? undefined : (serialize(e.payload) as Prisma.InputJsonValue),
          ipAddress: e.ip ?? null,
        },
      });
    } catch (err) {
      if (tx) throw err;
      this.logger.error(`Gagal menulis audit log: ${(err as Error).message}`);
    }
  }
}
