import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
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

  /** The run-log — WHEN the Lab learned + the morning wrap-up ran, with date/time. (BEA-468) */
  @Get('runs')
  async runs() {
    const runs = await this.prisma.mindRun.findMany({ orderBy: { at: 'desc' }, take: 50 });
    const lastOf = (kind: string) => runs.find((r) => r.kind === kind) ?? null;
    return {
      runs,
      lastLearn: lastOf('learn'),
      lastClose: lastOf('close'),
      lastStory: lastOf('story'),
      wrapAt: '10:00', // local IST — the daily morning wrap-up time (BEA-467)
    };
  }

  /** Holistic activity: a per-day calendar (did each step run?) + last-of-each status. (BEA-471) */
  @Get('activity')
  async activity(@Query('days') daysParam?: string) {
    const N = Math.min(90, Math.max(7, Number(daysParam) || 30));
    const istDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const addDays = (day: string, n: number) => {
      const dt = new Date(day + 'T12:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + n);
      return dt.toISOString().slice(0, 10);
    };
    const today = istDay(new Date());
    const dayList: string[] = Array.from({ length: N }, (_, i) => addDays(today, -i)); // newest first
    const oldest = dayList[dayList.length - 1];

    const [stories, closes, mentors, summaries, learnedRow, recent] = await Promise.all([
      this.prisma.story.findMany({ where: { day: { gte: oldest } }, select: { day: true } }),
      this.prisma.dayClose.findMany({ where: { day: { gte: oldest } }, select: { day: true, closedAt: true } }),
      this.prisma.mentorDay.findMany({ where: { day: { gte: oldest } }, select: { day: true, updatedAt: true } }),
      this.prisma.daySummary.findMany({ where: { day: { gte: oldest } }, select: { day: true, updatedAt: true } }),
      this.prisma.setting.findUnique({ where: { key: 'mind.learnedDays' } }),
      this.prisma.mindRun.findMany({ orderBy: { at: 'desc' }, take: 50 }),
    ]);
    const learnedSet = new Set<string>((() => { try { return JSON.parse(learnedRow?.value || '[]'); } catch { return []; } })());
    const storyDays = new Set(stories.map((s) => s.day));
    const closeDays = new Set(closes.map((c) => c.day));
    const mentorDays = new Set(mentors.map((m) => m.day));
    const summaryDays = new Set(summaries.map((s) => s.day));

    const days = dayList.map((day) => ({
      day,
      story: storyDays.has(day),
      wrapped: closeDays.has(day),
      learned: learnedSet.has(day),
      mentor: mentorDays.has(day),
      summary: summaryDays.has(day),
    }));

    // Last-of-each status, drawn from the truest source for each.
    const maxAt = <T,>(rows: T[], pick: (r: T) => Date | string | null | undefined): string | null => {
      let best: number | null = null;
      for (const r of rows) {
        const v = pick(r);
        if (!v) continue;
        const t = new Date(v).getTime();
        if (best === null || t > best) best = t;
      }
      return best === null ? null : new Date(best).toISOString();
    };
    const lastRunOf = (kind: string) => recent.find((r) => r.kind === kind) ?? null;
    const status = {
      story: { at: lastRunOf('story')?.at ?? null, detail: lastRunOf('story')?.detail ?? null },
      wrapped: { at: maxAt(closes, (c) => c.closedAt), detail: lastRunOf('close')?.detail ?? null },
      learned: { at: lastRunOf('learn')?.at ?? null, detail: lastRunOf('learn')?.detail ?? null },
      mentor: { at: maxAt(mentors, (m) => m.updatedAt), detail: 'Mentor guidance' },
      summary: { at: maxAt(summaries, (s) => s.updatedAt), detail: 'Day summary' },
    };

    return { today, wrapAt: '10:00', days, status, runs: recent };
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
