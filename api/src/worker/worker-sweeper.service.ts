import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { customerWords } from '../agent/failure-words';
import { RunLockService, isJobBusy } from '../agent/run-lock.service';
import { AlertsService } from '../push/alerts.service';
import { WorkerRunnerClient } from './worker-runner.client';
import { WorkerTokenService } from './worker-token.service';

// The kit this app is running (§F, the rollback guard) — one copy, shared with the dispatch switch.
import { kitVersion } from './kit-version';

/** How often the three sweeps run. A minute is fine — nothing here is urgent to the second. */
export const TICK_MS = 60_000;

/**
 * A `running` run with no step and no checkpoint for this long has stopped making progress.
 *
 * Twenty minutes, and it is safe because the app checkpoints from INSIDE its own loops — every
 * fetched page, every creator, every shaping batch (BEA-1387 · BEA-1392) — so a legitimately slow
 * job (11 pages with vendor backoff, 50 sequential creator calls, seven shaping batches) stamps
 * "still moving" long before this. Evidence it is needed: on 2026-08-20 a run sat `running` for
 * twenty HOURS with zero steps and nobody was told.
 */
export const STALL_MINUTES = Number(process.env.WORKER_STALL_MINUTES || 20);

/** The roads this watchdog covers. A Codex turn has its own watchdog and its own idea of slow. */
const WATCHED_KINDS = ['worker', 'plan'];

/**
 * The worker road's own sweeper (BEA-1392, agent workers 7/10 — `specs/AGENT-WORKERS.md` §H).
 *
 * `HermesBridgeService.resumeTick()` resumes ENGINE runs only (BEA-1387) — it would otherwise build
 * a Codex "continue the task…" prompt and run a live engine turn in place of the worker. So the
 * worker road needs its own, and it does three things every minute:
 *
 *  1. **resume** a parked run whose question has been answered — spawn it again with a fresh token;
 *     the journal replays everything it already did, so nothing is fetched, written or sent twice;
 *  2. **the deadline** — a question that ran out of time with no default stops the run honestly
 *     rather than waiting for ever (one with a default is resolved by `AgentService.sweepExpired`
 *     and comes back here as an ordinary answer);
 *  3. **the stall watchdog** for both the worker and the plan road.
 */
