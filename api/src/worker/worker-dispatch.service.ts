import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { isJobBusy } from '../agent/run-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';

import { RunJournalService } from './run-journal.service';
import { WorkerBuildService } from './worker-build.service';
import { WorkerRunnerClient } from './worker-runner.client';
import { WorkerTokenService } from './worker-token.service';
import { kitVersion } from './kit-version';

/** What `decide()` answers: which road this run takes, and the one line the owner reads about it. */
export type RoadDecision = {
  /** true = the worker road. Anything else runs exactly as it does today. */
  use: boolean;
  /** A visible step to write on the run when the switch is ON but the worker road is not available. */
  say?: string;
  /** The live worker's version, when there is one. */
  version?: number;
};

/**
 * The dispatch switch (BEA-1394, agent workers 9/10 — `specs/AGENT-WORKERS.md` §I).
 *
 * Every piece before this one assumed something else decided WHEN a job runs on its worker rather
 * than on the plan runner. Nothing did: since BEA-1390 a promoted worker has been installed and
 * completely inert. This service is that decision, and it has exactly two rules:
 *
 *  1. **A run takes the worker road only when the job has a promoted worker AND `Agent.useWorker`
 *     is on.** Nothing converts automatically, ever. The owner turns it on per job in the Worker
 *     row, and "run it the old way" turns it back off instantly — no rebuild, no migration.
 *  2. **The worker road being unavailable is never a failed run.** A stale worker (the plan was
 *     edited since it was compiled), a missing one, or one the runner refuses (built for a newer
 *     kit, the runner not installed, the host busy) falls back to the plan runner FOR THAT RUN and
 *     says so in a step the owner can read. Only a worker that really started and really failed
 *     fails the run — and that one goes to the self-heal loop (BEA-1393), which is why the fallback
 *     is decided on `notStarted` and on an empty journal, never on the error text.
 *
 * It hangs off `HermesBridgeService.startRun()` — the one door the scheduler, both manual routes,
 * event triggers and the voice lane already come through, and where the per-job lock is claimed —
 * through the same registration seam the flow drawer and the repair loop use, because WorkerModule
 * imports HermesModule and never the other way round.
 */
@Injectable()
export class WorkerDispatchService implements OnModuleInit {
  private readonly log = new Logger('WorkerDispatch');

  constructor(
    private readonly agent: AgentService,
    private readonly builds: WorkerBuildService,
    private readonly tokens: WorkerTokenService,
    private readonly runner: WorkerRunnerClient,
    private readonly journal: RunJournalService,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly bridge?: HermesBridgeService,
    private readonly prisma?: PrismaService,
  ) {}

  onModuleInit() {
    this.bridge?.setWorkerDispatch?.(this);
    // Deleting an agent deletes its worker (§I). The rows are the app's to clean up; the folders on
    // the host belong to the runner, so `deleteAgent` asks through this seam and never blocks on it.
    this.agent.setWorkerCleanup?.((jobId: string) => this.forget(jobId));
    // A finished worker run's journal goes at `finishRun()`, whichever road ended it (BEA-1401).
    // The worker's own `/finish` is only one of four; the other three are the sweeper's, and by then
    // the worker process is already gone and can never call anything.
    this.agent.setJournalCleanup?.((runId: string) => this.journal.forget(runId));
  }

  // ---- the decision ----------------------------------------------------------------------------

  /**
   * Which road this job's next run takes. Also the answer the Worker row shows, so what the owner
   * reads is decided by the same function that dispatches.
   */
  async decide(agentId: string): Promise<RoadDecision> {
    const job: any = await this.agent.getAgent(agentId).catch(() => null);
    return this.decideFor(job);
  }

  /** The same decision from a job already in hand (the run road has one; the Worker row has one). */
  async decideFor(job: any): Promise<RoadDecision> {
    // OFF is the default and the quiet case: no step, no lookup, nothing said. The owner's existing
    // jobs are all `useWorker:false`, so they behave exactly as they did before this piece.
    if (!job?.id || !job.useWorker) return { use: false };
    // The SAME rule the build and the screen use (BEA-1454, and again here in BEA-1462).
    // `isDirectFetchAgent` used to stand here, and it is a DIFFERENT question — "can the plan runner
    // do this whole job" — which answers no for a brief-built job that writes anywhere. That made a
    // job with a green, promoted worker fall back to the engine on every single run.
    const cannot = WorkerBuildService.whyNotCompilableFor(job);
    if (cannot) return { use: false, say: `Ran it the old way — ${lowerFirst(cannot)}` };
    const worker = await this.builds.livePromoted(job.id).catch(() => null);
    if (!worker) {
      return { use: false, say: 'Ran it the old way — no worker is built for this job yet. Build one in Settings → Worker.' };
    }
    // …and the SAME hash, from the one function that computes it. Bare `planHashOf` stood here while
    // the build stamped `buildHashOf(plan, brief)`, so a job with an approved brief could never match
    // and was told to rebuild for ever — even seconds after a fresh build.
    const planHash = await this.builds.buildHashFor(job);
    if (planHash && worker.planHash !== planHash) {
      return {
        use: false,
        version: worker.version,
        say: `Ran it the old way — the plan changed since worker v${worker.version} was built, so it is out of date. Rebuild it in Settings → Worker.`,
      };
    }
    return { use: true, version: worker.version };
  }

  // ---- the road --------------------------------------------------------------------------------

