import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Terjadi kesalahan pada server';
    let code = 'INTERNAL_ERROR';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      message = typeof r === 'string' ? r : r.message ?? exception.message;
      code = HttpStatus[status] ?? 'ERROR';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT; code = 'CONFLICT';
        message = `Data duplikat pada kolom ${(exception.meta?.target as any) ?? ''}`.trim();
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND; code = 'NOT_FOUND'; message = 'Data tidak ditemukan';
      } else if (exception.code === 'P2003') {
        status = HttpStatus.CONFLICT; code = 'FK_CONSTRAINT'; message = 'Data masih direferensikan oleh data lain';
      } else {
        this.logger.error(exception.message);
      }
    } else {
      this.logger.error((exception as Error)?.stack ?? String(exception));
    }

    res.status(status).json({ data: null, meta: null, error: { code, status, message } });
  }
}
