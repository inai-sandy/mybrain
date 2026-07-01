import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FlowsService } from './flows.service';
import { FlowRunnerService } from './flows-runner.service';

export type Sched = { every: 'day' | 'weekday' | 'week' | 'hour'; at?: string; dow?: number; minute?: number };

/**
 * FlowScheduler (Stage 3) — fires saved flows on their schedule. Per-minute tick gated on the user's
 * local time; dedup via the flow's `lastFiredKey` so a schedule fires once per slot, even across restarts.
 * Mirrors AgentScheduler.
 */
@Injectable()
export class FlowScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('FlowScheduler');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
    private readonly runner: FlowRunnerService,
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
    const { dayKey, hm, dow } = this.localParts(now, tz);
    const flows = await this.flows.listSchedulable();
    let fired = 0;
    for (const f of flows) {
      const key = `${dayKey}:${hm}`;
      if (f.lastFiredKey === key) continue;
      if (!this.matches(f.schedule as Sched, hm, dow)) continue;
      await this.flows.markFired(f.id, key);
      try {
        await this.runner.start(f.id);
        fired++;
      } catch (e: any) {
        this.log.error(`scheduled flow ${f.id} failed to start: ${e?.message || e}`);
      }
    }
    return fired;
  }
}
