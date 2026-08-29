import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { RunLockService } from '../agent/run-lock.service';
import { AlertsService } from '../push/alerts.service';
import { opsAlertIfPlumbing } from '../push/ops-alert';
import { isModelBlank } from '../agent/failure-words';
import { ToolSampleService } from '../tools/tool-sample.service';
import { planFromAgent, sourceActionId } from '../social/plan';
import { contractFromPlan } from './contract';
import { planInWords } from './build-brief';
import { RunJournalService } from './run-journal.service';
import { WorkerBuildService } from './worker-build.service';
import { WorkerRunnerClient } from './worker-runner.client';
import { parityHarness } from './parity-harness';
import {
  Drift,
  FAILING_FILE,
  FailureCause,
  FetchEvidence,
  MAX_ATTEMPTS,
  ParityResult,
  causeOf,
  driftOf,
  failingFile,
  fixedWords,
  heldWords,
  repairBrief,
  ruleWords,
  stopWords,
} from './repair';

const gunzipAsync = promisify(gunzip);

/** How often the queue is looked at. A repair is never urgent to the second. */
export const REPAIR_TICK_MS = 60_000;

/** How long the job's lock is held while a repair runs. Two Codex turns fit inside it comfortably. */
export const REPAIR_LOCK_MS = 25 * 60_000;

/**
 * The build rows that count as an attempt at a cause: one that failed, one that was held for the
 * owner (it did not fix anything until he says so), and one that went live and did not hold. ONE
 * list, read by both the cap and the "what has already been tried" note — two lists is how a cause
 * gets three tries out of a two-try rule.
 */
export const COUNTED = ['failed', 'held', 'promoted'];

/**
 * Self-heal (BEA-1393, agent workers 8/10 — `specs/AGENT-WORKERS.md` §G).
 *
 * The owner's reason for this whole architecture: *"If a micro-service fails, Codex will re-stitch
 * the changes that are required."* This is that mechanism, and it is built so it cannot go wrong
 * quietly:
 *
 *  1. **Capture.** A worker run that fails is caught at `finishRun()` — the one door every terminal
 *     state comes through — and the answers that broke it are kept as `ToolSample(kind:'failing')`
 *     with the error and the contract attached, BEFORE the journal is dropped. A repair reads what
 *     actually happened instead of guessing.
 *  2. **Two attempts, per failure CAUSE.** The owner's own number. The cause is `jobId|rule|actionId`
 *     (`causeOf`), so the same break never re-enters the loop once it has stopped — and a different
 *     break still gets its own two tries.
 *  3. **Serialised on the job's own lock** (BEA-1388), so a repair never runs while a run of that job
 *     is in flight, and never two at once.
 *  4. **Never a vendor call.** A repair is compiled and tested against saved answers only: the Codex
 *     turn runs in a folder with no token and no network, and the measurement afterwards runs in a
 *     throwaway copy with `fetch` replaced. A repair loop that could spend the owner's credits would
 *     be worse than the bug it is fixing.
 *  5. **The promotion guard.** Green tests are not enough. Both the live version and the repair are
 *     run against the same saved answers, and a repair whose rows move beyond the tolerance is
 *     **held for the owner**, not promoted. Self-healing may fix plumbing; it may not quietly change
 *     what his agents return.
 *  6. **STOP is a real stop.** After two failed attempts the job is paused the one existing way —
 *     `enabled:false` AND `pausedReason` (the `SocialBudgetService.pauseAgent()` convention) — and he
 *     is told what broke and what was tried. **Retirement to the plan runner is his tap**, so the
 *     notice says so and nothing here switches roads behind his back.
 */
