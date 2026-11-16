import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { ClientIp, CurrentUser, Public } from '../common/decorators';
import { AuthUser } from '../common/types';

class LoginDto {
  /** Email atau username (akun hasil impor SuperApps dapat memakai username). */
  @IsOptional() @IsString() identifier?: string;
  /** @deprecated pakai `identifier`; tetap diterima untuk klien lama. */
  @IsOptional() @IsString() email?: string;
  @IsString() @MinLength(1, { message: 'Kata sandi wajib diisi' }) password: string;
}
class RefreshDto { @IsString() refreshToken: string; }
class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MinLength(8, { message: 'Kata sandi baru minimal 8 karakter' }) newPassword: string;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Post('login') @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @ClientIp() ip: string) {
    const id = (dto.identifier ?? dto.email ?? '').trim();
    if (!id) throw new BadRequestException('Email atau username wajib diisi');
    return this.auth.login(id, dto.password, ip);
  }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout-all') @HttpCode(200)
  logoutAll(@CurrentUser() u: AuthUser) {
    return this.auth.logoutAll(u.id);
  }

  @Post('change-password') @HttpCode(200)
  changePassword(@CurrentUser() u: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(u.id, dto.currentPassword, dto.newPassword);
  }
}
