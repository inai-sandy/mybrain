import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { MentalModelService } from './mentalmodel.service';
import { MindLifecycleService } from './lifecycle.service';
import { MindReviewService } from './review.service';
import { PrismaService } from '../prisma/prisma.service';

// "The Lab" API. Run the engine + lifecycle, inspect findings, and review them with ✓/✗/almost. (BEA-447/448/449)
@Controller('mind')
export class MindController {
  constructor(
    private readonly engine: MentalModelService,
    private readonly lifecycle: MindLifecycleService,
    private readonly review_: MindReviewService,
    private readonly prisma: PrismaService,
  ) {}

  /** The nightly "what I understood" review — pending findings + fading "still you?" ones. */
  @Get('review')
  review() {
    return this.review_.review();
  }

  @Post('findings/:id/confirm')
  confirm(@Param('id') id: string) {
    return this.review_.confirm(id);
  }

  @Post('findings/:id/refute')
  refute(@Param('id') id: string) {
    return this.review_.refute(id);
  }

  @Patch('findings/:id')
  amend(@Param('id') id: string, @Body() body: { statement?: string; subject?: string; relation?: string; object?: string; valence?: string }) {
    return this.review_.amend(id, body || {});
  }

  @Post('findings/:id/pin')
  pin(@Param('id') id: string, @Body() body: { pinned?: boolean }) {
    return this.review_.pin(id, !!body?.pinned);
  }

  @Delete('findings/:id')
  remove(@Param('id') id: string) {
    return this.review_.remove(id);
  }

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
