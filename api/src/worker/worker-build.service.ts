import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { ToolKnowledgeService, ToolKnowledge } from '../tools/tool-knowledge.service';
import { ToolSampleService } from '../tools/tool-sample.service';
import { AgentPlan, PlanBlock, isDirectFetchAgent, planActionIds, planFromAgent, sourceActionId, sourceLabel } from '../social/plan';
import { tableOf } from '../social/rows';
import { argsHashOf } from '../tools/tool-sample';
import { BuildRequest, BuildSample, buildRequest, planHashOf } from './build-brief';
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
export class WorkerBuildService implements OnModuleInit {
  private readonly log = new Logger('WorkerBuild');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly runner: WorkerRunnerClient,
    // Optional + LAST — spec harnesses build services positionally with fewer arguments.
    private readonly knowledge?: ToolKnowledgeService,
    private readonly samples?: ToolSampleService,
  ) {}

  onModuleInit() {
    // The sweep may never evict a saved answer a live worker's tests stand on (§A's hook, filled in
    // here now that worker folders exist).
    this.samples?.setPinned?.(() => this.pinnedSampleIds());
  }

  // ---- what the owner sees ----------------------------------------------------------------------

  /** The live worker, whether it is stale, and the last few builds. */
  async state(agentId: string): Promise<WorkerState> {
    const job = await this.agent.getAgent(agentId).catch(() => null);
    if (!job) throw new BadRequestException('That job no longer exists.');
    const compilable = isDirectFetchAgent(job);
    const plan = compilable ? planFromAgent(job) : null;
    const planHash = plan ? planHashOf(plan) : '';
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
      compilable,
      reason: compilable ? undefined : 'This job runs on the engine, not on a plan of sources — there is nothing to compile into a worker yet.',
      building,
      builds: rows.map((b: any) => this.shape(b, planHash)),
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
    if (!isDirectFetchAgent(job)) throw new BadRequestException('This job runs on the engine, not on a plan of sources — there is nothing to compile into a worker yet.');

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
        sampleIds: JSON.stringify(req.sampleIds),
      },
    });

    const built = await this.runner.build({ jobId: agentId, brief: req.brief, files: req.files });
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
  ): Promise<{ plan: AgentPlan; cards: ToolKnowledge[]; kit: { version: string; js: string; doc: string }; req: BuildRequest }> {
    const plan = planFromAgent(job);
    const cards = await this.cards(plan);
    const samples = await this.samplesFor(plan, cards);
    const kit = this.kit();
    const req = buildRequest({
      job: { id: job.id, name: job.name },
      plan,
      cards,
      samples,
      kit,
      version: opts.version,
      previousVersion: opts.previousVersion ?? null,
      origin: opts.origin || 'build',
      reason: opts.reason ?? null,
    });
    return { plan, cards, kit, req };
  }

  /** The live worker of a job: the newest build that passed its tests and was put live. */
  async livePromoted(agentId: string): Promise<any | null> {
    return await this.prisma.workerBuild
      .findFirst({ where: { agentId, status: 'promoted' }, orderBy: { startedAt: 'desc' } })
      .catch(() => null);
  }

  /** The fact card for every action the plan calls — the know-how, not a one-line name. */
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
  private kit(): { version: string; js: string; doc: string } {
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
    return { version: m ? m[1] : '1', js, doc };
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
