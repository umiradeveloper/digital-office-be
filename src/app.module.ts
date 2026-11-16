import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './common/guards/auth.guard';
import { NotificationsModule } from './notifications/notifications.module';
import { UsersModule } from './users/users.module';
import { OrganizationModule } from './organization.module';
import { DocumentsModule } from './documents/documents.module';
import { WorkflowModule } from './workflow.module';
import { ExportsModule } from './exports/exports.module';
import { EDocumentsModule } from './e-documents/e-documents.module';
import { SuperappsModule } from './superapps/superapps.module';
import { AdminController } from './admin/admin.controller';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    NotificationsModule,
    UsersModule,
    OrganizationModule,
    DocumentsModule,
    WorkflowModule,
    ExportsModule,
    EDocumentsModule,
    SuperappsModule,
  ],
  controllers: [AdminController, HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
