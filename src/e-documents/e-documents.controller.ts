import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { EDocumentsService } from './e-documents.service';
import { sanitizeHtml } from './html';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../documents/storage.service';
import { ClientIp, CurrentUser, Public, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { toBigInt } from '../common/utils';

class SignerDto {
  @IsString() userId: string;
  @IsIn(['sign', 'paraf'], { message: 'Peran penanda tangan harus sign atau paraf' }) role: 'sign' | 'paraf';
}
class EDocDto {
  @IsString() @MinLength(3, { message: 'Judul minimal 3 karakter' }) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(255) subject?: string;
  @IsOptional() @IsString() @MaxLength(2000) recipient?: string;
  @IsOptional() @IsString() @MaxLength(255) attachmentNote?: string;
  @IsOptional() @IsString() @MaxLength(80) place?: string;
  @IsOptional() @IsDateString({}, { message: 'Tanggal naskah tidak valid' }) docDate?: string;
  @IsString() bodyHtml: string;
  @IsOptional() @IsString() templateId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SignerDto) signers?: SignerDto[];
}
class PartialEDocDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(255) subject?: string;
  @IsOptional() @IsString() @MaxLength(2000) recipient?: string;
  @IsOptional() @IsString() @MaxLength(255) attachmentNote?: string;
  @IsOptional() @IsString() @MaxLength(80) place?: string;
  @IsOptional() @IsString() docDate?: string;
  @IsOptional() @IsString() bodyHtml?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SignerDto) signers?: SignerDto[];
}
class SignDto {
  @IsString() @MinLength(1, { message: 'Masukkan kata sandi untuk menandatangani' }) password: string;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}
class SubmitDto {
  @IsOptional() @IsIn(['low', 'med', 'high', 'crit'], { message: 'Prioritas tidak valid' }) priority?: 'low' | 'med' | 'high' | 'crit';
  @IsOptional() @IsString() dueDate?: string | null;
}
class RejectDto { @IsString() @MinLength(5, { message: 'Alasan minimal 5 karakter' }) @MaxLength(2000) reason: string; }

class TemplateDto {
  @IsString() @MinLength(3) @MaxLength(150) name: string;
  @IsString() @Matches(/^[A-Z0-9-]{2,30}$/i, { message: 'Kode 2–30 karakter: huruf, angka, atau -' }) code: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsString() bodyHtml: string;
  @IsOptional() @IsString() @MaxLength(120) numberFormat?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class PartialTemplateDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsOptional() @IsString() bodyHtml?: string;
  @IsOptional() @IsString() @MaxLength(120) numberFormat?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('e-documents')
export class EDocumentsController {
  constructor(private edocs: EDocumentsService, private storage: StorageService, private prisma: PrismaService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) { return this.edocs.list(u, q); }

  @Get('meta/org') org() { return this.edocs.org; }

  @Get('to-sign/count') async count(@CurrentUser() u: AuthUser) { return { count: await this.edocs.countToSign(u) }; }

  @Post() @RequirePermissions('EDOC_CREATE')
  create(@CurrentUser() u: AuthUser, @Body() dto: EDocDto) { return this.edocs.create(u, dto); }

  @Get(':id') detail(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.edocs.detail(u, toBigInt(id)); }

  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PartialEDocDto) { return this.edocs.update(u, toBigInt(id), dto); }

  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.edocs.remove(u, toBigInt(id)); }

  @Post(':id/submit') @HttpCode(200)
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SubmitDto, @ClientIp() ip: string) {
    if (dto.dueDate && isNaN(new Date(dto.dueDate).getTime())) throw new BadRequestException('Batas waktu tidak valid');
    return this.edocs.submit(u, toBigInt(id), dto, ip);
  }

  /** Tanda tangan/paraf: wajib konfirmasi kata sandi. */
  @Post(':id/sign') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  sign(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SignDto, @ClientIp() ip: string) {
    return this.edocs.sign(u, toBigInt(id), dto.password, dto.comment, ip);
  }

  @Post(':id/reject') @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RejectDto, @ClientIp() ip: string) { return this.edocs.reject(u, toBigInt(id), dto.reason, ip); }

  @Post(':id/cancel') @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.edocs.cancel(u, toBigInt(id)); }

  /** PDF: final (bertanda tangan) bila sudah lengkap, selain itu pratinjau DRAF. */
  @Get(':id/pdf')
  async pdf(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('inline') inline: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const r = await this.edocs.pdfFor(u, toBigInt(id));
    const disposition = `${inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.name)}`;
    if (r.buffer) {
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': disposition });
      return new StreamableFile(r.buffer);
    }
    const f = await this.prisma.file.findUnique({ where: { id: r.fileId! } });
    if (!f) throw new NotFoundException('File PDF final tidak ditemukan');
    await this.prisma.fileAccessLog.create({ data: { fileId: f.id, userId: u.id, action: inline === '1' ? 'viewed' : 'downloaded' } });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': disposition, 'X-Checksum-SHA256': f.checksumSha256 });
    return new StreamableFile(this.storage.stream(f.storagePath));
  }
}

@Controller('doc-templates')
export class DocTemplatesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  list(@Query('all') all: string) {
    return this.prisma.docTemplate.findMany({ where: { deletedAt: null, enabled: all === '1' ? undefined : true }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
  }

  @Post() @RequirePermissions('EDOC_TEMPLATE_MANAGE')
  async create(@Body() dto: TemplateDto, @CurrentUser() u: AuthUser) {
    this.checkFormat(dto.numberFormat);
    const t = await this.prisma.docTemplate.create({
      data: { name: dto.name, code: dto.code.toUpperCase(), category: dto.category ?? 'Surat', description: dto.description, bodyHtml: sanitizeHtml(dto.bodyHtml), numberFormat: dto.numberFormat, enabled: dto.enabled ?? true },
    });
    await this.audit.log({ actorUserId: u.id, module: 'edoc', action: 'template_created', entityType: 'doc_template', entityId: t.id, payload: { name: t.name } });
    return t;
  }

  @Patch(':id') @RequirePermissions('EDOC_TEMPLATE_MANAGE')
  async update(@Param('id') id: string, @Body() dto: PartialTemplateDto, @CurrentUser() u: AuthUser) {
    this.checkFormat(dto.numberFormat);
    const t = await this.prisma.docTemplate.update({
      where: { id: toBigInt(id) },
      data: { ...dto, bodyHtml: dto.bodyHtml === undefined ? undefined : sanitizeHtml(dto.bodyHtml) },
    });
    await this.audit.log({ actorUserId: u.id, module: 'edoc', action: 'template_updated', entityType: 'doc_template', entityId: t.id });
    return t;
  }

  @Delete(':id') @RequirePermissions('EDOC_TEMPLATE_MANAGE')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    await this.prisma.docTemplate.update({ where: { id: toBigInt(id) }, data: { deletedAt: new Date(), enabled: false, code: `DEL${id}` } });
    await this.audit.log({ actorUserId: u.id, module: 'edoc', action: 'template_deleted', entityType: 'doc_template', entityId: id });
    return { ok: true };
  }

  private checkFormat(f?: string) {
    if (f !== undefined && !f.includes('{seq}')) throw new BadRequestException('Format nomor wajib memuat {seq}');
  }
}

/** Halaman verifikasi QR — publik, tanpa login. */
@Controller('verify')
export class VerifyController {
  constructor(private edocs: EDocumentsService) {}

  @Public() @Get(':token') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  verify(@Param('token') token: string, @ClientIp() ip: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return { valid: false, reason: 'Format kode verifikasi tidak dikenal.' };
    return this.edocs.verify(token, ip);
  }
}
