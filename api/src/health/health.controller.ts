import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    // Actually check the database so ship.sh's "confirm live" isn't blind — a container that boots
    // but can't reach/read its DB is NOT healthy and must not be marked live. (BEA-825)
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', service: 'mybrain', db: 'down' });
    }
    return { status: 'ok', service: 'mybrain', db: 'ok', time: new Date().toISOString() };
  }
}
