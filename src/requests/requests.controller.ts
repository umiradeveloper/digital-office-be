import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsDateString, IsEnum, IsNumber, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RequestsService } from './requests.service';
import { ClientIp, CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/types';
import { toBigInt } from '../common/utils';

const PRI = ['low', 'med', 'high', 'crit'] as const;

class CreateRequestDto {
  @IsString() @MinLength(3, { message: 'Judul minimal 3 karakter' }) @MaxLength(200) title: string;
  @IsOptional() @IsString() description?: string;
  @IsString({ message: 'Tipe request wajib dipilih' }) typeId: string;
  @IsOptional() @IsEnum(PRI) priority?: (typeof PRI)[number];
  @IsOptional() @IsDateString({}, { message: 'Due date tidak valid' }) dueDate?: string;
  @IsOptional() @IsString() assigneeUserId?: string;
  @IsOptional() @IsNumber() amount?: number;
  @IsOptional() @IsObject() customValues?: Record<string, unknown>;
  @IsOptional() @IsArray() attachmentFileIds?: string[];
  @IsOptional() @IsBoolean() submit?: boolean;
}

class UpdateRequestDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() typeId?: string;
  @IsOptional() @IsEnum(PRI) priority?: (typeof PRI)[number];
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() assigneeUserId?: string;
  @IsOptional() @IsNumber() amount?: number;
  @IsOptional() @IsObject() customValues?: Record<string, unknown>;
  @IsOptional() @IsArray() attachmentFileIds?: string[];
  @IsOptional() @IsString() status?: string;
}

class CommentDto { @IsString() @MinLength(1, { message: 'Komentar tidak boleh kosong' }) @MaxLength(5000) body: string; }
class NoteDto { @IsOptional() @IsString() @MaxLength(1000) comment?: string; }

@Controller('requests')
export class RequestsController {
  constructor(private requests: RequestsService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) { return this.requests.list(u, q); }

  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateRequestDto, @ClientIp() ip: string) { return this.requests.create(u, dto, ip); }

  @Get(':id') detail(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.requests.detail(u, toBigInt(id)); }

  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateRequestDto, @ClientIp() ip: string) {
    return this.requests.update(u, toBigInt(id), dto, ip);
  }

  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @ClientIp() ip: string) { return this.requests.remove(u, toBigInt(id), ip); }

  @Post(':id/comments') comment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CommentDto) {
    return this.requests.comment(u, toBigInt(id), dto.body);
  }

  @Post(':id/submit') @HttpCode(200)
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string, @ClientIp() ip: string) { return this.requests.submit(u, toBigInt(id), ip); }

  @Post(':id/close') @HttpCode(200)
  close(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NoteDto, @ClientIp() ip: string) {
    return this.requests.close(u, toBigInt(id), dto.comment, ip);
  }

  @Post(':id/remind') @HttpCode(200)
  remind(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) { return this.requests.remind(u, toBigInt(id), dto.comment); }
}