  /**
   * Run this run on its worker. Answers `{}` when the worker road owned the run (it finished, failed
   * or parked on a question) and `{ fallback }` when nothing of ours ran, in which case the caller
   * carries on down the ordinary road with the SAME run row and writes the reason as a step.
   */
  async run(runId: string, agentId: string, opts: { version?: number; trial?: boolean } = {}): Promise<{ fallback?: string }> {
    await this.agent
      .appendStep(runId, {
        label: opts.trial
          ? 'Trying it once, for real — nothing will be saved and nothing will be sent'
          : `Running this job's worker${opts.version ? ` (v${opts.version})` : ''}`,
        status: 'info',
      })
      .catch(() => undefined);

    let token = '';
    let seed: any;
    try {
      const minted = await this.tokens.mint(runId, agentId, { trial: !!opts.trial });
      token = minted.token;
      seed = minted.seed;
    } catch (e: any) {
      // The job lock is already this run's (it was claimed at `startRun`), so a busy answer here can
      // only mean somebody else took it over — which is not a road problem, and the plan runner would
      // hit the same wall. Say it plainly and let the ordinary road refuse it the ordinary way.
      if (isJobBusy(e)) return { fallback: 'Another run of this job is holding it, so its worker was not started.' };
      return { fallback: `The worker could not be started (${String(e?.message || e).slice(0, 160)}).` };
    }

    const r = await this.runner.run({ jobId: agentId, runId, token, seed, kit: kitVersion() });
    this.tokens.revokeRun(runId);

    if (r.status === 'waiting') return {}; // parked on a question — the sweeper owns it from here
    if (r.status === 'done') {
      // …unless a question of this run is still open. A worker that parks EXITS, and an exit with
      // nothing else said reads as a clean `done` at the runner — so a worker built against a kit
      // that does not say "waiting" on its way out would have its run finished here, and
      // `finishRun` cancels every pending waitpoint: the owner is left holding a question on his
      // phone that can never be answered, and the run says it is done having written nothing. The
      // BEA-1395 acceptance run met exactly that. The database is the authority on whether a
      // question is open, so it is asked here rather than trusted from the child's exit code.
      if (await this.questionOpen(runId)) return {};
      // The worker called `/api/worker/finish` itself, which is the authority on the result;
      // `finishRun` is a no-op on a run that already reached a terminal state.
      await this.agent.finishRun(runId, { status: 'done' }).catch(() => undefined);
      return {};
    }

    // Failed. Two very different things wear that word, and telling them apart is the whole point:
    // a worker that never started (no worker installed, kit too new, the runner down) leaves the run
    // untouched and free to go the old way; a worker that ran and broke is a real failure with
    // evidence, and it belongs to the repair loop.
    if (await this.neverRan(r, runId)) {
      await this.journal.forget(runId).catch(() => undefined); // only the seed can be there; start clean
      // One sentence, not two glued together: the runner's reason is folded into the owner's line
      // (its own leading capital and full stop would read as a second sentence inside this one).
      const why = String(r.error || 'the worker road was not available').replace(/\.$/, '').replace(/^([A-Z])(?![A-Z])/, (m) => m.toLowerCase());
      this.log.warn(`run ${runId}: worker road unavailable — ${why}`);
      return { fallback: `Ran it the old way for this run — ${why}.` };
    }
    await this.agent.finishRun(runId, { status: 'failed', error: r.error || 'The worker stopped without saying why.' }).catch(() => undefined);
    return {};
  }

  /** Is a question of this run still waiting for the owner? Then the run is parked, not finished. */
  private async questionOpen(runId: string): Promise<boolean> {
    const open = await this.prisma?.waitpoint
      ?.findFirst?.({ where: { runId, status: 'pending' }, select: { id: true } })
      .catch(() => null);
    return !!open;
  }

  /**
   * Did this spawn leave the run exactly as it found it?
   *
   * `notStarted` is the runner's own word for a refusal that happened before the spawn, and the
   * journal is the second half of the same question: it records every effectful call a worker makes,
   * so an empty one (only the run's seed, at `seq -1`) means nothing was fetched, written or sent.
   * Both must hold. A client-side timeout on a worker that really was working answers `notStarted`
   * from the transport, and the journal is what stops that from re-running the work.
   */
  private async neverRan(r: { notStarted?: boolean }, runId: string): Promise<boolean> {
    if (!r.notStarted) return false;
    const entries = await this.journal.list(runId).catch(() => [] as { seq: number }[]);
    return !(entries || []).some((e) => e.seq >= 0);
  }

  // ---- housekeeping ----------------------------------------------------------------------------

  /** Delete this job's worker folders on the host. Never throws — a delete is not held up by disk. */
  async forget(jobId: string): Promise<void> {
    const r = await this.runner.remove(jobId).catch(() => ({ ok: false, error: 'the worker runner could not be reached' }));
    if (!r?.ok) this.log.warn(`worker folder for ${jobId} was not removed: ${r?.error || 'unknown reason'}`);
  }
}

/**
 * Join a stand-alone sentence onto the end of another one (BEA-1462).
 *
 * `whyNotCompilableFor()` writes sentences that start a paragraph on the build screen ("This job has
 * nothing to fetch from yet…"). Dropping one straight after "Ran it the old way — " gives a capital
 * letter in the middle of a sentence, which reads as a machine stitching two strings together — and
 * it is on the run screen, which is the owner's, not a log.
 *
 * An id or an acronym keeps its case: `svc:gmail.send_email is not something an agent can use` must
 * not become `Svc:` — or worse, be "corrected" the other way.
 */
export function lowerFirst(s: string): string {
  const t = String(s || '');
  const first = t.split(/\s/)[0] || '';
  if (first.includes(':') || first === first.toUpperCase()) return t; // an id, or an acronym
  return t.charAt(0).toLowerCase() + t.slice(1);
}