@Injectable()
export class WorkerSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WorkerSweeper');
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Runs this process is already spawning — a second tick must never start the same one twice. */
  private readonly spawning = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly tokens: WorkerTokenService,
    private readonly runner: WorkerRunnerClient,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly alerts?: AlertsService,
    private readonly locks?: RunLockService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Guarded so a bad tick can never take the app down (the sweeper pattern here). */
  async tick(now: Date = new Date()): Promise<void> {
    await this.sweepDeadlines(now).catch((e) => this.log.warn(`deadlines: ${e?.message || e}`));
    await this.sweepStalls(now).catch((e) => this.log.warn(`stalls: ${e?.message || e}`));
    await this.resumeAnswered().catch((e) => this.log.warn(`resume: ${e?.message || e}`));
  }

  // ---- 1. resume -------------------------------------------------------------------------------

  /** Parked worker runs whose question has been answered — the worker road's `listResumable()`. */
  async resumeAnswered(): Promise<number> {
    const runs = await this.prisma.agentRun.findMany({
      where: { status: 'running', runKind: 'worker', NOT: { sessionId: null }, waitpoints: { some: { status: 'answered' } } },
      select: { id: true, agentId: true, title: true, startedAt: true },
    });
    let started = 0;
    for (const run of runs) {
      if (this.spawning.has(run.id)) continue;
      // The atomic claim first (it clears the park marker), so two ticks — or two app instances —
      // can never spawn one run twice.
      if (!(await this.agent.claimResume(run.id).catch(() => false))) continue;
      const newer = await this.overtakenBy(run);
      if (newer) {
        await this.finishOvertaken(run, newer);
        continue;
      }
      this.spawning.add(run.id);
      started++;
      void this.spawn(run).finally(() => this.spawning.delete(run.id));
    }
    return started;
  }

  /**
   * A newer run of the same job that has already FINISHED since this one parked (§H, decided after
   * BEA-1388).
   *
   * The per-job lock expires in 30 minutes and a question waits up to 12 hours, so a parked agent's
   * next scheduled run starts normally — deliberately, because an unanswered question must never
   * silently stop an agent from running again. This is the consequence, handled rather than
   * discovered: a late answer must not make yesterday's run write today's rows a second time.
   *
   * Only a `done` run counts. A newer run that failed did not do the work, so the answer is still
   * worth having.
   */
  private async overtakenBy(run: { id: string; agentId: string | null; startedAt: Date }): Promise<any | null> {
    if (!run.agentId) return null;
    return this.prisma.agentRun
      .findFirst({
        where: { agentId: run.agentId, id: { not: run.id }, status: 'done', startedAt: { gt: run.startedAt } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, endedAt: true, startedAt: true },
      })
      .catch(() => null);
  }

  /** Say so, and stop: no rows, nothing appended to the Sheet, no message. */
  private async finishOvertaken(run: { id: string; title?: string | null }, newer: any): Promise<void> {
    const when = newer?.endedAt ? new Date(newer.endedAt).toLocaleString('en-GB') : 'since then';
    const why = `A newer run of this job already did this (it finished ${when}) — your answer arrived too late, so this run stopped instead of doing the same work twice. Nothing was written and nothing was sent.`;
    await this.agent.appendStep(run.id, { label: 'Stopped — a newer run already did this', status: 'info', detail: why }).catch(() => undefined);
    await this.agent.finishRun(run.id, { status: 'done', resultText: why }).catch(() => undefined);
    this.tokens.revokeRun(run.id);
    this.log.log(`run ${run.id} was overtaken by ${newer?.id} — finished without repeating anything`);
  }

  /** One spawn of a resumed worker. Its steps come back through `/api/worker/step`, not through here. */
  private async spawn(run: { id: string; agentId: string | null; title?: string | null }): Promise<void> {
    if (!run.agentId) {
      await this.fail(run, 'This run has no job attached any more, so its worker could not be started.');
      return;
    }
    let token = '';
    let seed: any;
    try {
      const minted = await this.tokens.mint(run.id, run.agentId);
      token = minted.token;
      seed = minted.seed;
    } catch (e: any) {
      if (isJobBusy(e)) {
        // Something else holds the job right now. Put the park marker back so the next tick tries
        // again — a busy minute must never strand an answered question. The "still moving" stamp
        // matters as much: a run waiting politely for its own job's lock is not a stalled run, and
        // the watchdog reads exactly this line to tell them apart.
        await this.agent.stampProgress?.(run.id, 'Waiting — another run of this job is still going')?.catch?.(() => undefined);
        await this.agent.parkRun(run.id, 'worker').catch(() => undefined);
        return;
      }
      await this.fail(run, `The worker could not be started: ${String(e?.message || e).slice(0, 300)}`);
      return;
    }
    const r = await this.runner.run({ jobId: run.agentId, runId: run.id, token, seed, kit: kitVersion() });
    this.tokens.revokeRun(run.id);
    if (r.status === 'waiting') return; // it asked again and parked again — nothing to do here
    if (r.status === 'failed') {
      await this.fail(run, r.error || 'The worker stopped without saying why.');
      return;
    }
    // `done`: the worker called `/api/worker/finish` itself, which is the authority on the result.
    // `finishRun` is a no-op on a run that already reached a terminal state.
    await this.agent.finishRun(run.id, { status: 'done' }).catch(() => undefined);
  }

  // ---- 2. the deadline -------------------------------------------------------------------------

  /**
   * A question that ran out of time and named no default. One WITH a default is applied by
   * `AgentService.sweepExpired()` (every minute) and comes back here as an ordinary answer, which
   * is why this only looks at `defaultValue: null`.
   */
  async sweepDeadlines(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.waitpoint.findMany({
      where: {
        status: 'pending',
        defaultValue: null,
        expiresAt: { not: null, lte: now },
        run: { runKind: 'worker', status: { in: ['awaiting_input', 'paused'] } },
      },
      include: { run: { select: { id: true, title: true, agentId: true } } },
    });
    let handled = 0;
    for (const wp of due as any[]) {
      if (!(await this.agent.expireAsk(wp.id).catch(() => false))) continue;
      const hours = Math.max(1, Math.round((now.getTime() - new Date(wp.createdAt).getTime()) / 3600_000));
      const why = `I asked you "${String(wp.question).slice(0, 200)}" and heard nothing for ${hours} hours. The question named no default, so the run stopped rather than guess. Nothing was written. Run it again when you like.`;
      await this.agent.appendStep(wp.runId, { label: `No answer in ${hours} hours — stopped`, status: 'failed', detail: why }).catch(() => undefined);
      await this.agent.finishRun(wp.runId, { status: 'failed', error: why }).catch(() => undefined);
      this.tokens.revokeRun(wp.runId);
      await this.tell(wp.run?.title || 'Your agent', why, wp.runId);
      handled++;
    }
    return handled;
  }

  // ---- 3. the stall watchdog -------------------------------------------------------------------

  /**
   * Runs that are `running` and have written nothing for `STALL_MINUTES` — on BOTH roads, the
   * worker's and the plan runner's. Failed honestly, the owner told, and the per-job lock freed
   * (`finishRun` releases it), so the job can fire again on its next schedule.
   */
  async sweepStalls(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALL_MINUTES * 60_000);
    const runs = await this.prisma.agentRun.findMany({
      where: { status: 'running', runKind: { in: WATCHED_KINDS }, startedAt: { lte: cutoff } },
      select: { id: true, title: true, stepLog: true, startedAt: true },
    });
    let failed = 0;
    for (const run of runs as any[]) {
      if (lastActivityAt(run) > cutoff.getTime()) continue; // it is moving, just slowly
      const why = `This run stopped making progress — nothing was written for ${STALL_MINUTES} minutes, so it was stopped. Nothing half-finished was left behind; run it again when you like.`;
      await this.agent.appendStep(run.id, { label: 'Stopped making progress — nothing was written', status: 'failed', detail: why }).catch(() => undefined);
      await this.agent.finishRun(run.id, { status: 'failed', error: why }).catch(() => undefined);
      this.tokens.revokeRun(run.id);
      await this.locks?.releaseForRun(run.id).catch(() => undefined); // belt and braces: finishRun frees it too
      await this.tell(run.title || 'Your agent', why, run.id);
      failed++;
      this.log.warn(`run ${run.id} stalled — no step or checkpoint for ${STALL_MINUTES} minutes`);
    }
    return failed;
  }

  // ---- shared ----------------------------------------------------------------------------------

  private async fail(run: { id: string; title?: string | null }, why: string): Promise<void> {
    // The step is the customer's (BEA-1580): plumbing-class ("the worker runner could not be
    // reached") becomes the calm shape, anything actionable ends in its move. `finishRun` keeps
    // the honest sentence on the run row untouched.
    await this.agent.appendStep(run.id, { label: customerWords(why).slice(0, 200), status: 'failed' }).catch(() => undefined);
    await this.agent.finishRun(run.id, { status: 'failed', error: why }).catch(() => undefined);
    this.tokens.revokeRun(run.id);
    await this.tell(run.title || 'Your agent', why, run.id);
  }

  /** The owner hears about it on the one road every other alert takes. Never throws. */
  private async tell(name: string, why: string, runId: string): Promise<void> {
    // What lands on his phone follows the same rule as the screen (BEA-1580) — a plumbing failure
    // is never his problem, and everything else names his next move.
    await this.alerts?.runFailed?.(name, customerWords(why), `/agent/runs/${runId}`).catch(() => undefined);
  }
}

/** The last moment this run said anything — a step, or a "still moving" checkpoint. */
export function lastActivityAt(run: { stepLog?: unknown; startedAt: Date | string }): number {
  const started = new Date(run.startedAt).getTime();
  let log: any[] = [];
  try { log = typeof run.stepLog === 'string' ? JSON.parse(run.stepLog) : Array.isArray(run.stepLog) ? (run.stepLog as any[]) : []; } catch { log = []; }
  let last = started;
  for (const s of log) {
    const at = s?.at ? new Date(s.at).getTime() : NaN;
    if (Number.isFinite(at) && at > last) last = at;
  }
  return last;
}
