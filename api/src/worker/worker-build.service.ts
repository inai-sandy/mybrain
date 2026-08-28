import { BadRequestException, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { BriefService } from '../agent/brief.service';
import { ToolLessonService, shapeInWords } from '../tools/tool-lesson.service';
import { ToolLookupService } from '../tools/tool-lookup.service';
import { ToolKnowledgeService, ToolKnowledge } from '../tools/tool-knowledge.service';
import { ToolSampleService } from '../tools/tool-sample.service';
import { AgentPlan, PlanBlock, planActionIds, planFromAgent, sourceActionId, sourceLabel } from '../social/plan';
import { normaliseToolArgs } from '../social/tool-args';
import { isServiceToolId } from '../tools/service-provider';
import { tableOf } from '../social/rows';
import { argsHashOf } from '../tools/tool-sample';
import { BuildRequest, BuildSample, buildHashOf, buildRequest, planHashOf } from './build-brief';
import { goalBuildFiles, goalBuildPrompt, goalHash } from './goal-build';
import { buildActivity, type BuildActivity } from './build-activity';
import { toolsNamedIn } from '../tools/tool-doc';
import { ToolDocsService } from '../tools/tool-doc.service';
import { GoalService } from '../agent/goal.service';
import { cardText } from '../agent/thinking-builder';
import { WorkerRunnerClient } from './worker-runner.client';

/** A build that has been going this long is not going to finish — its row stops blocking the next one. */
const BUILD_STUCK_MS = 45 * 60_000;
/** How much of the runner's log is kept on the row. Enough to read the failure, not a novel. */
const LOG_KEPT = 8000;

export type WorkerState = {
  agentId: string;
  /** The live worker: the newest build that passed its tests and was put live. Null = no worker yet. */
  worker: any | null;
  /** The plan the job would run today. When it differs from the worker's, the worker is stale. */
  planHash: string;
  stale: boolean;
  /**
   * The live worker was built against an OLDER parts box than the one on the server (BEA-1461).
   *
   * Deliberately not `stale`, and it must never be folded into it: stale means "the plan changed and
   * this program no longer does what the job says", which is a reason to distrust the worker. This
   * means "the plan is exactly right, and there are tools this program was never told about" — the
   * worker is correct and still runs, it is just missing what was added since.
   *
   * It exists because the coarse signals both stayed silent when the tools were opened (BEA-1457):
   * the plan did not change, and the kit MAJOR did not move because the change was additive. A
   * worker built the day before sat there looking perfectly current with none of the new doors, and
   * the only way to find out was to remember.
   */
  partsBoxOld: boolean;
  /** What to tell him about it, in his own words. Empty when there is nothing to say. */
  partsBoxNote?: string;
  /**
   * A repair that passed its tests but changes the rows, waiting for the owner to decide (BEA-1393).
   * Never live — the promotion guard held it back on purpose.
   */
  held?: any | null;
  /** A repair is queued or running for this job right now. */
  repairing?: boolean;
  /** Why there is no worker road for this job at all (an engine job has no plan to compile). */
  compilable: boolean;
  reason?: string;
  building: boolean;
  builds: any[];
  /**
   * What the live build's own calls did, in plain words (BEA-1492). Null when the build predates
   * per-build attribution, or made no calls — never a guess from a time window.
   */
  activity?: BuildActivity | null;
};

/**
 * The build turn (BEA-1390, agent workers 5/10 — `specs/AGENT-WORKERS.md` §C, §D).
 *
 * The owner approves a plan; Codex compiles it into a small program that runs that plan. This
 * service is the whole of that turn on the app's side:
 *
 *   plan → build brief (the plan, the kit and its docs, the fact card for every action it uses, and
 *   the saved answers its tests will stand on) → ONE fresh Codex session in a new version folder →
 *   the version's own tests → **green tests, and only green tests, move the `current` symlink**.
 *
 * Three rules it never breaks:
 *  1. **Never promote an untested worker.** A build that cannot pass leaves the job exactly where it
 *     was — on the plan runner, or on its previous worker version — and the row says why in plain
 *     words. A promotion is one call to the runner and it happens after the tests, never before.
 *  2. **No secrets in a worker folder.** The files sent are the kit, its docs, the plan and masked
 *     saved answers. The run token is minted per spawn and lives only in the environment of the
 *     spawned process.
 *  3. **A plan edit makes a worker stale, and stale is said out loud.** `planHash` is on the build
 *     row; the job's plan is hashed fresh on every read. A stale worker keeps running until it is
 *     rebuilt — never silently ignored, and never silently used to mean an edit took effect.
 */
@Injectable()
export class WorkerBuildService implements OnModuleInit, OnModuleDestroy {
  private stuckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly log = new Logger('WorkerBuild');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly runner: WorkerRunnerClient,
    // Optional + LAST — spec harnesses build services positionally with fewer arguments.
    private readonly knowledge?: ToolKnowledgeService,
    private readonly samples?: ToolSampleService,
    private readonly briefs?: BriefService,
    private readonly lessons?: ToolLessonService, // the learned shapes a recipe is written from (BEA-1415)
    private readonly lookup?: ToolLookupService, // the whole shelf, for the build brief (BEA-1457)
    private readonly goals?: GoalService, // the goal HE approved, which the build now stands on (BEA-1464)
    private readonly docs?: ToolDocsService, // one document per tool, put in the prompt (BEA-1472)
  ) {}

  onModuleInit() {
    // The sweep may never evict a saved answer a live worker's tests stand on (§A's hook, filled in
    // here now that worker folders exist).
    this.samples?.setPinned?.(() => this.pinnedSampleIds());
    // A BUILD MUST BE ABLE TO FAIL, NOT FADE (BEA-1541). A build that never finished — the app was
    // deployed mid-Codex-session, the host died, the runner was restarted — left its row on
    // `building` for ever. The screens stopped CALLING it building after 45 minutes, so it vanished
    // from the interface while the record still claimed a build was in flight: no worker, no failure,
    // no reason, nothing to retry. Sweep once at boot (the restart IS the usual cause) and hourly.
    void this.failStuckBuilds();
    this.stuckTimer = setInterval(() => { void this.failStuckBuilds(); }, 60 * 60_000);
    if (typeof this.stuckTimer.unref === 'function') this.stuckTimer.unref();
  }

  onModuleDestroy() { if (this.stuckTimer) clearInterval(this.stuckTimer); }

  /**
   * Mark builds that stopped talking as failed, with words the owner can act on.
   *
   * Deliberately NOT a cancel of the Codex session — by the time a row is this old the process that
   * owned it is gone with the restart that orphaned it. This corrects the RECORD so the job stops
   * claiming a build is running, and so `Rebuild` is offered again.
   */
  /** Is a build for this job in flight right now? Same staleness rule the Worker row uses. */
  async isBuilding(agentId: string): Promise<boolean> {
    const row: any = await this.prisma.workerBuild
      .findFirst({ where: { agentId, status: 'building', startedAt: { gt: new Date(Date.now() - BUILD_STUCK_MS) } }, select: { id: true } })
      .catch(() => null);
    return !!row;
  }

  async failStuckBuilds(): Promise<number> {
    const cutoff = new Date(Date.now() - BUILD_STUCK_MS);
    const rows: any[] = await this.prisma.workerBuild
      .findMany({ where: { status: 'building', startedAt: { lt: cutoff } }, select: { id: true, version: true } })
      .catch(() => []);
    for (const r of rows) {
      await this.prisma.workerBuild
        .update({
          where: { id: r.id },
          data: {
            status: 'failed',
            error: `This build stopped part-way through and never finished — most likely the app was restarted or deployed while it was still writing. Nothing was put live. Press Rebuild to try again.`,
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
    if (rows.length) this.log?.warn?.(`marked ${rows.length} unfinished build(s) as failed`);
    return rows.length;
  }

  // ---- what the owner sees ----------------------------------------------------------------------

  /** The live worker, whether it is stale, and the last few builds. */
  async state(agentId: string): Promise<WorkerState> {
    const job = await this.agent.getAgent(agentId).catch(() => null);
    if (!job) throw new BadRequestException('That job no longer exists.');
    // The SAME rule the build uses (BEA-1454). It used to be the plan runner's check here and a
    // different check at the build, and the gap threw away a program that had just been written,
    // tested and promoted: `compilable:false` meant no hash was computed, an empty hash never equals
    // the one stamped on the worker, so a brand-new build read as STALE and the trial died with a
    // generic sentence. One rule, both places, or they drift the first time either changes.
    // …and an approved goal is its own answer (BEA-1464): a goal-built job has no plan for the old
    // rule to inspect, and the old rule refuses it for having no sources.
    const cannot = await this.whyNotBuildable(job);
    const compilable = !cannot;
    const planHash = await this.buildHashFor(job);
    const rows = await this.rows(agentId, 10);
    const worker = rows.find((b: any) => b.status === 'promoted') || null;
    const building = rows.some((b: any) => b.status === 'building' && Date.now() - new Date(b.startedAt).getTime() < BUILD_STUCK_MS);
    // A repair held for the owner only counts while it is NEWER than the live worker — once a later
    // version went live, the offer is history, not a decision he still owes.
    const heldRow = rows.find((b: any) => b.status === 'held' && (!worker || new Date(b.startedAt) > new Date(worker.startedAt))) || null;
    return {
      agentId,
      worker: worker ? this.shape(worker, planHash) : null,
      held: heldRow ? this.shape(heldRow, planHash) : null,
      repairing: rows.some((b: any) => b.origin === 'repair' && (b.status === 'queued' || (b.status === 'building' && Date.now() - new Date(b.startedAt).getTime() < BUILD_STUCK_MS))),
      planHash,
      stale: !!worker && worker.planHash !== planHash,
      ...partsBox(worker, this.kitRevNow()),
      compilable,
      reason: compilable ? undefined : cannot,
      building,
      builds: rows.map((b: any) => this.shape(b, planHash)),
      // What the live build actually touched, in plain words (BEA-1492). A build may now do anything
      // at all, so seeing what it did is the other half of that trade.
      activity: worker ? await this.activityFor(worker) : null,
    };
  }

  /**
   * The calls one build made, summarised (BEA-1492).
   *
   * Attributed by the build key, which `TryActionService` writes as the row's runId. A build from
   * before that change has no attributable rows and honestly answers null rather than guessing from a
   * time window and risking another build's calls.
   */
  private async activityFor(build: any): Promise<BuildActivity | null> {
    const key = String(build?.id || '');
    if (!key) return null;
    const rows: any[] = await this.prisma?.toolCall
      ?.findMany?.({ where: { runKind: 'build', runId: key }, select: { action: true, ok: true, error: true }, take: 200 })
      .catch(() => []) || [];
    if (!rows.length) return null;
    return buildActivity(rows.map((r) => ({ action: String(r.action || ''), ok: !!r.ok, error: r.error })));
  }

  /**
   * PUT AN OLDER VERSION BACK (BEA-1494).
   *
   * v6 read his mail, wrote the page and sent the link. Rebuilding for an unrelated reason produced
   * v8, which passed its own tests and then failed the first real run — and there was no way to put
   * the working one back except by hand.
   *
   * It has to move in TWO places or the app and the disk disagree about what is live: the runner's
   * `current` symlink decides what actually runs, and the newest promoted row decides what every
   * screen and the dispatcher believe. Moving one without the other is the exact bug this project
   * keeps paying for, so this method is the only thing allowed to do either.
   *
   * A rollback is recorded as its own build row rather than by editing history: "v6 was put back at
   * 07:40" is true, and "v6 was built at 07:40" would not be.
   */
  async rollback(agentId: string, version: number): Promise<WorkerState & { rolledBack?: { ok: boolean; version: number; error?: string } }> {
    const target: any = await this.prisma.workerBuild.findFirst({
      where: { agentId, version, status: { in: ['promoted', 'held'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!target) throw new BadRequestException(`There is no v${version} for this job that was ever built successfully.`);

    const live: any = await this.prisma.workerBuild.findFirst({ where: { agentId, status: 'promoted' }, orderBy: { startedAt: 'desc' } });
    if (live && live.version === version) return { ...(await this.state(agentId)), rolledBack: { ok: true, version } };

    const moved = await this.runner.promote({ jobId: agentId, version });
    if (!moved.ok) {
      // Nothing is recorded when the symlink did not move — a row claiming v6 is live while disk
      // still runs v8 is worse than no rollback at all.
      return { ...(await this.state(agentId)), rolledBack: { ok: false, version, error: moved.error || 'the runner would not move it' } };
    }

    await this.prisma.workerBuild.create({
      data: {
        agentId,
        version,
        status: 'promoted',
        origin: 'rollback',
        reason: `put v${version} back${live ? ` in place of v${live.version}` : ''}`,
        planHash: target.planHash,
        kit: target.kit,
        kitRev: target.kitRev,
        sampleIds: target.sampleIds,
        sessionId: target.sessionId,
        tests: target.tests,
        finishedAt: new Date(),
      },
    });
    this.log.log(`rolled job ${agentId} back to worker v${version}`);
    return { ...(await this.state(agentId)), rolledBack: { ok: true, version } };
  }

  /**
   * The hash of what this job's worker would be built from, today (BEA-1462).
   *
   * **Every place that asks "is this worker still right?" must call THIS** — `state()` for the
   * screen, `WorkerDispatchService.decideFor()` for the run. The build stamps the same value through
   * `buildRequest`, which computes it from the same plan and the same brief.
   *
   * It is a method rather than three call sites because three call sites is exactly how this went
   * wrong: the dispatcher used bare `planHashOf(plan)` while the build stamped `buildHashOf(plan,
   * brief)`, so for any job with an approved brief the two could never be equal and every run said
   * "the plan changed, rebuild it" — including a run seconds after a fresh, green, promoted build.
   */
  async buildHashFor(job: any): Promise<string> {
    // A goal-built job is hashed on its GOAL (BEA-1464). It has no plan, so `planHashOf` would hash
    // an empty shape — identical for every such job — and `whyNotCompilableFor` would refuse it for
    // having no sources. Either one alone would send a perfectly good worker down the old road on
    // every single run, which is precisely the failure BEA-1462 was.
    const goal = job?.areaId ? await this.goals?.approved?.(job.areaId).catch(() => null) : null;
    if (goal && String(goal.text || '').trim()) return goalHash(Number(goal.version) || 1, String(goal.text || ''));
    if (WorkerBuildService.whyNotCompilableFor(job)) return '';
    const plan = planFromAgent(job);
    const brief = job?.areaId ? await this.briefs?.forCodex?.(job.areaId).catch(() => null) : null;
    return buildHashOf(plan, brief || null);
  }

  /**
   * The build request when he has approved a goal (BEA-1464).
   *
   * Deliberately short: the goal, the conversation, the tools he named, the parts box. The hash is
   * of the GOAL and the conversation, because those are now what the program was built from — a
   * plan hash would mark a worker stale for an edit to a plan nobody reads any more.
   */
  /**
   * Can this job have a program at all? (BEA-1464)
   *
   * An approved goal is a yes, whatever the job's columns say — the goal IS the specification and
   * there is no plan to inspect. Everything else falls back to the old rule unchanged, so the nine
   * live jobs behave exactly as they did.
   */
  async whyNotBuildable(job: any): Promise<string> {
    const goal = job?.areaId ? await this.goals?.approved?.(job.areaId).catch(() => null) : null;
    if (goal && String(goal.text || '').trim()) return '';
    return WorkerBuildService.whyNotCompilableFor(job);
  }

  /**
   * The newest failed run of this job, in the three shapes that actually help (BEA-1478): what it
   * said, how far it got, and the exact arguments each call carried.
   *
   * The arguments matter most. Twice a program "set" a value that never left the building — a
   * misspelt key, then a falsy flag — and in both cases the code looked right and the call did not.
   * The `ToolCall` ledger is the only place that difference is visible.
   */
  /** His timezone, from his own setting. Null when it has never been set — then nothing is claimed. */
  private async timezone(): Promise<string | null> {
    const row: any = await this.prisma?.setting?.findUnique?.({ where: { key: 'tasks.tz' } }).catch(() => null);
    const tz = String(row?.value || '').trim();
    return tz || null;
  }

  private async lastFailureFor(agentId: string): Promise<any | null> {
    const run: any = await this.prisma?.agentRun?.findFirst?.({ where: { agentId, status: 'failed' }, orderBy: { startedAt: 'desc' } }).catch(() => null);
    if (!run?.error) return null;
    let steps: string[] = [];
    try {
      const parsed = JSON.parse(run.stepLog || '[]');
      steps = (Array.isArray(parsed) ? parsed : []).map((s: any) => `${s.status || ''} — ${String(s.label || '').slice(0, 160)}`).slice(-10);
    } catch { steps = []; }
    const rows: any[] = (await this.prisma?.toolCall?.findMany?.({ where: { runId: run.id }, orderBy: { id: 'asc' }, take: 12 }).catch(() => [])) || [];
    return {
      error: String(run.error).slice(0, 1200),
      steps,
      calls: rows.map((r: any) => ({ action: String(r.action || ''), args: String(r.arguments || '{}').slice(0, 400), error: r.ok ? undefined : String(r.error || '').slice(0, 200) })),
    };
  }

  private async goalMaterials(job: any, goal: any, kit: { version: string; js: string; doc: string; rev: string }, opts: any): Promise<BuildRequest> {
    let transcript: any[] = [];
    try { const t = JSON.parse(String((goal as any).transcript || '[]')); transcript = Array.isArray(t) ? t : []; } catch { transcript = []; }
    const tools: any[] = [];
    for (const id of goal.tools || []) {
      const card = await this.knowledge?.card?.(String(id)).catch(() => null);
      let sample: any = undefined;
      try { sample = (await this.samples?.replay?.(String(id)))?.data ?? undefined; } catch { sample = undefined; }
      tools.push({ actionId: String(id), name: (card as any)?.name || null, card: card ? cardText(card as any) : null, sample });
    }
    // The documents for every tool his words actually name (BEA-1472). Mechanical: a string match of
    // known slugs against the goal and the conversation, so Notion's whole action list is IN the
    // prompt rather than one lookup away. The build that pinned a non-existent WhatsApp id had that
    // lookup available and did not use it.
    let toolDocs: { service: string; text: string }[] = [];
    try {
      const known = await this.docs?.list?.();
      if (known?.length) {
        const said = `${String(goal.text || '')}\n${transcript.map((t: any) => String(t?.text || '')).join('\n')}`;
        const named = toolsNamedIn(said, known.map((k: any) => ({ service: k.service, name: k.name })));
        for (const slug of named.slice(0, 6)) {
          const doc = await this.docs?.get?.(slug).catch(() => null);
          if (doc?.text) toolDocs.push({ service: slug, text: doc.text });
        }
      }
    } catch { toolDocs = []; }

    // What broke last time, and the arguments that REALLY went out (BEA-1478). Read from the job's
    // own newest failed run, so a rebuild starts by looking at the evidence rather than at a general
    // note somebody wrote afterwards.
    const lastFailure = await this.lastFailureFor(job.id).catch(() => null);

    const inp = {
      job: { id: job.id, name: job.name },
      goal: String(goal.text || ''),
      toolDocs,
      lastFailure,
      // Whose clock the goal's times are on (BEA-1486). Read from his own setting, never assumed —
      // the server is UTC and every program written without this was five and a half hours out.
      timezone: await this.timezone(),
      transcript,
      tools,
      kit,
      version: opts.version,
      previousVersion: opts.previousVersion ?? null,
      reason: opts.reason ?? null,
    };
    return {
      brief: goalBuildPrompt(inp),
      files: goalBuildFiles(inp),
      planHash: goalHash(Number(goal.version) || 1, String(goal.text || '')),
      sampleIds: [],
    };
  }

  // ---- the build turn ---------------------------------------------------------------------------

  /**
   * Compile this job's plan into a new worker version. Answers the job's worker state, plus what
   * this build did — including, when it failed, the honest reason and the road the job is still on.
   */
  async build(agentId: string, opts: { reason?: string } = {}): Promise<WorkerState & { built: any }> {
    const job = await this.agent.getAgent(agentId).catch(() => null);
    if (!job) throw new BadRequestException('That job no longer exists.');
    const why = await this.whyNotBuildable(job);
    if (why) throw new BadRequestException(why);

    const before = await this.state(agentId);
    if (before.building) throw new BadRequestException('A build for this job is already going. Wait for it to finish.');

    const origin: 'build' | 'rebuild' = before.worker ? 'rebuild' : 'build';
    const { req, kit } = await this.materials(job, {
      // The runner picks the real version number (the folders on disk are the truth); this is only
      // what the brief SAYS, so the two agree in the normal case and the brief is never wrong by more
      // than a number nobody dispatches on.
      version: (before.worker?.version || 0) + 1,
      previousVersion: before.worker?.version || null,
      origin,
      reason: opts.reason || null,
    });

    const row = await this.prisma.workerBuild.create({
      data: {
        agentId,
        version: 0, // filled in from the runner's answer — the folders on disk decide the number
        status: 'building',
        origin,
        reason: opts.reason || null,
        planHash: req.planHash,
        kit: kit.version,
        kitRev: kit.rev,
        sampleIds: JSON.stringify(req.sampleIds),
      },
    });

    // `buildKey` is this build's own row id (BEA-1493): the runner puts it in the Codex child's
    // environment, the MCP server sends it with every try_action, and the trial calls come back
    // attributable to exactly this build.
    // START FROM THE VERSION THAT WORKS (BEA-1494).
    //
    // Every rebuild used to begin from a blank page, so a job that ran perfectly was one rebuild away
    // from a brand-new program with a brand-new bug — which is exactly what happened: v6 read his
    // mail, wrote the page and sent the link; rebuilding twice for an UNRELATED change produced v8,
    // which passed its own tests and then failed the first real run on a fresh mistake.
    //
    // A repair has always copied the version it is repairing. A rebuild had no reason not to, and
    // every reason to: working logic is the most valuable thing in the folder.
    const startFrom = before.worker?.version ?? null;
    const built = await this.runner.build({ jobId: agentId, brief: req.brief, files: req.files, buildKey: row.id, copyFrom: startFrom });
    const tests = built.tests || null;
    const version = Number(built.version) || 0;
    const log = String(built.log || '').slice(-LOG_KEPT);

    if (!built.ok) {
      const why = built.error
        ? built.error
        : !built.wrote
          ? 'Codex did not write a worker.mjs in the build folder.'
          : tests
            ? `The worker's own tests did not pass (${tests.passed} passed, ${tests.failed} failed).`
            : 'The worker wrote no tests, so nothing could be proved about it.';
      const stayed = before.worker ? `v${before.worker.version} is still the live worker.` : 'The job is still running the old way, on the plan runner.';
      await this.finish(row.id, { status: 'failed', version, tests, sessionId: built.sessionId, log, error: `${why} ${stayed}` });
      return { ...(await this.state(agentId)), built: { ok: false, version, tests, error: `${why} ${stayed}` } };
    }

    // Green. Only now does anything move.
    const meta = {
      jobId: agentId,
      version,
      kit: kit.version,
      planHash: req.planHash,
      builtAt: new Date().toISOString(),
      builtBy: 'codex',
      sessionId: built.sessionId || null,
      tests,
      origin,
      ...(before.worker ? { previousVersion: before.worker.version } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      samples: req.sampleIds.length,
    };
    const promoted = await this.runner.promote({ jobId: agentId, version, meta });
    if (!promoted.ok) {
      const stayed = before.worker ? `v${before.worker.version} is still the live worker.` : 'The job is still running the old way, on the plan runner.';
      await this.finish(row.id, { status: 'failed', version, tests, sessionId: built.sessionId, log, error: `v${version} passed its tests but could not be put live: ${promoted.error}. ${stayed}` });
      return { ...(await this.state(agentId)), built: { ok: false, version, tests, error: promoted.error } };
    }

    await this.finish(row.id, { status: 'promoted', version, tests, sessionId: built.sessionId, log, error: null });
    this.log.log(`worker v${version} live for job ${agentId} (${tests?.passed} tests, ${req.sampleIds.length} saved answers)`);
    return { ...(await this.state(agentId)), built: { ok: true, version, tests, previous: promoted.previous || null } };
  }

  // ---- the pieces the build turn is made of -----------------------------------------------------

  /**
   * Everything a version folder is made of, as it is TODAY: the job's plan, the fact card for every
   * action it calls, the saved answers its tests stand on, the pinned kit — and out of those, the
   * files and the brief.
   *
   * Shared with the repair turn (BEA-1393), on purpose: a repair that was compiled against different
   * material from the build would be measured against a version it cannot be compared with.
   */
  async materials(
    job: any,
    opts: { version: number; previousVersion?: number | null; origin?: 'build' | 'rebuild'; reason?: string | null } = { version: 1 },
  ): Promise<{ plan: AgentPlan; cards: ToolKnowledge[]; kit: { version: string; js: string; doc: string; rev: string }; req: BuildRequest }> {
    const plan = planFromAgent(job);
    const cards = await this.cards(plan);
    const samples = await this.samplesFor(plan, cards);
    const kit = this.kit();
    // The approved brief and the whole conversation behind it (BEA-1407). A job with no brief is
    // compiled from the plan exactly as before — the old road is not closed, it is just no longer
    // the only one.
    const brief = job.areaId ? await this.briefs?.forCodex?.(job.areaId).catch(() => null) : null;
    // What each answer really looks like, learned from real calls (BEA-1415). The only thing Codex
    // can write a reading recipe from when a service's answers are never kept.
    const shapes = await this.shapesFor(plan);
    // The whole shelf, not the shortlist (BEA-1457). A worker may now call anything the owner has
    // connected and look up anything it does not know, so the build turn is shown what exists rather
    // than only the actions this job's plan already named. A catalog that cannot be read is simply
    // absent from the brief — the lookup still works at run time.
    const catalog = await this.lookup?.services?.().catch(() => null);
    // THE NEW ROAD (BEA-1464). An approved goal means the conversation and that goal ARE the
    // specification — no plan, no contract, no brief. The old road stays exactly as it was for every
    // job that has no goal, so nothing already live changes underneath him.
    const goal = job.areaId ? await this.goals?.approved?.(job.areaId).catch(() => null) : null;
    if (goal && String(goal.text || '').trim()) {
      const req = await this.goalMaterials(job, goal, kit, opts);
      return { plan, cards, kit, req };
    }

    const req = buildRequest({
      job: { id: job.id, name: job.name },
      plan,
      cards,
      samples,
      kit,
      brief: brief || null,
      shapes,
      catalog: (catalog || []).map((s: any) => ({ slug: String(s.slug), name: String(s.name), actions: Number(s.actions) || 0 })),
      version: opts.version,
      previousVersion: opts.previousVersion ?? null,
      origin: opts.origin || 'build',
      reason: opts.reason ?? null,
    });
    return { plan, cards, kit, req };
  }

  /**
   * The job's last run, with what it cost (BEA-1394 §I). The Worker row shows it because "what did
   * the last run spend" is the question the owner actually has when he looks at a worker — and until
   * this piece neither road showed a total anywhere.
   */
  async lastRun(agentId: string): Promise<any | null> {
    const run: any = await this.prisma.agentRun
      .findFirst({ where: { agentId }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, runKind: true, startedAt: true, endedAt: true, aiTokens: true } as any })
      .catch(() => null);
    if (!run) return null;
    const cost = await this.agent.runCost?.(run.id, run.aiTokens).catch(() => ({ credits: 0, aiTokens: Number(run.aiTokens) || 0, calls: 0 }));
    return { ...run, cost: cost || { credits: 0, aiTokens: Number(run.aiTokens) || 0, calls: 0 } };
  }

  /** The live worker of a job: the newest build that passed its tests and was put live. */
  async livePromoted(agentId: string): Promise<any | null> {
    return await this.prisma.workerBuild
      .findFirst({ where: { agentId, status: 'promoted' }, orderBy: { startedAt: 'desc' } })
      .catch(() => null);
  }

  /** The fact card for every action the plan calls — the know-how, not a one-line name. */
  /**
   * Can this job be compiled into a program, and if not, why — in words that are TRUE.
   *
   * It used to lean on the plan runner's own check, which asks a different question: "can the PLAN RUNNER
   * do this whole job by itself?" That requires every tool to be a source, which was true when an
   * agent could only read and false the moment a brief could name what it WRITES with (BEA-1453).
   * The owner's first brief that created Notion pages was refused by it — with the words "this job
   * runs on the engine", which is not true of a brief-built agent, and four steps after the point
   * where the real problem (a tool nothing can call) should have been raised.
   *
   * A job is compilable when it has at least one source to fetch from, and every tool it names is an
   * outside-service action — because those are the only things a worker can call.
   */
  static whyNotCompilableFor(job: any): string {
    const tools: string[] = Array.isArray(job?.tools) ? job.tools : [];
    const sources = Object.keys(normaliseToolArgs(job?.toolArgs) || {});
    if (!sources.length) return 'This job has nothing to fetch from yet, so there is nothing to build. Say where the information comes from.';
    const cannot = tools.filter((t) => !isServiceToolId(t));
    if (cannot.length) {
      return `${cannot.join(' and ')} ${cannot.length === 1 ? 'is not something' : 'are not things'} an agent can use. Take ${cannot.length === 1 ? 'it' : 'them'} out of the brief and say what it should do instead.`;
    }
    return '';
  }

  /** The learned shape of every action this plan calls, in the words the build brief prints. */
  private async shapesFor(plan: AgentPlan): Promise<Record<string, string>> {
    const ids = planActionIds(plan);
    if (!ids.length || !this.lessons) return {};
    const facts: any = await this.lessons.forActions(ids).catch(() => ({}));
    const out: Record<string, string> = {};
    for (const id of ids) {
      const shape = (facts[id] || []).find((f: any) => f.kind === 'shape' && f.shape)?.shape;
      if (shape) out[id] = shapeInWords(id, shape);
    }
    return out;
  }

  private async cards(plan: AgentPlan): Promise<ToolKnowledge[]> {
    const ids = planActionIds(plan);
    if (!ids.length || !this.knowledge?.lookup) return [];
    return await this.knowledge.lookup(ids).catch(() => [] as ToolKnowledge[]);
  }

  /**
   * One saved answer per source, turned into exactly what the callback API returns for it. A
   * creators-first block is sampled on its PER-CREATOR action, because those are the items that end
   * up in the table. A source with nothing saved yet is simply absent — the brief says so.
   */
  private async samplesFor(plan: AgentPlan, cards: ToolKnowledge[]): Promise<BuildSample[]> {
    if (!this.samples?.pick) return [];
    const out: BuildSample[] = [];
    for (const block of plan.sources || []) {
      const actionId = sampleActionOf(block);
      // This source's OWN call shape first — five hashtag sources on one action must not all be
      // handed the same saved answer, or the merge would de-dupe the whole fixture away. Any saved
      // answer for the action is the fallback: a shape to test against is better than none.
      const exact = exactArgsOf(block, actionId);
      const picked = (exact ? await this.samples.pick(actionId, argsHashOf(exact)).catch(() => null) : null) || (await this.samples.pick(actionId).catch(() => null));
      if (!picked?.data) continue;
      const card = cards.find((c) => c.actionId === actionId);
      const credits = Number(card?.cost?.credits?.typical) || 1;
      out.push({
        sourceId: block.id,
        actionId,
        args: picked.args || {},
        sampleId: picked.id,
        capturedAt: picked.createdAt ? new Date(picked.createdAt).toISOString() : null,
        creditsEstimated: true,
        answer: {
          ok: true,
          label: sourceLabel(block, plan.sources),
          credits,
          empty: false,
          unrecognised: false,
          why: null,
          stop: null,
          table: tableOf(picked.data),
        },
      });
    }
    return out;
  }

  /** The kit this app is running, read from disk once per build — file and docs, both pinned. */
  private kit(): { version: string; js: string; doc: string; rev: string } {
    const dir = join(__dirname, 'kit');
    let js = '';
    let doc = '';
    try {
      js = readFileSync(join(dir, 'kit.js'), 'utf8');
      doc = readFileSync(join(dir, 'KIT.md'), 'utf8');
    } catch (e: any) {
      // The kit is a plain file, so it only reaches the image through the Dockerfile's own copy —
      // if that ever stops happening, say so plainly instead of building a worker with no parts box.
      throw new BadRequestException(`The kit could not be read on the server (${String(e?.message || e).slice(0, 120)}), so nothing can be built against it.`);
    }
    const m = /KIT_VERSION\s*=\s*'([^']+)'/.exec(js);
    // The MAJOR (`version`) is what the runner refuses a worker on — it only moves when the kit
    // breaks something. That is deliberately coarse, and it is why a worker built the day before the
    // tools were opened (BEA-1457) still reads as perfectly current: nothing about its plan changed
    // and the major did not move either, so no existing signal says a word.
    //
    // `rev` is the fine one: a hash of the kit's own contents. It changes the moment anybody edits
    // the parts box, with nobody having to remember to bump anything — which is the failure this is
    // closing, not a new number to maintain.
    const rev = createHash('sha256').update(`${js}\n---\n${doc}`).digest('hex').slice(0, 12);
    return { version: m ? m[1] : '1', js, doc, rev };
  }

  /** The parts box a worker would be built against right now. Null when it cannot be read at all. */
  kitRevNow(): string | null {
    try { return this.kit().rev; } catch { return null; }
  }

  /**
   * The saved answers no sweep may take away: the ones the LIVE worker of every job was tested
   * against. A build that never went live pins nothing — its samples are as evictable as any other.
   */
  private async pinnedSampleIds(): Promise<string[]> {
    const rows = await this.prisma.workerBuild
      .findMany({ where: { status: 'promoted' }, orderBy: { startedAt: 'desc' }, select: { agentId: true, sampleIds: true } })
      .catch(() => [] as any[]);
    const seenJob = new Set<string>();
    const ids: string[] = [];
    for (const r of rows || []) {
      if (seenJob.has(r.agentId)) continue; // only the newest promoted build of each job is live
      seenJob.add(r.agentId);
      try {
        for (const id of JSON.parse(r.sampleIds || '[]')) if (typeof id === 'string') ids.push(id);
      } catch { /* a row we cannot read pins nothing */ }
    }
    return ids;
  }

  private async rows(agentId: string, take: number): Promise<any[]> {
    return await this.prisma.workerBuild.findMany({ where: { agentId }, orderBy: { startedAt: 'desc' }, take }).catch(() => [] as any[]);
  }

  private async finish(id: string, data: { status: string; version: number; tests: any; sessionId?: string | null; log: string; error: string | null }) {
    await this.prisma.workerBuild
      .update({
        where: { id },
        data: {
          status: data.status,
          version: data.version,
          tests: data.tests ? JSON.stringify(data.tests) : null,
          sessionId: data.sessionId || null,
          log: data.log || null,
          error: data.error,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  /** One build row as the owner reads it. `stale` is decided against the plan as it is right now. */
  private shape(b: any, planHash: string) {
    let tests: any = null;
    try { tests = b.tests ? JSON.parse(b.tests) : null; } catch { tests = null; }
    return {
      id: b.id,
      version: b.version,
      status: b.status,
      origin: b.origin,
      cause: b.cause || null,
      reason: b.reason || null,
      planHash: b.planHash,
      kit: b.kit,
      kitRev: b.kitRev || null,
      tests,
      sampleCount: countOf(b.sampleIds),
      sessionId: b.sessionId || null,
      error: b.error || null,
      log: b.log || null,
      stale: b.status === 'promoted' && !!planHash && b.planHash !== planHash,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt || null,
    };
  }
}

/** Which action's saved answer stands for this source: a creators block is judged on its items. */
export function sampleActionOf(block: PlanBlock): string {
  return block.kind === 'creators' ? block.then.actionId || block.find.actionId : sourceActionId(block);
}

/**
 * The exact arguments this source sends, when they can be known. A creators block's per-creator call
 * is built from a creator it has not found yet, so there are no exact arguments to match on.
 */
export function exactArgsOf(block: PlanBlock, actionId: string): Record<string, any> | null {
  if (block.kind === 'creators') return actionId === block.find.actionId ? block.find.args || {} : null;
  return block.args || {};
}

function countOf(raw: any): number {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Is the live worker's parts box older than the server's, and what do we tell him about it?
 *
 * Three states, and the middle one is the whole point:
 *  - **no worker, or the kit cannot be read** → nothing to say;
 *  - **the worker predates the revision stamp** (`kitRev` null — every build before BEA-1461) → say
 *    so plainly. Treating "unknown" as old is the honest reading: those builds really were compiled
 *    against a kit that had no `kit.call`, no `kit.facts`, no `kit.think` and no `kit.research`;
 *  - **the revisions differ** → the parts box changed under it.
 *
 * It never blocks a run. The kit change that prompted this was additive, so an older worker still
 * works perfectly — it just cannot use what it was never told about, and he should be the one to
 * decide whether that matters rather than finding out by testing.
 */
export function partsBox(worker: any, revNow: string | null): { partsBoxOld: boolean; partsBoxNote?: string } {
  if (!worker || !revNow) return { partsBoxOld: false };
  const was = worker.kitRev || null;
  if (was === revNow) return { partsBoxOld: false };
  return {
    partsBoxOld: true,
    partsBoxNote: was
      ? 'This worker was built against an older parts box, so anything added to it since is not in this program. Rebuild it to pick the new tools up — the plan is unchanged, so nothing else about the job moves.'
      : 'This worker was built before the tools were opened up, so it cannot call anything outside its own plan, and it never sees what a service really answers. Rebuild it to give it the full set — the plan is unchanged, so nothing else about the job moves.',
  };
}
