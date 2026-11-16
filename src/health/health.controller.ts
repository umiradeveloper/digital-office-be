import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Public() @Get()
  async health() {
    const started = Date.now();
    let db = 'up';
    try { await this.prisma.$queryRaw`SELECT 1`; } catch { db = 'down'; }
    return { status: db === 'up' ? 'ok' : 'degraded', db, latencyMs: Date.now() - started, uptimeSec: Math.round(process.uptime()), time: new Date() };
  }
}