@Injectable()
export class WorkerRepairService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WorkerRepair');
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Jobs this process is already repairing — a second tick must never start the same one twice. */
  private readonly working = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly builds: WorkerBuildService,
    private readonly runner: WorkerRunnerClient,
    private readonly journal: RunJournalService,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly samples?: ToolSampleService,
    private readonly locks?: RunLockService,
    private readonly alerts?: AlertsService,
  ) {}

  onModuleInit() {
    // Every road that fails a worker run comes through `finishRun()`, so this is the only hook the
    // loop needs (AgentModule cannot import this module — the registration pattern, as elsewhere).
    this.agent.setRunFailedHook?.((runId, ctx) => this.onRunFailed(runId, ctx));
    this.timer = setInterval(() => void this.tick().catch(() => undefined), REPAIR_TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- 1. capture --------------------------------------------------------------------------------

  /**
   * A worker run failed. Keep the evidence and, if this job has a worker to repair and this failure
   * has attempts left, queue one. Nothing here starts a Codex session — the run has only just ended
   * and its own lock may still be settling; the queue is drained on the next tick, under the lock.
   *
   * Never throws: it is called from inside `finishRun()`.
   */
  /**
   * Did this run end because HE answered a question, rather than because something broke?
   *
   * True when the run has a question he actually answered and the run ended after it. A wall the
   * worker could not get past is still worth knowing about — but it is a finding, not a defect, and
   * spending a Codex build on "the owner pressed stop" helps nobody.
   */
  private async ownerChoseToStop(runId: string): Promise<boolean> {
    const answered: any = await this.prisma.waitpoint
      .findFirst({ where: { runId, status: 'answered' }, orderBy: { answeredAt: 'desc' }, select: { answeredAt: true } })
      .catch(() => null);
    if (!answered?.answeredAt) return false;
    const run: any = await this.prisma.agentRun.findUnique({ where: { id: runId }, select: { endedAt: true } }).catch(() => null);
    if (!run?.endedAt) return false;
    return new Date(run.endedAt).getTime() >= new Date(answered.answeredAt).getTime();
  }

  async onRunFailed(runId: string, ctx: { agentId: string | null; error: string; runKind: string }): Promise<string | null> {
    try {
      const agentId = ctx.agentId;
      if (!agentId || !String(ctx.error || '').trim()) return null;

      // A MODEL BLANK REPAIRS NOTHING (BEA-1582). One transient blank at the provider failed the
      // Daily Email Agent's run AND spent a Codex session repairing a worker that was never broken
      // — a promotion (v10) with no parity baseline, all for weather. The run's failure is real and
      // stays failed (the retry against the blink lives in `completeHelper`, BEA-1582's other
      // half); what must NOT happen is the repair loop treating a provider outage as a crash in the
      // worker's own code. BEA-1580's classifier decides — the one list, never a second one here.
      if (isModelBlank(ctx.error)) {
        this.log.log(`run ${runId} failed because a model answered nothing — a provider blink, not a broken worker; no repair queued`);
        return null;
      }

      const job = await this.agent.getAgent(agentId).catch(() => null);
      if (!job) return null;


      const fetches = await this.evidenceOf(runId, job);
      const cause = causeOf({ jobId: agentId, error: ctx.error, fetches });
      const contract = safeContract(job);
      const sampleIds = await this.keepEvidence(agentId, cause, contract, ctx.error, fetches);

      // HIS DECISION IS NOT A DEFECT (BEA-1546).
      //
      // A worker that hits a wall asks him, and Codex writes the "he said stop" branch as
      // `kit.fail('Stopped at your request…')` — so a run he deliberately ended arrives here looking
      // exactly like a crash. It cost a real Codex build: his Reddit agent asked, he answered "Stop
      // this run", and the repair loop was handed "Stopped at your request; nothing further was sent."
      // as the thing to fix. It rebuilt, promoted v2, and changed nothing that mattered — the sentence
      // it was given described his button press, not the wall.
      //
      // Deliberately placed AFTER the evidence is kept: the wall is still worth having for a later
      // rebuild. What is skipped is spending a Codex build on "the owner pressed stop".
      //
      // Detected from the RUN, not the wording, so it holds however a worker phrases it: a question he
      // answered, and a failure that followed it. Nothing else ends that way.
      if (await this.ownerChoseToStop(runId).catch(() => false)) {
        this.log.log(`run ${runId} ended on his own answer — kept the evidence, but this is not a defect to repair`);
        return null;
      }

      const live = await this.builds.livePromoted(agentId);
      if (!live) return null; // nothing to repair — this job has no worker of its own
      const done = await this.attemptsFor(agentId, cause.key);
      if (done >= MAX_ATTEMPTS) {
        this.log.warn(`job ${agentId}: "${cause.rule}" has already had its ${MAX_ATTEMPTS} repairs — not trying again`);
        return null;
      }
      // One repair per cause at a time — and `held` counts as waiting: a repair the owner has not
      // decided on yet is not finished, and queueing another would ask Codex to solve a problem that
      // may already have a fix sitting there.
      const waiting = await this.prisma.workerBuild
        .findFirst({ where: { agentId, origin: 'repair', cause: cause.key, status: { in: ['queued', 'building', 'held'] } }, select: { id: true } })
        .catch(() => null);
      if (waiting) return null;

      const row = await this.prisma.workerBuild.create({
        data: {
          agentId,
          version: 0,
          status: 'queued',
          origin: 'repair',
          cause: cause.key,
          reason: String(ctx.error).slice(0, 500),
          planHash: live.planHash || '',
          kit: live.kit || '1',
          sampleIds: JSON.stringify(sampleIds),
        },
        select: { id: true },
      });
      this.log.log(`job ${agentId}: queued a repair (${cause.rule}${cause.actionId ? ` on ${cause.actionId}` : ''}), attempt ${done + 1} of ${MAX_ATTEMPTS}`);
      return row?.id || null;
    } catch (e: any) {
      this.log.warn(`could not take over the failed run ${runId}: ${e?.message || e}`);
      return null;
    }
  }

  /** What every source answered on the run that broke, out of the run's own journal. */
  private async evidenceOf(runId: string, job: any): Promise<FetchEvidence[]> {
    const rows = await this.journal.entries(runId).catch(() => [] as any[]);
    const out: FetchEvidence[] = [];
    for (const e of rows || []) {
      // `fetchPaged` is the paged fetch a goal-built program uses (BEA-1495). Leaving it out here
      // would make the very calls that matter most invisible to the repair.
      if (e.fn !== 'fetchSource' && e.fn !== 'tool' && e.fn !== 'fetchPaged') continue;
      const answer = e.value || {};
      const sourceId = String(answer.sourceId || answer.label || answer.actionId || `call ${e.seq}`);
      out.push({
        sourceId,
        // The answer's OWN action id first (BEA-1495). `actionOf` reads the job's plan, and a
        // goal-built job has no plan — so this used to be empty for exactly the agents that fail
        // most, and `keepEvidence` silently dropped all of their evidence.
        actionId: answer.actionId || actionOf(job, sourceId),
        // The call's REAL arguments, off the job's own plan — the journal records the call's position
        // and its answer, not what went out. Without this the evidence would be filed under an empty
        // argument set, and "which hashtag broke" is exactly what a repair wants to know.
        args: argsOf(job, sourceId),
        label: answer.label || null,
        empty: !!answer.empty,
        unrecognised: !!answer.unrecognised,
        why: answer.why || null,
        stop: answer.stop || null,
        rows: answer.table?.rows?.length ?? answer.count ?? 0,
        columns: answer.table?.columns || [],
        answer,
      });
    }
    return out;
  }

  /** The failing answers, kept (§G). Nothing that reads like anybody's messages is ever stored. */
  private async keepEvidence(agentId: string, cause: FailureCause, contract: any, error: string, fetches: FetchEvidence[]): Promise<string[]> {
    if (!this.samples?.keepFailing) return [];
    const ids: string[] = [];
    for (const f of fetches) {
      if (!f.actionId) continue;
      const id = await this.samples
        .keepFailing({ actionId: f.actionId, agentId, args: f.args || {}, answer: f.answer, error, rule: cause.rule, contract })
        .catch(() => null);
      if (id) ids.push(id);
    }
    return ids;
  }

  // ---- 2. the queue ------------------------------------------------------------------------------

  /** One pass over the queue. Answers how many repairs it started. */
  async tick(): Promise<number> {
    const queued = await this.prisma.workerBuild
      .findMany({ where: { status: 'queued', origin: 'repair' }, orderBy: { startedAt: 'asc' }, take: 10 })
      .catch(() => [] as any[]);
    let started = 0;
    const seen = new Set<string>();
    for (const row of queued || []) {
      if (seen.has(row.agentId) || this.working.has(row.agentId)) continue;
      seen.add(row.agentId);
      this.working.add(row.agentId);
      started++;
      void this.repair(row)
        .catch((e: any) => this.log.warn(`repair of ${row.agentId} ended badly: ${e?.message || e}`))
        .finally(() => this.working.delete(row.agentId));
    }
    return started;
  }

  /**
   * Repair one job, under its own lock: up to `MAX_ATTEMPTS` fresh Codex sessions, counted against
   * this failure cause and never more. Answers what happened, in one word, for the tests and the log.
   */
  async repair(queuedRow: any): Promise<{ outcome: 'promoted' | 'held' | 'stopped' | 'busy' | 'skipped'; version?: number; why?: string }> {
    const agentId = String(queuedRow.agentId);
    const claim = await this.locks?.claim(agentId, { reason: 'repairing this job\'s worker' }).catch(() => ({ ok: false } as any));
    if (this.locks && !claim?.ok) {
      // Something is running this job right now. The row stays queued and the next tick tries again —
      // a repair may never run while a run of that job is in flight.
      return { outcome: 'busy' };
    }
    const holder = claim?.holder || '';
    try {
      const job = await this.agent.getAgent(agentId).catch(() => null);
      const live = await this.builds.livePromoted(agentId);
      if (!job || !live) {
        await this.finish(queuedRow.id, { status: 'failed', error: job ? 'This job has no live worker to repair any more.' : 'This job no longer exists.' });
        return { outcome: 'skipped' };
      }

      const cause = causeFrom(queuedRow.cause, agentId);
      const tried = await this.triedFor(agentId, queuedRow.cause);
      if (tried.length >= MAX_ATTEMPTS) {
        // Already stopped for this cause. The row is closed rather than tried again — this is the
        // rule that keeps a broken job from asking Codex to fix it for ever.
        await this.finish(queuedRow.id, { status: 'failed', error: `This failure has already had its ${MAX_ATTEMPTS} repairs, so it was not tried again.` });
        return { outcome: 'skipped' };
      }
      // The queued row IS the first attempt this call makes; every later one gets its own row, so
      // the history reads as what happened and the cap counts real attempts.
      const first = tried.length + 1;
      let row = queuedRow;
      for (let attempt = first; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > first) row = await this.nextRow(queuedRow, live);
        const done = await this.attempt(row, job, live, cause, attempt, tried);
        if (done.outcome === 'promoted' || done.outcome === 'held') return { outcome: done.outcome, version: done.version, why: done.why };
        if (done.outcome === 'notStarted') {
          // The runner refused before Codex existed (BEA-1577). The row is already back to `queued`,
          // no attempt was used, and the cause is simply tried again on a later tick — the same
          // reading as an app lock that could not be claimed.
          this.log.log(`job ${agentId}: the runner refused before Codex started (${done.why}) — the repair stays queued and no attempt was used`);
          // A repair that could not even start on OUR plumbing phones home (BEA-1581). This path
          // re-queues and re-runs every tick — the seam's per-day dedupe holds it to one alert.
          opsAlertIfPlumbing(done.why, { agentId });
          return { outcome: 'busy', why: done.why };
        }
        tried.push(done.why || 'it did not say why');
        // Two Codex turns can outlast the lock's own 30 minutes; keep it while we are still working.
        if (holder && !(await this.locks?.renew(holder, REPAIR_LOCK_MS).catch(() => false))) {
          this.log.warn(`job ${agentId}: the lock was taken away mid-repair — stopping here`);
          return { outcome: 'busy' };
        }
      }
      await this.stop(job, cause, tried);
      return { outcome: 'stopped', why: tried[tried.length - 1] };
    } catch (e: any) {
      this.log.error(`repair of ${agentId} broke: ${e?.message || e}`);
      // The repair itself breaking on a plumbing-class reason is ours to hear about (BEA-1581).
      opsAlertIfPlumbing(String(e?.message || e), { agentId });
      await this.finish(queuedRow.id, { status: 'failed', error: `The repair itself could not run: ${String(e?.message || e).slice(0, 300)}` });
      return { outcome: 'skipped', why: String(e?.message || e) };
    } finally {
      if (holder) await this.locks?.release(holder).catch(() => undefined);
    }
  }

  // ---- 3. one attempt ----------------------------------------------------------------------------

  /** One fresh Codex session, its tests, the promotion guard, and what the owner is told. */
  private async attempt(
    row: any,
    job: any,
    live: any,
    cause: FailureCause,
    attempt: number,
    tried: string[],
  ): Promise<{ outcome: 'promoted' | 'held' | 'failed' | 'notStarted'; version?: number; why?: string }> {
    await this.prisma.workerBuild.update({ where: { id: row.id }, data: { status: 'building', startedAt: new Date() } }).catch(() => undefined);
    const { req, kit, plan } = await this.builds.materials(job, { version: (live.version || 0) + 1, previousVersion: live.version, origin: 'rebuild' });
    const contract = safeContract(job);
    const fetches = await this.loadEvidence(row);
    const inputs = {
      job: { id: job.id, name: job.name },
      attempt,
      error: String(row.reason || ''),
      cause,
      contract,
      planInWords: planInWords(plan),
      fetches,
      fromVersion: live.version,
      previousTries: tried,
    };
    // The evidence is trimmed to the RUNNER's own limits before it travels (BEA-1577) — a 2MB
    // failing.json used to be refused at the door, and the refusal counted as a repair attempt.
    const files = { ...req.files, [FAILING_FILE]: failingFile(inputs, await this.evidenceCap(req.files)) };

    const built = await this.runner.build({ jobId: job.id, brief: repairBrief(inputs), files, copyFrom: live.version });
    const tests = built.tests || null;
    const version = Number(built.version) || 0;
    const log = String(built.log || '').slice(-8000);
    if (!built.ok && built.notStarted) {
      // The runner refused BEFORE any Codex session — busy on the host, an oversized body, a closed
      // door, or not reachable at all. Nothing was tried, so nothing may be counted (BEA-1577): the
      // row goes back to `queued` — a status both `attemptsFor` and `triedFor` ignore, so neither
      // the two-try cap nor the "already tried" note ever sees it — and the next tick tries the
      // same cause again. The field is the runner's own fact, never read out of error prose.
      const why = String(built.error || 'the worker runner refused before Codex was started');
      await this.prisma.workerBuild
        .update({ where: { id: row.id }, data: { status: 'queued', error: `Waiting for the runner — no repair attempt was used: ${why.slice(0, 300)}` } })
        .catch(() => undefined);
      return { outcome: 'notStarted', why };
    }
    if (!built.ok) {
      const why = built.error
        ? built.error
        : tests
          ? `the repair's tests did not pass (${tests.passed} passed, ${tests.failed} failed)`
          : 'the repair wrote nothing that could be proved';
      await this.finish(row.id, { status: 'failed', version, tests, sessionId: built.sessionId, log, error: `Repair ${attempt} of ${MAX_ATTEMPTS}: ${why}. v${live.version} is still the live worker.` });
      return { outcome: 'failed', why };
    }

    // Green tests. Now the guard: did the answer move?
    const drift = await this.guard(job.id, live.version, version, req.files);

    if (!drift.within) {
      const words = heldWords(job.name || 'Your agent', cause, version, drift);
      await this.finish(row.id, {
        status: 'held',
        version,
        tests,
        sessionId: built.sessionId,
        log,
        error: `Not put live: ${drift.why}. v${live.version} is still the live worker — open the job to decide.`,
      });
      await this.tell(words.headline, words.detail, `/agent/a/${job.id}`);
      this.log.warn(`job ${job.id}: repair v${version} passed its tests but ${drift.why} — held for the owner`);
      return { outcome: 'held', version, why: drift.why };
    }

    const meta = {
      jobId: job.id,
      version,
      kit: kit.version,
      planHash: req.planHash,
      builtAt: new Date().toISOString(),
      builtBy: 'codex',
      sessionId: built.sessionId || null,
      tests,
      origin: 'repair',
      cause: cause.key,
      previousVersion: live.version,
      repairedFrom: live.version,
      samples: req.sampleIds.length,
    };
    const promoted = await this.runner.promote({ jobId: job.id, version, meta });
    if (!promoted.ok) {
      await this.finish(row.id, { status: 'failed', version, tests, sessionId: built.sessionId, log, error: `The repair passed its tests but could not be put live: ${promoted.error}. v${live.version} is still the live worker.` });
      return { outcome: 'failed', why: String(promoted.error || 'it could not be put live') };
    }
    await this.prisma.workerBuild.update({ where: { id: row.id }, data: { sampleIds: JSON.stringify(req.sampleIds) } }).catch(() => undefined);
    await this.finish(row.id, { status: 'promoted', version, tests, sessionId: built.sessionId, log, error: null });
    const words = fixedWords(job.name || 'Your agent', cause, version, drift);
    await this.tell(words.headline, words.detail, `/agent/a/${job.id}`);
    this.log.log(`job ${job.id}: repaired itself — v${version} is live (${drift.why})`);
    return { outcome: 'promoted', version, why: drift.why };
  }

  /**
   * The promotion guard: both versions run against the same saved answers, in throwaway copies of
   * their own folders, with no token and no network. A repair that moves the rows beyond the
   * tolerance is held for the owner.
   */
  private async guard(jobId: string, liveVersion: number, version: number, files: Record<string, string>): Promise<Drift> {
    const harness = parityHarness();
    // Only the fixtures and the contract travel: each version keeps the kit it was built against.
    const fixtures: Record<string, string> = {};
    for (const [name, body] of Object.entries(files)) if (name.startsWith('samples/') || name === 'contract.json') fixtures[name] = body;
    const before = await this.measure(jobId, liveVersion, harness, fixtures);
    const after = await this.measure(jobId, version, harness, fixtures);
    return driftOf(before, after);
  }

  private async measure(jobId: string, version: number, harness: string, files: Record<string, string>): Promise<ParityResult | null> {
    const r = await this.runner.parity({ jobId, version, harness, files }).catch(() => null);
    if (!r?.ok || !r.result) return { ok: false, error: r?.error || 'the version could not be measured' };
    return r.result;
  }

  // ---- STOP ---------------------------------------------------------------------------------------

  /**
   * Two attempts, both failed. The job genuinely stops — `enabled:false` AND `pausedReason`, the one
   * existing convention (`SocialBudgetService.pauseAgent`) — and the owner is told what broke and what
   * was tried. **Retiring to the plan runner is his tap**: the notice offers it, and nothing here does
   * it. The switch that would move a job back is the Worker tab's (BEA-1394); a job that is off is
   * honestly off in the meantime.
   */
  private async stop(job: any, cause: FailureCause, tried: string[]): Promise<void> {
    const words = stopWords(job.name || 'Your agent', cause, tried);
    await this.prisma.agent
      .update({ where: { id: job.id }, data: { enabled: false, pausedReason: words.reason.slice(0, 400) } })
      .catch((e: any) => this.log.warn(`could not pause ${job.id}: ${e?.message || e}`));
    this.log.warn(`job ${job.id} switched off: ${MAX_ATTEMPTS} repairs of "${cause.rule}" did not work`);
    await this.tell(words.headline, words.detail, `/agent/a/${job.id}`);
  }

  // ---- the owner's decision on a held repair -------------------------------------------------------

  /**
   * The owner looked at a held repair and said yes: put it live. This is the other half of the
   * promotion guard — the loop never takes this decision, and he always can.
   */
  async accept(agentId: string, buildId: string): Promise<{ ok: boolean; version?: number; error?: string }> {
    const row = await this.prisma.workerBuild.findFirst({ where: { id: buildId, agentId, status: 'held' } }).catch(() => null);
    if (!row) return { ok: false, error: 'There is no repair waiting for your decision on this job.' };
    const job = await this.agent.getAgent(agentId).catch(() => null);
    if (!job) return { ok: false, error: 'That job no longer exists.' };
    const promoted = await this.runner.promote({
      jobId: agentId,
      version: row.version,
      meta: { jobId: agentId, version: row.version, kit: row.kit, planHash: row.planHash, builtAt: new Date().toISOString(), builtBy: 'codex', origin: 'repair', cause: row.cause, acceptedByOwner: true },
    });
    if (!promoted.ok) return { ok: false, error: promoted.error };
    await this.finish(row.id, { status: 'promoted', version: row.version, tests: parseJson(row.tests), log: row.log || '', error: null });
    this.log.log(`job ${agentId}: the owner put the held repair v${row.version} live`);
    return { ok: true, version: row.version };
  }

  /** Or no: the repair stays on disk, unused, and the job keeps the worker it has. */
  async decline(agentId: string, buildId: string): Promise<{ ok: boolean; error?: string }> {
    const row = await this.prisma.workerBuild.findFirst({ where: { id: buildId, agentId, status: 'held' }, select: { id: true, error: true } }).catch(() => null);
    if (!row) return { ok: false, error: 'There is no repair waiting for your decision on this job.' };
    await this.prisma.workerBuild
      .update({ where: { id: row.id }, data: { status: 'failed', error: `${row.error || 'It changed the rows.'} You looked at it and left the worker as it was.`, finishedAt: new Date() } })
      .catch(() => undefined);
    return { ok: true };
  }

  // ---- shared -------------------------------------------------------------------------------------

  /** How many repairs of this exact cause have already finished — the two-attempt cap's counter. */
  private async attemptsFor(agentId: string, causeKey: string): Promise<number> {
    if (!causeKey) return 0;
    return await this.prisma.workerBuild
      .count({ where: { agentId, origin: 'repair', cause: causeKey, status: { in: COUNTED } } })
      .catch(() => 0);
  }

  /**
   * What those attempts tried, in order, so the next one is told not to repeat them — and, because
   * `tried.length` is what the loop counts up from, **it must read exactly the same rows
   * `attemptsFor` counts**. They disagreed once (this counted only `failed`, that counted `held` and
   * `promoted` too), and the effect was three Codex turns on a cause the owner allowed two.
   */
  private async triedFor(agentId: string, causeKey: string): Promise<string[]> {
    if (!causeKey) return [];
    const rows = await this.prisma.workerBuild
      .findMany({ where: { agentId, origin: 'repair', cause: causeKey, status: { in: COUNTED } }, orderBy: { startedAt: 'asc' }, select: { status: true, error: true, version: true } })
      .catch(() => [] as any[]);
    return (rows || []).map((r: any) => {
      if (r.status === 'held') return `v${r.version} passed its tests but was held: ${String(r.error || 'it changed the rows')}`;
      if (r.status === 'promoted') return `v${r.version} went live and the same thing broke again`;
      return String(r.error || 'it did not say why');
    });
  }

  /** The second attempt's own row — one row per attempt, so the history reads as what happened. */
  private async nextRow(first: any, live: any): Promise<any> {
    return await this.prisma.workerBuild.create({
      data: {
        agentId: first.agentId,
        version: 0,
        status: 'building',
        origin: 'repair',
        cause: first.cause,
        reason: first.reason,
        planHash: live.planHash || '',
        kit: live.kit || '1',
        // The same failing evidence rides into the later attempt's folder — and stays with the row
        // if a runner refusal sends it back to `queued` for a later tick (BEA-1577).
        sampleIds: first.sampleIds || '[]',
      },
    });
  }

  /**
   * The most `samples/failing.json` may be, read from the RUNNER's own declared limits — the cap
   * has exactly one home, the runner (BEA-1577). Bounded twice: the per-file limit, and what is
   * left of the all-files limit after the build's other files. `null` = the runner did not say
   * (down, or older): no trimming, and an over-cap send comes back `notStarted`, which never
   * counts as an attempt.
   */
  private async evidenceCap(others: Record<string, string>): Promise<number | null> {
    const limits = await this.runner.limits?.().catch(() => null);
    const file = Number(limits?.fileBytes) || 0;
    if (!file) return null;
    const total = Number(limits?.filesBytes) || 0;
    if (!total) return file;
    let used = 0;
    for (const body of Object.values(others || {})) used += Buffer.byteLength(String(body ?? ''), 'utf8');
    const room = total - used;
    // The other files alone already blow the all-files budget: no trim of the evidence can save the
    // send, so at least keep it consistent at the per-file cap — a 0 here would read as "no cap
    // known" and skip trimming entirely (review finding, BEA-1577).
    return room <= 0 ? file : Math.min(file, room);
  }

  /** The failing answers this repair was queued with, read back out of the store. */
  private async loadEvidence(row: any): Promise<FetchEvidence[]> {
    const ids = parseJson(row.sampleIds) || [];
    if (!Array.isArray(ids) || !ids.length) return [];
    const rows = await this.prisma.toolSample.findMany({ where: { id: { in: ids }, kind: 'failing' } }).catch(() => [] as any[]);
    const out: FetchEvidence[] = [];
    for (const r of rows || []) {
      const bundle = await gunzipAsync(Buffer.isBuffer(r.payload) ? r.payload : Buffer.from(r.payload))
        .then((b) => JSON.parse(b.toString('utf8')))
        .catch(() => null);
      if (!bundle?.answer) continue;
      const answer = bundle.answer;
      out.push({
        sourceId: String(answer.sourceId || answer.label || r.actionId),
        actionId: r.actionId,
        label: answer.label || null,
        args: parseJson(r.arguments) || {},
        empty: !!answer.empty,
        unrecognised: !!answer.unrecognised,
        why: answer.why || null,
        stop: answer.stop || null,
        rows: answer.table?.rows?.length ?? 0,
        columns: answer.table?.columns || [],
        answer,
      });
    }
    return out;
  }

  private async finish(id: string, data: { status: string; version?: number; tests?: any; sessionId?: string | null; log?: string; error: string | null }): Promise<void> {
    await this.prisma.workerBuild
      .update({
        where: { id },
        data: {
          status: data.status,
          ...(data.version !== undefined ? { version: data.version } : {}),
          ...(data.tests !== undefined ? { tests: data.tests ? JSON.stringify(data.tests) : null } : {}),
          ...(data.sessionId !== undefined ? { sessionId: data.sessionId || null } : {}),
          ...(data.log !== undefined ? { log: data.log || null } : {}),
          error: data.error,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  /** The owner hears about it on the one road every other owner message takes (BEA-1379). */
  private async tell(headline: string, detail: string, path: string): Promise<void> {
    const r: any = await this.alerts?.workerRepair?.({ headline, detail, path })?.catch?.(() => ({ sent: false }));
    if (r && !r.sent) this.log.warn(`the owner was not told (${r.why || 'no reason given'}): ${headline}`);
  }
}

/** The plan's contract, or null when the job is not one a plan can be derived from. */
function safeContract(job: any): any {
  try {
    return contractFromPlan(planFromAgent(job));
  } catch {
    return null;
  }
}

/** The exact arguments a source sends, off the job's own plan. A creators block sends its finder's. */
function argsOf(job: any, sourceId: string): Record<string, any> {
  try {
    const src = (planFromAgent(job).sources || []).find((s: any) => s.id === sourceId);
    if (!src) return {};
    return (src.kind === 'creators' ? src.find?.args : src.args) || {};
  } catch {
    return {};
  }
}

/** Which action a source id calls, off the job's own plan. '' when the plan no longer has it. */
function actionOf(job: any, sourceId: string): string {
  try {
    const plan = planFromAgent(job);
    const src = (plan.sources || []).find((s: any) => s.id === sourceId);
    if (!src) return String(sourceId).startsWith('svc:') ? String(sourceId).split('#')[0] : '';
    return src.kind === 'creators' ? src.then?.actionId || src.find?.actionId : sourceActionId(src);
  } catch {
    return '';
  }
}

/**
 * The cause back out of its key — the loop stores the key on the row, and the brief needs the words.
 * The key is `jobId|rule[:signature]|actionId`, written by `causeOf`.
 */
export function causeFrom(key: string, jobId: string): FailureCause {
  const parts = String(key || `${jobId}|crash|`).split('|');
  const rule = String(parts[1] || 'crash').split(':')[0] as FailureCause['rule'];
  return { rule, actionId: String(parts[2] || ''), key, label: ruleWords(rule) };
}

function parseJson(raw: any): any {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
