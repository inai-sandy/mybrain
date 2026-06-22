import { Body, Controller, Get, Post } from '@nestjs/common';
import { MentalModelService } from './mentalmodel.service';
import { MindLifecycleService } from './lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';

// "The Lab" API. Run the engine + lifecycle on-demand + inspect findings. (BEA-447/448)
@Controller('mind')
export class MindController {
  constructor(
    private readonly engine: MentalModelService,
    private readonly lifecycle: MindLifecycleService,
    private readonly prisma: PrismaService,
  ) {}

  /** Run the mental model for a day (defaults to yesterday). On-demand companion to the nightly pass. */
  @Post('run')
  async run(@Body() body: { day?: string }) {
    const day = body?.day || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    return this.engine.run(day);
  }

  /** Run the living lifecycle (decay/promote/consolidate) on demand. */
  @Post('lifecycle')
  async runLifecycle() {
    return this.lifecycle.runDaily(new Date().toISOString().slice(0, 10));
  }

  /** The current mind graph — findings ordered by confidence (retired hidden). */
  @Get('findings')
  async findings() {
    return this.prisma.mindFinding.findMany({
      where: { NOT: { status: 'retired' } },
      orderBy: [{ confidence: 'desc' }],
      take: 200,
    });
  }
}
