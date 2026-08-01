import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey, TZ_OFFSET_MIN } from '../common/localday';

/**
 * A ceiling on tokens, per run and per day (BEA-1204).
 *
 * Until now nothing anywhere capped tokens. Search credits were capped in BEA-1196 — real money, but
 * small. Tokens are the big cost and were unlimited: 1,063,648 of them went in two days, which
 * emptied the ChatGPT subscription until 28 August. Nothing noticed, nothing stopped it, and every
 * call quietly moved to a paid model instead.
 *
 * Two rules the owner set:
 *  • It BLOCKS. It does not merely warn, and it never silently drops to a cheaper model — quality
 *    falling quietly is the failure mode being removed everywhere else in this project.
 *  • On hitting the ceiling: finish the step in flight, then start nothing new. Checking *before*
 *    each call gives exactly that, with no extra machinery.
 */

/** Thrown instead of a model answer when the ceiling is reached. Callers surface the reason. */
export class TokenBudgetError extends Error {}

/**
 * What an engine turn costs, measured across the owner's last 9 runs (1,063,648 tokens / 9).
 *
 * An engine turn reports nothing until it finishes, so it is charged this up front and reconciled
 * with the real figure afterwards. Without that, the most expensive thing in the app would be the
 * one thing the budget cannot see.
 */
export const ENGINE_TURN_TOKENS = 118_000;

/**
 * What to charge up front for a turn on THIS engine (BEA-1240).
 *
 * One flat figure for every engine was measured back when everything ran on Claude. Codex turns
 * really cost about 23,400 — a fifth of it. A 7-step research run therefore booked ~826,000 against
 * a 500,000 ceiling and was refused after spending closer to 165,000. A safety net that stops free
 * work on a wrong number is a net that cries wolf, and the owner's only lever was to raise a ceiling
 * he was never actually approaching.
 *
 * Measured from real usage, not guessed. The flat figure survives as the fallback for an engine we
 * have never seen — an unmeasured engine must never be free to start unlimited work.
 */
const ESTIMATE_SAMPLE = 20;      // recent turns to average
const MIN_ESTIMATE = 20_000;     // never charge so little that a runaway looks cheap

const DEFAULT_DAY = 500_000;
const DEFAULT_RUN = 150_000;

@Injectable()
export class TokenBudgetService {
  private readonly log = new Logger('TokenBudget');
  /** Charged but not yet in UsageLog — an in-flight engine turn, or a call that has not returned. */
  private reserved = 0;
  /** So the owner is told once a day, not once a call. */
  private toldOnDay = '';
  private listeners: Array<(m: string) => void | Promise<void>> = [];

  constructor(private readonly prisma: PrismaService) {}

  async dayLimit(): Promise<number> { return this.setting('budget.tokens.day', DEFAULT_DAY); }
  async runLimit(): Promise<number> { return this.setting('budget.tokens.run', DEFAULT_RUN); }

  /** Everything spent since local midnight, including what is in flight right now. */
  async spentToday(): Promise<number> {
    const rows = await this.prisma.usageLog?.findMany?.({
      where: { at: { gte: this.startOfLocalDay() } },
      select: { promptTokens: true, completionTokens: true },
    }).catch(() => []) ?? [];
    const logged = rows.reduce((n: number, r: any) => n + (r.promptTokens || 0) + (r.completionTokens || 0), 0);
    return logged + this.reserved;
  }

  /**
   * May a call of roughly this size start?
   *
   * Deliberately checked BEFORE the call. A call that would begin past the ceiling does not begin —
   * which is what "finish the current step, then stop" means in practice.
   */
  async check(estimate = 0): Promise<{ ok: boolean; reason?: string; spent: number; limit: number }> {
    const limit = await this.dayLimit();
    const spent = await this.spentToday();
    if (limit <= 0) return { ok: true, spent, limit }; // 0 or less = the ceiling is switched off
    if (spent + Math.max(0, estimate) <= limit) return { ok: true, spent, limit };
    return {
      ok: false,
      spent,
      limit,
      reason: `today's AI budget is used up (${spent.toLocaleString()} of ${limit.toLocaleString()} tokens). Nothing new will start until tomorrow, or until you raise it in Settings.`,
    };
  }

  /**
   * Throw unless there is room, and make sure the owner hears about it ONCE.
   *
   * Announcing here rather than at the catch site matters: around forty callers already wrap their
   * model call in `.catch(() => null)`, so a budget stop would be swallowed by most of the app and
   * the owner would learn nothing — which is precisely the "nothing noticed, nothing said" symptom
   * this issue exists to end, just from a different cause.
   */
  async require(estimate = 0): Promise<void> {
    const r = await this.check(estimate);
    if (r.ok) return;
    if (this.shouldAnnounce()) {
      const t = await this.today().catch(() => null);
      const msg = `⏹ Today's AI budget is used up — ${t ? `${t.spent.toLocaleString()} of ${t.limit.toLocaleString()} tokens` : 'the ceiling was reached'}. Jobs that need the AI will not start until tomorrow. You can raise it in Settings.`;
      this.log.warn(msg);
      for (const cb of this.listeners) { try { void cb(msg); } catch { /* a notifier must never break a refusal */ } }
    }
    throw new TokenBudgetError(r.reason!);
  }

