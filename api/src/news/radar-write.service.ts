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
 * One batched engine call per day — never one call per article. Runs at 12:00 IST,
 * the same hour as AI News Daily, plus a catch-up on boot because deploys restart
 * the container and would otherwise skip a day. A failed engine call leaves picks
 * pending — the run reports the failure instead of claiming done (honest-runs rule).
 */
@Injectable()
export class RadarWriteService implements OnModuleInit, OnModuleDestroy {
  /** IST is UTC+5:30 with no daylight saving — the offset is safe to hard-code. */
  static readonly IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  static readonly NOON_IST_HOUR = 12;
  /** One brief holds ~20 picks; 25 leaves headroom without letting the prompt balloon. */
  static readonly BATCH_CAP = 25;
  static readonly LINE_TOKENS = 1200;

  private readonly log = new Logger('RadarWrite');
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private noonTimer: ReturnType<typeof setTimeout> | null = null;
  private dailyTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  onModuleInit() {
    // Catch-up shortly after boot — but only when there is actually work, so container
    // restarts do not burn engine calls. The delay lets the first radar sync land first.
    this.bootTimer = setTimeout(() => {
      this.annotateIfNeeded().catch((e) => this.log.error(`boot annotate failed: ${e?.message || e}`));
    }, 2 * 60 * 1000);
    if (typeof this.bootTimer.unref === 'function') this.bootTimer.unref();

    const wait = RadarWriteService.msUntilNextNoonIst(new Date());
    this.noonTimer = setTimeout(() => {
      this.annotateIfNeeded().catch((e) => this.log.error(`noon annotate failed: ${e?.message || e}`));
      this.dailyTimer = setInterval(() => {
        this.annotateIfNeeded().catch((e) => this.log.error(`daily annotate failed: ${e?.message || e}`));
      }, 24 * 60 * 60 * 1000);
      if (typeof this.dailyTimer.unref === 'function') this.dailyTimer.unref();
    }, wait);
    if (typeof this.noonTimer.unref === 'function') this.noonTimer.unref();
  }

  onModuleDestroy() {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.noonTimer) clearTimeout(this.noonTimer);
    if (this.dailyTimer) clearInterval(this.dailyTimer);
  }

  /** Milliseconds until the next 12:00 in IST. Pure so the arithmetic is testable. */
  static msUntilNextNoonIst(now: Date): number {
    const ist = new Date(now.getTime() + RadarWriteService.IST_OFFSET_MS);
    const next = new Date(ist);
    next.setUTCHours(RadarWriteService.NOON_IST_HOUR, 0, 0, 0);
    if (next.getTime() <= ist.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - ist.getTime();
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
