import { Injectable, NotFoundException, BadRequestException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { normaliseToolArgs, toolsFor } from '../social/tool-args';
import { RunLockService } from './run-lock.service';

/** The shape of a mid-task question the agent can ask. */
export type WaitKind = 'choice' | 'free_text' | 'approve_edit_reject' | 'form';

export type AskInput = {
  question: string;
  kind?: WaitKind;
  options?: unknown; // choices array, form fields, or the draft for approve_edit_reject
  defaultValue?: string; // smart default, auto-applied on timeout
  expiresInMs?: number; // optional timeout; on expiry the default is applied (or the run parks)
  /** Where the question is being SENT (BEA-1392): 'whatsapp' for a worker's `kit.ask`. */
  askedVia?: string;
};

/**
 * What runs when a question is answered, whichever road answered it (BEA-1392) — see
 * {@link AgentService.setAnswerHook}. `via` is `web | telegram | whatsapp | timeout`.
 */
export type RunAnswered = (runId: string, answer: string, via: string) => any;

/**
 * A run on the WORKER road has just failed (BEA-1393, agent workers 8/10). The self-heal loop
 * registers itself here at boot: `finishRun()` is the one door every terminal state comes through —
 * the worker's own `/finish` callback, the sweeper's timeout, the stall watchdog — so hooking it
 * means no road can fail a worker without the evidence being kept.
 *
 * It runs BEFORE the callback controller drops the run's journal, and it is awaited so the answers
 * that broke the run are still there to be read. It must therefore stay cheap: capture, and hand the
 * repair itself to a later tick. A hook that throws is swallowed — a failed run must not fail twice.
 */
export type RunFailed = (runId: string, ctx: { agentId: string | null; error: string; runKind: string }) => any;

const FINISHED = ['done', 'failed', 'cancelled'];

/**
 * The flow-picture drawer (BEA-1366). Every agent shows its flow without a button: a Social agent's
 * picture is BUILT from its settings on every save, any other agent's is planned on save. The drawer
 * lives in FlowsModule (`AgentFlowSyncService`) and registers itself here at boot — AgentModule
 * cannot import FlowsModule (FlowsModule imports AgentModule), so this is a seam, not an import.
 * A drawer that throws must never break a save; the caller swallows.
 */
export type AgentFlowSync = { afterSave(agent: any, ctx: { created: boolean; changed: string[] }): Promise<void> };

/**
 * "Deleting an agent deletes its worker" (BEA-1394 — `specs/AGENT-WORKERS.md` §I). The rows are this
 * service's to clean up; the version folders on the host belong to the worker runner, so the delete
 * asks through this seam (registered by `WorkerDispatchService`) rather than importing WorkerModule,
 * which imports AgentModule. It never throws and never blocks the delete — a folder we could not
 * reach is a warning in the log, not a job the owner cannot get rid of.
 */
export type WorkerCleanup = (jobId: string) => Promise<void>;

/**
 * AgentService — the DURABLE human-in-the-loop engine (BEA-619).
 *
 * This is the piece Hermes does NOT give us: a run can pause on a structured question,
 * notify the user, and resume even days later / after an API restart, because the whole
 * state lives in SQLite (no in-memory waiting). Hermes's own approvals time out in ~60s
 * and don't survive a restart. The bridge (BEA-618) and MCP tools (BEA-622) call into this.
 */
@Injectable()
export class AgentService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private flowSync: AgentFlowSync | null = null;
  private answered: RunAnswered | null = null;
  private runFailed: RunFailed | null = null;
  private workerCleanup: WorkerCleanup | null = null;

  // `locks` is optional and LAST: spec harnesses build this service positionally with just Prisma,
  // and every call is `?.`-guarded, so a harness without it behaves exactly as before. (BEA-1388)
  constructor(private readonly prisma: PrismaService, private readonly locks?: RunLockService) {}

  /** Register the flow-picture drawer (BEA-1366). Called once by `AgentFlowSyncService.onModuleInit`. */
  setFlowSync(sync: AgentFlowSync | null) {
    this.flowSync = sync;
  }

  /**
   * Register what else has to happen when a run's question is answered (BEA-1392). Called once by
   * `OwnerAskService.onModuleInit` — the registration pattern again, because the gates live in
   * ToolCatalogModule and an import here would be a cycle.
   *
   * It hangs off `resolve()` on purpose: EVERY road that answers a question — the run screen,
   * Telegram, WhatsApp, and the 12-hour timeout applying the question's own default — goes through
   * that one method, so a can't-undo call a worker parked on is settled the same way whichever road
   * answered it. Hanging it off the WhatsApp road alone would leave a timed-out gate for ever
   * `pending`, and the resumed worker would park and message the owner again, and again.
   */
  setAnswerHook(hook: RunAnswered | null) {
    this.answered = hook;
  }

  /**
   * Register the self-heal loop (BEA-1393). Called once by `WorkerRepairService.onModuleInit` — the
   * same registration pattern, because WorkerModule imports AgentModule and never the other way.
   */
  setRunFailedHook(hook: RunFailed | null) {
    this.runFailed = hook;
  }

  /**
   * Register who removes a deleted job's worker folders (BEA-1394). Called once by
   * `WorkerDispatchService.onModuleInit` — the same registration seam, for the same reason.
   */
  setWorkerCleanup(hook: WorkerCleanup | null) {
    this.workerCleanup = hook;
  }

  onModuleInit() {
    // A run's driver lives in this process's memory. If the process restarts (deploy/crash/reboot)
    // mid-run, the row is left status='running' with nothing to advance it — it would spin forever.
    // Fail those orphans on boot so they never spin silently again (BEA-629). The DB can be briefly
    // locked in the post-deploy stampede, so a failed attempt RETRIES instead of being swallowed —
    // a swallowed failure left runs stuck 'running' in the UI (BEA-859).
    void this.reconcileWithRetry();
    // Per-minute sweeper that applies timeouts to overdue questions. Guarded so a bad tick
    // can never crash the app (matches the gmail-brief.service.ts pattern).
    this.sweepTimer = setInterval(() => {
      this.sweepExpired().catch(() => undefined);
    }, 60_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /** Boot reconcile with retries (BEA-859): up to 5 attempts, 5s apart, then give up loudly-ish. */
  async reconcileWithRetry(attempts = 5, delayMs = 5_000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.reconcileOrphans();
        return;
      } catch {
        if (i < attempts - 1) await new Promise((r) => { const t = setTimeout(r, delayMs); if (typeof (t as any).unref === 'function') (t as any).unref(); });
      }
    }
  }

  /**
   * Fail runs left mid-flight by a restart (BEA-629). A 'running' row has no live driver after a
   * process restart, so it can never finish on its own — mark it failed with a clear message and a
   * logged step. Idempotent: terminal runs (done/failed/cancelled) and paused ones are untouched.
   */
  async reconcileOrphans(): Promise<number> {
    // Durable ask (BEA-795): a run PARKED on a question carries its engine session on the row
    // (sessionId != null) and needs no live driver — surviving a restart is the whole point, so
    // those are left alone (same for an answered park the resume sweeper hasn't picked up yet).
    // Only runs with no way to advance are failed:
    //   'running' + no sessionId        → mid-turn when the process died
    //   'awaiting_input' + no sessionId → an old in-memory wait whose poll loop died
    const orphans = await this.prisma.agentRun.findMany({ where: { status: { in: ['running', 'awaiting_input'] }, sessionId: null }, select: { id: true, status: true, stepLog: true } });
    if (!orphans.length) return 0;
    const now = new Date();
    for (const o of orphans) {
      const msg = o.status === 'awaiting_input'
        ? 'This run was waiting for your answer when the engine restarted — please run it again.'
        : 'Interrupted by an engine restart — please run it again.';
      const log = this.parse(o.stepLog, [] as any[]);
      log.push({ label: 'Interrupted by a restart', status: 'failed', detail: msg, at: now.toISOString() });
      await this.prisma.waitpoint.updateMany({ where: { runId: o.id, status: 'pending' }, data: { status: 'cancelled' } }).catch(() => undefined);
      await this.prisma.agentRun
        .update({ where: { id: o.id }, data: { status: 'failed', error: msg, endedAt: now, stepLog: JSON.stringify(log) } })
        .catch(() => undefined);
      // The restart that orphaned this run also left its lock behind (the row is in the database, not
      // in memory). Free it here rather than waiting out the timeout — the job can fire again at once.
      await this.locks?.releaseForRun(o.id).catch(() => undefined);
    }
    return orphans.length;
  }

  /** Watchdog health state (BEA-632) — read/written by the engine watchdog, shown in settings. */
  async engineHealth() {
    const [healthyAt, restartedAt, error] = await Promise.all([
      this.getSetting('engine.lastHealthyAt'),
      this.getSetting('engine.lastAutoRestartAt'),
      this.getSetting('engine.lastError'),
    ]);
    return {
      lastHealthyAt: healthyAt ? Number(healthyAt) : null,
      lastAutoRestartAt: restartedAt ? Number(restartedAt) : null,
      lastError: error || null,
    };
  }
  async recordEngineHealth(patch: { healthyAt?: number; restartedAt?: number; error?: string | null }) {
    if (patch.healthyAt !== undefined) await this.setSetting('engine.lastHealthyAt', String(patch.healthyAt));
    if (patch.restartedAt !== undefined) await this.setSetting('engine.lastAutoRestartAt', String(patch.restartedAt));
    if (patch.error !== undefined) await this.setSetting('engine.lastError', patch.error == null ? '' : patch.error);
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ---------- runs ----------

  async createRun(input: { agentId?: string | null; title?: string; input?: string; depth?: string } = {}) {
    const run = await this.prisma.agentRun.create({
      data: {
        agentId: input.agentId ?? null,
        title: input.title ?? null,
        input: input.input ?? null,
        depth: input.depth ?? null,
        status: 'running',
      },
    });
    return this.shapeRun(run);
  }

  async listRuns(opts: { agentId?: string; limit?: number } = {}) {
    const runs = await this.prisma.agentRun.findMany({
      where: opts.agentId ? { agentId: opts.agentId } : undefined,
      orderBy: { startedAt: 'desc' },
      take: Math.min(opts.limit ?? 100, 500),
      include: { waitpoints: true },
    });
    return runs.map((r: any) => this.shapeRun(r));
  }

  async getRun(id: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id }, include: { waitpoints: true } });
    if (!run) throw new NotFoundException('Run not found');
    return { ...this.shapeRun(run), cost: await this.runCost(id, (run as any).aiTokens) };
  }

  /**
   * What ONE run really cost (BEA-1394 §I, "cost is shown per run"). Until now neither road showed a
   * total — the plan runner said its credits inside a sentence and the worker road said nothing.
   *
   * Credits are summed from the `ToolCall` rows that already carry this run's id (every paid call
   * goes through `runDetailed()`, on both roads and from the worker's callback API alike), so there
   * is no second ledger to keep in step. AI tokens have no such column anywhere, so they are added
   * up on the run row as the model steps happen (`addAiTokens`). `calls` is how many paid calls the
   * total is made of — a 0-credit answer is still a call, and saying so is how a cache hit reads.
   */
  async runCost(runId: string, aiTokens?: number): Promise<{ credits: number; aiTokens: number; calls: number }> {
    let credits = 0;
    let calls = 0;
    try {
      const rows: any[] = (await (this.prisma as any).toolCall?.findMany?.({ where: { runId }, select: { credits: true } })) || [];
      calls = rows.length;
      for (const r of rows) credits += Number(r.credits) || 0;
    } catch { /* no ledger in a harness — the run still reads, with nothing claimed */ }
    let tokens = Number(aiTokens) || 0;
    if (aiTokens === undefined) {
      const row: any = await this.prisma.agentRun.findUnique({ where: { id: runId }, select: { aiTokens: true } as any }).catch(() => null);
      tokens = Number(row?.aiTokens) || 0;
    }
    return { credits, aiTokens: tokens, calls };
  }

  /**
   * Add what a model step just spent to the run's own total (BEA-1394). Both roads call it — the plan
   * runner after its shaping step, the worker's `/api/worker/ai` after each one — because `UsageLog`
   * is keyed by FEATURE and has no run on it. Never throws: a figure is not worth a run.
   */
  async addAiTokens(runId: string, tokens: number): Promise<void> {
    const n = Math.max(0, Math.round(Number(tokens) || 0));
    if (!runId || !n) return;
    try {
      await this.prisma.agentRun.update({ where: { id: runId }, data: { aiTokens: { increment: n } } as any });
    } catch { /* a run that has gone, or a harness without the column */ }
  }

  /**
   * Per-job history retention (BEA-1099): jobs with `keepDays` set drop FINISHED entries older
   * than that. Only done/failed/cancelled rows go; running/waiting rows and the saved Documents
   * are never touched (documents live in the Documents library with their own rules).
   */
  async sweepOldRuns(): Promise<number> {
    const jobs = await this.prisma.agent.findMany({ where: { keepDays: { not: null } } as any, select: { id: true, keepDays: true } as any });
    let swept = 0;
    for (const j of jobs as any[]) {
      const cutoff = new Date(Date.now() - j.keepDays * 86_400_000);
      const r = await this.prisma.agentRun.deleteMany({
        where: { agentId: j.id, status: { in: ['done', 'failed', 'cancelled'] }, endedAt: { lt: cutoff } },
      }).catch(() => ({ count: 0 }));
      swept += r.count;
    }
    return swept;
  }

  /** Statuses that mean "still in flight" — these can't be deleted (cancel first). */
  private readonly liveRunStatuses = ['running', 'awaiting_input'];

  /** Delete a single run (its waitpoints cascade). Saved Documents are NOT touched. */
  async deleteRun(id: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Run not found');
    if (this.liveRunStatuses.includes(run.status)) throw new BadRequestException('This run is still in progress — cancel it first.');
    await this.prisma.agentRun.delete({ where: { id } });
    return { ok: true };
  }

  /** Clear finished runs — all of them, or just one agent's. In-flight runs are kept. */
  async clearRuns(agentId?: string) {
    const where: any = { status: { notIn: this.liveRunStatuses } };
    if (agentId) where.agentId = agentId;
    const res = await this.prisma.agentRun.deleteMany({ where });
    return { ok: true, deleted: res.count };
  }

  // ---------- engine settings (configurable knobs) ----------

  private async getSetting(key: string): Promise<string | null> {
    const r = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    return (r as any)?.value ?? null;
  }
  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /** The user-configurable agent engine knobs (with sane defaults). */
  async engineSettings() {
    const [model, autonomy, askTimeoutMin, askTtlHours, recall, learn, outputCollectionId, alertsOnFailure, alertsWhatsappNumber, flowPartDays, whatsappOutputs, socialCeiling] = await Promise.all([
      this.getSetting('agent.model'),
      this.getSetting('agent.autonomy'),
      this.getSetting('agent.askTimeoutMin'),
      this.getSetting('agent.askTtlHours'),
      this.getSetting('agent.recall'),
      this.getSetting('agent.learn'),
      this.getSetting('agent.outputCollectionId'),
      this.getSetting('alerts.onFailure'),
      this.getSetting('alerts.whatsappNumber'),
      this.getSetting('docs.flowPartDays'),
      this.getSetting('whatsapp.outputs'),
      this.getSetting('social.dailyCreditCeiling'),
    ]);
    return {
      model: model || '', // '' = use the engine's default model
      autonomy: autonomy || 'cautious', // cautious | balanced | autopilot
      askTimeoutMin: askTimeoutMin ? Math.max(1, Number(askTimeoutMin) || 20) : 20,
      // How long a durable "ask me" waits before the run pauses itself gently (BEA-1068).
      askTtlHours: askTtlHours ? Math.max(1, Number(askTtlHours) || 72) : 72,
      recall: recall == null ? true : recall === 'true',
      learn: learn == null ? true : learn === 'true',
      outputCollectionId: outputCollectionId || null,
      // "WhatsApp me when an automation fails" (BEA-1071)
      alertsOnFailure: alertsOnFailure == null ? true : alertsOnFailure === 'true',
      alertsWhatsappNumber: alertsWhatsappNumber || '',
      // How long flow working-part documents live before auto-clean (BEA-1085); 0 = keep forever.
      flowPartDays: flowPartDays == null || flowPartDays === '' ? 30 : Math.max(0, Number(flowPartDays) || 0),
      // Master switch for "WhatsApp me every finished job" (BEA-1102) — per-job toggles sit under it.
      whatsappOutputs: whatsappOutputs == null ? true : whatsappOutputs === 'true',
      // The daily Social credit ceiling (BEA-1358): default 500; 0 = no limit. Enforced before every job's call.
      socialDailyCreditCeiling: socialCeiling == null || socialCeiling === '' ? 500 : Math.max(0, Math.floor(Number(socialCeiling) || 0)),
    };
  }

  async setEngineSettings(patch: Record<string, unknown>) {
    const map: Record<string, string> = {
      model: 'agent.model',
      autonomy: 'agent.autonomy',
      askTimeoutMin: 'agent.askTimeoutMin',
      askTtlHours: 'agent.askTtlHours',
      recall: 'agent.recall',
      learn: 'agent.learn',
      outputCollectionId: 'agent.outputCollectionId',
      alertsOnFailure: 'alerts.onFailure',
      alertsWhatsappNumber: 'alerts.whatsappNumber',
      flowPartDays: 'docs.flowPartDays',
      whatsappOutputs: 'whatsapp.outputs',
      socialDailyCreditCeiling: 'social.dailyCreditCeiling',
    };
    for (const [k, key] of Object.entries(map)) {
      if (patch[k] === undefined) continue;
      let v = patch[k] == null ? '' : String(patch[k]);
      // The Social credit ceiling is a whole number ≥ 0 (0 = no limit); a negative or nonsense value
      // must not silently switch the guard off (BEA-1358).
      if (k === 'socialDailyCreditCeiling' && v !== '') { const n = Math.floor(Number(v)); v = Number.isFinite(n) ? String(Math.max(0, n)) : ''; }
      await this.setSetting(key, v);
    }
    return this.engineSettings();
  }

  /** Counts for the status panel. */
  async engineCounts() {
    const [agents, scheduled, running] = await Promise.all([
      this.prisma.agent.count(),
      this.prisma.agent.count({ where: { enabled: true, NOT: { schedule: null } } }),
      this.prisma.agentRun.count({ where: { status: { in: ['running', 'awaiting_input'] } } }),
    ]);
    return { agents, scheduled, running };
  }

  // ---------- saved agents (BEA-623) ----------

  async createAgent(
    input: { name: string; prompt?: string; rubric?: string; evals?: unknown[]; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean; defaultDepth?: string; category?: string; color?: string; sourceUrl?: string; origin?: string; tools?: string[]; outputDest?: string; sheetId?: string | null; sheetAppend?: boolean; toolArgs?: unknown; notifyWhatsApp?: boolean; ui?: unknown; mode?: string; alertCondition?: string | null; threshold?: unknown; folderId?: string | null },
    // `drawFlow:false` — the caller draws (and plans) the picture itself, e.g. the voice research
    // job, which links its own flow so it can plan inside the toolbox in one pass (BEA-1366).
    opts: { drawFlow?: boolean } = {},
  ) {
    if (!input?.name?.trim()) throw new BadRequestException('An agent needs a name');
    // The sources of a direct-fetch job (BEA-1374): stored keyed by SOURCE id, and `tools` always
    // lists every action they call — a source the toolbox forgot would never run.
    const sources = input.toolArgs && typeof input.toolArgs === 'object' ? normaliseToolArgs(input.toolArgs) : null;
    const tools = sources && Object.keys(sources).length ? toolsFor(sources, input.tools) : Array.isArray(input.tools) ? input.tools.filter((t) => typeof t === 'string') : [];
    const a = await this.prisma.agent.create({
      data: {
        category: input.category?.trim() || null,
        color: input.color?.trim() || null,
        sourceUrl: input.sourceUrl?.trim() || null,
        name: input.name.trim().slice(0, 120),
        prompt: input.prompt?.trim() || null,
        rubric: input.rubric?.trim() || null,
        evals: Array.isArray(input.evals) ? JSON.stringify(input.evals) : '[]',
        icon: input.icon || null,
        description: input.description || null,
        autonomy: input.autonomy || 'cautious',
        schedule: input.schedule ? JSON.stringify(input.schedule) : null,
        scheduleText: input.scheduleText || null,
        defaultDepth: this.normDepth(input.defaultDepth),
        collectionId: input.collectionId ?? null,
        enabled: input.enabled ?? true,
        // Where it came from (BEA-1175/1176) — chat, voice, an import, or a Social result (BEA-1357).
        origin: ['chat', 'voice', 'import', 'social'].includes(String(input.origin)) ? String(input.origin) : 'chat',
        ...(tools.length ? { tools: JSON.stringify(tools.slice(0, 60)) } : {}),
        // Where the result goes (BEA-1357): document (default) | telegram | task | sheet.
        outputDest: this.normOutputDest(input.outputDest),
        sheetId: this.cleanSheetId(input.sheetId),
        ...(input.sheetAppend !== undefined ? { sheetAppend: !!input.sheetAppend } : {}),
        ...(sources ? { toolArgs: JSON.stringify(sources) } : {}),
        ...(input.notifyWhatsApp !== undefined ? { notifyWhatsApp: !!input.notifyWhatsApp } : {}),
        // Watch / Alert (BEA-1358): how a direct-fetch job treats its result, and what an Alert judges.
        mode: this.normMode(input.mode),
        alertCondition: this.cleanCondition(input.alertCondition),
        threshold: this.cleanThreshold(input.threshold),
        // A ready mini-interface (BEA-1357): a direct-fetch job has no inputs to design, so the builder
        // hands one over and the job page never spends an engine turn designing a screen for it.
        ...(input.ui && typeof input.ui === 'object' ? { ui: JSON.stringify(input.ui) } : {}),
        ...((input as any).areaId ? { areaId: (input as any).areaId } : {}),
      },
    });
    // Areas invariant (BEA-1095): every job belongs to an area. A job created without one gets
    // its own area (same identity) — exactly like the migration did for the pre-areas agents.
    if (!(a as any).areaId) {
      try {
        // Toolbox inferred at creation (BEA-1100) — lands on the new area's Tools section.
        const KINDS = ['skill', 'api', 'mcp', 'cli'];
        const tools = Array.isArray((input as any).tools)
          ? (input as any).tools.slice(0, 40).map((t: any) => ({
              ...(t?.id ? { id: String(t.id).slice(0, 120) } : {}), // catalog id (BEA-1167)
              ...(t?.group ? { group: String(t.group).slice(0, 40) } : {}),
              kind: KINDS.includes(t?.kind) ? t.kind : 'api',
              name: String(t?.name || '').slice(0, 80),
              ...(t?.note ? { note: String(t.note).slice(0, 200) } : {}),
              status: t?.status === 'installed' ? 'installed' : 'needed',
            })).filter((t: any) => t.name)
          : [];
        // Created from inside a folder (BEA-1380) → its card lands in that folder; a stale/unknown
        // folder id degrades to Unfiled (the create itself must never fail on it).
        const wantFolder = typeof (input as any).folderId === 'string' && (input as any).folderId ? String((input as any).folderId) : null;
        const folder = wantFolder ? await Promise.resolve((this.prisma as any).agentFolder?.findUnique?.({ where: { id: wantFolder } })).catch(() => null) : null;
        const area = await (this.prisma as any).agentArea.create({
          data: { name: a.name, icon: a.icon, color: a.color, description: a.description, sourceUrl: (a as any).sourceUrl ?? null, tools: JSON.stringify(tools), ...(folder ? { folderId: folder.id } : {}) },
        });
        await this.prisma.agent.update({ where: { id: a.id }, data: { areaId: area.id } as any });
        (a as any).areaId = area.id;
      } catch { /* area creation must never block agent creation */ }
    }
    const shaped = this.shapeAgent(a);
    // Every agent shows its flow (BEA-1366): drawn from the settings (Social) or planned (others).
    if (opts.drawFlow !== false) await this.flowSync?.afterSave?.(shaped, { created: true, changed: [] }).catch(() => undefined);
    return shaped;
  }

  /** Clamp a depth value to the allowed set (default 'standard'). */
  private normDepth(d?: string): string {
    return d && ['quick', 'standard', 'deep'].includes(d) ? d : 'standard';
  }

  /** The output destinations a job can have (BEA-1357). Anything else falls back to a Document. */
  static readonly OUTPUT_DESTS = ['document', 'telegram', 'task', 'sheet'];
  private normOutputDest(d?: string): string {
    return d && AgentService.OUTPUT_DESTS.includes(d) ? d : 'document';
  }

  /**
   * A Google Sheet id, from the id itself or a pasted sheet URL — the owner copies the address bar,
   * not the id (BEA-1357). Empty → null (a new sheet per run).
   */
  private cleanSheetId(v?: string | null): string | null {
    const s = String(v || '').trim();
    if (!s) return null;
    const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(s);
    return (m ? m[1] : s).slice(0, 120);
  }

  async listAgents() {
    const rows = await this.prisma.agent.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((a: any) => this.shapeAgent(a));
  }

  async getAgent(id: string) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    const shaped: any = this.shapeAgent(a);
    // The job page's folder crumb (BEA-1380): the folder its agent card sits in, when there is one.
    if ((a as any).areaId) {
      const area: any = await Promise.resolve((this.prisma as any).agentArea?.findUnique?.({ where: { id: (a as any).areaId } })).catch(() => null);
      if (area?.folderId) {
        const f: any = await Promise.resolve((this.prisma as any).agentFolder?.findUnique?.({ where: { id: area.folderId } })).catch(() => null);
        if (f) shaped.folder = { id: f.id, name: f.name };
      }
    }
    return shaped;
  }

  /**
   * The tools this job is ALLOWED to use (BEA-1168): its own picked set, else the agent's toolbox.
   *
   * `source: 'none'` means nobody has chosen yet. That is deliberately NOT treated as "nothing" —
   * every agent built before the toolbox existed would stop working overnight. It is also not
   * silent: the run prompt says plainly that no toolbox has been set, and the UI says so too.
   */
  async allowedTools(agentId?: string | null): Promise<{ ids: string[]; source: 'job' | 'agent' | 'none' }> {
    if (!agentId) return { ids: [], source: 'none' };
    const a: any = await this.prisma.agent.findUnique({ where: { id: agentId } }).catch(() => null);
    if (!a) return { ids: [], source: 'none' };
    const own = this.parseIds(a.tools);
    if (own.length) return { ids: own, source: 'job' };
    if (!a.areaId) return { ids: [], source: 'none' };
    const area: any = await (this.prisma as any).agentArea.findUnique({ where: { id: a.areaId } }).catch(() => null);
    let box: any[] = [];
    try { box = area?.tools ? JSON.parse(area.tools) : []; } catch { box = []; }
    const ids = (Array.isArray(box) ? box : []).map((t: any) => t?.id).filter((x: any) => typeof x === 'string' && x);
    return ids.length ? { ids, source: 'agent' } : { ids: [], source: 'none' };
  }

  private parseIds(s?: string | null): string[] {
    try {
      const v = s ? JSON.parse(s) : [];
      return Array.isArray(v) ? v.filter((x: any) => typeof x === 'string' && x) : [];
    } catch { return []; }
  }

  /**
   * What this run is graded against (BEA-1173): the job's own Outcome and checks, falling back to
   * the agent's STANDING Outcome. That fallback is what makes a voice job — created with no setup
   * of its own — still come back with a pass or fail.
   */
  async outcomeFor(agentId?: string | null): Promise<{ rubric: string; checks: string[] }> {
    if (!agentId) return { rubric: '', checks: [] };
    const a: any = await this.prisma.agent.findUnique({ where: { id: agentId } }).catch(() => null);
    if (!a) return { rubric: '', checks: [] };
    let rubric = (a.rubric || '').trim();
    let checks: string[] = [];
    try {
      const evals = a.evals ? JSON.parse(a.evals) : [];
      checks = (Array.isArray(evals) ? evals : []).map((e: any) => String(e?.input || '').trim()).filter(Boolean);
    } catch { checks = []; }
    if (!rubric && a.areaId) {
      const area: any = await (this.prisma as any).agentArea.findUnique({ where: { id: a.areaId } }).catch(() => null);
      rubric = (area?.outcome || '').trim();
    }
    return { rubric, checks };
  }

  /** Set the tools this job may use. */
  async setTools(id: string, ids: string[]) {
    const clean = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x).slice(0, 60);
    await this.prisma.agent.update({ where: { id }, data: { tools: JSON.stringify(clean) } as any });
    return this.getAgent(id);
  }

  async updateAgent(id: string, patch: { name?: string; prompt?: string; rubric?: string; evals?: unknown[]; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean; defaultDepth?: string; category?: string; color?: string; skills?: unknown[]; ui?: unknown; tools?: unknown[] }) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    const data: any = {};
    if (patch.category !== undefined) data.category = patch.category?.trim() || null;
    if (patch.color !== undefined) data.color = patch.color?.trim() || null;
    if (patch.skills !== undefined) data.skills = JSON.stringify(Array.isArray(patch.skills) ? patch.skills.slice(0, 10) : []); // attached skills (BEA-1079)
    // The tools this job may use (BEA-1168) — ids from the one catalog.
    if (patch.tools !== undefined) data.tools = JSON.stringify((Array.isArray(patch.tools) ? patch.tools : []).filter((x: any) => typeof x === 'string' && x).slice(0, 60));
    // The sources (BEA-1374): written back in the source-id shape; `tools` keeps every action they call.
    if ((patch as any).toolArgs && typeof (patch as any).toolArgs === 'object') {
      const sources = normaliseToolArgs((patch as any).toolArgs);
      if (Object.keys(sources).length) {
        const base = patch.tools !== undefined ? (Array.isArray(patch.tools) ? patch.tools : []) : this.parse(a.tools, [] as unknown);
        data.tools = JSON.stringify(toolsFor(sources, base).slice(0, 60));
      }
    }
    if (patch.ui !== undefined) data.ui = patch.ui ? JSON.stringify(patch.ui) : null; // mini-interface spec (BEA-1082)
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120);
    if (patch.prompt !== undefined) data.prompt = patch.prompt?.trim() || null;
    if (patch.rubric !== undefined) data.rubric = patch.rubric?.trim() || null;
    if (patch.evals !== undefined) data.evals = JSON.stringify(Array.isArray(patch.evals) ? patch.evals : []);
    if (patch.icon !== undefined) data.icon = patch.icon || null;
    if (patch.description !== undefined) data.description = patch.description || null;
    if (patch.autonomy !== undefined) data.autonomy = patch.autonomy;
    if (patch.schedule !== undefined) { data.schedule = patch.schedule ? JSON.stringify(patch.schedule) : null; data.lastFiredKey = null; }
    if (patch.scheduleText !== undefined) data.scheduleText = patch.scheduleText || null;
    if (patch.collectionId !== undefined) data.collectionId = patch.collectionId ?? null;
    // Switching a job back on clears why it paused itself (BEA-1358) — the same rule as a trigger binding.
    if (patch.enabled !== undefined) { data.enabled = patch.enabled; if (patch.enabled) data.pausedReason = null; }
    if (patch.defaultDepth !== undefined) data.defaultDepth = this.normDepth(patch.defaultDepth);
    // Per-job settings (BEA-1095) — each job is fully independent.
    const p: any = patch;
    if (p.areaId !== undefined) data.areaId = p.areaId || null;
    if (p.notifyWhatsApp !== undefined) data.notifyWhatsApp = !!p.notifyWhatsApp;
    if (p.keepDays !== undefined) data.keepDays = p.keepDays == null ? null : Math.max(1, Math.min(3650, Number(p.keepDays) || 0)) || null;
    if (p.engine !== undefined) data.engine = p.engine && typeof p.engine === 'object' ? JSON.stringify(p.engine) : null;
    if (p.indexToBrain !== undefined) data.indexToBrain = !!p.indexToBrain;
    // The dispatch switch (BEA-1394): "run it on its worker" / "run it the old way". Nothing else
    // in the app ever writes this — it is the owner's tap, and turning it off needs no rebuild.
    if (p.useWorker !== undefined) data.useWorker = !!p.useWorker;
    // Where the result goes + the pinned fetch arguments (BEA-1357).
    if (p.outputDest !== undefined) data.outputDest = this.normOutputDest(p.outputDest);
    if (p.sheetId !== undefined) data.sheetId = this.cleanSheetId(p.sheetId);
    if (p.sheetAppend !== undefined) data.sheetAppend = !!p.sheetAppend;
    if (p.toolArgs !== undefined) data.toolArgs = p.toolArgs && typeof p.toolArgs === 'object' ? JSON.stringify(normaliseToolArgs(p.toolArgs)) : null;
    // Watch / Alert (BEA-1358).
    if (p.mode !== undefined) data.mode = this.normMode(p.mode);
    if (p.alertCondition !== undefined) data.alertCondition = this.cleanCondition(p.alertCondition);
    if (p.threshold !== undefined) data.threshold = this.cleanThreshold(p.threshold);
    const updated = await this.prisma.agent.update({ where: { id }, data });
    const shaped = this.shapeAgent(updated);
    // The picture follows the settings (BEA-1366): the drawer decides from `changed` whether this
    // save touches what runs (sources, task, output, mode…) — a rename or a pause does not re-draw.
    const changed = Object.keys(data);
    if (changed.length) await this.flowSync?.afterSave?.(shaped, { created: false, changed }).catch(() => undefined);
    return shaped;
  }

  /** Append messages to a job's persisted chat history (BEA-1097). Server-side only. */
  async appendChat(id: string, msgs: { who: 'you' | 'ai'; text: string }[]) {
    const a = await this.prisma.agent.findUnique({ where: { id }, select: { chatLog: true } });
    if (!a) throw new NotFoundException('Agent not found');
    const log = this.parse((a as any).chatLog, [] as any[]);
    const at = new Date().toISOString();
    for (const m of msgs) log.push({ who: m.who, text: String(m.text).slice(0, 4000), at });
    const trimmed = log.slice(-200); // keep the last 200 messages
    await this.prisma.agent.update({ where: { id }, data: { chatLog: JSON.stringify(trimmed) } as any });
    return trimmed;
  }

  /** Clear a job's chat history (BEA-1097). */
  async clearChat(id: string) {
    await this.prisma.agent.update({ where: { id }, data: { chatLog: '[]' } as any }).catch(() => { throw new NotFoundException('Agent not found'); });
    return { ok: true };
  }

  /**
   * Delete a job and everything that belongs to it — nothing left behind (BEA-1394 §I).
   *
   * Most of this is hand-kept because the tables have no foreign key back to `Agent`, which is
   * exactly the bug class CLAUDE.md flags and the reason `deleteAgentLeavesNothing` asserts it row by
   * row. The order matters in one place: `RunJournal` is keyed on the RUN, so it has to go while the
   * run rows are still here to be listed.
   *
   * Deliberately NOT deleted: `ToolCall` rows. That table is the credit ledger the daily Social
   * ceiling is summed from, and rewriting yesterday's spend because a job was deleted would make the
   * ceiling lie. Saved Documents are not touched either — they live in the library with their own
   * rules.
   */
  async deleteAgent(id: string) {
    // A deleted job takes its run history with it (BEA-1109) — no orphan rows in Landed/History —
    // and its flows + flow runs (BEA-1113): with no Flows sidebar, an orphaned flow is unreachable.
    // Waitpoints cascade with their runs; saved Documents are never touched.
    // `?.`-guarded: spec harnesses pass partial Prisma stubs, and a delete must degrade rather than
    // throw on a client that only has the delegates the older test knew about.
    const runIds = ((await (this.prisma as any).agentRun?.findMany?.({ where: { agentId: id }, select: { id: true } })?.catch?.(() => [] as any[])) || []).map((r: any) => r.id);
    if (runIds.length) {
      // The journal of every worker run (BEA-1387) — no FK, and it must go BEFORE the runs do, or
      // there is nothing left to find its rows by. Any still-pending question is cancelled first so
      // nothing can act on it in the moment between the two deletes; the rows themselves cascade.
      await (this.prisma as any).waitpoint?.updateMany?.({ where: { runId: { in: runIds }, status: 'pending' }, data: { status: 'cancelled' } })?.catch?.(() => undefined);
      await (this.prisma as any).runJournal?.deleteMany?.({ where: { runId: { in: runIds } } }).catch(() => undefined);
    }
    await this.prisma.agentRun.deleteMany({ where: { agentId: id } }).catch(() => undefined);
    // …and what a Watch/Alert job saw last time (BEA-1358) — no FK, so by hand.
    await (this.prisma as any).socialWatch?.deleteMany?.({ where: { agentId: id } }).catch(() => undefined);
    await this.locks?.releaseJob(id).catch(() => undefined); // …and its run lock (BEA-1388) — no FK either.
    // …and the history of the workers Codex built for it (BEA-1390), plus the whole vendor answers
    // its builds and repairs were tested against (BEA-1386) — a deleted job's fetched content has no
    // reason to stay on disk, and with its builds gone nothing pins it anyway.
    await (this.prisma as any).workerBuild?.deleteMany?.({ where: { agentId: id } }).catch(() => undefined);
    await (this.prisma as any).toolSample?.deleteMany?.({ where: { agentId: id } }).catch(() => undefined);
    // …and the version folders on the host, through the runner (BEA-1394 §I). Best effort by design:
    // a runner that is down must not leave the owner with a job he cannot delete.
    await this.workerCleanup?.(id)?.catch?.(() => undefined);
    try {
      const flows = await this.prisma.flow.findMany({ where: { agentId: id }, select: { id: true } });
      for (const f of flows) await this.prisma.flowRun.deleteMany({ where: { flowId: f.id } }).catch(() => undefined);
      await this.prisma.flow.deleteMany({ where: { agentId: id } });
    } catch { /* flow cleanup must never block the delete */ }
    await this.prisma.agent.delete({ where: { id } }).catch(() => { throw new NotFoundException('Agent not found'); });
    return { ok: true };
  }

  /** Enabled agents that have both a schedule and a prompt (candidates for the scheduler). */
  async listSchedulable() {
    const rows = await this.prisma.agent.findMany({ where: { enabled: true, NOT: [{ schedule: null }, { prompt: null }] } });
    return rows.map((a: any) => this.shapeAgent(a));
  }

  /** Record that a scheduled agent fired for this minute-key, so it can't double-fire. */
  async markFired(agentId: string, key: string) {
    await this.prisma.agent.update({ where: { id: agentId }, data: { lastFiredKey: key } }).catch(() => undefined);
  }

  /** Persist eval cases + their latest verdicts (BEA-642). */
  async setEvals(id: string, evals: unknown[]) {
    await this.prisma.agent.update({ where: { id }, data: { evals: JSON.stringify(Array.isArray(evals) ? evals : []) } }).catch(() => undefined);
  }

  private shapeAgent(a: any) {
    return {
      ...a,
      skills: this.parse(a.skills, [] as unknown),
      schedule: a.schedule ? this.parse(a.schedule, null) : null,
      evals: this.parse(a.evals, [] as unknown),
      ui: a.ui ? this.parse(a.ui, null) : null,
      engine: a.engine ? this.parse(a.engine, null) : null, // this job's own model (BEA-1106)
      chatLog: this.parse(a.chatLog, [] as unknown), // persisted change-by-chatting history (BEA-1097)
      tools: this.parse(a.tools, [] as unknown), // catalog tool ids this job may use (BEA-1168)
      // The sources of a direct-fetch job (BEA-1357), always in the source-id shape (BEA-1374) whatever is stored.
      toolArgs: a.toolArgs ? this.shapeToolArgs(a.toolArgs) : null,
      threshold: a.threshold ? this.parse(a.threshold, null) : null, // an Alert's number to cross (BEA-1358)
    };
  }

  /** `Agent.toolArgs` as the UI reads it: the source-id shape (`normaliseToolArgs`), null when empty or unreadable. */
  private shapeToolArgs(raw: string): Record<string, any> | null {
    const parsed = this.parse(raw, null);
    if (!parsed || typeof parsed !== 'object') return null;
    const map = normaliseToolArgs(parsed);
    return Object.keys(map).length ? map : null;
  }

  /** run (fetch every time) | watch (only what changed) | alert (watch + a condition → push). BEA-1358. */
  private normMode(v: unknown): string {
    return ['run', 'watch', 'alert'].includes(String(v)) ? String(v) : 'run';
  }
  private cleanCondition(v: unknown): string | null {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, 500) : null;
  }
  /** `{ field?, dir: above|below, value }` as JSON, or null when there is no usable number. */
  private cleanThreshold(v: unknown): string | null {
    let t: any = v;
    if (typeof v === 'string') { try { t = JSON.parse(v); } catch { t = null; } }
    if (!t || typeof t !== 'object') return null;
    const value = Number(t.value);
    if (!Number.isFinite(value)) return null;
    const field = typeof t.field === 'string' && t.field.trim() ? t.field.trim().slice(0, 80) : undefined;
    return JSON.stringify({ ...(field ? { field } : {}), dir: t.dir === 'below' ? 'below' : 'above', value });
  }

  /** Append a step to the run's plain-English step log (mirror of Hermes events). */
  async appendStep(runId: string, step: { label: string; status?: string; detail?: string; kind?: string; nodeId?: string }) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');
    const log = this.parse(run.stepLog, [] as any[]);
    log.push({ ...step, at: new Date().toISOString() });
    const updated = await this.prisma.agentRun.update({ where: { id: runId }, data: { stepLog: JSON.stringify(log) } });
    return this.shapeRun(updated);
  }

  /**
   * "Still moving" (BEA-1387 §H): ONE live line that updates itself, so a long fetch (11 pages with
   * vendor backoff, 50 creator calls one after the other) is never mistaken for a hang. It replaces
   * the previous checkpoint instead of appending, so a slow run leaves one line, not fifty, and the
   * next real step pushes it down the log as usual. Never throws — progress is not worth a run.
   */
  async stampProgress(runId: string, label: string) {
    try {
      const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
      if (!run) return;
      const log = this.parse(run.stepLog, [] as any[]);
      const entry = { label: String(label).slice(0, 300), status: 'running', kind: 'checkpoint', at: new Date().toISOString() };
      if (log.length && log[log.length - 1]?.kind === 'checkpoint') log[log.length - 1] = entry;
      else log.push(entry);
      await this.prisma.agentRun.update({ where: { id: runId }, data: { stepLog: JSON.stringify(log) } });
    } catch { /* a progress line that cannot be written is not a reason to stop */ }
  }

  /**
   * Which road this run is on (BEA-1387): `engine` (a Codex turn — the default) | `worker` | `plan`.
   * The Codex resume sweeper only ever resumes an `engine` run; without this a parked worker either
   * strands for ever or wakes up as a live Codex turn instead of the worker.
   */
  async setRunKind(runId: string, kind: 'engine' | 'worker' | 'plan') {
    await this.prisma.agentRun.update({ where: { id: runId }, data: { runKind: kind } }).catch(() => undefined);
  }

  async finishRun(id: string, patch: { status?: 'done' | 'failed' | 'cancelled'; outputDocId?: string; outputUrl?: string; error?: string; resultText?: string; grade?: string } = {}) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Run not found');
    // A run that already reached a terminal state must NOT be revived — otherwise a Codex turn that
    // finishes after the user cancelled would flip 'cancelled' back to 'done' and save its result. (BEA-793)
    if (run.status === 'cancelled' || run.status === 'done' || run.status === 'failed') return this.shapeRun(run);
    // A finishing run must not leave an open question behind that a later tap/timeout could act on. (BEA-794)
    await this.prisma.waitpoint.updateMany({ where: { runId: id, status: 'pending' }, data: { status: 'cancelled' } }).catch(() => undefined);
    const updated = await this.prisma.agentRun.update({
      where: { id },
      data: {
        status: patch.status ?? 'done',
        outputDocId: patch.outputDocId ?? run.outputDocId,
        outputUrl: patch.outputUrl ?? (run as any).outputUrl,
        resultText: patch.resultText ?? run.resultText,
        grade: patch.grade ?? run.grade,
        error: patch.error ?? null,
        endedAt: new Date(),
      },
    });
    // ANY terminal state frees the job (BEA-1388). This is the natural release point: every road that
    // ends a run — the engine, the plan runner, the worker's /finish callback, a crash caught in
    // startRun — comes through here, and the terminal guard above means it happens exactly once. It
    // goes AFTER the row is written: a lock freed for a run still marked 'running' would let the next
    // start overlap the one that never actually ended.
    await this.locks?.releaseForRun(id).catch(() => undefined);
    // A worker that failed is evidence (BEA-1393). This runs before the callback controller drops
    // the run's journal, so the answers that broke it are still there — and it is swallowed, because
    // a run that has already failed must not fail a second time on the way out.
    if ((patch.status ?? 'done') === 'failed' && (run as any).runKind === 'worker' && this.runFailed) {
      try {
        await this.runFailed(id, { agentId: run.agentId ?? null, error: String(patch.error || run.error || ''), runKind: 'worker' });
      } catch {
        /* the loop says its own piece in its own log; a finish is never held up by it */
      }
    }
    return this.shapeRun(updated);
  }

  /** Link a saved Document to the run (the agent's output). */
  async attachOutput(runId: string, docId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');
    const updated = await this.prisma.agentRun.update({ where: { id: runId }, data: { outputDocId: docId } });
    return this.shapeRun(updated);
  }

  /** Read a waitpoint by its one-time token (so a polling agent can fetch the answer once given). */
  async getWaitpoint(token: string) {
    const wp = await this.prisma.waitpoint.findUnique({ where: { resumeToken: token } });
    return wp ? this.shapeWaitpoint(wp) : null;
  }

  /** Read a waitpoint by id (the Telegram callback / run screen answer it by id). */
  async getWaitpointById(id: string) {
    const wp = await this.prisma.waitpoint.findUnique({ where: { id } });
    return wp ? this.shapeWaitpoint(wp) : null;
  }

  /** Attach the quiet double-check's warning to a pending draft (BEA-1078). */
  async annotateWaitpoint(id: string, validatorNote: string) {
    const wp = await this.prisma.waitpoint.findUnique({ where: { id } });
    if (!wp || wp.status !== 'pending') return;
    const options = this.parse(wp.options, {} as any);
    const next = options && !Array.isArray(options) ? { ...options, validatorNote } : { validatorNote };
    await this.prisma.waitpoint.update({ where: { id }, data: { options: JSON.stringify(next) } }).catch(() => undefined);
  }

  /** Cancel a run and any of its still-pending questions. */
  async cancelRun(id: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Run not found');
    await this.prisma.waitpoint.updateMany({ where: { runId: id, status: 'pending' }, data: { status: 'cancelled' } });
    const updated = await this.prisma.agentRun.update({ where: { id }, data: { status: 'cancelled', endedAt: new Date() } });
    await this.locks?.releaseForRun(id).catch(() => undefined); // cancelled is terminal too (BEA-1388)
    return this.shapeRun(updated);
  }

  /**
   * "What's fresh in my life" (BEA-1077) — a tiny always-current grounding note injected at the
   * start of every real agent run: the latest journal head + today's open-task picture. Cheap
   * (two small queries), and it makes a run about MY life instead of a cold start.
   */
  async freshContext(): Promise<string> {
    try {
      const [story, open] = await Promise.all([
        this.prisma.story.findFirst({ orderBy: { createdAt: 'desc' }, select: { day: true, rawText: true } }),
        this.prisma.task.findMany({ where: { status: 'open' }, orderBy: [{ pinned: 'desc' }, { day: 'desc' }], take: 60, select: { title: true, pinned: true, day: true } }),
      ]);
      const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST day
      const parts: string[] = [];
      if (story?.rawText) parts.push(`Latest journal (${story.day}): "${story.rawText.replace(/\s+/g, ' ').slice(0, 260)}…"`);
      if (open.length) {
        const dueToday = open.filter((t) => t.day && t.day <= today).length;
        const top = open.slice(0, 3).map((t) => t.title).join(' · ');
        parts.push(`Open tasks: ${open.length}${dueToday ? ` (${dueToday} due today or overdue)` : ''}. Top of mind: ${top}.`);
      }
      if (!parts.length) return '';
      return `\n\n[What's fresh in the user's life — today is ${today}]\n${parts.join('\n')}\nUse this only as context; the task above is what you're doing.`;
    } catch {
      return '';
    }
  }

  /** How many questions are waiting on the owner right now — the nav badge (BEA-1066). */
  async waitingCount(): Promise<{ count: number }> {
    const [wps, flows] = await Promise.all([
      this.prisma.waitpoint.count({ where: { status: 'pending', run: { status: { notIn: FINISHED } } } }),
      this.prisma.flowRun.count({ where: { status: 'waiting' } }),
    ]);
    return { count: wps + flows };
  }

  /**
   * Every run — agents AND flows — merged into one honest history (BEA-1069). Each row carries a
   * human name ("Morning Brief — Thu"), its source, and how long it took.
   */
  async allRuns(limit = 500) {
    const take = Math.min(Math.max(limit, 1), 1000);
    const [agentRuns, flowRuns] = await Promise.all([
      this.prisma.agentRun.findMany({ orderBy: { startedAt: 'desc' }, take }),
      this.prisma.flowRun.findMany({ orderBy: { startedAt: 'desc' }, take }),
    ]);
    const flowIds = [...new Set(flowRuns.map((f: any) => f.flowId).filter(Boolean))] as string[];
    const flowNames = new Map<string, string>();
    if (flowIds.length) {
      for (const f of await this.prisma.flow.findMany({ where: { id: { in: flowIds } }, select: { id: true, name: true } })) flowNames.set(f.id, f.name);
    }
    const dayName = (d: Date | null) => (d ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(d.getTime() + 330 * 60000).getUTCDay()] : '');
    const durationSec = (s: Date | null, e: Date | null) => (s && e ? Math.max(0, Math.round((new Date(e).getTime() - new Date(s).getTime()) / 1000)) : null);
    const rows = [
      ...agentRuns.map((r: any) => ({
        id: r.id,
        source: 'agent' as const,
        name: `${r.title || 'Agent run'} — ${dayName(r.startedAt)}`,
        title: r.title || 'Agent run',
        status: r.status,
        depth: r.depth || null,
        grade: r.grade ? this.parse(r.grade, null) : null,
        outputDocId: r.outputDocId || null,
        outputUrl: r.outputUrl || null, // the sheet it wrote (BEA-1357)
        error: r.error || null,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationSec: durationSec(r.startedAt, r.endedAt),
      })),
      ...flowRuns.map((f: any) => ({
        id: f.id,
        source: 'flow' as const,
        name: `${flowNames.get(f.flowId) || 'Flow run'} — ${dayName(f.startedAt)}`,
        title: flowNames.get(f.flowId) || 'Flow run',
        status: f.status, // running | waiting | done | failed | cancelled
        depth: null,
        grade: null,
        outputDocId: null,
        outputUrl: null,
        error: f.error || null,
        startedAt: f.startedAt,
        endedAt: f.endedAt,
        durationSec: durationSec(f.startedAt, f.endedAt),
      })),
    ].sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
    return rows.slice(0, take);
  }

  // ---------- the Agents home (BEA-1087): one payload for the whole screen ----------

  /** Shelf group when the agent has none set — a light keyword guess, never persisted. */
  guessCategory(a: { name?: string | null; prompt?: string | null; description?: string | null }): string {
    const t = `${a.name || ''} ${a.description || ''} ${a.prompt || ''}`.toLowerCase();
    if (/brief|morning|daily|digest|journal|summar|week/.test(t)) return 'Daily';
    if (/remind|chase|contact|whatsapp|message|nudge|follow|people/.test(t)) return 'People';
    if (/clean|duplicate|tidy|hygiene|stale|organis|organiz/.test(t)) return 'Brain care';
    if (/research|find|compare|watch|monitor|report|look/.test(t)) return 'Research';
    return 'Other';
  }

  /** Card colour when none is set — a stable palette by category. */
  categoryColor(category: string): string {
    return (
      {
        'Daily': '#818cf8',
        'Research': '#22d3ee',
        'People': '#34d399',
        'Brain care': '#c084fc',
        'Imported': '#f59e0b',
      } as Record<string, string>
    )[category] || '#94a3b8';
  }

  /**
   * Everything the Agents home shows, in ONE call: what's waiting on you (agent waitpoints + flow
   * waits), what's running, what landed in the last 24h, and the agent shelf with health.
   */
  async home() {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const [pendingWps, waitingFlows, runningAgents, runningFlows, landedAgents, landedFlows, agentRows, recentRuns] = await Promise.all([
      this.prisma.waitpoint.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, include: { run: true } }),
      this.prisma.flowRun.findMany({ where: { status: 'waiting' }, orderBy: { startedAt: 'asc' } }),
      this.prisma.agentRun.findMany({ where: { status: 'running' }, orderBy: { startedAt: 'desc' }, take: 6 }),
      this.prisma.flowRun.findMany({ where: { status: 'running' }, orderBy: { startedAt: 'desc' }, take: 6 }),
      this.prisma.agentRun.findMany({ where: { status: { in: ['done', 'failed', 'cancelled'] }, endedAt: { gte: dayAgo } }, orderBy: { endedAt: 'desc' }, take: 12 }),
      this.prisma.flowRun.findMany({ where: { status: { in: ['done', 'failed', 'cancelled'] }, endedAt: { gte: dayAgo } }, orderBy: { endedAt: 'desc' }, take: 12 }),
      this.prisma.agent.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.agentRun.findMany({ orderBy: { startedAt: 'desc' }, take: 120, select: { agentId: true, status: true, startedAt: true, endedAt: true } }),
    ]);

    const flowIds = [...new Set([...waitingFlows, ...runningFlows, ...landedFlows].map((f: any) => f.flowId).filter(Boolean))] as string[];
    const flowNames = new Map<string, string>();
    if (flowIds.length) {
      const flows = await this.prisma.flow.findMany({ where: { id: { in: flowIds } }, select: { id: true, name: true } });
      for (const f of flows) flowNames.set(f.id, f.name);
    }
    const byAgent = new Map<string, any>();
    for (const a of agentRows) byAgent.set(a.id, a);
    // newest run per agent → the honest health chip on its card
    const lastRun = new Map<string, { status: string; at: Date | null }>();
    for (const r of recentRuns) if (r.agentId && !lastRun.has(r.agentId)) lastRun.set(r.agentId, { status: r.status, at: r.endedAt || r.startedAt });

    const waiting = [
      ...pendingWps
        .filter((wp: any) => wp.run && !FINISHED.includes(wp.run.status))
        .map((wp: any) => {
          const agent = wp.run.agentId ? byAgent.get(wp.run.agentId) : null;
          const category = agent ? agent.category || this.guessCategory(agent) : 'Other';
          return {
            source: 'agent' as const,
            waitpointId: wp.id,
            runId: wp.runId,
            title: wp.run.title || agent?.name || 'Agent run',
            icon: agent?.icon || '🤖',
            color: agent?.color || this.categoryColor(category),
            question: wp.question,
            kind: wp.kind,
            options: this.parse(wp.options, [] as unknown),
            defaultValue: wp.defaultValue ?? null,
            askedAt: wp.createdAt,
            expiresAt: wp.expiresAt ?? null,
            paused: wp.run.status === 'paused', // waited past the TTL and paused itself (BEA-1068)
          };
        }),
      ...waitingFlows.map((f: any) => ({
        source: 'flow' as const,
        waitpointId: null,
        runId: f.id,
        title: flowNames.get(f.flowId) || 'Flow run',
        icon: '🕸',
        color: '#22d3ee',
        question: f.waitQuestion || 'Your input is needed to continue.',
        kind: f.waitKind || 'free_text',
        options: this.parse(f.waitOptions, [] as unknown),
        defaultValue: null,
        askedAt: f.startedAt,
        expiresAt: null,
      })),
    ].sort((a, b) => new Date(a.askedAt).getTime() - new Date(b.askedAt).getTime());

    const lastSteps = (stepLog: unknown, n = 3) => this.parse(stepLog, [] as any[]).filter((s: any) => s.kind !== 'log').slice(-n).map((s: any) => ({ label: s.label, status: s.status }));
    const running = [
      ...runningAgents.map((r: any) => ({ source: 'agent' as const, id: r.id, title: r.title || 'Agent run', startedAt: r.startedAt, steps: lastSteps(r.stepLog) })),
      ...runningFlows.map((f: any) => ({ source: 'flow' as const, id: f.id, title: flowNames.get(f.flowId) || 'Flow run', startedAt: f.startedAt, steps: this.parse(f.terminal, [] as any[]).slice(-3).map((t: any) => ({ label: t.text, status: 'done' })) })),
    ].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const landed = [
      ...landedAgents.map((r: any) => ({ source: 'agent' as const, id: r.id, title: r.title || 'Agent run', status: r.status, endedAt: r.endedAt, outputDocId: r.outputDocId || null, error: r.error || null })),
      ...landedFlows.map((f: any) => ({ source: 'flow' as const, id: f.id, title: flowNames.get(f.flowId) || 'Flow run', status: f.status, endedAt: f.endedAt, outputDocId: null, error: f.error || null })),
    ]
      .sort((a, b) => new Date(b.endedAt || 0).getTime() - new Date(a.endedAt || 0).getTime())
      .slice(0, 12);

    const shelf = agentRows.map((a: any) => {
      const category = a.category || this.guessCategory(a);
      return { ...this.shapeAgent(a), category, color: a.color || this.categoryColor(category), lastRun: lastRun.get(a.id) || null };
    });

    return { waiting, running, landed, agents: shelf };
  }

  // ---------- durable park + resume (BEA-795) ----------

  /**
   * Park a run on its engine session: the model asked a question and ended its turn, so nothing is
   * running in memory any more — the row alone (status 'awaiting_input' + sessionId) carries enough
   * to resume hours or days later, across restarts. '' = parked without a session id (the engine
   * gave none); the resume then starts a fresh session from the task text instead.
   */
  async parkRun(runId: string, sessionId?: string | null) {
    await this.prisma.agentRun.update({ where: { id: runId }, data: { sessionId: sessionId || '' } }).catch(() => undefined);
  }

  /** Parked runs whose question has been answered — ready for the resume sweeper. */
  async listResumable() {
    const rows = await this.prisma.agentRun.findMany({
      where: { status: 'running', NOT: { sessionId: null }, waitpoints: { some: { status: 'answered' } } },
      include: { waitpoints: true },
    });
    return rows.map((r: any) => this.shapeRun(r));
  }

  /**
   * Atomically claim a resumable run (clears the park marker) — only one sweeper tick can win,
   * so an answer can never spawn two concurrent drivers (same discipline as BEA-791).
   */
  async claimResume(runId: string): Promise<boolean> {
    const res = await this.prisma.agentRun.updateMany({ where: { id: runId, status: 'running', NOT: { sessionId: null } }, data: { sessionId: null } });
    return res.count > 0;
  }

  // ---------- the durable HITL primitive ----------

  /**
   * Pause a run on a question. Persists a Waitpoint (with a one-time resume token), flips the
   * run to `awaiting_input`, and returns — there is NO in-memory wait, so the pause survives a
   * restart. Whoever delivers the question (Telegram in BEA-620, the run screen in BEA-621)
   * reads it back from the DB.
   */
  async ask(runId: string, q: AskInput) {
    if (!q?.question?.trim()) throw new BadRequestException('A question is required');
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');
    if (FINISHED.includes(run.status)) throw new BadRequestException('Run is already finished');

    const token = randomBytes(24).toString('hex');
    const wp = await this.prisma.waitpoint.create({
      data: {
        runId,
        question: q.question.trim(),
        kind: q.kind ?? 'choice',
        options: JSON.stringify(q.options ?? []),
        defaultValue: q.defaultValue ?? null,
        resumeToken: token,
        askedVia: q.askedVia ?? null,
        expiresAt: q.expiresInMs && q.expiresInMs > 0 ? new Date(Date.now() + q.expiresInMs) : null,
      },
    });
    await this.prisma.agentRun.update({ where: { id: runId }, data: { status: 'awaiting_input' } });
    return this.shapeWaitpoint(wp);
  }

  /** Answer a question by its one-time token (used by the Telegram callback / resume link). */
  async answerByToken(token: string, answer: unknown, via = 'web') {
    const wp = await this.prisma.waitpoint.findUnique({ where: { resumeToken: token } });
    if (!wp) throw new NotFoundException('That question was not found — the link may be old.');
    return this.resolve(wp, answer, via);
  }

  /** Answer a question by its id (used by the in-app run screen). */
  async answerById(id: string, answer: unknown, via = 'web') {
    const wp = await this.prisma.waitpoint.findUnique({ where: { id } });
    if (!wp) throw new NotFoundException('Question not found');
    return this.resolve(wp, answer, via);
  }

  /**
   * Resolve a waitpoint exactly once. The guard is an atomic `updateMany ... where status='pending'`,
   * so two taps (e.g. phone + web at the same instant) can never both win — the first updates one
   * row, the second updates zero and is reported as an idempotent no-op.
   */
  private async resolve(wp: any, answer: unknown, via: string) {
    const res = await this.prisma.waitpoint.updateMany({
      where: { id: wp.id, status: 'pending' },
      data: { status: 'answered', answer: JSON.stringify(answer ?? null), answeredVia: via, answeredAt: new Date() },
    });
    if (res.count === 0) {
      // Already answered/expired/cancelled — idempotent: report state, change nothing.
      const fresh = await this.prisma.waitpoint.findUnique({ where: { id: wp.id } });
      const run = fresh ? await this.prisma.agentRun.findUnique({ where: { id: fresh.runId } }) : null;
      return { applied: false, alreadyResolved: true, status: fresh?.status, waitpoint: fresh && this.shapeWaitpoint(fresh), run: run && this.shapeRun(run) };
    }
    // Hand the run back to the engine ONLY if it's still waiting (or gently auto-paused — BEA-1068:
    // answering a paused run revives it too). If it already finished (e.g. the Codex turn hit its
    // cap and failed while the question was open), answering must NOT flip a terminal run back to
    // 'running' with no driver — that leaves it stuck forever. (BEA-794)
    await this.prisma.agentRun.updateMany({ where: { id: wp.runId, status: { in: ['awaiting_input', 'paused'] } }, data: { status: 'running' } });
    // Whatever else this answer settles — today, a can't-undo call a worker parked on (BEA-1392).
    // Never throws: an answer that was applied must stay applied.
    try {
      await this.answered?.(wp.runId, typeof answer === 'string' ? answer : JSON.stringify(answer ?? ''), via);
    } catch { /* the answer stands whatever the hook makes of it */ }
    const run = await this.prisma.agentRun.findUnique({ where: { id: wp.runId } });
    const fresh = await this.prisma.waitpoint.findUnique({ where: { id: wp.id } });
    return { applied: true, alreadyResolved: false, status: 'answered', waitpoint: this.shapeWaitpoint(fresh), run: run ? this.shapeRun(run) : null };
  }

  /**
   * Apply timeouts to overdue questions that carry a SMART DEFAULT. Questions without a default are
   * no longer expired-and-failed here — they pause gently via pauseStaleAsks (BEA-1068), with the
   * question kept answerable.
   */
  async sweepExpired(now: Date = new Date()) {
    const due = await this.prisma.waitpoint.findMany({ where: { status: 'pending', expiresAt: { not: null, lte: now } } });
    let handled = 0;
    for (const wp of due) {
      if (wp.defaultValue == null) continue; // gentle-pause territory (BEA-1068)
      const r = await this.resolve(wp, wp.defaultValue, 'timeout');
      if (r.applied) handled++;
    }
    return handled;
  }

  /**
   * Gentle auto-pause (BEA-1068): a question that has waited past the TTL (default 72h) — or past
   * its own expiry with no smart default — moves its run to 'paused'. Nothing is failed and the
   * question STAYS pending, so answering it any time later still resumes the run (resolve() flips
   * paused → running and the resume sweeper carries on). Returns what was paused this call so the
   * caller can notify the owner exactly once.
   */
  async pauseStaleAsks(now: Date = new Date()) {
    const { askTtlHours } = await this.engineSettings();
    const cutoff = new Date(now.getTime() - askTtlHours * 3600_000);
    const pending = await this.prisma.waitpoint.findMany({ where: { status: 'pending' } });
    const stale = pending.filter((wp: any) =>
      wp.expiresAt ? wp.defaultValue == null && new Date(wp.expiresAt) <= now : new Date(wp.createdAt) <= cutoff,
    );
    const paused: { runId: string; title: string | null; question: string; waitedHours: number }[] = [];
    for (const wp of stale) {
      // Atomic claim: only a run still actively waiting flips — a second sweep is a no-op.
      const res = await this.prisma.agentRun.updateMany({ where: { id: wp.runId, status: 'awaiting_input' }, data: { status: 'paused' } });
      if (res.count === 0) continue;
      const waitedHours = Math.max(1, Math.round((now.getTime() - new Date(wp.createdAt).getTime()) / 3600_000));
      await this.appendStep(wp.runId, { label: `Paused — I waited ${waitedHours}h for your answer`, status: 'info', detail: 'Answer whenever you like and the run continues.' }).catch(() => undefined);
      const run = await this.prisma.agentRun.findUnique({ where: { id: wp.runId }, select: { title: true } }).catch(() => null);
      paused.push({ runId: wp.runId, title: run?.title ?? null, question: wp.question, waitedHours });
    }
    return paused;
  }

  /**
   * Every question WhatsApp itself asked and is still waiting on (BEA-1392 §H).
   *
   * Deliberately narrow: `askedVia: 'whatsapp'` only, and only a run that is really parked. An
   * inbound owner message may never answer a question the run screen or Telegram is holding — he
   * would answer those there, and a stray "ok" on WhatsApp must not decide them.
   */
  async openWhatsAppAsks() {
    const rows = await this.prisma.waitpoint.findMany({
      where: { status: 'pending', askedVia: 'whatsapp', run: { status: { in: ['awaiting_input', 'paused'] } } },
      orderBy: { createdAt: 'asc' },
      include: { run: { select: { id: true, agentId: true, title: true } } },
    });
    return rows.map((w: any) => ({ ...this.shapeWaitpoint(w), runId: w.runId, runTitle: w.run?.title ?? null }));
  }

  /**
   * A question that ran out of time with no default to fall back on (BEA-1392). Marked expired so
   * nothing can answer it afterwards; the caller ends the run honestly. Idempotent — a second sweep
   * changes nothing.
   */
  async expireAsk(id: string): Promise<boolean> {
    const res = await this.prisma.waitpoint.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired' } });
    return res.count > 0;
  }

  // ---------- shaping / json safety ----------

  private parse<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== 'string') return (raw as T) ?? fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /** Store the proposed/kept learnings for a run (BEA-624). */
  async setLearnings(runId: string, items: Array<{ text: string; status?: string; memId?: string }>) {
    const updated = await this.prisma.agentRun.update({ where: { id: runId }, data: { learnings: JSON.stringify(items) } });
    return this.shapeRun(updated);
  }

  private shapeRun(run: any) {
    return {
      ...run,
      stepLog: this.parse(run.stepLog, [] as any[]),
      learnings: this.parse(run.learnings, [] as any[]),
      grade: run.grade ? this.parse(run.grade, null) : null,
      waitpoints: Array.isArray(run.waitpoints) ? run.waitpoints.map((w: any) => this.shapeWaitpoint(w)) : undefined,
    };
  }

  private shapeWaitpoint(wp: any) {
    if (!wp) return wp;
    return {
      ...wp,
      options: this.parse(wp.options, [] as unknown),
      answer: wp.answer == null ? null : this.parse(wp.answer, wp.answer),
    };
  }
}
