import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { MentalModelService } from './mentalmodel.service';
import { MindLifecycleService } from './lifecycle.service';
import { MindReviewService } from './review.service';
import { MindStatsService } from './stats.service';
import { PrismaService } from '../prisma/prisma.service';

// "The Lab" API. Run the engine + lifecycle, inspect findings, and review them with ✓/✗/almost. (BEA-447/448/449)
@Controller('mind')
export class MindController {
  constructor(
    private readonly engine: MentalModelService,
    private readonly lifecycle: MindLifecycleService,
    private readonly review_: MindReviewService,
    private readonly stats_: MindStatsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Scientist dashboard analytics — mood trend, what-moves-your-mood, heatmaps. (BEA-455) */
  @Get('stats')
  stats() {
    return this.stats_.stats();
  }

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

  /** The user's own words on a finding — stored as feedback + soft confirm. (BEA-464) */
  @Post('findings/:id/note')
  note(@Param('id') id: string, @Body() body: { text?: string }) {
    return this.review_.note(id, String(body?.text ?? ''));
  }

  @Delete('findings/:id')
  remove(@Param('id') id: string) {
    return this.review_.remove(id);
  }

  /** Run the mental model. With {day}: that day. Without: learn any closed days not yet learned (BEA-458). */
  @Post('run')
  async run(@Body() body: { day?: string }) {
    if (body?.day) return this.engine.run(body.day);
    return this.engine.runNow();
  }

  /** Run the living lifecycle (decay/promote/consolidate) on demand. */
  @Post('lifecycle')
  async runLifecycle() {
    return this.lifecycle.runDaily(new Date().toISOString().slice(0, 10));
  }

  /** Merge duplicate findings now (lexical + semantic). (BEA-459) */
  @Post('dedupe')
  async dedupe() {
    return { merged: await this.lifecycle.dedupe() };
  }

  /** About Me — the user's own words, used to ground the engine + Mentor. (BEA-463) */
  @Get('about')
  async getAbout() {
    return { text: await this.engine.aboutMe() };
  }

  @Put('about')
  async setAbout(@Body() body: { text?: string }) {
    return { text: await this.engine.setAboutMe(String(body?.text ?? '')) };
  }

  // ---- engine picker (Settings → Models): which model reasons about you. (BEA-452) ----
  @Get('model')
  getModel() {
    return this.engine.model();
  }

  @Put('model')
  setModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.engine.setModel(body.provider || 'openrouter', body.model);
  }

  @Get('models')
  async models() {
    return { models: await this.engine.listModels() };
  }

  /** The current mind graph — findings ordered by confidence (retired hidden). */
  @Get('findings')
  async findings() {
    return this.prisma.mindFinding.findMany({
      where: { NOT: { status: 'retired' } },
      orderBy: [{ confidence: 'desc' }],
      take: 200,
      include: { evidence: { take: 6, orderBy: { createdAt: 'desc' } } }, // for the tap-to-read popup (BEA-462)
    });
  }
}
