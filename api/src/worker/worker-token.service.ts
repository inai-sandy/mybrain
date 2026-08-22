import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AgentService } from '../agent/agent.service';
import { RunJournalService } from './run-journal.service';

/**
 * How long a spawn's token lives. Minutes, never days: a token is minted per SPAWN, not per run,
 * and revoked when the worker exits — including the exit into a two-day pause, which mints a fresh
 * one on resume (`specs/AGENT-WORKERS.md` §I, "the callback token does not sleep").
 */
export const TOKEN_TTL_MS = 20 * 60_000;

export type WorkerIdentity = { runId: string; agentId: string | null; expiresAt: number };
export type WorkerSpawn = WorkerIdentity & {
  token: string;
  /** The worker's frozen clock + random seed for this RUN (the same across every spawn of it). */
  seed: { now: number; random: number };
};

/**
 * The run-scoped tokens the callback API accepts (BEA-1387 §C).
 *
 * Not a user session and not an API key: a token names one run, is bound to `{runId, agentId,
 * expiresAt}`, and is passed to the spawned process in its environment — never written into the
 * worker folder. The app never trusts a worker for identity; `runId`/`agentId` come from the token
 * and never from the body.
 *
 * Kept in memory on purpose: a token's life is a spawn, and a deploy kills in-flight runs anyway
 * (`docker rm -f`, then the boot reconciler fails whatever was left running).
 */
@Injectable()
export class WorkerTokenService {
  private readonly live = new Map<string, WorkerIdentity>();

  constructor(
    private readonly journal: RunJournalService,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly agent?: AgentService,
  ) {}

  /**
   * A token for one spawn of one run. Marks the run as a worker run first, so the Codex resume
   * sweeper leaves it alone from the moment it exists, and hands back the run's recorded seed.
   */
  async mint(runId: string, agentId: string | null, opts: { ttlMs?: number } = {}): Promise<WorkerSpawn> {
    await this.agent?.setRunKind?.(runId, 'worker')?.catch?.(() => undefined);
    const seed = await this.journal.seed(runId);
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + Math.max(1, opts.ttlMs ?? TOKEN_TTL_MS);
    this.live.set(token, { runId, agentId: agentId || null, expiresAt });
    this.sweep();
    return { token, runId, agentId: agentId || null, expiresAt, seed };
  }

  /** Who is calling — null for an unknown, expired or revoked token. Nothing else grants access. */
  verify(token: string): WorkerIdentity | null {
    const found = this.live.get(String(token || ''));
    if (!found) return null;
    if (found.expiresAt <= Date.now()) {
      this.live.delete(String(token));
      return null;
    }
    return found;
  }

  /** The worker exited (finished, failed, or parked on a question) — its token stops working now. */
  revoke(token: string): void {
    this.live.delete(String(token || ''));
  }

  /** Every token of one run, whoever holds it: what `finishRun` and a pause both call. */
  revokeRun(runId: string): number {
    let n = 0;
    for (const [token, id] of this.live.entries()) {
      if (id.runId === runId) { this.live.delete(token); n++; }
    }
    return n;
  }

  /** How many tokens are alive — the tests count with it; expired ones are dropped as they are seen. */
  liveCount(): number {
    this.sweep();
    return this.live.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, id] of this.live.entries()) if (id.expiresAt <= now) this.live.delete(token);
  }
}
