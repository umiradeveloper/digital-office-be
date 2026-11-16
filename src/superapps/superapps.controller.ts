import { BadRequestException, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { SuperappsService } from './superapps.service';

@Controller('admin/superapps')
export class SuperappsController {
  constructor(private superapps: SuperappsService) {}

  /** Status koneksi & sinkron terakhir. */
  @Get() @RequirePermissions('USER_MANAGE')
  status() {
    return this.superapps.status();
  }

  /** Sinkron penuh sekarang. */
  @Post('sync') @HttpCode(200) @RequirePermissions('USER_MANAGE')
  async sync(@CurrentUser() u: AuthUser) {
    if (!this.superapps.enabled) throw new BadRequestException('Koneksi SuperApps belum diatur (SUPERAPPS_DATABASE_URL)');
    try {
      return await this.superapps.syncAll('manual', u.id);
    } catch (e) {
      throw new BadRequestException(`Sinkronisasi gagal: ${(e as Error).message}`);
    }
  }
}
