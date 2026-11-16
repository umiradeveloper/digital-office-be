import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, StreamableFile,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsArray, IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { DocumentsService } from './documents.service';
import { StorageService } from './storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClientIp, CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { toBigInt } from '../common/utils';

const MAX_MB = Number(process.env.MAX_UPLOAD_MB ?? 25);

class FolderDto {
  @IsString() @MinLength(1, { message: 'Nama folder wajib diisi' }) @MaxLength(150) name: string;
  @IsOptional() @IsString() parentFolderId?: string;
  @IsOptional() @IsString() departmentId?: string;
}
class UpdateFolderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(150) name?: string;
  @IsOptional() @IsString() parentFolderId?: string | null;
}
class UpdateFileDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() tags?: string;
  @IsOptional() @IsString() folderId?: string;
}
class ShareDto {
  @IsOptional() @IsArray() userIds?: string[];
  @IsOptional() @IsArray() deptIds?: string[];
  @IsEnum(['read', 'comment', 'write'], { message: 'Level akses tidak valid' }) accessLevel: 'read' | 'comment' | 'write';
  @IsOptional() @IsDateString() expiresAt?: string;
}
class TagDto {
  @IsString() @MinLength(1) @MaxLength(60) name: string;
  @IsOptional() @IsString() color?: string;
}

@Controller()
export class DocumentsController {
  constructor(private docs: DocumentsService, private storage: StorageService, private prisma: PrismaService) {}

  // ── Folder ──
  @Get('folders') folders(@CurrentUser() u: AuthUser) { return this.docs.listFolders(u); }

  @Post('folders') @RequirePermissions('DOC_UPLOAD', 'DOC_MANAGE')
  createFolder(@CurrentUser() u: AuthUser, @Body() dto: FolderDto) { return this.docs.createFolder(u, dto); }

  @Patch('folders/:id') @RequirePermissions('DOC_UPLOAD', 'DOC_MANAGE')
  updateFolder(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateFolderDto) { return this.docs.updateFolder(u, toBigInt(id), dto); }

  @Delete('folders/:id') @RequirePermissions('DOC_MANAGE')
  deleteFolder(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.docs.deleteFolder(u, toBigInt(id)); }

  // ── Tag & kategori ──
  @Get('tags')
  async tags() {
    const tags = await this.prisma.fileTag.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { taggings: true } } } });
    return tags.map((t) => ({ id: t.id, name: t.name, color: t.color, count: t._count.taggings }));
  }

  @Post('tags') @RequirePermissions('DOC_UPLOAD', 'DOC_MANAGE')
  createTag(@Body() dto: TagDto) {
    return this.prisma.fileTag.upsert({ where: { name: dto.name.trim() }, update: { color: dto.color }, create: { name: dto.name.trim(), color: dto.color } });
  }

  @Get('files/categories')
  async categories() {
    const rows = await this.prisma.file.groupBy({ by: ['category'], where: { deletedAt: null, isActive: true, category: { not: null } }, _count: { _all: true } });
    return rows.map((r) => ({ category: r.category, count: r._count._all }));
  }

  // ── File ──
  @Get('files') list(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) { return this.docs.listFiles(u, q); }

  @Post('files') @RequirePermissions('DOC_UPLOAD', 'DOC_MANAGE', 'REQUEST_CREATE')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() body: Record<string, string>, @ClientIp() ip: string) {
    return this.docs.upload(u, file, body, ip);
  }

  @Get('files/:id') detail(@CurrentUser() u: AuthUser, @Param('id') id: string, @ClientIp() ip: string) {
    return this.docs.detail(u, toBigInt(id), ip);
  }

  @Patch('files/:id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateFileDto) {
    return this.docs.updateMeta(u, toBigInt(id), dto);
  }

  /** Unduh / lihat (inline=1) — setiap akses dicatat (FR-DOC-07). */
  @Get('files/:id/download')
  async download(
    @CurrentUser() u: AuthUser, @Param('id') id: string, @Query('inline') inline: string,
    @ClientIp() ip: string, @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { file } = await this.docs.requireAccess(u, toBigInt(id), 'read');
    const path = this.storage.resolve(file.storagePath);
    if (!(await this.storage.exists(path))) throw new BadRequestException('File fisik tidak ditemukan di storage');
    await this.docs.logAccess(file.id, u.id, inline === '1' ? 'viewed' : 'downloaded', ip);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `${inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      'X-Checksum-SHA256': file.checksumSha256,
    });
    return new StreamableFile(this.storage.stream(file.storagePath));
  }

  @Delete('files/:id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @ClientIp() ip: string) {
    return this.docs.remove(u, toBigInt(id), ip);
  }

  @Post('files/:id/share') share(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ShareDto, @ClientIp() ip: string) {
    return this.docs.share(u, toBigInt(id), dto, ip);
  }

  @Delete('files/:id/shares/:shareId') unshare(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('shareId') shareId: string) {
    return this.docs.unshare(u, toBigInt(id), toBigInt(shareId));
  }

  @Get('files/:id/access-logs') accessLogs(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.docs.accessLogs(u, toBigInt(id));
  }
}
