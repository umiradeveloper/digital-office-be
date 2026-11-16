import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query,
  Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { UsersService } from './users.service';
import { CreateUserDto, ResetPasswordDto, UpdateMeDto, UpdateUserDto } from './users.dto';
import { CurrentUser, Public, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { toBigInt } from '../common/utils';
import { StorageService } from '../documents/storage.service';

@Controller('users')
export class UsersController {
  constructor(private users: UsersService, private storage: StorageService) {}

  @Get('me') me(@CurrentUser() u: AuthUser) { return this.users.me(u); }

  @Patch('me') updateMe(@CurrentUser() u: AuthUser, @Body() dto: UpdateMeDto) { return this.users.updateMe(u, dto); }

  @Post('me/photo')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } }))
  async photo(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File) {
    if (!file || !/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) throw new BadRequestException('Unggah gambar PNG/JPG/WEBP maks 3MB');
    const ext = file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    await this.storage.save(`avatars/${u.id}.${ext}`, file.buffer);
    return this.users.setPhoto(u, `/api/v1/users/${u.id}/photo?ext=${ext}&v=${Date.now()}`);
  }

  @Public() @Get(':id/photo')
  async getPhoto(@Param('id') id: string, @Query('ext') ext: string, @Res() res: Response) {
    const safeExt = ['png', 'jpg', 'webp'].includes(ext) ? ext : 'jpg';
    const path = this.storage.resolve(`avatars/${toBigInt(id)}.${safeExt}`);
    if (!(await this.storage.exists(path))) throw new NotFoundException();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path);
  }

  /** Daftar pengguna (semua user terautentikasi — untuk pilih assignee/delegasi/share). */
  @Get() list(@Query() q: Record<string, string>) { return this.users.list(q); }

  @Get(':id') get(@Param('id') id: string) { return this.users.get(toBigInt(id)); }

  @Post() @RequirePermissions('USER_MANAGE')
  create(@Body() dto: CreateUserDto, @CurrentUser() u: AuthUser) { return this.users.create(dto, u); }

  @Patch(':id') @RequirePermissions('USER_MANAGE')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() u: AuthUser) { return this.users.update(toBigInt(id), dto, u); }

  @Post(':id/disable') @HttpCode(200) @RequirePermissions('USER_MANAGE')
  disable(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.users.setStatus(toBigInt(id), 'disabled', u); }

  @Post(':id/enable') @HttpCode(200) @RequirePermissions('USER_MANAGE')
  enable(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.users.setStatus(toBigInt(id), 'active', u); }

  @Post(':id/reset-password') @HttpCode(200) @RequirePermissions('USER_MANAGE')
  reset(@Param('id') id: string, @Body() dto: ResetPasswordDto, @CurrentUser() u: AuthUser) {
    return this.users.resetPassword(toBigInt(id), dto.newPassword, u);
  }

  @Delete(':id') @RequirePermissions('USER_MANAGE')
  remove(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.users.softDelete(toBigInt(id), u); }
}
