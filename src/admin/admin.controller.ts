import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { RequestsService, STATUS_API } from '../requests/requests.service';
import { DocumentsService } from '../documents/documents.service';
import { CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/types';

@Controller('admin')
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private approvals: ApprovalsService,
    private requests: RequestsService,
    private docs: DocumentsService,
  ) {}

  /** Dashboard counts — cakupan data mengikuti hak lihat user. */
  @Get('stats')
  async stats(@CurrentUser() u: AuthUser) {
    const vis = { AND: [{ deletedAt: null }, this.requests.visibilityWhere(u)] };
    const since = new Date(); since.setMonth(since.getMonth() - 5); since.setDate(1); since.setHours(0, 0, 0, 0);

    const [byStatus, byPriority, myCreated, myAssigned, overdue, docCount, inbox, recentLogs, trendRows, pendingGlobal, decisions7d] = await Promise.all([
      this.prisma.request.groupBy({ by: ['status'], where: vis, _count: { _all: true } }),
      this.prisma.request.groupBy({ by: ['priority'], where: { ...vis, status: { notIn: ['closed', 'draft'] } }, _count: { _all: true } }),
      this.prisma.request.groupBy({ by: ['status'], where: { deletedAt: null, requesterUserId: u.id }, _count: { _all: true } }),
      this.prisma.request.count({ where: { deletedAt: null, assigneeUserId: u.id, status: { in: ['submitted', 'in_progress', 'approved'] } } }),
      this.prisma.request.count({ where: { ...vis, dueDate: { lt: new Date() }, status: { in: ['submitted', 'in_progress', 'pending_approval'] } } }),
      this.prisma.file.count({ where: { AND: [{ deletedAt: null, isActive: true }, this.docs.visibleFilesWhere(u)] } }),
      this.approvals.inbox(u),
      this.prisma.requestLog.findMany({
        where: { request: vis }, orderBy: { createdAt: 'desc' }, take: 12,
        include: { actor: { select: { id: true, fullName: true, photoUrl: true } }, request: { select: { id: true, refCode: true, title: true } } },
      }),
      this.prisma.request.findMany({ where: { ...vis, createdAt: { gte: since } }, select: { createdAt: true, status: true } }),
      this.prisma.approvalInstance.count({ where: { status: 'in_progress' } }),
      this.prisma.approvalDecision.count({ where: { decidedAt: { gte: new Date(Date.now() - 7 * 86400_000) } } }),
    ]);

    const months: { key: string; label: string; created: number; approved: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(since); d.setMonth(since.getMonth() + i);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('id-ID', { month: 'short' }), created: 0, approved: 0 });
    }
    for (const r of trendRows) {
      const m = months.find((x) => x.key === `${r.createdAt.getFullYear()}-${r.createdAt.getMonth()}`);
      if (m) { m.created++; if (r.status === 'approved' || r.status === 'closed') m.approved++; }
    }

    return {
      requestsByStatus: Object.fromEntries(byStatus.map((s) => [STATUS_API[s.status], s._count._all])),
      openByPriority: Object.fromEntries(byPriority.map((p) => [p.priority, p._count._all])),
      mine: {
        created: myCreated.reduce((a, b) => a + b._count._all, 0),
        byStatus: Object.fromEntries(myCreated.map((s) => [STATUS_API[s.status], s._count._all])),
        assignedOpen: myAssigned,
      },
      pendingApprovals: inbox.length,
      pendingApprovalsGlobal: u.isSuperAdmin ? pendingGlobal : undefined,
      inboxPreview: inbox.slice(0, 5),
      overdue,
      documents: docCount,
      decisionsLast7Days: decisions7d,
      trend: months.map(({ label, created, approved }) => ({ label, created, approved })),
      recentActivity: recentLogs,
    };
  }
}
