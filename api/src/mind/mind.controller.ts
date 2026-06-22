import { Body, Controller, Get, Post } from '@nestjs/common';
import { MentalModelService } from './mentalmodel.service';
import { PrismaService } from '../prisma/prisma.service';

// "The Lab" API. P2 = run the engine on-demand + inspect findings. (BEA-447)
@Controller('mind')
export class MindController {
  constructor(
    private readonly engine: MentalModelService,
    private readonly prisma: PrismaService,
  ) {}

  /** Run the mental model for a day (defaults to yesterday). On-demand companion to the nightly pass. */
  @Post('run')
  async run(@Body() body: { day?: string }) {
    const day = body?.day || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    return this.engine.run(day);
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
