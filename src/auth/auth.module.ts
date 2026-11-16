import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PermissionSyncService } from './permission-sync.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [AuthService, PermissionSyncService],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
