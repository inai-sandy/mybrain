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
    // Fail those orphans on boot so they never spin silently again (BEA-629).
    this.reconcileOrphans().catch(() => undefined);
    // Per-minute sweeper that applies timeouts to overdue questions. Guarded so a bad tick
    // can never crash the app (matches the gmail-brief.service.ts pattern).
    this.sweepTimer = setInterval(() => {
      this.sweepExpired().catch(() => undefined);
    }, 60_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /**
   * Fail runs left mid-flight by a restart (BEA-629). A 'running' row has no live driver after a
   * process restart, so it can never finish on its own — mark it failed with a clear message and a
   * logged step. Idempotent: terminal runs (done/failed/cancelled) and paused ones are untouched.
   */
  async reconcileOrphans(): Promise<number> {
    const orphans = await this.prisma.agentRun.findMany({ where: { status: 'running' }, select: { id: true, stepLog: true } });
    if (!orphans.length) return 0;
    const msg = 'Interrupted by an engine restart — please run it again.';
    const now = new Date();
    for (const o of orphans) {
      const log = this.parse(o.stepLog, [] as any[]);
      log.push({ label: 'Interrupted by a restart', status: 'failed', detail: msg, at: now.toISOString() });
      await this.prisma.agentRun
        .update({ where: { id: o.id }, data: { status: 'failed', error: msg, endedAt: now, stepLog: JSON.stringify(log) } })
        .catch(() => undefined);
    }
    return orphans.length;
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ---------- runs ----------

  async createRun(input: { agentId?: string | null; title?: string; input?: string } = {}) {
    const run = await this.prisma.agentRun.create({
      data: {
        agentId: input.agentId ?? null,
        title: input.title ?? null,
        input: input.input ?? null,
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
    const [model, autonomy, askTimeoutMin, recall, learn, outputCollectionId] = await Promise.all([
      this.getSetting('agent.model'),
      this.getSetting('agent.autonomy'),
      this.getSetting('agent.askTimeoutMin'),
      this.getSetting('agent.recall'),
      this.getSetting('agent.learn'),
      this.getSetting('agent.outputCollectionId'),
    ]);
    return {
      model: model || '', // '' = use the engine's default model
      autonomy: autonomy || 'cautious', // cautious | balanced | autopilot
      askTimeoutMin: askTimeoutMin ? Math.max(1, Number(askTimeoutMin) || 20) : 20,
      recall: recall == null ? true : recall === 'true',
      learn: learn == null ? true : learn === 'true',
      outputCollectionId: outputCollectionId || null,
    };
  }

  async setEngineSettings(patch: Record<string, unknown>) {
    const map: Record<string, string> = {
      model: 'agent.model',
      autonomy: 'agent.autonomy',
      askTimeoutMin: 'agent.askTimeoutMin',
      recall: 'agent.recall',
      learn: 'agent.learn',
      outputCollectionId: 'agent.outputCollectionId',
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

  async createAgent(input: { name: string; prompt?: string; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean }) {
    if (!input?.name?.trim()) throw new BadRequestException('An agent needs a name');
    const a = await this.prisma.agent.create({
      data: {
        name: input.name.trim().slice(0, 120),
        prompt: input.prompt?.trim() || null,
        icon: input.icon || null,
        description: input.description || null,
        autonomy: input.autonomy || 'cautious',
        schedule: input.schedule ? JSON.stringify(input.schedule) : null,
        scheduleText: input.scheduleText || null,
        collectionId: input.collectionId ?? null,
        enabled: input.enabled ?? true,
      },
    });
    return this.shapeAgent(a);
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

  async updateAgent(id: string, patch: { name?: string; prompt?: string; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean }) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120);
    if (patch.prompt !== undefined) data.prompt = patch.prompt?.trim() || null;
    if (patch.icon !== undefined) data.icon = patch.icon || null;
    if (patch.description !== undefined) data.description = patch.description || null;
    if (patch.autonomy !== undefined) data.autonomy = patch.autonomy;
    if (patch.schedule !== undefined) { data.schedule = patch.schedule ? JSON.stringify(patch.schedule) : null; data.lastFiredKey = null; }
    if (patch.scheduleText !== undefined) data.scheduleText = patch.scheduleText || null;
    if (patch.collectionId !== undefined) data.collectionId = patch.collectionId ?? null;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
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

  private shapeAgent(a: any) {
    return { ...a, skills: this.parse(a.skills, [] as unknown), schedule: a.schedule ? this.parse(a.schedule, null) : null };
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

  async finishRun(id: string, patch: { status?: 'done' | 'failed' | 'cancelled'; outputDocId?: string; error?: string; resultText?: string } = {}) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Run not found');
    const updated = await this.prisma.agentRun.update({
      where: { id },
      data: {
        status: patch.status ?? 'done',
        outputDocId: patch.outputDocId ?? run.outputDocId,
        resultText: patch.resultText ?? run.resultText,
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
    // Hand the run back to the engine (the bridge / MCP resumes the Hermes session from here).
    const run = await this.prisma.agentRun.update({ where: { id: wp.runId }, data: { status: 'running' } });
    const fresh = await this.prisma.waitpoint.findUnique({ where: { id: wp.id } });
    return { applied: true, alreadyResolved: false, status: 'answered', waitpoint: this.shapeWaitpoint(fresh), run: this.shapeRun(run) };
  }

  /** Apply timeouts to overdue questions: use the smart default if there is one, else park the run. */
  async sweepExpired(now: Date = new Date()) {
    const due = await this.prisma.waitpoint.findMany({ where: { status: 'pending', expiresAt: { not: null, lte: now } } });
    let handled = 0;
    for (const wp of due) {
      if (wp.defaultValue != null) {
        const r = await this.resolve(wp, wp.defaultValue, 'timeout');
        if (r.applied) handled++;
      } else {
        const res = await this.prisma.waitpoint.updateMany({ where: { id: wp.id, status: 'pending' }, data: { status: 'expired', answeredAt: new Date() } });
        if (res.count > 0) {
          handled++;
          await this.prisma.agentRun.update({ where: { id: wp.runId }, data: { status: 'failed', error: 'No answer in time, so this run was parked.', endedAt: new Date() } });
        }
      }
    }
    return handled;
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
