import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { Block, parseBlocks } from './html';
import { BRAND, logoPath } from '../common/brand';

export interface PdfSigner {
  order: number; role: 'sign' | 'paraf'; status: string; name: string; position: string | null;
  token: string | null; signedAt: Date | null;
}
export interface PdfInput {
  number: string | null; title: string; subject: string | null; recipient: string | null; attachmentNote: string | null;
  place: string; docDate: Date | null; departmentName: string | null; contentHash: string | null;
  bodyHtml: string; // sudah disanitasi & placeholder terisi
  signers: PdfSigner[];
  draft: boolean;
}

const FONT = { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique', bi: 'Helvetica-BoldOblique' };
export const fmtLongDate = (d: Date) => d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtDateTime = (d: Date) => d.toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Render naskah dinas ke PDF A4: kop, kepala surat, isi, blok tanda tangan QR, footer verifikasi. */
@Injectable()
export class EDocPdfService {
  constructor(private config: ConfigService) {}

  get org() {
    return {
      name: this.config.get<string>('ORG_NAME', 'Digital Office'),
      address: this.config.get<string>('ORG_ADDRESS', ''),
      contact: this.config.get<string>('ORG_CONTACT', ''),
    };
  }

  verifyUrl(token: string) {
    return `${this.config.get('APP_URL', 'http://localhost:3000')}/verify/${token}`;
  }

  qrPng(token: string) {
    return QRCode.toBuffer(this.verifyUrl(token), { margin: 1, width: 300, errorCorrectionLevel: 'M' });
  }

  qrDataUrl(token: string) {
    return QRCode.toDataURL(this.verifyUrl(token), { margin: 1, width: 240, errorCorrectionLevel: 'M' });
  }

  async render(input: PdfInput): Promise<Buffer> {
    const qr = new Map<number, Buffer>();
    for (const s of input.signers) if (s.token && s.status === 'signed') qr.set(s.order, await this.qrPng(s.token));

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4', margins: { top: 48, bottom: 70, left: 64, right: 64 }, bufferPages: true,
        info: { Title: input.title, Subject: input.subject ?? input.title, Creator: 'Digital Office', Keywords: input.number ?? '' },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      const ink = '#111827';
      const date = input.docDate ?? new Date();

      // ── Kop surat: logo Umira kiri, identitas organisasi, garis teal + tembaga ──
      const org = this.org;
      const logo = logoPath();
      const logoW = logo ? 150 : 0;
      if (logo) doc.image(logo, L, 46, { width: logoW });
      const tx = L + (logo ? logoW + 16 : 0);
      const tw = W - (logo ? logoW + 16 : 0);
      const align = logo ? 'right' : 'center';
      doc.fillColor(BRAND.tealDeep).font(FONT.b).fontSize(14).text(org.name.toUpperCase(), tx, 46, { width: tw, align });
      if (input.departmentName) doc.fillColor(ink).font(FONT.r).fontSize(10).text(input.departmentName, tx, doc.y, { width: tw, align });
      if (org.address) doc.font(FONT.r).fontSize(8.5).fillColor('#374151').text(org.address, tx, doc.y, { width: tw, align });
      if (org.contact) doc.font(FONT.r).fontSize(8.5).fillColor('#374151').text(org.contact, tx, doc.y, { width: tw, align });
      const ky = Math.max(doc.y, logo ? 46 + logoW * (370 / 1734) : 0) + 8;
      doc.moveTo(L, ky).lineTo(L + W, ky).lineWidth(2.2).strokeColor(BRAND.teal).stroke();
      doc.moveTo(L, ky + 3.4).lineTo(L + W, ky + 3.4).lineWidth(0.8).strokeColor(BRAND.copper).stroke();
      doc.y = ky + 18;
      doc.x = L;
      doc.fillColor(ink);

      const letter = !!input.recipient?.trim();
      if (letter) {
        // Kepala surat: Nomor / Lampiran / Perihal + tempat, tanggal
        const y0 = doc.y;
        doc.font(FONT.r).fontSize(11).text(`${input.place}, ${fmtLongDate(date)}`, L, y0, { width: W, align: 'right' });
        doc.y = y0;
        const row = (k: string, v: string, bold = false) => {
          const y = doc.y;
          doc.font(FONT.r).fontSize(11).text(k, L, y, { width: 70 });
          doc.text(':', L + 70, y, { width: 10 });
          doc.font(bold ? FONT.b : FONT.r).text(v, L + 82, y, { width: W * 0.55 });
          doc.moveDown(0.15);
        };
        row('Nomor', input.number ?? '(terbit saat dikirim)');
        row('Lampiran', input.attachmentNote || '-');
        row('Perihal', input.subject || input.title, true);
        doc.moveDown(1);
        doc.font(FONT.r).fontSize(11).text('Kepada Yth.', L, doc.y, { width: W });
        doc.text(input.recipient!.trim(), { width: W * 0.6 });
        doc.moveDown(1);
      } else {
        doc.font(FONT.b).fontSize(13).text(input.title.toUpperCase(), L, doc.y, { width: W, align: 'center', underline: true });
        doc.font(FONT.r).fontSize(10.5).text(`Nomor: ${input.number ?? '(terbit saat dikirim)'}`, { width: W, align: 'center' });
        if (input.subject) doc.text(`Perihal: ${input.subject}`, { width: W, align: 'center' });
        doc.moveDown(1.2);
      }

      // ── Isi ──
      this.renderBlocks(doc, parseBlocks(input.bodyHtml), L, W);

      // ── Tanda tangan ──
      const signs = input.signers.filter((s) => s.role === 'sign').sort((a, b) => a.order - b.order);
      const parafs = input.signers.filter((s) => s.role === 'paraf').sort((a, b) => a.order - b.order);
      doc.moveDown(1.5);
      const colW = 200;
      const blockH = 175;
      const perRow = signs.length > 1 ? 2 : 1;
      for (let i = 0; i < signs.length; i += perRow) {
        if (doc.y + blockH > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const y0 = doc.y;
        const row = signs.slice(i, i + perRow);
        row.forEach((s, j) => {
          const x = perRow === 1 ? L + W - colW : L + (j === 0 ? 0 : W - colW);
          let y = y0;
          if (!letter && i === 0 && (perRow === 1 || j === row.length - 1)) {
            doc.font(FONT.r).fontSize(10.5).fillColor(ink).text(`${input.place}, ${fmtLongDate(date)}`, x, y, { width: colW, align: 'center' });
          }
          y += 16;
          doc.font(FONT.b).fontSize(10.5).fillColor(ink).text(s.position || 'Penanda tangan', x, y, { width: colW, align: 'center' });
          y = doc.y + 6;
          const img = qr.get(s.order);
          const q = 82;
          if (img) {
            doc.image(img, x + (colW - q) / 2, y, { width: q, height: q });
          } else {
            doc.save().dash(3, { space: 3 }).lineWidth(0.8).strokeColor('#9CA3AF').rect(x + (colW - q) / 2, y, q, q).stroke().undash().restore();
            doc.font(FONT.i).fontSize(7.5).fillColor('#6B7280').text('Menunggu tanda tangan', x + (colW - q) / 2, y + q / 2 - 8, { width: q, align: 'center' });
          }
          y += q + 6;
          doc.font(FONT.b).fontSize(10.5).fillColor(ink).text(s.name, x, y, { width: colW, align: 'center', underline: true });
          if (s.signedAt) doc.font(FONT.r).fontSize(7).fillColor('#4B5563').text(`Ditandatangani elektronik ${fmtDateTime(s.signedAt)}`, x, doc.y + 2, { width: colW, align: 'center' });
        });
        doc.y = y0 + blockH;
        doc.x = L;
      }

      if (parafs.length) {
        if (doc.y + 90 > doc.page.height - doc.page.margins.bottom) doc.addPage();
        doc.font(FONT.b).fontSize(8.5).fillColor(ink).text('Paraf', L, doc.y);
        const y0 = doc.y + 4;
        parafs.forEach((s, k) => {
          const x = L + k * 150;
          const img = qr.get(s.order);
          if (img) doc.image(img, x, y0, { width: 44, height: 44 });
          else doc.save().dash(2, { space: 2 }).lineWidth(0.6).strokeColor('#9CA3AF').rect(x, y0, 44, 44).stroke().undash().restore();
          doc.font(FONT.r).fontSize(7.5).fillColor(ink).text(s.name, x + 50, y0 + 6, { width: 96 });
          doc.fillColor('#4B5563').text(s.position ?? '', x + 50, doc.y, { width: 96 });
          if (s.signedAt) doc.text(fmtDateTime(s.signedAt), x + 50, doc.y, { width: 96 });
        });
        doc.y = y0 + 54;
      }

      // ── Footer & watermark tiap halaman ──
      const range = doc.bufferedPageRange();
      const appUrl = this.config.get('APP_URL', 'http://localhost:3000');
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0; // footer di area margin tanpa memicu halaman baru
        if (input.draft) {
          doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] })
            .font(FONT.b).fontSize(90).fillColor('#E5E7EB').opacity(0.55)
            .text('DRAF', 0, doc.page.height / 2 - 55, { width: doc.page.width, align: 'center', lineBreak: false })
            .restore();
          doc.opacity(1);
        }
        const fy = doc.page.height - 52;
        doc.moveTo(L, fy).lineTo(L + W, fy).lineWidth(0.5).strokeColor('#D1D5DB').stroke();
        const note = input.draft
          ? 'DRAF — dokumen belum ditandatangani lengkap dan belum berlaku.'
          : `Dokumen ini ditandatangani secara elektronik. Pindai QR code atau buka ${appUrl}/verify untuk memeriksa keasliannya.`;
        doc.font(FONT.r).fontSize(6.8).fillColor('#6B7280')
          .text(note, L, fy + 6, { width: W - 60, lineBreak: true })
          .text(`Nomor: ${input.number ?? '-'}  ·  Hash: ${input.contentHash ? input.contentHash.slice(0, 16) : '-'}`, L, doc.y + 1, { width: W - 60, lineBreak: false });
        doc.text(`Hal. ${p + 1}/${range.count}`, L + W - 60, fy + 6, { width: 60, align: 'right', lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    });
  }

  private renderBlocks(doc: PDFKit.PDFDocument, blocks: Block[], L: number, W: number) {
    const size: Record<Block['type'], number> = { p: 11, li: 11, blockquote: 10.5, h1: 15, h2: 13, h3: 12 };
    for (const b of blocks) {
      const fs = size[b.type];
      const runs = b.runs.filter((r) => r.text.length);
      if (!runs.length || runs.every((r) => !r.text.trim())) { doc.moveDown(0.55); continue; }
      if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
      const heading = b.type.startsWith('h');
      let x = L; let width = W;
      if (b.list) {
        const indent = 22 + b.list.depth * 16;
        x = L + indent; width = W - indent;
        const marker = b.list.ordered ? `${b.list.index}.` : '•';
        const y = doc.y;
        doc.font(FONT.r).fontSize(fs).fillColor('#111827').text(marker, x - 16, y, { width: 14, lineBreak: false });
        doc.y = y;
      }
      if (b.type === 'blockquote') { x = L + 18; width = W - 36; }
      const y = doc.y;
      runs.forEach((r, i) => {
        const bold = r.bold || heading;
        const font = bold && r.italic ? FONT.bi : bold ? FONT.b : r.italic ? FONT.i : FONT.r;
        const opts: PDFKit.Mixins.TextOptions = { continued: i < runs.length - 1, underline: r.underline, align: b.align, lineGap: 3 };
        doc.font(font).fontSize(fs).fillColor('#111827');
        if (i === 0) doc.text(r.text, x, y, { ...opts, width });
        else doc.text(r.text, opts);
      });
      doc.x = L;
      doc.moveDown(heading ? 0.5 : 0.45);
    }
  }
}
