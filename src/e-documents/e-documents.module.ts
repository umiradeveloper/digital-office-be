import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { WorkflowModule } from '../workflow.module';
import { EDocumentsService } from './e-documents.service';
import { EDocPdfService } from './e-doc-pdf.service';
import { DocTemplatesController, EDocumentsController, VerifyController } from './e-documents.controller';

@Module({
  imports: [DocumentsModule, WorkflowModule],
  providers: [EDocumentsService, EDocPdfService],
  controllers: [EDocumentsController, DocTemplatesController, VerifyController],
  exports: [EDocumentsService],
})
export class EDocumentsModule {}
