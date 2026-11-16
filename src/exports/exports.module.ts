import { Module } from '@nestjs/common';
import { ExportsService } from './exports.service';
import { ExportsController } from './exports.controller';
import { AuditController } from '../audit/audit.controller';
import { DocumentsModule } from '../documents/documents.module';
import { WorkflowModule } from '../workflow.module';

@Module({ imports: [DocumentsModule, WorkflowModule], providers: [ExportsService], controllers: [ExportsController, AuditController] })
export class ExportsModule {}
