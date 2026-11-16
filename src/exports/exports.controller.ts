import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ExportsService } from './exports.service';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/types';

/** BR-12: hanya role dengan permission EXPORT (auditor boleh, read-only). */
@Controller('exports')
@RequirePermissions('EXPORT')
export class ExportsController {
  constructor(private exports: ExportsService) {}

  @Get('requests.xlsx')
  requests(@Query() q: Record<string, string>, @CurrentUser() u: AuthUser): Promise<StreamableFile> { return this.exports.requestsXlsx(q, u); }

  @Get('approvals.xlsx')
  approvals(@Query() q: Record<string, string>, @CurrentUser() u: AuthUser): Promise<StreamableFile> { return this.exports.approvalsXlsx(q, u); }

  @Get('document-access.xlsx')
  docAccess(@Query() q: Record<string, string>, @CurrentUser() u: AuthUser): Promise<StreamableFile> { return this.exports.fileAccessXlsx(q, u); }

  @Get('report.pdf')
  report(@Query() q: Record<string, string>, @CurrentUser() u: AuthUser): Promise<StreamableFile> { return this.exports.reportPdf(q, u); }

  @Get('history')
  history(@CurrentUser() u: AuthUser) { return this.exports.history(u); }
}
