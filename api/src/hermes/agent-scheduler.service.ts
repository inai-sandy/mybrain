import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { isJobBusy } from '../agent/run-lock.service';
import { HermesBridgeService } from './hermes-bridge.service';
import { PrismaService } from '../prisma/prisma.service';
import { guardedTick, safeTz } from './schedule-clock';

export type Sched = { every: 'day' | 'weekday' | 'week' | 'hour'; at?: string; dow?: number; minute?: number };

/**
 * AgentScheduler (BEA-623) — fires saved agents on their schedule. Per-minute tick gated on the
 * user's local time (same shape as gmail-brief.service.ts). Dedup via the agent's `lastFiredKey`
 * so a schedule fires exactly once per slot, even across restarts.
 */
@Injectable()
export class AgentScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AgentScheduler');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly agent: AgentService,
    private readonly bridge: HermesBridgeService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    // A throw is logged, never swallowed, and the next tick still runs (BEA-1605).
    this.timer = setInterval(() => { void guardedTick('AgentScheduler', this.log, () => this.tick()); }, 60_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tz(): Promise<string> {
    const r = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } }).catch(() => null);
    return safeTz((r as any)?.value, 'AgentScheduler', this.log); // a zone Intl rejects falls back, out loud (BEA-1605)
  }

  localParts(now: Date, tz: string): { dayKey: string; hm: string; dow: number } {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
    const parts: any = {};
    for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
    const hh = parts.hour === '24' ? '00' : parts.hour;
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { dayKey: `${parts.year}-${parts.month}-${parts.day}`, hm: `${hh}:${parts.minute}`, dow: dowMap[parts.weekday] ?? 0 };
  }

  matches(s: Sched | null | undefined, hm: string, dow: number): boolean {
    if (!s || !s.every) return false;
    if (s.every === 'hour') return Number(hm.split(':')[1]) === (s.minute ?? 0);
    if (!s.at || hm !== s.at) return false;
    if (s.every === 'day') return true;
    if (s.every === 'weekday') return dow >= 1 && dow <= 5;
    if (s.every === 'week') return dow === (s.dow ?? 1);
    return false;
  }

  async tick(now: Date = new Date()): Promise<number> {
    const tz = await this.tz();
    const agents = await this.agent.listSchedulable();
    // Look back a few minutes so a drifted/stalled 60s timer can't skip a slot; lastFiredKey still
    // dedups per (day,minute) so each slot fires at most once. (BEA-798)
    const slots = [2, 1, 0].map((back) => this.localParts(new Date(now.getTime() - back * 60_000), tz));
    let fired = 0;
    for (const a of agents) {
      for (const { dayKey, hm, dow } of slots) {
        const key = `${dayKey}:${hm}`;
        if (a.lastFiredKey === key) continue;
        if (!this.matches(a.schedule as Sched, hm, dow)) continue;
        await this.agent.markFired(a.id, key);
        a.lastFiredKey = key;
        try {
          await this.bridge.startRun(await this.bridge.applyAgentSkills(a, { prompt: a.prompt, title: a.name, agentId: a.id, saveCollectionId: a.collectionId, lockReason: 'the scheduled run' })); // skills ride along (BEA-1079)
          fired++;
        } catch (e: any) {
          if (isJobBusy(e)) await this.skipped(a, hm, e);
          else this.log.error(`scheduled agent ${a.id} failed to start: ${e?.message || e}`);
        }
        break;
      }
    }
    return fired;
  }

  /**
   * The slot came round while the last run was still going (BEA-1388). The fire is **skipped, not
   * queued and not duplicated** — a job that takes longer than its own interval would otherwise pile
   * runs on top of each other, sharing one Watch baseline, one "keep adding" sheet and one credit
   * ceiling.
   *
   * It is never silent. The line goes in the log AND — the part the owner can actually see — a step
   * lands on the run that is still going: open it and the reason the 08:00 fire is missing is right
   * there in its own step list. The slot still counts as fired (`markFired` already ran), exactly
   * like a fire that throws today, so the same slot is not retried a minute later.
   */
  private async skipped(a: any, hm: string, e: any): Promise<void> {
    const heldRunId = e?.held?.runId || null;
    this.log.log(`scheduled agent ${a.id} skipped at ${hm}: previous run still going${heldRunId ? ` (run ${heldRunId})` : ''}`);
    if (!heldRunId) return;
    try {
      await this.agent.appendStep(heldRunId, {
        label: `Skipped the ${hm} start — this run was still going`,
        status: 'info',
        kind: 'info',
        detail: 'One run at a time per job: the scheduled start was skipped, not queued. It will fire again at its next time.',
      });
    } catch { /* a note that cannot be written is not worth a crash in the tick */ }
  }
}
