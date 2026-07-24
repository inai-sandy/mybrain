import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { HermesBridgeService } from './hermes-bridge.service';
import { PrismaService } from '../prisma/prisma.service';

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
    this.timer = setInterval(() => { this.tick().catch(() => undefined); }, 60_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tz(): Promise<string> {
    const r = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } }).catch(() => null);
    return (r as any)?.value || 'Asia/Kolkata';
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
          await this.bridge.startRun(await this.bridge.applyAgentSkills(a, { prompt: a.prompt, title: a.name, agentId: a.id, saveCollectionId: a.collectionId })); // skills ride along (BEA-1079)
          fired++;
        } catch (e: any) {
          this.log.error(`scheduled agent ${a.id} failed to start: ${e?.message || e}`);
        }
        break;
      }
    }
    return fired;
  }
}
