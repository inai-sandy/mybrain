import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** How many rows of a trial are kept for the screen. Enough to judge it, never the whole job. */
export const TRIAL_ROWS_SHOWN = 25;

export type TrialHold = { kind: string; title: string; table: { columns: string[]; rows: any[][] }; markdown: string };

export type TrialView = {
  id: string;
  areaId: string;
  briefVersion: number;
  agentId: string | null;
  runId: string | null;
  status: 'building' | 'running' | 'passed' | 'failed';
  columns: string[];
  rows: any[][];
  rowCount: number;
  message: string;
  credits: number;
  aiTokens: number;
  verdict: string;
  error: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * The trial run (BEA-1408, "Brief First") — the second gate, and the one that makes a wrong agent
 * unable to reach the owner.
 *
 * Nine hours were lost because what he approved was a *description* of an agent, typed in a chat.
 * A description can say anything. So the last thing between a brief and a live agent is now the
 * program itself, run once, on his real account, with everything it produces held back:
 *
 *  - **nothing is written** — no sheet, no document, no saved row;
 *  - **nothing is sent** — the message is drawn on screen exactly as it would arrive, and sending it
 *    is his tap, to his own number, and nobody else's;
 *  - **it runs small** — enough rows to judge it, not the whole job.
 *
 * This service is only the holder and the record. The worker controller calls `hold()` and
 * `holdMessage()` in place of writing and sending, because trial mode rides on the run's TOKEN — a
 * worker cannot talk its way out of it.
 */
@Injectable()
export class TrialService {
  private readonly log = new Logger('Trial');
  /** runId → the trial row it belongs to. In memory: a trial is minutes long, never days. */
  private readonly byRun = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  // ---- the record --------------------------------------------------------------------------------

  private shape(row: any): TrialView {
    const json = (v: any, fallback: any) => {
      if (v && typeof v === 'object') return v;
      try { return JSON.parse(String(v ?? '')) ?? fallback; } catch { return fallback; }
    };
    return {
      id: String(row.id),
      areaId: String(row.areaId),
      briefVersion: Number(row.briefVersion) || 0,
      agentId: row.agentId ? String(row.agentId) : null,
      runId: row.runId ? String(row.runId) : null,
      status: (['building', 'running', 'passed', 'failed'].includes(row.status) ? row.status : 'building') as any,
      columns: json(row.columns, []),
      rows: json(row.rows, []),
      rowCount: Number(row.rowCount) || 0,
      message: String(row.message || ''),
      credits: Number(row.credits) || 0,
      aiTokens: Number(row.aiTokens) || 0,
      verdict: String(row.verdict || ''),
      error: String(row.error || ''),
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
    };
  }

  /**
   * The trial that proves THIS version of the brief. A trial of an older version is not an answer:
   * what he looked at is no longer what would run, which is the whole point of the gate.
   */
  async latest(areaId: string, briefVersion: number): Promise<TrialView | null> {
    const row = await this.prisma?.agentTrial?.findFirst?.({
      where: { areaId: String(areaId), briefVersion: Number(briefVersion) },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.shape(row) : null;
  }

  async get(id: string): Promise<TrialView | null> {
    const row = await this.prisma?.agentTrial?.findUnique?.({ where: { id: String(id) } });
    return row ? this.shape(row) : null;
  }

  async start(input: { areaId: string; briefId: string; briefVersion: number; agentId?: string | null }): Promise<TrialView> {
    const row = await this.prisma.agentTrial.create({
      data: {
        areaId: String(input.areaId),
        briefId: String(input.briefId),
        briefVersion: Number(input.briefVersion),
        agentId: input.agentId || null,
        status: 'building',
      },
    });
    return this.shape(row);
  }

  /** Bind a run to its trial, so the held rows and message find their way home. */
  async attach(trialId: string, runId: string): Promise<void> {
    this.byRun.set(String(runId), String(trialId));
    await this.prisma?.agentTrial?.update?.({ where: { id: String(trialId) }, data: { runId: String(runId), status: 'running' } }).catch(() => undefined);
  }

  private async idFor(runId: string): Promise<string | null> {
    const known = this.byRun.get(String(runId));
    if (known) return known;
    // A restart between spawn and callback loses the map, not the answer.
    const row = await this.prisma?.agentTrial?.findFirst?.({ where: { runId: String(runId) }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (row) this.byRun.set(String(runId), String(row.id));
    return row ? String(row.id) : null;
  }

  // ---- what the run produced, held back ------------------------------------------------------------

  /** What would have been written. It is not written. */
  async hold(runId: string, out: TrialHold): Promise<void> {
    const id = await this.idFor(runId);
    if (!id) return;
    const columns = out.kind === 'sheet' ? out.table.columns || [] : ['result'];
    const all = out.kind === 'sheet' ? out.table.rows || [] : [[out.markdown]];
    await this.prisma?.agentTrial?.update?.({
      where: { id },
      data: {
        columns: JSON.stringify(columns),
        rows: JSON.stringify(all.slice(0, TRIAL_ROWS_SHOWN)),
        // The COUNT is the whole count, even though only the first rows are kept — "20 of 47" is the
        // number he is judging, and showing 25 as if it were everything would be its own small lie.
        rowCount: all.length,
      },
    }).catch((e: any) => this.log.warn(`could not hold the trial rows: ${e?.message || e}`));
  }

  /** The message exactly as it would arrive. It is not sent. */
  async holdMessage(runId: string, message: string): Promise<void> {
    const id = await this.idFor(runId);
    if (!id) return;
    await this.prisma?.agentTrial?.update?.({ where: { id }, data: { message: String(message || '') } }).catch(() => undefined);
  }

  /** How the trial ended, and what it cost. */
  async settle(runId: string, out: { ok: boolean; verdict?: string; error?: string; credits?: number; aiTokens?: number }): Promise<void> {
    const id = await this.idFor(runId);
    if (!id) return;
    await this.prisma?.agentTrial?.update?.({
      where: { id },
      data: {
        status: out.ok ? 'passed' : 'failed',
        verdict: String(out.verdict || '').slice(0, 600),
        error: String(out.error || '').slice(0, 900),
        credits: Math.max(0, Math.round(Number(out.credits) || 0)),
        aiTokens: Math.max(0, Math.round(Number(out.aiTokens) || 0)),
      },
    }).catch((e: any) => this.log.warn(`could not settle the trial: ${e?.message || e}`));
    this.byRun.delete(String(runId));
  }

  async fail(trialId: string, why: string): Promise<void> {
    await this.prisma?.agentTrial?.update?.({ where: { id: String(trialId) }, data: { status: 'failed', error: String(why || '').slice(0, 900) } }).catch(() => undefined);
  }

  /** Everything for one agent — swept when the agent is deleted. */
  async forget(areaId: string): Promise<void> {
    await this.prisma?.agentTrial?.deleteMany?.({ where: { areaId: String(areaId) } }).catch(() => undefined);
  }
}

/**
 * May this brief be created as a live agent?
 *
 * Pure, so the rule is one sentence and one test rather than a condition spread over a controller:
 * **a passing trial of THIS version of the brief, or no.**
 */
export function whyNotCreatable(brief: { version: number; status: string }, trial: TrialView | null): string {
  if (brief.status !== 'approved') return 'Read the brief and approve it first.';
  if (!trial) return 'Run it once first, so you can see what it really does before you keep it.';
  if (trial.briefVersion !== brief.version) return 'You changed the brief after that run, so what you saw is not what would happen now. Run it once more.';
  if (trial.status === 'building' || trial.status === 'running') return 'It is still running. Give it a moment.';
  if (trial.status === 'failed') return `That run did not work${trial.error ? `: ${trial.error}` : ''}. Fix it and run it again.`;
  return '';
}
