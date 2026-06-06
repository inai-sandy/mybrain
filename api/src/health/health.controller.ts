import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok', service: 'mybrain', time: new Date().toISOString() };
  }
}
