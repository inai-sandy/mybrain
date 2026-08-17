import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { stableHash, storable } from './diff';

/**
 * What a Watch/Alert job saw last time (BEA-1358) — the `SocialWatch` table, one row per (job,
 * action, arguments). Thin on purpose: read the row, write the row. The diff itself is `diff.ts`
 * (pure), the run is `SocialAgentRunService`. A failed fetch never reaches `save()`, so the last
 * good result is never overwritten by a failure.
 */

export type WatchRow = {
  id: string;
  agentId: string;
  actionId: string;
  args: any;
  lastHash: string;
  /** The stored last result, parsed. */
  lastResult: any;
  lastAt: Date;
  alertState: string | null;
  lastAlertedAt: Date | null;
};

@Injectable()
export class SocialWatchStore {
  constructor(private readonly prisma?: PrismaService) {}

  /** The arguments' stable key — the same arguments in another order are the same watch. */
  argsHash(args: any): string {
    return stableHash(args && typeof args === 'object' ? args : {});
  }

  async get(agentId: string, actionId: string, args: any): Promise<WatchRow | null> {
    const row = await this.prisma?.socialWatch?.findUnique?.({ where: { agentId_actionId_argsHash: { agentId, actionId, argsHash: this.argsHash(args) } } }).catch(() => null);
    if (!row) return null;
    let lastResult: any = null;
    try { lastResult = JSON.parse(row.lastResult); } catch { lastResult = null; }
    let parsedArgs: any = {};
    try { parsedArgs = JSON.parse(row.args); } catch { parsedArgs = {}; }
    return { id: row.id, agentId: row.agentId, actionId: row.actionId, args: parsedArgs, lastHash: row.lastHash, lastResult, lastAt: row.lastAt, alertState: row.alertState ?? null, lastAlertedAt: row.lastAlertedAt ?? null };
  }

  /**
   * Store the fresh result as "last". `data` is the provider's answer; it is cleaned and capped
   * here (`storable`). `alert` carries the once-only state for a numeric threshold, when there is one.
   */
  async save(agentId: string, actionId: string, args: any, data: any, alert?: { state?: string | null; alertedAt?: Date | null }): Promise<void> {
    const argsHash = this.argsHash(args);
    const lastHash = stableHash(data);
    const lastResult = storable(data);
    const now = new Date();
    const extra: any = {};
    if (alert && alert.state !== undefined) extra.alertState = alert.state;
    if (alert && alert.alertedAt !== undefined) extra.lastAlertedAt = alert.alertedAt;
    // Deliberately NOT swallowed: a row that failed to store must fail the run (the caller catches
    // and says so), or the next run would report the same change again as if it were new.
    try {
      await this.prisma?.socialWatch?.upsert?.({
        where: { agentId_actionId_argsHash: { agentId, actionId, argsHash } },
        create: { agentId, actionId, argsHash, args: JSON.stringify(args && typeof args === 'object' ? args : {}), lastHash, lastResult, lastAt: now, ...extra },
        update: { lastHash, lastResult, lastAt: now, ...extra },
      });
    } catch (e: any) {
      throw new Error(`could not store what this job saw (${String(e?.message || e).slice(0, 120)})`);
    }
  }

  /** Every watch row of one job — for the job page ("watching since …"). */
  async listForAgent(agentId: string): Promise<{ actionId: string; args: any; lastAt: Date; alertState: string | null; lastAlertedAt: Date | null }[]> {
    const rows = await this.prisma?.socialWatch?.findMany?.({ where: { agentId }, orderBy: { lastAt: 'desc' } }).catch(() => []);
    return (rows || []).map((r: any) => { let args: any = {}; try { args = JSON.parse(r.args); } catch { args = {}; } return { actionId: r.actionId, args, lastAt: r.lastAt, alertState: r.alertState ?? null, lastAlertedAt: r.lastAlertedAt ?? null }; });
  }

  /** Forget what a job saw — the next run is a baseline again. */
  async reset(agentId: string): Promise<number> {
    const r = await this.prisma?.socialWatch?.deleteMany?.({ where: { agentId } }).catch(() => ({ count: 0 }));
    return r?.count || 0;
  }
}