  /**
   * Register something that tells the owner (the telegram module does this at boot).
   *
   * A callback rather than an injected service, so this stays dependency-free and cannot create the
   * import cycle that rolled back BEA-1190.
   */
  onStop(cb: (message: string) => void | Promise<void>): void {
    this.listeners.push(cb);
  }

  /**
   * Charge an estimate now, settle with the truth later.
   *
   * Two engine turns starting together would otherwise both see the same "spent" figure and both be
   * allowed. Returning a release function keeps that honest without a lock.
   */
  reserve(estimate: number): () => void {
    const n = Math.max(0, Math.round(estimate));
    this.reserved += n;
    let released = false;
    return () => { if (!released) { released = true; this.reserved = Math.max(0, this.reserved - n); } };
  }

  /** True the first time today the ceiling is hit — so the owner is told once, not once per call. */
  shouldAnnounce(): boolean {
    const day = localDayKey();
    if (this.toldOnDay === day) return false;
    this.toldOnDay = day;
    return true;
  }

  /**
   * What an engine turn cost, when the runner did not say.
   *
   * The reservation only lasts while the call runs. If nothing is ever written to the usage log, an
   * engine turn becomes invisible the instant it finishes — and engine turns are exactly the traffic
   * that emptied the subscription. So an unreported turn is charged its measured average.
   */
  static tokensOf(usage: any): { prompt: number; completion: number } {
    const p = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.promptTokens ?? 0) || 0;
    const c = Number(usage?.output_tokens ?? usage?.completion_tokens ?? usage?.completionTokens ?? 0) || 0;
    if (p + c > 0) return { prompt: p, completion: c };
    return { prompt: ENGINE_TURN_TOKENS, completion: 0 };
  }

  /**
   * The up-front charge for a turn on this engine, from its own recent history.
   *
   * Cached for a minute: this runs before every engine call, and a fresh query each time would put a
   * database read in front of work the budget is meant to protect, not slow down.
   */
  private estimates = new Map<string, { at: number; n: number }>();
  async estimateFor(provider?: string): Promise<number> {
    if (!provider) return ENGINE_TURN_TOKENS;
    const hit = this.estimates.get(provider);
    if (hit && Date.now() - hit.at < 60_000) return hit.n;
    const rows = await this.prisma.usageLog?.findMany?.({
      where: { model: provider },
      orderBy: { at: 'desc' },
      take: ESTIMATE_SAMPLE,
      select: { promptTokens: true, completionTokens: true },
    }).catch(() => []) ?? [];
    const used = rows.map((r: any) => (r.promptTokens || 0) + (r.completionTokens || 0)).filter((n: number) => n > 0);
    // No history yet — charge the old flat figure rather than letting an unknown engine start free.
    const n = used.length
      ? Math.max(MIN_ESTIMATE, Math.round(used.reduce((a: number, b: number) => a + b, 0) / used.length))
      : ENGINE_TURN_TOKENS;
    this.estimates.set(provider, { at: Date.now(), n });
    return n;
  }

  /** For Settings: what today looks like against the ceiling. */
  async today(): Promise<{ spent: number; limit: number; runLimit: number; left: number; pct: number }> {
    const [limit, runLimit, spent] = await Promise.all([this.dayLimit(), this.runLimit(), this.spentToday()]);
    return { spent, limit, runLimit, left: Math.max(0, limit - spent), pct: limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0 };
  }

  async setLimits(day?: number, run?: number): Promise<void> {
    if (Number.isFinite(day)) await this.write('budget.tokens.day', Math.max(0, Math.floor(Number(day))));
    if (Number.isFinite(run)) await this.write('budget.tokens.run', Math.max(0, Math.floor(Number(run))));
  }

  // ---- plumbing --------------------------------------------------------------------------------

  /**
   * The UTC instant the owner's day began.
   *
   * The app lives in IST (UTC+5:30), so "today" starts at 18:30 UTC the previous evening. Using the
   * server's UTC midnight instead would reset the budget five and a half hours late — and this is
   * the same trap that had a test failing every Friday until BEA-1202.
   */
  private startOfLocalDay(): Date {
    return new Date(new Date(`${localDayKey()}T00:00:00.000Z`).getTime() - TZ_OFFSET_MIN * 60_000);
  }

  private async setting(key: string, fallback: number): Promise<number> {
    const row = await this.prisma.setting?.findUnique?.({ where: { key } }).catch(() => null);
    const n = Number(row?.value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  private async write(key: string, value: number): Promise<void> {
    await this.prisma.setting?.upsert?.({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } }).catch((e: any) => {
      this.log.warn(`could not save ${key}: ${e?.message || e}`);
    });
  }
}
