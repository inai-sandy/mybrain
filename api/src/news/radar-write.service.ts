import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';

export type RadarAnnotateResult = {
  ok: boolean;
  /** Picks sent to the engine in THIS batch (capped at BATCH_CAP). */
  picks: number;
  /** Lines actually written this run. */
  written: number;
  /** Picks still without a line in the DATABASE afterwards — batch leftovers AND any
   *  backlog beyond the cap. They stay visibly pending, never faked. */
  pending: number;
  message?: string;
};

/**
 * Writes the one-line "why it matters" note under each Scout Pick (BEA-1312).
 *
 * Batched engine calls, never one call per article. An hourly check (plus a boot
 * catch-up, since deploys restart the container) runs the engine ONLY when at least
 * one pick is missing its line — picks rotate through the day, so waiting for a fixed
 * hour left fresh picks blank (BEA-1314 live finding). A failed engine call leaves
 * picks pending — the run reports the failure instead of claiming done (honest-runs).
 */
@Injectable()
export class RadarWriteService implements OnModuleInit, OnModuleDestroy {
  /**
   * First check after boot. Five minutes, not two: the live gap on ship day (BEA-1314)
   * was the boot check racing the first radar sync — it looked before any picks existed,
   * found nothing, and the day's lines would have waited a full cycle.
   */
  static readonly BOOT_DELAY_MS = 5 * 60 * 1000;
  /**
   * The picks rotate through the day as the radar's brief updates, so the check runs
   * hourly — the ENGINE only runs when at least one pick is missing its line, so a
   * quiet day still costs at most a few small batched calls, never per-article ones.
   */
  static readonly CHECK_MS = 60 * 60 * 1000;
  /** One brief holds ~20 picks; 25 leaves headroom without letting the prompt balloon. */
  static readonly BATCH_CAP = 25;
  static readonly LINE_TOKENS = 1200;

  private readonly log = new Logger('RadarWrite');
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  onModuleInit() {
    // Catch-up after boot — after the first radar sync has had time to land, and only
    // when there is actually work, so container restarts do not burn engine calls.
    this.bootTimer = setTimeout(() => {
      this.annotateIfNeeded().catch((e) => this.log.error(`boot annotate failed: ${e?.message || e}`));
    }, RadarWriteService.BOOT_DELAY_MS);
    if (typeof this.bootTimer.unref === 'function') this.bootTimer.unref();

    this.checkTimer = setInterval(() => {
      this.annotateIfNeeded().catch((e) => this.log.error(`hourly annotate failed: ${e?.message || e}`));
    }, RadarWriteService.CHECK_MS);
    if (typeof this.checkTimer.unref === 'function') this.checkTimer.unref();
  }

  onModuleDestroy() {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  /** Skips the engine entirely when every pick already has its line. */
  async annotateIfNeeded(): Promise<RadarAnnotateResult> {
    const waiting = await this.prisma.radarItem.count({
      where: { isPick: true, whyItMatters: null, pendingTranslation: false },
    });
    if (!waiting) return { ok: true, picks: 0, written: 0, pending: 0, message: 'nothing to annotate' };
    return this.annotate();
  }

  /**
   * ONE batched engine call for every pick still missing its line. Only picks whose
   * titles are already English are sent — a pending translation goes first (BEA-1311).
   */
  async annotate(): Promise<RadarAnnotateResult> {
    if (this.running) return { ok: false, picks: 0, written: 0, pending: 0, message: 'annotate already running' };
    this.running = true;
    try {
      return await this.doAnnotate();
    } finally {
      this.running = false;
    }
  }

  private async doAnnotate(): Promise<RadarAnnotateResult> {
    const picks = await this.prisma.radarItem.findMany({
      where: { isPick: true, whyItMatters: null, pendingTranslation: false },
      orderBy: [{ aiScore: 'desc' }, { publishedAt: 'desc' }],
      take: RadarWriteService.BATCH_CAP,
    });
    if (!picks.length) return { ok: true, picks: 0, written: 0, pending: 0, message: 'nothing to annotate' };

    const list = picks.map((p: any, i: number) => `${i + 1}. ${p.title}${p.source ? ` (${p.source})` : ''}`).join('\n');
    const prompt = [
      'You write one-line notes for an AI news reader.',
      'For each numbered headline below, write ONE short sentence in plain English saying why it matters to someone who builds with AI.',
      'Simple words, no hype, no jargon. Do not repeat the headline.',
      `Reply with the same numbers, one line each, in the form "1. <sentence>" — nothing else.`,
      '',
      list,
    ].join('\n');

    // Named helper on purpose — the loose general model is the recurring trap here.
    const out = await this.llm
      .completeHelper('radar-why', prompt, RadarWriteService.LINE_TOKENS, 'radar-why')
      .catch((e: any) => {
        this.log.warn(`engine call failed: ${e?.message || e}`);
        return null;
      });

    if (!out) {
      // Honest-runs: the picks stay pending and the result SAYS the engine failed.
      return { ok: false, picks: picks.length, written: 0, pending: picks.length, message: 'engine unavailable — picks stay pending' };
    }

    const lines = this.parseNumbered(out, picks.length);
    let written = 0;
    for (let i = 0; i < picks.length; i += 1) {
      const line = lines.get(i + 1);
      if (!line) continue;
      try {
        await this.prisma.radarItem.update({ where: { id: picks[i].id }, data: { whyItMatters: line } });
        written += 1;
      } catch (e: any) {
        this.log.warn(`could not save line for ${picks[i].id}: ${e?.message || e}`);
      }
    }

    // The truth comes from the database, not batch arithmetic: leftovers of this batch
    // plus any backlog beyond the cap both count, so ok:true really means "all done".
    const pending = await this.prisma.radarItem.count({
      where: { isPick: true, whyItMatters: null, pendingTranslation: false },
    });
    const ok = pending === 0;
    const result: RadarAnnotateResult = {
      ok, picks: picks.length, written, pending,
      message: ok ? undefined : `${pending} pick(s) still without a line — they stay pending`,
    };
    this.log.log(`annotate: picks ${result.picks}, written ${result.written}, pending ${result.pending}`);
    return result;
  }

  /**
   * Accepts "1. text" / "1) text", with or without the space — but a digit straight after
   * the dot is NOT a marker ("2.78T parameters" is a headline, not line 2). Ignores junk
   * lines, over-long lines, and unknown numbers.
   */
  private parseNumbered(text: string, max: number): Map<number, string> {
    const out = new Map<number, string>();
    for (const raw of String(text).split('\n')) {
      const m = raw.trim().match(/^(\d{1,2})[.)]\s*(?!\d)(.+)$/);
      if (!m) continue;
      const n = Number(m[1]);
      const line = m[2].trim();
      if (n < 1 || n > max || !line || line.length > 300) continue;
      if (!out.has(n)) out.set(n, line);
    }
    return out;
  }
}
