import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { toBigInt } from '../common/utils';
import { CustomField } from '../requests/requests.service';

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'currency'];

class TypeDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsString() @Matches(/^[A-Z0-9_]{2,40}$/i, { message: 'Kode hanya huruf/angka/underscore (2–40)' }) code: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(['tugas', 'pengajuan', 'follow-up']) category?: string;
  @IsOptional() @IsArray() customFields?: CustomField[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class PartialTypeDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(['tugas', 'pengajuan', 'follow-up']) category?: string;
  @IsOptional() @IsArray() customFields?: CustomField[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

function validateFields(fields?: CustomField[]) {
  if (!fields) return undefined;
  const keys = new Set<string>();
  for (const f of fields) {
    if (!f.key || !/^[a-z][a-z0-9_]*$/.test(f.key)) throw new BadRequestException(`Key field "${f.key}" harus huruf kecil/underscore`);
    if (keys.has(f.key)) throw new BadRequestException(`Key field "${f.key}" duplikat`);
    keys.add(f.key);
    if (!f.label) throw new BadRequestException('Label field wajib diisi');
    if (!FIELD_TYPES.includes(f.type)) throw new BadRequestException(`Tipe field "${f.type}" tidak didukung`);
    if (f.type === 'select' && !f.options?.length) throw new BadRequestException(`Field "${f.label}" butuh opsi pilihan`);
  }
  return fields as unknown as Prisma.InputJsonValue;
}

@Controller('request-types')
export class RequestTypesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  list(@Query('all') all: string) {
    return this.prisma.requestType.findMany({ where: { deletedAt: null, enabled: all === '1' ? undefined : true }, orderBy: { name: 'asc' } });
  }

  @Post() @RequirePermissions('REQUEST_TYPE_MANAGE')
  async create(@Body() dto: TypeDto, @CurrentUser() u: AuthUser) {
    const t = await this.prisma.requestType.create({
      data: { name: dto.name, code: dto.code.toUpperCase(), description: dto.description, category: dto.category ?? 'pengajuan', customFieldsJson: validateFields(dto.customFields), enabled: dto.enabled ?? true },
    });
    await this.audit.log({ actorUserId: u.id, module: 'workflow', action: 'request_type_created', entityType: 'request_type', entityId: t.id, payload: dto });
    return t;
  }

  @Patch(':id') @RequirePermissions('REQUEST_TYPE_MANAGE')
  async update(@Param('id') id: string, @Body() dto: PartialTypeDto, @CurrentUser() u: AuthUser) {
    const t = await this.prisma.requestType.update({
      where: { id: toBigInt(id) },
      data: { name: dto.name, description: dto.description, category: dto.category, enabled: dto.enabled, customFieldsJson: validateFields(dto.customFields) },
    });
    await this.audit.log({ actorUserId: u.id, module: 'workflow', action: 'request_type_updated', entityType: 'request_type', entityId: t.id, payload: dto });
    return t;
  }

  @Delete(':id') @RequirePermissions('REQUEST_TYPE_MANAGE')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const t = await this.prisma.requestType.update({ where: { id: toBigInt(id) }, data: { deletedAt: new Date(), enabled: false } });
    await this.audit.log({ actorUserId: u.id, module: 'workflow', action: 'request_type_deleted', entityType: 'request_type', entityId: t.id });
    return { ok: true };
  }
}
