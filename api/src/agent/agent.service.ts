import { Injectable, NotFoundException, BadRequestException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** The shape of a mid-task question the agent can ask. */
export type WaitKind = 'choice' | 'free_text' | 'approve_edit_reject' | 'form';

export type AskInput = {
  question: string;
  kind?: WaitKind;
  options?: unknown; // choices array, form fields, or the draft for approve_edit_reject
  defaultValue?: string; // smart default, auto-applied on timeout
  expiresInMs?: number; // optional timeout; on expiry the default is applied (or the run parks)
};

const FINISHED = ['done', 'failed', 'cancelled'];

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

  constructor(private readonly prisma: PrismaService) {}

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
    return this.shapeRun(run);
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
    const [model, autonomy, askTimeoutMin, askTtlHours, recall, learn, outputCollectionId, alertsOnFailure, alertsWhatsappNumber, flowPartDays] = await Promise.all([
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
    };
    for (const [k, key] of Object.entries(map)) {
      if (patch[k] !== undefined) await this.setSetting(key, patch[k] == null ? '' : String(patch[k]));
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

  async createAgent(input: { name: string; prompt?: string; rubric?: string; evals?: unknown[]; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean; defaultDepth?: string; category?: string; color?: string; sourceUrl?: string }) {
    if (!input?.name?.trim()) throw new BadRequestException('An agent needs a name');
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
      },
    });
    return this.shapeAgent(a);
  }

  /** Clamp a depth value to the allowed set (default 'standard'). */
  private normDepth(d?: string): string {
    return d && ['quick', 'standard', 'deep'].includes(d) ? d : 'standard';
  }

  async listAgents() {
    const rows = await this.prisma.agent.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((a: any) => this.shapeAgent(a));
  }

  async getAgent(id: string) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    return this.shapeAgent(a);
  }

  async updateAgent(id: string, patch: { name?: string; prompt?: string; rubric?: string; evals?: unknown[]; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean; defaultDepth?: string; category?: string; color?: string; skills?: unknown[] }) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    const data: any = {};
    if (patch.category !== undefined) data.category = patch.category?.trim() || null;
    if (patch.color !== undefined) data.color = patch.color?.trim() || null;
    if (patch.skills !== undefined) data.skills = JSON.stringify(Array.isArray(patch.skills) ? patch.skills.slice(0, 10) : []); // attached skills (BEA-1079)
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
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.defaultDepth !== undefined) data.defaultDepth = this.normDepth(patch.defaultDepth);
    const updated = await this.prisma.agent.update({ where: { id }, data });
    return this.shapeAgent(updated);
  }

  async deleteAgent(id: string) {
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
    return { ...a, skills: this.parse(a.skills, [] as unknown), schedule: a.schedule ? this.parse(a.schedule, null) : null, evals: this.parse(a.evals, [] as unknown) };
  }

  /** Append a step to the run's plain-English step log (mirror of Hermes events). */
  async appendStep(runId: string, step: { label: string; status?: string; detail?: string; kind?: string }) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');
    const log = this.parse(run.stepLog, [] as any[]);
    log.push({ ...step, at: new Date().toISOString() });
    const updated = await this.prisma.agentRun.update({ where: { id: runId }, data: { stepLog: JSON.stringify(log) } });
    return this.shapeRun(updated);
  }

  async finishRun(id: string, patch: { status?: 'done' | 'failed' | 'cancelled'; outputDocId?: string; error?: string; resultText?: string; grade?: string } = {}) {
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
        resultText: patch.resultText ?? run.resultText,
        grade: patch.grade ?? run.grade,
        error: patch.error ?? null,
        endedAt: new Date(),
      },
    });
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

  /** Cancel a run and any of its still-pending questions. */
  async cancelRun(id: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Run not found');
    await this.prisma.waitpoint.updateMany({ where: { runId: id, status: 'pending' }, data: { status: 'cancelled' } });
    const updated = await this.prisma.agentRun.update({ where: { id }, data: { status: 'cancelled', endedAt: new Date() } });
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
