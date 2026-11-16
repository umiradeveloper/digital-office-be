import { Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../documents/storage.service';
import { RequestsService, STATUS_LABEL } from '../requests/requests.service';
import { PRIORITY_LABEL } from '../approvals/approvals.service';
import { DocumentsService } from '../documents/documents.service';
import { AuthUser } from '../common/types';
import { parseDate } from '../common/utils';
import { auditWhere } from '../audit/audit.where';
import { BRAND, logoPath } from '../common/brand';

type Q = Record<string, string>;

const fmtDate = (d?: Date | null) => (d ? d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');

const MIME_FILTER: Record<string, Prisma.FileWhereInput> = {
  pdf: { mimeType: 'application/pdf' },
  image: { mimeType: { startsWith: 'image/' } },
  office: { OR: [{ mimeType: { contains: 'officedocument' } }, { mimeType: { contains: 'msword' } }, { mimeType: { contains: 'ms-excel' } }] },
};

/** FR-EXP-01..03 — ekspor Excel & PDF dengan filter rentang waktu, departemen, status, tipe dokumen. */
@Injectable()
export class ExportsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private storage: StorageService,
    private requests: RequestsService,
    private docs: DocumentsService,
  ) {}

  private async record(user: AuthUser, module: string, format: 'xlsx' | 'pdf', filters: Q, buf: Buffer, rowCount: number) {
    const key = `exports/${user.id}/${module}-${stamp()}.${format}`;
    await this.storage.save(key, buf);
    await this.prisma.exportJob.create({ data: { userId: user.id, module, format, filtersJson: filters as Prisma.InputJsonValue, filePath: key, rowCount, status: 'done' } });
    await this.audit.log({ actorUserId: user.id, module: 'export', action: `export_${module}_${format}`, payload: { filters, rowCount } });
  }

  private file(buf: Buffer, name: string, type: string) {
    return new StreamableFile(buf, { type, disposition: `attachment; filename="${name}"`, length: buf.length });
  }

  private workbook() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Digital Office';
    wb.created = new Date();
    return wb;
  }

  private sheet(wb: ExcelJS.Workbook, name: string, columns: Partial<ExcelJS.Column>[], filters: Q) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = columns;
    ws.spliceRows(1, 0, [`Digital Office — ${name}`], [`Dibuat: ${fmtDate(new Date())} · Filter: ${JSON.stringify(filters)}`]);
    ws.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF024558' } };
    ws.getRow(2).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
    const header = ws.getRow(3);
    header.values = columns.map((c) => c.header as string);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF075F78' } };
    header.alignment = { vertical: 'middle' };
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };
    return ws;
  }

  private requestWhere(user: AuthUser, q: Q) {
    return this.requests.buildWhere(user, { ...q, type: q.type ?? q.requestType });
  }

  // ───────── Excel ─────────

  async requestsXlsx(q: Q, user: AuthUser) {
    const rows = await this.prisma.request.findMany({
      where: this.requestWhere(user, q), orderBy: { createdAt: 'desc' }, take: 50_000,
      include: {
        type: true, requester: { include: { department: true } }, assignee: true,
        instances: { orderBy: { id: 'desc' }, take: 1, include: { flow: true } },
      },
    });
    const wb = this.workbook();
    const ws = this.sheet(wb, 'Daftar Request', [
      { header: 'Ref', key: 'ref', width: 22 }, { header: 'Judul', key: 'title', width: 40 },
      { header: 'Tipe', key: 'type', width: 20 }, { header: 'Status', key: 'status', width: 18 },
      { header: 'Prioritas', key: 'priority', width: 11 }, { header: 'Nilai', key: 'amount', width: 16, style: { numFmt: '#,##0' } },
      { header: 'Pengaju', key: 'requester', width: 24 }, { header: 'Departemen', key: 'dept', width: 22 },
      { header: 'Penanggung Jawab', key: 'assignee', width: 24 }, { header: 'Alur Approval', key: 'flow', width: 26 },
      { header: 'Dibuat', key: 'created', width: 20 }, { header: 'Dikirim', key: 'submitted', width: 20 },
      { header: 'Due Date', key: 'due', width: 20 }, { header: 'Ditutup', key: 'closed', width: 20 },
    ], q);
    for (const r of rows) {
      ws.addRow({
        ref: r.refCode, title: r.title, type: r.type.name, status: STATUS_LABEL[r.status], priority: PRIORITY_LABEL[r.priority],
        amount: r.amount ? Number(r.amount) : null, requester: r.requester.fullName, dept: r.requester.department?.name ?? '',
        assignee: r.assignee?.fullName ?? '', flow: r.instances[0]?.flow.name ?? '', created: fmtDate(r.createdAt),
        submitted: fmtDate(r.submittedAt), due: fmtDate(r.dueDate), closed: fmtDate(r.closedAt),
      });
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await this.record(user, 'requests', 'xlsx', q, buf, rows.length);
    return this.file(buf, `requests-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  async approvalsXlsx(q: Q, user: AuthUser) {
    const from = parseDate(q.from); const to = parseDate(q.to, true);
    const rows = await this.prisma.approvalDecision.findMany({
      where: {
        decidedAt: from || to ? { gte: from, lte: to } : undefined,
        instance: { request: this.requestWhere(user, { ...q, from: '', to: '' }) },
      },
      orderBy: { decidedAt: 'desc' }, take: 50_000,
      include: {
        approver: true, onBehalfOf: true, delegatedToUser: true,
        instance: { include: { flow: true, request: { include: { requester: { include: { department: true } } } } } },
      },
    });
    const wb = this.workbook();
    const ws = this.sheet(wb, 'Riwayat Approval', [
      { header: 'Waktu', key: 'at', width: 20 }, { header: 'Ref', key: 'ref', width: 22 }, { header: 'Judul', key: 'title', width: 36 },
      { header: 'Alur', key: 'flow', width: 24 }, { header: 'Level', key: 'level', width: 8 }, { header: 'Keputusan', key: 'decision', width: 12 },
      { header: 'Oleh', key: 'by', width: 24 }, { header: 'Atas nama (delegasi)', key: 'behalf', width: 24 },
      { header: 'Didelegasikan ke', key: 'to', width: 24 }, { header: 'Catatan', key: 'comment', width: 40 },
      { header: 'Departemen pengaju', key: 'dept', width: 22 },
    ], q);
    const label = { approve: 'Approve', reject: 'Reject', delegate: 'Delegate' } as const;
    for (const d of rows) {
      ws.addRow({
        at: fmtDate(d.decidedAt), ref: d.instance.request.refCode, title: d.instance.request.title, flow: d.instance.flow.name,
        level: d.levelOrder, decision: label[d.decision], by: d.approver.fullName, behalf: d.onBehalfOf?.fullName ?? '',
        to: d.delegatedToUser?.fullName ?? '', comment: d.comment ?? '', dept: d.instance.request.requester.department?.name ?? '',
      });
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await this.record(user, 'approvals', 'xlsx', q, buf, rows.length);
    return this.file(buf, `approval-history-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  private fileLogWhere(user: AuthUser, q: Q): Prisma.FileAccessLogWhereInput {
    const from = parseDate(q.from); const to = parseDate(q.to, true);
    const fileAnd: Prisma.FileWhereInput[] = [this.docs.visibleFilesWhere(user)];
    if (q.dept) fileAnd.push({ folder: { departmentId: BigInt(q.dept) } });
    if (q.docType && MIME_FILTER[q.docType]) fileAnd.push(MIME_FILTER[q.docType]);
    return { createdAt: from || to ? { gte: from, lte: to } : undefined, action: (q.action as any) || undefined, file: { AND: fileAnd } };
  }

  async fileAccessXlsx(q: Q, user: AuthUser) {
    const rows = await this.prisma.fileAccessLog.findMany({
      where: this.fileLogWhere(user, q), orderBy: { createdAt: 'desc' }, take: 100_000,
      include: { user: true, file: { include: { folder: { include: { department: true } } } } },
    });
    const wb = this.workbook();
    const ws = this.sheet(wb, 'Akses Dokumen', [
      { header: 'Waktu', key: 'at', width: 20 }, { header: 'Aksi', key: 'action', width: 12 }, { header: 'Pengguna', key: 'user', width: 24 },
      { header: 'Email', key: 'email', width: 28 }, { header: 'Dokumen', key: 'file', width: 40 }, { header: 'Versi', key: 'ver', width: 7 },
      { header: 'Folder', key: 'folder', width: 22 }, { header: 'Unit', key: 'dept', width: 20 }, { header: 'IP', key: 'ip', width: 16 },
    ], q);
    for (const l of rows) {
      ws.addRow({
        at: fmtDate(l.createdAt), action: l.action, user: l.user.fullName, email: l.user.email, file: l.file.originalName,
        ver: l.file.version, folder: l.file.folder.name, dept: l.file.folder.department?.name ?? 'Umum', ip: l.ipAddress ?? '',
      });
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await this.record(user, 'file-access', 'xlsx', q, buf, rows.length);
    return this.file(buf, `document-access-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  async auditXlsx(q: Q, user: AuthUser) {
    const rows = await this.prisma.auditLog.findMany({ where: auditWhere(q), orderBy: { createdAt: 'desc' }, take: 100_000, include: { actor: true } });
    const wb = this.workbook();
    const ws = this.sheet(wb, 'Audit Trail', [
      { header: 'Waktu', key: 'at', width: 20 }, { header: 'Aktor', key: 'actor', width: 24 }, { header: 'Modul', key: 'module', width: 14 },
      { header: 'Aksi', key: 'action', width: 26 }, { header: 'Entitas', key: 'entity', width: 18 }, { header: 'ID', key: 'eid', width: 10 },
      { header: 'IP', key: 'ip', width: 16 }, { header: 'Payload', key: 'payload', width: 60 },
    ], q);
    for (const a of rows) {
      ws.addRow({
        at: fmtDate(a.createdAt), actor: a.actor?.fullName ?? 'Sistem', module: a.module, action: a.action,
        entity: a.entityType ?? '', eid: a.entityId ?? '', ip: a.ipAddress ?? '', payload: a.payloadJson ? JSON.stringify(a.payloadJson).slice(0, 32000) : '',
      });
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await this.record(user, 'audit', 'xlsx', q, buf, rows.length);
    return this.file(buf, `audit-trail-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  // ───────── PDF (ringkas request, approval, dokumen, aktivitas) ─────────

  async reportPdf(q: Q, user: AuthUser) {
    const where = this.requestWhere(user, q);
    const from = parseDate(q.from); const to = parseDate(q.to, true);
    const sections = (q.sections ?? 'requests,approvals,documents,activity').split(',');

    const [byStatus, byPriority, list, decisions, docCount, docAgg, accessByAction, topActivity, dept] = await Promise.all([
      this.prisma.request.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.request.groupBy({ by: ['priority'], where, _count: { _all: true } }),
      this.prisma.request.findMany({ where, orderBy: { createdAt: 'desc' }, take: 60, include: { type: true, requester: true } }),
      this.prisma.approvalDecision.groupBy({
        by: ['decision'], _count: { _all: true },
        where: { decidedAt: from || to ? { gte: from, lte: to } : undefined, instance: { request: this.requestWhere(user, { ...q, from: '', to: '' }) } },
      }),
      this.prisma.file.count({
        where: {
          AND: [
            { deletedAt: null, isActive: true, createdAt: from || to ? { gte: from, lte: to } : undefined },
            this.docs.visibleFilesWhere(user),
            ...(q.dept ? [{ folder: { departmentId: BigInt(q.dept) } }] : []),
            ...(q.docType && MIME_FILTER[q.docType] ? [MIME_FILTER[q.docType]] : []),
          ],
        },
      }),
      this.prisma.file.aggregate({ _sum: { sizeBytes: true }, where: { deletedAt: null, ...(q.dept ? { folder: { departmentId: BigInt(q.dept) } } : {}) } }),
      this.prisma.fileAccessLog.groupBy({ by: ['action'], _count: { _all: true }, where: this.fileLogWhere(user, q) }),
      this.prisma.auditLog.groupBy({ by: ['module'], _count: { _all: true }, where: { createdAt: from || to ? { gte: from, lte: to } : undefined } }),
      q.dept ? this.prisma.department.findUnique({ where: { id: BigInt(q.dept) } }) : null,
    ]);

    const total = byStatus.reduce((a, b) => a + b._count._all, 0);
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: 'Laporan Digital Office', Author: user.fullName } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 84;
      const accent = BRAND.teal;
      const cyan = BRAND.copper;

      // Header: logo Umira + judul, garis teal & tembaga
      const logo = logoPath();
      if (logo) doc.image(logo, 42, 26, { height: 40 });
      else doc.fillColor(BRAND.teal).font('Helvetica-Bold').fontSize(18).text('UMIRA', 42, 34);
      doc.font('Helvetica-Bold').fillColor(BRAND.tealDeep).fontSize(18).text('Laporan Ringkas', 42, 28, { width: W, align: 'right' });
      doc.font('Helvetica').fillColor(BRAND.muted).fontSize(8.5).text(`Digital Office · dibuat ${fmtDate(new Date())} oleh ${user.fullName}`, 42, 52, { width: W, align: 'right' });
      doc.rect(0, 80, doc.page.width, 4).fill(BRAND.teal);
      doc.rect(0, 84, doc.page.width, 1.5).fill(BRAND.copper);
      doc.moveDown(3);
      doc.y = 112;

      const filterTxt = [
        from || to ? `Periode: ${from ? from.toLocaleDateString('id-ID') : '…'} – ${to ? to.toLocaleDateString('id-ID') : '…'}` : 'Periode: semua',
        `Departemen: ${dept?.name ?? 'semua'}`,
        q.status ? `Status: ${q.status}` : null,
        q.docType ? `Tipe dokumen: ${q.docType}` : null,
      ].filter(Boolean).join('   |   ');
      doc.fillColor('#374151').fontSize(9).text(filterTxt, 42, doc.y, { width: W });
      doc.moveDown(1.2);

      const heading = (t: string) => {
        if (doc.y > doc.page.height - 140) doc.addPage();
        doc.moveDown(0.6);
        doc.fillColor(accent).fontSize(13).text(t, 42);
        doc.moveTo(42, doc.y + 2).lineTo(42 + W, doc.y + 2).lineWidth(1).strokeColor(cyan).stroke();
        doc.moveDown(0.6);
      };
      const kv = (items: [string, string | number][]) => {
        const colW = W / Math.min(4, items.length);
        const y0 = doc.y;
        items.forEach(([k, v], i) => {
          const x = 42 + (i % 4) * colW; const y = y0 + Math.floor(i / 4) * 44;
          doc.roundedRect(x, y, colW - 8, 38, 5).fillAndStroke(BRAND.tealSoft, BRAND.line);
          doc.fillColor(BRAND.tealDeep).fontSize(14).text(String(v), x + 8, y + 5, { width: colW - 20 });
          doc.fillColor('#6B7280').fontSize(8).text(k, x + 8, y + 24, { width: colW - 20 });
        });
        doc.y = y0 + Math.ceil(items.length / 4) * 44 + 4;
        doc.x = 42;
      };
      const table = (headers: string[], widths: number[], rows: string[][]) => {
        const drawRow = (cells: string[], bold = false, fill?: string) => {
          if (doc.y > doc.page.height - 60) doc.addPage();
          const y = doc.y; let x = 42;
          const h = Math.max(...cells.map((c, i) => doc.fontSize(8).heightOfString(c, { width: widths[i] - 6 }))) + 6;
          if (fill) doc.rect(42, y, W, h).fill(fill);
          cells.forEach((c, i) => {
            doc.fillColor(bold ? '#FFFFFF' : '#1F2937').fontSize(8).text(c, x + 3, y + 3, { width: widths[i] - 6 });
            x += widths[i];
          });
          doc.y = y + h; doc.x = 42;
        };
        drawRow(headers, true, accent);
        rows.forEach((r, i) => drawRow(r, false, i % 2 ? BRAND.rowAlt : undefined));
      };

      if (sections.includes('requests')) {
        heading('Ringkasan Request');
        const get = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
        kv([
          ['Total request', total], ['Pending approval', get('pending_approval')], ['Approved', get('approved')], ['Rejected', get('rejected')],
          ['Draft', get('draft')], ['Submitted', get('submitted')], ['In-Progress', get('in_progress')], ['Closed', get('closed')],
        ]);
        doc.fillColor('#374151').fontSize(9).text(
          'Per prioritas: ' + (['crit', 'high', 'med', 'low'] as const).map((p) => `${PRIORITY_LABEL[p]} ${byPriority.find((b) => b.priority === p)?._count._all ?? 0}`).join(' · '),
        );
        doc.moveDown(0.6);
        table(
          ['Ref', 'Judul', 'Tipe', 'Pengaju', 'Status', 'Prioritas', 'Dibuat'],
          [78, 140, 60, 70, 60, 45, 58].map((w) => (w * W) / 511),
          list.map((r) => [r.refCode, r.title, r.type.name, r.requester.fullName, STATUS_LABEL[r.status], PRIORITY_LABEL[r.priority], r.createdAt.toLocaleDateString('id-ID')]),
        );
        if (total > list.length) doc.fillColor('#6B7280').fontSize(8).text(`… menampilkan ${list.length} dari ${total} request terbaru. Gunakan ekspor Excel untuk data lengkap.`);
      }
      if (sections.includes('approvals')) {
        heading('Approval');
        const g = (d: string) => decisions.find((x) => x.decision === d)?._count._all ?? 0;
        kv([['Keputusan approve', g('approve')], ['Keputusan reject', g('reject')], ['Delegasi', g('delegate')], ['Total keputusan', g('approve') + g('reject') + g('delegate')]]);
      }
      if (sections.includes('documents')) {
        heading('Dokumen');
        const ga = (a: string) => accessByAction.find((x) => x.action === a)?._count._all ?? 0;
        const mb = Number(docAgg._sum.sizeBytes ?? 0n) / 1024 / 1024;
        kv([['Dokumen aktif', docCount], ['Total penyimpanan', `${mb.toFixed(1)} MB`], ['Dilihat', ga('viewed')], ['Diunduh', ga('downloaded')], ['Diunggah', ga('uploaded')], ['Dibagikan', ga('shared')]]);
      }
      if (sections.includes('activity')) {
        heading('Aktivitas Sistem (audit trail per modul)');
        table(['Modul', 'Jumlah aktivitas'], [W * 0.6, W * 0.4], topActivity.sort((a, b) => b._count._all - a._count._all).map((a) => [a.module, String(a._count._all)]));
      }

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fillColor('#9CA3AF').fontSize(7).text(
          `Digital Office · Rahasia internal · Dibuat ${new Date().toISOString()} · Hal. ${i + 1}/${range.count}`,
          42, doc.page.height - 30, { width: W, align: 'center', lineBreak: false },
        );
      }
      doc.end();
    });

    await this.record(user, 'report', 'pdf', q, buf, total);
    return this.file(buf, `laporan-${stamp()}.pdf`, 'application/pdf');
  }

  async history(user: AuthUser) {
    return this.prisma.exportJob.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 30 });
  }
}
