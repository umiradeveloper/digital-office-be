import { Module } from '@nestjs/common';
import { DocumentsModule } from './documents/documents.module';
import { ApprovalsService } from './approvals/approvals.service';
import { ApprovalsController } from './approvals/approvals.controller';
import { ApprovalFlowsController } from './approvals/approval-flows.controller';
import { TasksService } from './approvals/tasks.service';
import { RequestsService } from './requests/requests.service';
import { RequestsController } from './requests/requests.controller';
import { RequestTypesController } from './request-types/request-types.controller';

/** Workflow + Approval digabung agar tidak ada dependensi melingkar. */
@Module({
  imports: [DocumentsModule],
  providers: [ApprovalsService, RequestsService, TasksService],
  controllers: [RequestsController, RequestTypesController, ApprovalsController, ApprovalFlowsController],
  exports: [ApprovalsService, RequestsService],
})
export class WorkflowModule {}
