import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import * as nodemailer from 'nodemailer';
import { Priority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_TEMPLATES } from './templates';
import { PRIORITY_RANK } from '../common/permissions';
import { renderTemplate } from '../common/utils';
import { BRAND } from '../common/brand';

export interface NotifyOptions {
  requestId?: bigint;
  priority?: Priority;
  vars?: Record<string, string | number | undefined | null>;
  path?: string; // path relatif di web app
}

/**
 * Notifikasi e-mail (FR-NTF-01..03, BR-10).
 * Antrian berbasis tabel `notifications` (status pending → sent/failed) diproses worker interval
 * dengan retry — stateless & aman untuk multi-instance karena klaim baris memakai updateMany atomik.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;
  private processing = false;

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  onModuleInit() {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('SMTP_HOST', 'localhost'),
      port: Number(this.config.get('SMTP_PORT', 1025)),
      secure: this.config.get('SMTP_SECURE') === 'true',
      auth: this.config.get('SMTP_USER') ? { user: this.config.get('SMTP_USER'), pass: this.config.get('SMTP_PASS') } : undefined,
    });
  }

  /** Antrikan e-mail untuk satu user. Mengembalikan null bila template nonaktif / di bawah threshold. */
  async notify(eventType: string, userId: bigint, opts: NotifyOptions = {}) {
    const tpl =
      (await this.prisma.notificationTemplate.findUnique({ where: { eventType } })) ??
      (DEFAULT_TEMPLATES[eventType] ? { ...DEFAULT_TEMPLATES[eventType], enabled: true, minPriority: DEFAULT_TEMPLATES[eventType].minPriority ?? 'low' } : null);
    if (!tpl || !tpl.enabled) return null;
    if (opts.priority && PRIORITY_RANK[opts.priority] < PRIORITY_RANK[tpl.minPriority]) return null;

    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null, status: 'active' } });
    if (!user) return null;
    const appUrl = this.config.get('APP_URL', 'http://localhost:3000');
    const link = appUrl + (opts.path ?? (opts.requestId ? `/requests/${opts.requestId}` : '/'));
    const vars = { nama: user.fullName, link, ...opts.vars };
    return this.prisma.notification.create({
      data: {
        userId, requestId: opts.requestId, eventType,
        subject: renderTemplate(tpl.subject, vars),
        body: renderTemplate(tpl.body, vars),
      },
    });
  }

  async notifyMany(eventType: string, userIds: bigint[], opts: NotifyOptions = {}) {
    const unique = [...new Set(userIds.map(String))].map((s) => BigInt(s));
    return Promise.all(unique.map((id) => this.notify(eventType, id, opts)));
  }

  /** Worker: kirim antrian setiap 5 detik (target < 60 detik — AC 10.4). */
  @Interval(5000)
  async processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      const maxAttempts = Number(this.config.get('NOTIF_MAX_ATTEMPTS', 3));
      const batch = await this.prisma.notification.findMany({
        where: { status: 'pending', attempts: { lt: maxAttempts } },
        orderBy: { createdAt: 'asc' }, take: 25,
        include: { user: { select: { email: true, fullName: true } } },
      });
      for (const n of batch) {
        // klaim atomik agar tidak terkirim dobel oleh instance lain
        const claim = await this.prisma.notification.updateMany({
          where: { id: n.id, status: 'pending', attempts: n.attempts }, data: { attempts: { increment: 1 } },
        });
        if (claim.count === 0) continue;
        try {
          await this.transporter.sendMail({
            from: this.config.get('MAIL_FROM', 'Digital Office <no-reply@digital-office.local>'),
            to: `"${n.user.fullName}" <${n.user.email}>`,
            subject: n.subject,
            text: n.body,
            html: this.wrapHtml(n.subject, n.body),
          });
          await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'sent', sentAt: new Date(), error: null } });
        } catch (err) {
          const final = n.attempts + 1 >= maxAttempts;
          await this.prisma.notification.update({
            where: { id: n.id }, data: { status: final ? 'failed' : 'pending', error: (err as Error).message.slice(0, 2000) },
          });
          this.logger.warn(`Gagal kirim notifikasi #${n.id} (percobaan ${n.attempts + 1}): ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Worker notifikasi error: ${(err as Error).message}`);
    } finally {
      this.processing = false;
    }
  }

  private wrapHtml(subject: string, body: string) {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const html = esc(body).replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${BRAND.teal};font-weight:600">$1</a>`).replace(/\n/g, '<br>');
    const logo = `${this.config.get('APP_URL', 'http://localhost:3000')}/brand/umira-logo-white.png`;
    return `<!doctype html><html><body style="margin:0;background:#F2F6F7;font-family:Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:14px;color:${BRAND.ink};overflow:hidden">
<tr><td style="padding:18px 28px;background:${BRAND.teal};background-image:linear-gradient(135deg,${BRAND.teal},${BRAND.tealDeep})">
<img src="${logo}" alt="UMIRA" height="34" style="display:block;height:34px;border:0"><div style="color:#cfe3e9;font-size:12px;margin-top:4px">Digital Office</div></td></tr>
<tr><td style="height:3px;background:${BRAND.copper};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 28px"><h2 style="margin:0 0 16px;font-size:18px;color:${BRAND.tealDeep}">${esc(subject)}</h2>
<div style="font-size:14px;line-height:1.6;color:#3C5862">${html}</div></td></tr>
<tr><td style="padding:14px 28px;border-top:1px solid ${BRAND.line};font-size:12px;color:${BRAND.muted}">E-mail otomatis Digital Office Umira — mohon tidak membalas.</td></tr>
</table></td></tr></table></body></html>`;
  }
}
