import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { ScrapeCreatorsProvider } from '../tools/scrapecreators.provider';
import { SocialService } from './social.service';

/**
 * The daily credit ceiling (BEA-1358) — design: `specs/SOCIAL.md`. Every Social call is charged
 * in the provider's credits (1→26 each, `ToolCall.credits`), and a "comments on 50 posts" job is
 * 750 credits, not 50. So: `Setting social.dailyCreditCeiling` (default 500; 0 = no limit), and
 * BEFORE a job's call is made, "would this pass the ceiling?" — when it would, the job pauses
 * itself (`enabled:false`, `pausedReason`), records why on the run and tells the owner on Telegram,
 * exactly like the trigger rate cap. The call is NOT made.
 *
 * "Spent today" is the sum of `ToolCall.credits` since the owner's local midnight (`SocialService.
 * spentToday()` — one truth, the same number the Social header shows). The cost of the NEXT call is
 * not known until it is made, so it is estimated from the last successful call of the same action
 * (default 1) — an estimate is the only honest number here, and it errs on the side of pausing.
 */

export type BudgetCheck = { ok: boolean; spent: number; ceiling: number | null; estimate: number; reason?: string };

@Injectable()
export class SocialBudgetService {
  private readonly log = new Logger('SocialBudget');

  constructor(
    private readonly social: SocialService,
    private readonly provider: ScrapeCreatorsProvider,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly prisma?: PrismaService,
    private readonly telegram?: TelegramService,
  ) {}

  /** The ceiling in force: the Setting, else the default (`CEILING_DEFAULT`). Null = no limit (the owner set 0). */
  ceiling(): Promise<number | null> {
    return this.social.ceiling();
  }

  /**
   * May this call be made today? Only Social actions count — a Sheets write through the other
   * provider is not a credit. `ok:false` carries the plain reason the job's run and the owner get.
   */
  async check(actionId: string): Promise<BudgetCheck> {
    const owned = await this.provider.owns?.(actionId).catch(() => false);
    if (!owned) return { ok: true, spent: 0, ceiling: null, estimate: 0 };
    const [ceiling, slugs] = await Promise.all([this.ceiling(), this.provider.listServices().then((s) => s.map((x) => x.slug)).catch(() => [] as string[])]);
    const spent = await this.social.spentToday(slugs);
    const estimate = await this.estimate(actionId);
    if (ceiling === null || spent + estimate <= ceiling) return { ok: true, spent, ceiling, estimate };
    const reason = `The daily Social credit ceiling is ${ceiling.toLocaleString('en-US')} and ${spent.toLocaleString('en-US')} ${spent === 1 ? 'credit is' : 'credits are'} already spent today; this call (about ${estimate.toLocaleString('en-US')} ${estimate === 1 ? 'credit' : 'credits'}) would pass it, so the job paused itself and no call was made. Raise the ceiling in Settings → Agents & Engines, or switch the job back on tomorrow.`;
    return { ok: false, spent, ceiling, estimate, reason };
  }

  /** What this action cost last time it succeeded — the best guess for what it costs next. */
  private async estimate(actionId: string): Promise<number> {
    try {
      const last = await this.prisma?.toolCall?.findFirst?.({ where: { action: actionId, ok: true, credits: { not: null } }, orderBy: { createdAt: 'desc' }, select: { credits: true } });
      const n = Number(last?.credits);
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
      return 1;
    }
  }

  /**
   * Stop the job and say why — on the row, in the log, and to the owner. The run's own steps are the
   * caller's to write (it knows the run id); this is the durable part.
   */
  async pauseAgent(agent: { id: string; name?: string }, reason: string, runId?: string): Promise<void> {
    await this.prisma?.agent?.update?.({ where: { id: agent.id }, data: { enabled: false, pausedReason: reason.slice(0, 400) } }).catch((e: any) => this.log.warn(`could not pause ${agent.id}: ${e?.message || e}`));
    this.log.warn(`agent ${agent.id} paused itself: ${reason}`);
    const r: any = await this.telegram?.notifyJobPaused?.({ what: agent.name || 'A Social job', reason, url: runId ? `https://mybrain.1site.ai/agent/runs/${runId}` : `https://mybrain.1site.ai/agent/agents/${agent.id}` })?.catch?.((e: any) => ({ sent: false, why: String(e?.message || e) }));
    if (!r?.sent) this.log.warn(`paused-itself message not delivered on Telegram: ${r?.why || 'Telegram is not available on this server'}`);
  }

  /** An Alert's condition came true — one Telegram message with the diff and the run link. */
  async pushAlert(agent: { id: string; name?: string }, text: string, runId: string): Promise<{ sent: boolean; why?: string }> {
    if (!this.telegram?.notifySocialAlert) return { sent: false, why: 'Telegram is not available on this server' };
    try {
      const r = await this.telegram.notifySocialAlert({ what: agent.name || 'Alert', text, url: `https://mybrain.1site.ai/agent/runs/${runId}` });
      return r && typeof r === 'object' ? { sent: !!r.sent, why: r.why } : { sent: false, why: 'Telegram did not answer' };
    } catch (e: any) {
      return { sent: false, why: String(e?.message || e) };
    }
  }
}
