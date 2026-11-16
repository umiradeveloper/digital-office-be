import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService } from './approvals.service';
import { STATUS_LABEL } from '../requests/requests.service';

/** Job terjadwal: pengingat due date (BR-10/BR-11) & kedaluwarsa delegasi (BR-04). */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  constructor(private prisma: PrismaService, private notif: NotificationsService, private approvals: ApprovalsService) {}

  private async recipients(r: { id: bigint; status: string; requesterUserId: bigint; assigneeUserId: bigint | null; typeId: bigint; departmentId: bigint | null; priority: any; amount: any }) {
    const ids = [r.requesterUserId, ...(r.assigneeUserId ? [r.assigneeUserId] : [])];
    if (r.status === 'pending_approval') {
      const inst = await this.prisma.approvalInstance.findFirst({ where: { requestId: r.id, status: 'in_progress' } });
      if (inst) ids.push(...(await this.approvals.currentActors(inst, r)).actors.map((a) => a.userId));
    }
    return ids;
  }

  /** Tiap jam: request jatuh tempo dalam 24 jam ke depan → due_tomorrow (sekali). */
  @Cron(CronExpression.EVERY_HOUR)
  async dueTomorrow() {
    const now = new Date();
    const rows = await this.prisma.request.findMany({
      where: {
        deletedAt: null, status: { in: ['submitted', 'in_progress', 'pending_approval'] },
        dueDate: { gt: now, lte: new Date(now.getTime() + 24 * 3600_000) },
        notifications: { none: { eventType: 'due_tomorrow' } },
      },
    });
    for (const r of rows) {
      await this.notif.notifyMany('due_tomorrow', await this.recipients(r), {
        requestId: r.id, priority: r.priority,
        vars: { ref: r.refCode, judul: r.title, due: r.dueDate!.toLocaleString('id-ID'), status: STATUS_LABEL[r.status] },
      });
    }
    if (rows.length) this.logger.log(`Pengingat due-tomorrow: ${rows.length} request`);
  }

  /** Harian 08:00: request lewat due date → overdue (maks sekali per 24 jam). */
  @Cron('0 8 * * *')
  async overdue() {
    const now = new Date();
    const rows = await this.prisma.request.findMany({
      where: {
        deletedAt: null, status: { in: ['submitted', 'in_progress', 'pending_approval'] }, dueDate: { lt: now },
        notifications: { none: { eventType: 'overdue', createdAt: { gt: new Date(now.getTime() - 20 * 3600_000) } } },
      },
    });
    for (const r of rows) {
      await this.notif.notifyMany('overdue', await this.recipients(r), {
        requestId: r.id, priority: r.priority,
        vars: { ref: r.refCode, judul: r.title, due: r.dueDate!.toLocaleString('id-ID'), status: STATUS_LABEL[r.status] },
      });
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireDelegations() {
    const r = await this.prisma.delegation.updateMany({ where: { status: 'active', toDate: { lt: new Date() } }, data: { status: 'expired' } });
    if (r.count) this.logger.log(`${r.count} delegasi kedaluwarsa`);
  }
}
