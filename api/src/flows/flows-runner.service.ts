import { Injectable, Logger, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';
import { AgentService } from '../agent/agent.service';
import { JobBusyError, RunLockService } from '../agent/run-lock.service';
import { LlmService } from '../llm/llm.service';
import { DocumentsService } from '../documents/documents.service';
import { MemoryService } from '../memory/memory.service';
import { PushService } from '../push/push.service';
import { AlertsService } from '../push/alerts.service';
import { OwnerAlertResult, ownerFirstName, sendOwnerAlert } from '../contacts/owner-alert';
import { SkillsService } from '../skills/skills.service';
import { TelegramService } from '../telegram/telegram.service';
import { FlowsService } from './flows.service';
import { WebResearchService } from '../tools/web-research.service';
import { DeepResearchService, ResearchSpend } from '../tools/deep-research.service';
import { ItemsService } from '../items/items.service';
import { TasksService } from '../tasks/tasks.service';
import { PostboxService } from '../contacts/postbox.service';
import { TokenBudgetService, TokenBudgetError, ENGINE_TURN_TOKENS } from '../llm/token-budget.service';
import { NewsPipelineService } from '../news/news-pipeline.service';
import { isServiceToolId, parseServiceToolId } from '../tools/service-provider';
import { ServiceActionsService } from '../tools/service-actions.service';
import { GatePause, PendingGate } from '../tools/service-gates.service';
import { randomBytes } from 'crypto';
import { Grade, GRADE_MAX_TOKENS, GradeResult, parseGrade } from '../hermes/grade';

type NodeResult = {
  status: 'running' | 'done' | 'failed' | 'skipped' | 'waiting';
  output: string;
  kind?: string;
  label?: string;
  condFalse?: boolean;
  cascaded?: boolean;
  /**
   * Set only on a step paused by a gate (BEA-1348): what it was about to do, and the exact
   * arguments the owner is being shown. Persisted with the run, so the pending gate is still there
   * — and still answerable — after a restart.
   */
  gate?: PendingGate;
  /** The owner said no to this step's gate. It is settled, and the resumed walk must not re-ask. */
  gateRejected?: boolean;
};

/** Thrown to abort the graph walk when a flow pauses on an "Ask me" block (Move B). */
class PauseSignal { constructor(public nodeId: string) {} }

/**
 * How much of a run's starting material is kept (BEA-1350). A service event's payload is a whole API
 * object and can be enormous; this is plenty to work from and small enough that the run row, which is
 * read on every poll of the live view, does not become the payload.
 */
const RUN_INPUT_CHARS = 8000;

/**
 * FlowRunner (BEA-646) — runs a saved Flow's graph. Memoised async walk so independent branches run
 * in parallel; skill/tool/ask_ai nodes run through the agent engine; merge synthesises (AI or raw).
 */
@Injectable()
export class FlowRunnerService implements OnModuleInit {
  private readonly log = new Logger('FlowRunner');
  /** Runs cancelled in this process — checked before a live driver writes back, so a cancel sticks. */
  private cancelled = new Set<string>();
  /**
   * BEA-792: per-run driver generation + the live walk's in-flight node promises. When one branch
   * pauses on a question, sibling branches keep running; answering starts a NEW driver. The old
   * driver's writes must then become no-ops (generation guard), and the new driver ADOPTS the
   * still-in-flight sibling promises instead of re-running them (no duplicate engine cost/docs).
   */
  private gens = new Map<string, number>();
  private liveMemo = new Map<string, Map<string, Promise<string>>>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: HermesBridgeService,
    private readonly agent: AgentService,
    private readonly llm: LlmService,
    private readonly documents: DocumentsService,
    private readonly memory: MemoryService,
    private readonly skills: SkillsService,
    private readonly telegram: TelegramService,
    private readonly flows: FlowsService,
    // Optional so older test harnesses that build with 9 args keep working (BEA-1088).
    private readonly push?: PushService,
    private readonly alerts?: AlertsService,
    private readonly web?: WebResearchService, // real Tavily/Exa research (BEA-1194)
    private readonly deep?: DeepResearchService, // our own research loop (BEA-1196)
    // Tier-1 tools: work we simply do, no model at all (BEA-1203).
    private readonly items?: ItemsService,
    private readonly tasks?: TasksService,
    private readonly postbox?: PostboxService,
    private readonly budget?: TokenBudgetService, // the token ceiling (BEA-1204)
    // LAST, and optional: many spec harnesses build this service positionally with fewer args.
    private readonly news?: NewsPipelineService, // AI News Daily's own steps (BEA-1259)
    private readonly serviceActions?: ServiceActionsService, // outside services, run directly (BEA-1347)
    private readonly locks?: RunLockService, // one run at a time per job (BEA-1388)
  ) {}

  private partSweepTimer: ReturnType<typeof setInterval> | null = null;

  onModuleInit() {
    // Working-part retention (BEA-1085): branch part-documents auto-clean after N days (default 30).
    // Pure deletion by id, finals untouched, user-edited docs never candidates. Zero AI cost.
    this.partSweepTimer = setInterval(() => void this.sweepFlowParts().catch(() => undefined), 6 * 3600_000);
    if (typeof this.partSweepTimer.unref === 'function') this.partSweepTimer.unref();
    setTimeout(() => void this.sweepFlowParts().catch(() => undefined), 90_000); // one pass shortly after boot
    // A flow run's driver (the execute() walk) lives in this process's memory. A restart
    // (deploy/crash/reboot — we docker rm -f on every ship) leaves 'running' rows with nothing to
    // advance them, and start()'s no-stacking guard then hands that dead run back on every future
    // Run click and schedule — the flow can never run again. Fail those orphans on boot. (BEA-776)
    // Retried (BEA-859): the DB can be briefly locked in the post-deploy stampede; a swallowed
    // failure would leave those runs stuck 'running' — and blocking their flow — forever.
    void this.reconcileWithRetry();
  }

  /** Boot reconcile with retries (BEA-859): up to 5 attempts, 5s apart. */
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
   * Fail flow runs left mid-flight by a restart (BEA-776). Only 'running' rows are orphaned: a
   * 'waiting' run is durable — answer() re-drives it from the persisted per-node results, so it
   * survives a restart and must be left alone. Idempotent; terminal runs are untouched.
   */
  async reconcileOrphans(): Promise<number> {
    const orphans = await this.prisma.flowRun.findMany({ where: { status: 'running' }, select: { id: true, terminal: true } });
    if (!orphans.length) return 0;
    const now = new Date();
    const msg = 'Interrupted by a restart — please run it again.';
    for (const o of orphans) {
      const term = this.parseArr(o.terminal);
      term.push({ text: '✗ interrupted by a restart', at: now.getTime() });
      await this.prisma.flowRun
        .update({ where: { id: o.id }, data: { status: 'failed', error: msg, endedAt: now, terminal: JSON.stringify(term.slice(-300)), waitNodeId: null, waitQuestion: null, waitToken: null } })
        .catch(() => undefined);
      // The restart that orphaned this run also left its job lock behind (BEA-1388) — free it now
      // rather than making the job wait out the timeout.
      await this.locks?.releaseForRun(o.id).catch(() => undefined);
    }
    this.log.warn(`reconciled ${orphans.length} orphaned flow run(s) on boot`);
    return orphans.length;
  }

  /** Cancel a run that's still running or waiting, freeing the flow to run again. (BEA-776) */
  async cancelRun(id: string): Promise<{ ok: boolean }> {
    const r = await this.prisma.flowRun.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Run not found');
    if (r.status !== 'running' && r.status !== 'waiting') return { ok: false };
    this.cancelled.add(id); // so a still-live driver won't write this run back to done/failed
    const term = this.parseArr(r.terminal);
    term.push({ text: '⊘ cancelled', at: Date.now() });
    await this.prisma.flowRun.update({ where: { id }, data: { status: 'cancelled', endedAt: new Date(), terminal: JSON.stringify(term.slice(-300)), waitNodeId: null, waitQuestion: null, waitToken: null } });
    await this.freeJob(id); // cancelled is terminal — the job runs again at once (BEA-1388)
    return { ok: true };
  }

  /**
   * Evals ① (BEA-670): run an agent's eval cases through its flow approach. For each case we re-plan
   * the flow for that input (so the steps actually fit the input), run it, and grade the output
   * against the agent's Outcome. Background + persists per case (keeps BEA-658 live-progress/retry).
   */
  async runAgentEvals(agentId: string): Promise<{ ok: boolean; started?: number; message?: string }> {
    const agent: any = await this.agent.getAgent(agentId).catch(() => null);
    const evals: any[] = Array.isArray(agent?.evals) ? agent.evals : [];
    if (!agent || !evals.length) return { ok: false, message: 'no evals' };
    const flow = (await this.prisma.flow.findMany({ where: { agentId }, orderBy: { updatedAt: 'desc' }, take: 1 }))[0];
    if (!flow) return { ok: false, message: 'no flow' }; // caller falls back to prompt-based evals
    void this.runAgentEvalsBg(agentId, agent, evals, flow.id).catch((e) => this.log.error(`flow evals ${agentId} crashed: ${e?.message || e}`));
    return { ok: true, started: evals.length };
  }

  private async runAgentEvalsBg(agentId: string, agent: any, evals: any[], flowId: string) {
    for (const c of evals) c.running = false;
    await this.agent.setEvals(agentId, evals).catch(() => undefined);
    for (const c of evals) {
      if (!c?.input) continue;
      c.running = true;
      await this.agent.setEvals(agentId, evals).catch(() => undefined);
      let res = await this.runForEval(flowId, c.input).catch(() => ({ runId: '', finalOutput: '', status: 'failed' }));
      if (res.status !== 'done') res = await this.runForEval(flowId, c.input).catch(() => ({ runId: '', finalOutput: '', status: 'failed' })); // retry once
      const gr = agent.rubric && res.finalOutput ? await this.gradeOutput(agent.rubric, res.finalOutput) : null;
      let grade: Grade | null = null;
      let gradeErr: string | null = null;
      if (gr) { if (gr.ok) grade = gr.grade; else gradeErr = gr.reason; }
      c.running = false;
      c.lastRunId = res.runId || c.lastRunId;
      c.lastRunKind = 'flow';
      // "Couldn't grade it" is its own state, never a real 'partial' — a failure must not be counted
      // in the passed pill as though it had been judged (BEA-1247).
      c.lastVerdict = grade?.verdict || (res.status !== 'done' ? 'fail' : gradeErr ? 'ungraded' : 'partial');
      c.lastScore = grade?.score ?? null;
      c.lastCriteria = Array.isArray(grade?.criteria) ? grade.criteria : null;
      // Why a check has no verdict, kept on the case itself (BEA-1247) — a blank row used to be the
      // only sign that grading had failed, and it looked identical to "not run yet".
      c.lastNotes = grade?.notes || (gradeErr ? `Couldn't check this — ${gradeErr}` : null);
      c.lastGradeError = gradeErr;
      c.lastRunAt = new Date().toISOString();
      await this.agent.setEvals(agentId, evals).catch(() => undefined);
    }
  }

  /** Run the agent's flow approach for one input (re-planned for that input), synchronously. */
  private async runForEval(realFlowId: string, input: string): Promise<{ runId: string; finalOutput: string; status: string }> {
    const fresh = await this.flows.planFlow(input).catch(() => ({ nodes: [], edges: [] }));
    // Eval runs are detached from the flow (flowId: null) so they can't collide with the no-stacking
    // guard (a user's Run would otherwise get handed an eval run of a different input), don't pollute
    // the flow's run history, and can't lock the flow if one crashes mid-eval. Still viewable by id. (BEA-797)
    const run = await this.prisma.flowRun.create({ data: { flowId: null, status: 'running', results: '{}' } });
    const synthetic = { id: realFlowId, name: 'Eval run', graph: JSON.stringify(fresh) };
    try { await this.execute(run.id, synthetic, { evalMode: true }); }
    catch (e: any) { await this.prisma.flowRun.update({ where: { id: run.id }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined); }
    const after = await this.prisma.flowRun.findUnique({ where: { id: run.id } });
    return { runId: run.id, finalOutput: after?.finalOutput || '', status: after?.status || 'failed' };
  }

  /** Grade a result against the Outcome (same rubric, same reader and same cap as agent runs). */
  private async gradeOutput(rubric: string, result: string): Promise<GradeResult> {
    let out: string | null = null;
    try {
      const gradePrompt = `You grade an AI agent's result against the user's definition of done ("the Outcome"). Be strict but fair.\n\nThe Outcome:\n${rubric.slice(0, 1500)}\n\nThe agent's result:\n${result.slice(0, 3000)}\n\nReply with ONLY JSON, no prose:\n{"verdict":"pass|partial|fail","score":<0-100 integer>,"criteria":[{"text":"<short criterion>","met":true|false}],"notes":"<one short sentence>"}`;
      out = (this.llm as any).completeHelper
        ? await (this.llm as any).completeHelper('flow-eval-grade', gradePrompt, GRADE_MAX_TOKENS, 'flow-eval-grade')
        : await this.llm.complete(gradePrompt, GRADE_MAX_TOKENS, 'flow-eval-grade');
    } catch (e: any) {
      return { ok: false, reason: `the grader could not be reached — ${String(e?.message || e).slice(0, 120)}` };
    }
    return parseGrade(out);
  }

  /** Resolve a skill's on-disk folder name from its id (for running the real skill in Codex). */
  private async skillSlug(refId?: string): Promise<string | null> {
    if (!refId) return null;
    try {
      const s: any = await this.skills.get(refId);
      if (!s) return null;
      const dep = typeof s.deployments === 'string' ? JSON.parse(s.deployments || '{}') : (s.deployments || {});
      return dep.sandy || s.slug || dep.hermes || dep.beakn || null;
    } catch { return null; }
  }

  // The single Codex engine chokes on concurrent heavy turns (they stall + time out), so agent-node
  // runs are serialised through this chain — branches still merge, they just take the engine in turn (BEA-646).
  private engineChain: Promise<unknown> = Promise.resolve();
  /** How many engine turns are queued or running right now — a branch uses this to say it is waiting. */
  private engineQueued = 0;

  private runOnEngine<T>(fn: () => Promise<T>): Promise<T> {
    this.engineQueued++;
    const out = this.engineChain.then(fn, fn);
    this.engineChain = out.then(() => undefined, () => undefined);
    void out.then(() => { this.engineQueued--; }, () => { this.engineQueued--; });
    return out;
  }

  /**
   * Mirror a branch's real work into the FLOW's play-by-play while it happens (BEA-1192).
   *
   * A branch turn does dozens of searches over several minutes, but none of it reached the flow —
   * the flow logged "started" and then nothing until the whole thing finished. A five-minute job
   * showing a spinner and silence is indistinguishable from a broken one, which is exactly how a
   * healthy run came to be reported as stuck.
   */
  private mirrorSteps(runId: string, onLine?: (t: string) => void): () => void {
    if (!onLine) return () => undefined;
    let seen = 0;
    const timer = setInterval(async () => {
      const r: any = await this.prisma.agentRun.findUnique({ where: { id: runId }, select: { stepLog: true } }).catch(() => null);
      const steps = this.parseArr(r?.stepLog);
      for (const s of steps.slice(seen)) {
        const label = String(s?.label || '').trim();
        if (label) onLine(`   ${label.slice(0, 90)}`);
      }
      seen = steps.length;
    }, 4000);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    return () => clearInterval(timer);
  }

  private parse(s?: string | null): any { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
  private parseArr(s?: string | null): any[] { try { const a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
  private shape(r: any) {
    const results = this.parse(r.results);
    return {
      ...r,
      results,
      documents: this.parseArr(r.documentIds),
      waitOptions: this.parseArr(r.waitOptions),
      terminal: this.parseArr(r.terminal),
      // Is the open question a GATE (BEA-1348) or a plain "Ask me"? Answered from the step's own
      // stored gate, never by reading the question's words — the page shows a different heading for
      // each, and a wording change must not be able to silently turn one into the other.
      waitIsGate: !!(r.waitNodeId && results?.[r.waitNodeId]?.gate),
    };
  }

  /** A clean play-by-play line for the terminal, per node kind (workspace ②). */
  private termLine(node: any, output: string): string | null {
    const kind = node.data?.kind;
    const label = node.data?.label || '';
    const ref = node.data?.refId;
    if (kind === 'tool') {
      if (ref === 'search_brain') return '🧠 searched your brain';
      if (ref === 'web_search') return '🌐 searched the web';
      if (ref === 'web_read') return '📄 read the page(s)';
      if (ref === 'deep_research') return '🔬 researched it in depth';
      if (ref === 'gmail') return '📧 checked Gmail';
      if (ref === 'calendar') return '📅 checked the calendar';
      if (ref === 'drive') return '🗂 looked in Drive';
      if (ref === 'save_document') return '💾 saved a document';
      if (ref === 'telegram') return '✈️ sent on Telegram';
      if (ref === 'http') return '🔌 called an API';
      return `🛠 used ${label}`;
    }
    if (kind === 'skill') return `🛠 ran the "${label}" skill`;
    if (kind === 'ask_ai') return `💬 wrote the answer (${(output || '').length} chars)`;
    if (kind === 'merge') return '✦ combined the parts';
    if (kind === 'ask_user') return '⏸ asked you a question';
    return null;
  }

  /** Recent runs of a flow, with the documents each produced (Agent↔Flow merge ④). */
  async listRuns(flowId: string) {
    const rows = await this.prisma.flowRun.findMany({ where: { flowId }, orderBy: { startedAt: 'desc' }, take: 50 });
    // spend rides along so the Runs list can show what a report actually cost (BEA-1196) — the owner
    // asked for this because he would not take a per-report price on trust.
    return rows.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, finalOutput: r.finalOutput?.slice(0, 240) || null, documents: this.parseArr(r.documentIds), spend: (r as any).spend ? this.parse((r as any).spend) : null }));
  }

  /** Turn off the given branch indexes (b{idx}_*) for ONE run only, without touching the saved flow. (BEA-796) */
  private applySkip(flow: any, skipBranches?: number[]): any {
    if (!skipBranches?.length) return flow;
    const skip = new Set(skipBranches.map(Number));
    const graph = this.parse(flow.graph);
    const nodes = (graph.nodes || []).map((n: any) => {
      const m = /^b(\d+)_/.exec(n.id);
      return m && skip.has(Number(m[1])) ? { ...n, data: { ...n.data, enabled: false } } : n;
    });
    return { ...flow, graph: JSON.stringify({ ...graph, nodes }) };
  }

  /** Replay (BEA-1070): run the same flow again, straight from a past run's row. */
  async replay(runId: string): Promise<{ runId: string; ok?: boolean; message?: string }> {
    const old = await this.prisma.flowRun.findUnique({ where: { id: runId } });
    if (!old) throw new NotFoundException('Run not found');
    if (!old.flowId) return { runId: '', ok: false, message: 'That run has no saved flow to replay (it was a one-off eval).' };
    return this.start(old.flowId); // the no-stacking guard hands back a live run if one exists
  }

  /**
   * `input` is material from outside the flow — today, the payload of a service event that woke it
   * (BEA-1350). It is written on the run row rather than held in memory so it survives a restart and
   * a durable pause, and the walk hands it to every step that has nothing upstream.
   */
  async start(flowId: string, opts: { skipBranches?: number[]; input?: string } = {}): Promise<{ runId: string; joined?: boolean }> {
    const flow = await this.prisma.flow.findUnique({ where: { id: flowId } });
    if (!flow) throw new NotFoundException('Flow not found');
    // No stacking: if this flow already has a live run, return it instead of starting another. (BEA-772)
    const active = await this.prisma.flowRun.findFirst({ where: { flowId, status: { in: ['running', 'waiting'] } }, orderBy: { startedAt: 'desc' } });
    // `joined` is said out loud for the caller (a trigger has nobody watching, so "it ran" and "one
    // was already going" must not look the same in its history).
    if (active) return { runId: active.id, joined: true };
    // A flow that belongs to a job IS a run of that job, so it takes the same lock the Run button and
    // the scheduler take (BEA-1388) — the Flow tab's Run and the job's own Run are two doors on one
    // job, and without this they could both be open at once. Claimed BEFORE the run row exists, so a
    // refused start leaves no half-run in the history; a standalone flow (no `agentId`) is not a job
    // and is never locked.
    const claim = flow.agentId ? await this.locks?.claim(flow.agentId, { reason: 'a flow run' }) : null;
    if (claim && !claim.ok) throw new JobBusyError(claim.held, `"${flow.name || 'This job'}"`);
    const holder = claim?.ok ? claim.holder : null;
    let run: any;
    try {
      run = await this.prisma.flowRun.create({ data: { flowId, status: 'running', results: '{}', input: opts.input ? String(opts.input).slice(0, RUN_INPUT_CHARS) : null } });
    } catch (e) {
      if (holder) await this.locks?.release(holder).catch(() => undefined);
      throw e;
    }
    if (holder) await this.locks?.attachRun(holder, run.id).catch(() => undefined);
    const flowForRun = this.applySkip(flow, opts.skipBranches); // per-run selection; saved flow untouched (BEA-796)
    void this.execute(run.id, flowForRun).catch(async (e) => {
      this.log.error(`flow run ${run.id} crashed: ${e?.message || e}`);
      await this.prisma.flowRun.update({ where: { id: run.id }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined);
      this.telegram.notifyFlowDone({ flowName: flow?.name, status: 'failed' }).catch(() => undefined);
    }).finally(() => this.freeJob(run.id));
    return { runId: run.id };
  }

  async getRun(id: string) {
    const r = await this.prisma.flowRun.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Run not found');
    return this.shape(r);
  }

  /** Delete one flow run. Refuses while it's still running/waiting. Saved Documents are kept. */
  async deleteRun(id: string) {
    const r = await this.prisma.flowRun.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Run not found');
    if (r.status === 'running' || r.status === 'waiting') throw new BadRequestException('This run is still in progress.');
    await this.prisma.flowRun.delete({ where: { id } });
    return { ok: true };
  }

  /** Clear finished runs for a flow (in-flight ones are kept). */
  async clearRuns(flowId: string) {
    const res = await this.prisma.flowRun.deleteMany({ where: { flowId, status: { notIn: ['running', 'waiting'] } } });
    return { ok: true, deleted: res.count };
  }

  private async execute(runId: string, flow: any, opts: { evalMode?: boolean } = {}) {
    // Claim the driver generation for this run (BEA-792). If a later driver claims it (an answer
    // re-drive), THIS driver's writes go dead — stale branches can never clobber the new state.
    const gen = (this.gens.get(runId) || 0) + 1;
    this.gens.set(runId, gen);
    const stale = () => this.gens.get(runId) !== gen;

    // The toolbox this flow's job may use (BEA-1168). null = nobody has picked yet, so nothing is
    // blocked. This is the HARD half of the toolbox: a step whose tool is not on the list does not
    // run, whatever ended up on the canvas.
    const allowed = await this.allowedFor(flow);

    const graph = this.parse(flow.graph);
    const nodes = new Map<string, any>((graph.nodes || []).map((n: any) => [n.id, n]));
    const incoming = new Map<string, string[]>();
    for (const n of graph.nodes || []) incoming.set(n.id, []);
    for (const e of graph.edges || []) if (incoming.has(e.target)) incoming.get(e.target)!.push(e.source);
    // "on failure" edges (BEA-1071) — marked on the canvas; keyed "src->tgt".
    const errEdge = new Set<string>();
    for (const e of graph.edges || []) if (e?.data?.onError) errEdge.add(`${e.source}->${e.target}`);

    // Resume-safe (Move B): start from whatever finished before a pause/restart so we don't re-run it.
    const runRow = await this.prisma.flowRun.findUnique({ where: { id: runId } });
    // What this run was handed from outside — a service event's payload (BEA-1350). Read off the row
    // on every drive, so a run that paused and resumed days later still knows what woke it.
    const runInput = String((runRow as any)?.input || '');
    const results: Record<string, NodeResult> = this.parse(runRow?.results) || {};
    const terminal: { text: string; at: number }[] = this.parseArr(runRow?.terminal);
    const memo = new Map<string, Promise<string>>();
    // Seed both 'done' and 'skipped' so a resumed run doesn't re-run branches that were skipped
    // (a per-run selection isn't re-applied on resume, which reloads the saved flow). (BEA-796)
    // A step the owner refused at its gate is settled too (BEA-1348) — it stays FAILED (so the rest
    // of the run knows that part did not happen) but it must never be re-run, or answering "no"
    // would immediately ask the same question again.
    for (const [nid, rr] of Object.entries(results)) { const r = rr as NodeResult; if (r?.status === 'done' || r?.status === 'skipped' || r?.gateRejected) memo.set(nid, Promise.resolve(r.output || '')); }
    const persist = () => stale() || this.cancelled.has(runId) ? Promise.resolve(undefined) : this.prisma.flowRun.update({ where: { id: runId }, data: { results: JSON.stringify(results), terminal: JSON.stringify(terminal.slice(-300)) } }).catch(() => undefined);
    const term = (text: string) => { terminal.push({ text, at: Date.now() }); };

    // BEA-1253: say it in the run log too. A run on a bare fallback produces a thin answer for a
    // reason, and the owner should be able to see that reason afterwards rather than wondering
    // whether the flow or the question was at fault.
    if (nodes.get('question')?.data?.planFailed) {
      term(`⚠ ${FlowsService.PLAN_FAILED_NOTE}`);
      this.log.warn(`run ${runId} is on a flow whose planning failed — one generic step, no real plan`);
    }
    // What this run spent on search, totalled across every deep research step (BEA-1196). Recorded so
    // the owner reads the real cost of a report off the run instead of trusting an estimate.
    const spend: ResearchSpend = { searches: 0, extracts: 0, sources: 0, meaningSearches: 0, braveSearches: 0, paidCalls: 0 };
    const addSpend = (s: ResearchSpend) => {
      spend.searches += s?.searches || 0;
      spend.extracts += s?.extracts || 0;
      spend.sources += s?.sources || 0;
      spend.meaningSearches += s?.meaningSearches || 0;
      spend.braveSearches += s?.braveSearches || 0;
      spend.paidCalls += s?.paidCalls || 0;
    };
    const spendJson = () => (spend.searches || spend.extracts || runTokens ? { spend: JSON.stringify({ ...spend, tokens: runTokens }) } : {});
    // Tokens this run has used. An engine turn reports nothing until it ends, so it is charged the
    // measured average; everything else is charged what the step's own text implies.
    // Carried across a pause (BEA-1204). A run that spent 140k before an "Ask me" would otherwise
    // resume at zero and get a whole fresh allowance — and durable HITL is the normal case here.
    let runTokens = Number(this.parse(runRow?.spend as any)?.tokens) || 0;
    let stoppedOnBudget = '';
    const chargeRun = (n: number) => { runTokens += Math.max(0, n); };
    if (!opts.evalMode && !terminal.length) term('▶ started');

    // Adopt the paused driver's still-in-flight sibling work (BEA-792): a node the old walk left
    // 'running' has a live engine call behind it — await THAT promise instead of starting a second
    // one. Nodes that never really started (blocked behind the question) aren't 'running' and run
    // fresh. After a restart there is no old memo and 'running' nodes simply re-run.
    const prior = this.liveMemo.get(runId);
    if (prior && !opts.evalMode) {
      for (const [nid, p] of prior) {
        if (memo.has(nid)) continue;
        if ((results[nid] as NodeResult)?.status !== 'running') continue;
        const node = nodes.get(nid);
        memo.set(nid, p.then((out) => {
          results[nid] = { status: 'done', output: out, kind: node?.data?.kind, label: node?.data?.label };
          const line = this.termLine(node, out);
          if (line) term(line);
          void persist();
          return out;
        }).catch((e: any) => {
          results[nid] = { status: 'failed', output: String(e?.message || e), kind: node?.data?.kind, label: node?.data?.label };
          void persist();
          return '';
        }));
      }
    }
    this.liveMemo.set(runId, memo);

    /**
     * The nearest thing this branch DID produce (BEA-1235).
     *
     * A branch is normally research → summarise → merge. When the summarise step dies, the research
     * behind it is still sitting in `results`, already gathered and already paid for. One real run
     * lost 31,204 characters that way — two branches whose research succeeded and whose one-line
     * summary step failed, dropped without a word. Walking back one hop recovers them.
     */
    const rescueFrom = (id: string, seen = new Set<string>()): string => {
      for (const up of incoming.get(id) || []) {
        if (seen.has(up)) continue;
        seen.add(up);
        const r = results[up] as NodeResult;
        if (r?.status === 'done' && (r.output || '').trim()) return r.output;
        const deeper = rescueFrom(up, seen);
        if (deeper) return deeper;
      }
      return '';
    };

    const outputOf = (nodeId: string): Promise<string> => {
      if (memo.has(nodeId)) return memo.get(nodeId)!;
      const p = (async (): Promise<string> => {
        const node = nodes.get(nodeId);
        if (!node) return '';
        const kind = node.data?.kind;
        const label = node.data?.label;
        if (node.data?.enabled === false) { results[nodeId] = { status: 'skipped', output: '', kind, label }; await persist(); return ''; }
        const ups = incoming.get(nodeId) || [];
        // Error branches (BEA-1071): an "on failure" edge delivers ONLY when its source failed — and
        // then it carries the error text, so the fallback path knows what went wrong. Normal edges
        // deliver only on success (unchanged).
        const upOuts = await Promise.all(ups.map(async (s) => {
          const out = await outputOf(s);
          const rs = results[s] as NodeResult;
          const failedUp = rs?.status === 'failed';
          const marked = errEdge.has(`${s}->${nodeId}`);
          // An If steers its edges (BEA-1073): plain edges are the TRUE path, ⚠-marked edges are
          // the FALSE/else path (carrying the input through so the other branch can use it).
          if (rs?.kind === 'if' && rs.condFalse !== undefined) {
            if (marked) return rs.condFalse ? (rs.output || 'the condition was not met') : '';
            return rs.condFalse ? '' : out;
          }
          if (marked) return failedUp ? `The previous step failed: ${rs?.output || 'unknown error'}` : '';
          // A merge must never be handed SILENCE for a dead branch (BEA-1235). `''` is
          // indistinguishable from "this branch found nothing", so the merge synthesised
          // confidently from a third of the work and said nothing about the rest. Give it either
          // the branch's own research or an explicit note that the branch is missing.
          if (failedUp && kind === 'merge') {
            const why = (rs?.output || 'unknown error').slice(0, 200);
            const name = rs?.label || s;
            const rescued = rescueFrom(s);
            return rescued
              ? `--- ${name}: its summary step failed (${why}). What follows is this part's RAW RESEARCH, unsummarised. ---\n\n${rescued}`
              : `--- ${name}: MISSING. This part of the research failed (${why}) and produced nothing. ---`;
          }
          return failedUp ? '' : out;
        }));
        /**
         * A step whose input NEVER ARRIVED cannot have succeeded (BEA-1235).
         *
         * Found by a test: when a branch's research died, its Ask AI step was handed '' and returned
         * '' — and was recorded as DONE with an empty answer. So the branch failed twice over and
         * reported success both times, and the merge dropped the empty string without a word. Same
         * silence as the bug this issue is about, reached by a different route.
         */
        const steered = (sid: string) => {
          if (errEdge.has(`${sid}->${nodeId}`)) return true;
          // Only a RESOLVED If steers its edges. A crashed If still carries kind:'if' on its failed
          // result with condFalse undefined — treating that as steering let a node run on empty
          // input and report done, which is the very silence this check exists to end.
          const r = results[sid] as NodeResult;
          return r?.kind === 'if' && r.condFalse !== undefined;
        };
        const realUps = ups.filter((sid) => !steered(sid));
        const deadUps = realUps.filter((sid) => (results[sid] as NodeResult)?.status === 'failed');
        /**
         * Some steps do NOT need their input to have arrived, and must still run:
         *  • ask_user — the whole point of "the research failed, ask me what to do". Short-circuiting
         *    it meant a durable checkpoint was never asked and the run just ended.
         *  • merge — it now handles missing branches itself (BEA-1235). Killing it here threw away
         *    the rescue/MISSING machinery for the case where every branch died.
         */
        const runsWithoutInput = kind === 'ask_user' || kind === 'merge';
        if (!runsWithoutInput && ups.length && realUps.length && deadUps.length === realUps.length) {
          const why = deadUps
            .map((sid) => `${(results[sid] as NodeResult)?.label || sid}: ${((results[sid] as NodeResult)?.output || 'failed').slice(0, 120)}`)
            .join('; ');
          // Marked as a knock-on so the run's message names the steps that REALLY broke. Without
          // this a single dead research step reported "6 of 6 steps failed", listing a merge and an
          // output node that never ran — true that the run failed, misleading about where.
          results[nodeId] = { status: 'failed', output: `its input never arrived — ${why}`, kind, label, cascaded: true };
          await persist();
          return '';
        }

        // A node fed ONLY by error paths is skipped when nothing actually failed.
        if (ups.length && ups.every((s) => errEdge.has(`${s}->${nodeId}`)) && !upOuts.some(Boolean)) {
          results[nodeId] = { status: 'skipped', output: '', kind, label };
          await persist();
          return '';
        }
        const live = upOuts.filter(Boolean);
        // A step with NOTHING upstream is where the run's own material goes in (BEA-1350) — it is
        // the only place in the graph that can be handed something from outside. A step fed by other
        // steps is unaffected, so a flow started by hand behaves exactly as it always did.
        const input = live.join('\n\n') || (!ups.length && runInput ? runInput : '');
        // "Ask me" block — pause durably until the user answers (Move B). An already-answered one
        // is seeded in the memo above, so reaching here means it still needs an answer.
        if (kind === 'ask_user') {
          // In eval mode there's no one to answer — skip it so the regression test doesn't hang.
          if (opts.evalMode) { results[nodeId] = { status: 'skipped', output: '', kind, label }; await persist(); return ''; }
          await this.pauseForInput(runId, flow, node, input, results, spendJson().spend);
          throw new PauseSignal(nodeId);
        }
        // Before starting anything new, is there budget left? (BEA-1204) Checked here rather than
        // inside the call so the answer is "finish the step in flight, then start nothing new" —
        // the owner gets a whole thought, not half of one.
        const guard = await this.budgetStop(kind, node?.data?.refId, runTokens);
        if (guard) {
          results[nodeId] = { status: 'skipped', output: guard, kind, label };
          if (!stoppedOnBudget) { stoppedOnBudget = guard; term(`⏹ ${guard}`); }
          await persist();
          return '';
        }
        // Branches run in parallel, so two could pass the guard on the same figure and then both
        // charge afterwards — overshooting by a whole turn. Charge the run NOW for what this step is
        // expected to cost, and correct it with the real figure once it finishes.
        const expected = this.stepCost(kind, node?.data?.refId, input, '');
        chargeRun(expected);
        results[nodeId] = { status: 'running', output: '', kind, label }; await persist();
        try {
          // Optional per-node retry (BEA-1071): "if it fails, try again N times" before giving up.
          const retries = Math.min(3, Math.max(0, Number(node.data?.retries) || 0));
          let output = '';
          let lastErr: any = null;
          for (let attempt = 0; attempt <= retries; attempt++) {
            try { output = await this.runNode(node, input, live, allowed, flow?.agentId, (t) => { term(t); void persist(); }, (s) => addSpend(s), graph?.researchFrom, graph?.researchTo, runId); lastErr = null; break; }
            catch (e: any) {
              // A gate is not a failure and must never be retried — retrying would ask the same
              // question again (and write a second "held" row) instead of waiting for the answer.
              if (e instanceof PauseSignal || e instanceof GatePause) throw e;
              lastErr = e;
              if (attempt < retries) term(`↻ ${label || kind} failed — retrying (${attempt + 1}/${retries})`);
            }
          }
          if (lastErr) throw lastErr;
          // Replace the up-front estimate with what the step really moved.
          chargeRun(this.stepCost(kind, node?.data?.refId, input, output) - expected);
          // If-condition verdict (BEA-1073) — stored on the result so its edges can steer.
          const condFalse = kind === 'if' ? !this.evalCond(node.data?.cond, input) : undefined;
          if (kind === 'if') term(`🔱 ${label || 'If'}: ${condFalse ? 'no — taking the other path' : 'yes'}`);
          results[nodeId] = { status: 'done', output, kind, label, ...(condFalse !== undefined ? { condFalse } : {}) };
          const line = this.termLine(node, output);
          if (line) term(`${line}`);
          await persist();
          return output;
        } catch (e: any) {
          if (e instanceof PauseSignal) throw e;
          /**
           * A gate (BEA-1348): the step is about to do something that cannot be undone, so it
           * stopped BEFORE the provider was called and is asking. Turned into the same durable
           * pause an "Ask me" block uses — the run is written to the database as waiting and
           * nothing is held in memory, so it survives a restart and can be answered days later.
           */
          if (e instanceof GatePause) {
            // In eval mode nobody is there to answer. Held back rather than run, and said plainly.
            if (opts.evalMode) {
              results[nodeId] = { status: 'skipped', output: `Held back — ${e.gate.headline} cannot be undone and needs your approval.`, kind, label };
              await persist();
              return '';
            }
            await this.pauseForGate(runId, flow, node, e.gate, results, spendJson().spend);
            throw new PauseSignal(nodeId);
          }
          results[nodeId] = { status: 'failed', output: String(e?.message || e), kind, label };
          await persist();
          return '';
        }
      })();
      memo.set(nodeId, p);
      return p;
    };

    const hasOut = new Set((graph.edges || []).map((e: any) => e.source));
    const outputNodes = (graph.nodes || []).filter((n: any) => n.data?.kind === 'output');
    const terminals = outputNodes.length ? outputNodes : (graph.nodes || []).filter((n: any) => !hasOut.has(n.id));
    try {
      await Promise.all(terminals.map((n: any) => outputOf(n.id)));
    } catch (e: any) {
      if (e instanceof PauseSignal) return; // run was left 'waiting' by pauseForInput; resumed on answer
      throw e;
    }

    // Only a genuinely DONE terminal counts as the answer — never a failed node's error text, which
    // would otherwise be promoted to finalOutput and saved as a Document. (BEA-800)
    let finalOutput = '';
    for (const n of terminals) { const r = results[n.id]; if (r?.status === 'done' && r.output) finalOutput = r.output; }

    // A newer driver owns this run now (the question was answered mid-walk) — this walk's ending
    // must not touch the row. (BEA-792)
    if (stale()) return;

    // If the run was cancelled while this driver was mid-flight, don't resurrect it as 'done'. (BEA-776)
    if (this.cancelled.has(runId)) { this.cancelled.delete(runId); this.dropDriver(runId, gen); return; }

    /**
     * ANY failed step means the run did not succeed (BEA-1234).
     *
     * This check used to run only when the final answer was empty (BEA-800 wrote it for "everything
     * broke"). It had no answer for "some of it broke", which is the common case. One real run lost
     * two of three branches — 31,204 characters of paid-for research — and still reported ✓ done with
     * a 1,739-character answer built from the one branch that survived. The grader scored it 0/100
     * while the screen said it had worked.
     *
     * A partial run is now FAILED, not done. It keeps everything the working steps produced — the
     * answer, the research, the documents — but it never claims to have succeeded. 'failed' rather
     * than a new 'partial' status on purpose: every screen already renders 'failed' correctly, and a
     * sixth status would have to be handled in ~65 places to say the same thing.
     */
    // A ⚠ edge means the author planned for this failure — but ONLY if the fallback actually RAN.
    // An edge drawn to a dead-end node (an alert with nothing after it) is never reached when the
    // graph has its own output node, so it never lands in `results`. Excusing a failure on the
    // strength of an edge that exists on the canvas would let two dead branches pass as a healthy
    // run — reproducing the exact bug this issue exists to fix.
    const handled = new Set<string>();
    for (const e of graph.edges || []) if (e?.data?.onError && results[e.target]) handled.add(e.source);
    const allFailed = Object.entries(results)
      .filter(([, r]) => (r as NodeResult).status === 'failed')
      .filter(([id]) => !handled.has(id));
    // Blame only what really broke. A knock-on ("its input never arrived") still fails the run, but
    // naming it alongside the root cause overstates the damage and hides the step to actually fix.
    const rootFailed = allFailed.filter(([, r]) => !(r as NodeResult).cascaded);
    const failedSteps = rootFailed.length ? rootFailed : allFailed;

    /**
     * An EVAL run must fail too (BEA-1234).
     *
     * The old guard was `!opts.evalMode`, so a graded eval whose branches died was scored on a
     * partial answer as though it had fully succeeded — and `runForEval` only retries when the
     * status is not 'done', so it did not even retry. The status is the honest part and applies to
     * both; only the side effects (documents, Telegram, push, WhatsApp) are skipped for evals.
     */
    if (opts.evalMode && failedSteps.length) {
      const names = failedSteps.map(([id, r]) => (r as NodeResult).label || id);
      await this.prisma.flowRun.update({ where: { id: runId }, data: { status: 'failed', error: `${failedSteps.length} step(s) failed: ${names.join(', ')}`.slice(0, 300), ...(finalOutput.trim() ? { finalOutput } : {}), results: JSON.stringify(results), terminal: JSON.stringify(terminal.slice(-300)), endedAt: new Date(), waitNodeId: null, waitQuestion: null, waitToken: null, ...spendJson() } as any }).catch(() => undefined);
      this.dropDriver(runId, gen);
      return;
    }

    if (failedSteps.length) {
      const names = failedSteps.map(([id, r]) => (r as NodeResult).label || id);
      const first = (failedSteps[0][1] as NodeResult).output || 'a step failed';
      const headline = failedSteps.length === 1
        ? `✗ the "${names[0]}" step failed`
        : `✗ ${failedSteps.length} steps failed: ${names.join(', ')}`;
      if (!terminal.length || terminal[terminal.length - 1]?.text !== headline) term(headline);

      // Keep what DID work (BEA-1200/BEA-1193) — including the answer, if a later step still produced
      // one. Passing finalOutput here is what stops a partial run from throwing away a usable report
      // just because a sibling branch died.
      const kept = await this.saveDocuments(flow, graph, incoming, results, finalOutput, true).catch((e: any) => {
        this.log.warn(`could not keep the work of partly-failed run ${runId}: ${e?.message || e}`);
        return [] as any[];
      });
      if (kept.length) term(`💾 kept what the steps that worked produced (${kept.length} document${kept.length === 1 ? '' : 's'})`);
      if (finalOutput.trim()) term('⚠ the answer below is incomplete — it is missing the failed steps');

      const ran = Object.values(results).filter((r) => (r as NodeResult).status !== 'skipped').length;
      const error = `${failedSteps.length} of ${ran} steps failed (${names.join(', ')}) — ${first}`.slice(0, 300);
      // Only write an answer when one genuinely survived. Writing '' would still satisfy "not done",
      // but BEA-800's guarantee is that a failed run never promotes anything to finalOutput at all.
      await this.prisma.flowRun.update({ where: { id: runId }, data: { status: 'failed', error, ...(finalOutput.trim() ? { finalOutput } : {}), results: JSON.stringify(results), documentIds: JSON.stringify(kept), terminal: JSON.stringify(terminal.slice(-300)), endedAt: new Date(), waitNodeId: null, waitQuestion: null, waitToken: null, ...spendJson() } as any });
      this.telegram.notifyFlowDone({ flowName: flow?.name, status: 'failed' }).catch(() => undefined);
      void this.push?.send({ title: `${flow?.name || 'Your flow'} failed`, body: error.slice(0, 140), url: `/flows/runs/${runId}`, tag: `flow-${runId}` }).catch(() => undefined);
      void this.alerts?.runFailed(flow?.name || 'Your flow', error.slice(0, 200), `/flows/runs/${runId}`).catch(() => undefined); // WhatsApp (BEA-1071)
      this.dropDriver(runId, gen);
      return;
    }

    // Save the outputs as Documents you can browse later (Agent↔Flow merge ④) — but not for eval runs.
    const docs = opts.evalMode ? [] : await this.saveDocuments(flow, graph, incoming, results, finalOutput);
    // A run cut short by the budget did not fail — nothing broke — but it must not read as a clean
    // success either, or the owner acts on a partial answer thinking it is the whole one (BEA-1204).
    if (!opts.evalMode) term(stoppedOnBudget ? '⏹ stopped on budget — what was finished is saved' : '✓ done');
    if (stoppedOnBudget && !opts.evalMode) void this.announceBudget(stoppedOnBudget, flow?.name).catch(() => undefined);

    // Grade the finished result against the job's Outcome — or the agent's standing one (BEA-1191).
    // Deep runs and EVERY voice job come through here, and they were finishing with no verdict at
    // all, which made the standing Outcome added for exactly those jobs pointless.
    let gradeJson: string | undefined;
    if (!opts.evalMode && (flow as any)?.agentId && finalOutput) {
      // BEA-1247: a grader that cannot answer says so. It used to return null on a cut-off reply and
      // the run finished with a clean ✓ and no verdict — silence exactly when the answer got good.
      const gr: GradeResult | null = await this.bridge.gradeFor?.((flow as any).agentId, finalOutput)
        .catch((e: any) => ({ ok: false, reason: `the grader could not be reached — ${String(e?.message || e).slice(0, 120)}` }));
      if (gr) {
        if (gr.ok) { gradeJson = JSON.stringify(gr.grade); term(`✓ checked against your Outcome — ${gr.grade.verdict} ${gr.grade.score}/100`); }
        else term(`⚠ couldn't check this against your Outcome — ${gr.reason}`);
      }
    }

    await this.prisma.flowRun.update({ where: { id: runId }, data: { status: 'done', finalOutput, results: JSON.stringify(results), documentIds: JSON.stringify(docs), terminal: JSON.stringify(terminal.slice(-300)), endedAt: new Date(), waitNodeId: null, waitQuestion: null, waitToken: null, ...(gradeJson ? { grade: gradeJson } : {}), ...spendJson() } as any });
    this.dropDriver(runId, gen);

    // Notify on a background/long run so you know it's ready even if you walked away (workspace ⑥).
    if (!opts.evalMode && runRow?.startedAt && Date.now() - new Date(runRow.startedAt).getTime() > 60_000) {
      this.telegram.notifyFlowDone({ flowName: flow?.name, status: 'done', snippet: finalOutput }).catch(() => undefined);
      void this.push?.send({ title: `${flow?.name || 'Your flow'} finished ✓`, body: (finalOutput || 'The result is ready.').slice(0, 140), url: `/flows/runs/${runId}`, tag: `flow-${runId}` }).catch(() => undefined);
    }
  }

  /**
   * Delete flow working-part documents older than the retention window (BEA-1085). Only docs
   * tagged 'flow-part'; a doc edited after creation (updatedAt drifted) is treated as the user's
   * and left alone. Deletion is by exact id via DocumentsService.
   */
  async sweepFlowParts(now: Date = new Date()): Promise<number> {
    const raw = await this.prisma.setting.findUnique({ where: { key: 'docs.flowPartDays' } }).catch(() => null);
    const days = raw?.value === '' ? 30 : Number(raw?.value ?? 30);
    if (!days || days <= 0 || Number.isNaN(days)) return 0; // 0/blank = keep forever
    const cutoff = new Date(now.getTime() - days * 24 * 3600_000);
    const parts = await this.prisma.document.findMany({
      where: { tags: { contains: '"flow-part"' }, createdAt: { lt: cutoff } },
      select: { id: true, createdAt: true, updatedAt: true },
      take: 200,
    });
    let removed = 0;
    for (const d of parts) {
      if (d.updatedAt && d.createdAt && new Date(d.updatedAt).getTime() - new Date(d.createdAt).getTime() > 60_000) continue; // edited → the user's now
      await this.documents.remove(d.id).then(() => removed++).catch(() => undefined);
    }
    if (removed) this.log.log(`cleaned ${removed} flow working-part document(s) older than ${days}d`);
    return removed;
  }

  /**
   * "Run to here" (BEA-1072): execute ONLY the blocks needed to feed one node — using any frozen
   * (pinned) results instead of re-running those steps — and report exactly what went in and what
   * came out. Nothing is persisted: no run row, no documents, no notifications. Pins are honoured
   * for UPSTREAM blocks; the target itself always runs fresh (so you can re-freeze it).
   */
  async testToNode(flowId: string, nodeId: string): Promise<{ ok: boolean; message?: string; input?: string; output?: string; nodes?: Record<string, { status: string; output: string; pinned?: boolean }> }> {
    const flow = await this.prisma.flow.findUnique({ where: { id: flowId } });
    if (!flow) throw new NotFoundException('Flow not found');
    const graph = this.parse(flow.graph);
    const nodes = new Map<string, any>((graph.nodes || []).map((n: any) => [n.id, n]));
    if (!nodes.has(nodeId)) return { ok: false, message: 'That block is not in the saved flow — Save first, then test.' };
    // "Run to here" does REAL work (engine turns, real skills), so it obeys the toolbox exactly
    // like a full run — otherwise this endpoint would be a way around it. (BEA-1168)
    const allowed = await this.allowedFor(flow);
    const incoming = new Map<string, string[]>();
    for (const n of graph.nodes || []) incoming.set(n.id, []);
    for (const e of graph.edges || []) if (incoming.has(e.target)) incoming.get(e.target)!.push(e.source);
    const errEdge = new Set<string>();
    for (const e of graph.edges || []) if (e?.data?.onError) errEdge.add(`${e.source}->${e.target}`);

    const results: Record<string, NodeResult & { pinned?: boolean }> = {};
    const memo = new Map<string, Promise<string>>();
    let targetInput = '';

    const outputOf = (nid: string): Promise<string> => {
      if (memo.has(nid)) return memo.get(nid)!;
      const p = (async (): Promise<string> => {
        const node = nodes.get(nid);
        if (!node) return '';
        const kind = node.data?.kind;
        const label = node.data?.label;
        if (node.data?.enabled === false) { results[nid] = { status: 'skipped', output: '', kind, label }; return ''; }
        // Frozen result (pin): upstream blocks reuse it — no engine call, no re-send, no cost.
        if (nid !== nodeId && node.data?.pin?.output != null) {
          results[nid] = { status: 'done', output: String(node.data.pin.output), kind, label, pinned: true };
          return String(node.data.pin.output);
        }
        const ups = incoming.get(nid) || [];
        const upOuts = await Promise.all(ups.map(async (s) => {
          const out = await outputOf(s);
          const rs = results[s];
          const failedUp = rs?.status === 'failed';
          const marked = errEdge.has(`${s}->${nid}`);
          if (rs?.kind === 'if' && rs.condFalse !== undefined) {
            if (marked) return rs.condFalse ? (rs.output || 'the condition was not met') : '';
            return rs.condFalse ? '' : out;
          }
          if (marked) return failedUp ? `The previous step failed: ${rs?.output || 'unknown error'}` : '';
          return failedUp ? '' : out;
        }));
        const live = upOuts.filter(Boolean);
        const input = live.join('\n\n');
        if (nid === nodeId) targetInput = input;
        if (kind === 'ask_user') { results[nid] = { status: 'skipped', output: input, kind, label }; return input; } // nobody to answer in a test — pass through
        try {
          // "Run to here" performs REAL side effects, so it obeys the toolbox exactly like a full run.
          // No `runId`: this path never creates a FlowRun row, so an outside-service call made from
          // here is still written to `ToolCall` — it just has no run to point back at (BEA-1347).
          const output = await this.runNode(node, input, live, allowed, flow?.agentId);
          const condFalse = kind === 'if' ? !this.evalCond(node.data?.cond, input) : undefined;
          results[nid] = { status: 'done', output, kind, label, ...(condFalse !== undefined ? { condFalse } : {}) };
          return output;
        } catch (e: any) {
          if (e instanceof PauseSignal) { results[nid] = { status: 'skipped', output: input, kind, label }; return input; }
          // A gate (BEA-1348). "Run to here" makes no FlowRun row, so there is nowhere durable to
          // ask — the step stops, and says where the question CAN be answered.
          if (e instanceof GatePause) {
            results[nid] = { status: 'failed', output: `${e.gate.headline} cannot be undone, so it needs your approval — and a single step run has nowhere to ask. Run the whole flow and answer the question it asks.`, kind, label };
            return '';
          }
          results[nid] = { status: 'failed', output: String(e?.message || e), kind, label };
          return '';
        }
      })();
      memo.set(nid, p);
      return p;
    };

    const output = await outputOf(nodeId);
    const compact: Record<string, { status: string; output: string; pinned?: boolean }> = {};
    for (const [nid, r] of Object.entries(results)) compact[nid] = { status: r.status, output: (r.output || '').slice(0, 4000), ...(r.pinned ? { pinned: true } : {}) };
    return { ok: results[nodeId]?.status !== 'failed', message: results[nodeId]?.status === 'failed' ? results[nodeId].output : undefined, input: targetInput.slice(0, 6000), output: (output || '').slice(0, 8000), nodes: compact };
  }

  /** Plain-English If conditions (BEA-1073). No condition set = "did anything arrive?". */
  evalCond(cond: any, input: string): boolean {
    const text = input || '';
    if (!cond || !cond.op) return !!text.trim();
    const val = String(cond.value ?? '');
    if (cond.op === 'contains') return text.toLowerCase().includes(val.toLowerCase());
    if (cond.op === 'not_contains') return !text.toLowerCase().includes(val.toLowerCase());
    if (cond.op === 'longer_than') return text.length > (Number(val) || 0);
    if (cond.op === 'empty') return !text.trim();
    if (cond.op === 'number_gte' || cond.op === 'number_lte') {
      const m = text.match(/-?\d+(\.\d+)?/);
      if (!m) return false;
      const n = Number(m[0]);
      return cond.op === 'number_gte' ? n >= (Number(val) || 0) : n <= (Number(val) || 0);
    }
    return true;
  }

  /** Forget a finished run's driver state — only if this generation still owns the run. (BEA-792) */
  private dropDriver(runId: string, gen: number) {
    if (this.gens.get(runId) !== gen) return;
    this.gens.delete(runId);
    this.liveMemo.delete(runId);
  }

  /** Persist the pause (status 'waiting') + notify the user (Move B). */
  private async pauseForInput(runId: string, flow: any, node: any, input: string, results: Record<string, NodeResult>, spendSoFar?: string) {
    const label = node.data?.label || 'Ask me';
    const base = node.data?.question || node.data?.sub || node.data?.text || 'Your input is needed to continue.';
    const question = input ? `${base}\n\n${input.slice(0, 1500)}` : base;
    const options = Array.isArray(node.data?.options) ? node.data.options : [];
    const kind = node.data?.askKind || (options.length ? 'choice' : 'free_text');
    results[node.id] = { status: 'waiting', output: '', kind: 'ask_user', label };
    await this.prisma.flowRun.update({
      where: { id: runId },
      // Carry the spend across the pause (BEA-1204) — otherwise the resumed run starts its token
      // count at zero and quietly gets a second full allowance.
      data: { status: 'waiting', results: JSON.stringify(results), waitNodeId: node.id, waitQuestion: question, waitKind: kind, waitOptions: JSON.stringify(options), waitToken: randomBytes(16).toString('hex'), ...(spendSoFar ? { spend: spendSoFar } : {}) } as any,
    });
    this.telegram.notifyFlowWaiting({ flowName: flow?.name, question }).catch(() => undefined);
    // Phone push (BEA-1088): a flow's direct ask always delivers; tapping lands on the waiting card.
    void this.push?.send({ title: `${flow?.name || 'Your flow'} needs you`, body: question.slice(0, 160), url: `/agent?focus=${runId}`, tag: `flow-ask-${runId}`, isAsk: true }).catch(() => undefined);
  }

  /**
   * Persist a GATE pause (BEA-1348) — the same durable machinery as "Ask me", with two differences:
   * the paused step is the tool step itself (not an Ask-me block), and what it is holding is
   * carried on the step's own result, so the pending gate is still there after a restart.
   */
  private async pauseForGate(runId: string, flow: any, node: any, gate: PendingGate, results: Record<string, NodeResult>, spendSoFar?: string) {
    const label = node.data?.label || gate.actionName;
    results[node.id] = { status: 'waiting', output: '', kind: node.data?.kind || 'tool', label, gate };
    await this.prisma.flowRun.update({
      where: { id: runId },
      data: {
        status: 'waiting',
        results: JSON.stringify(results),
        waitNodeId: node.id,
        waitQuestion: gate.question,
        waitKind: 'choice',
        waitOptions: JSON.stringify(['Yes, run it', 'No, stop']),
        waitToken: randomBytes(16).toString('hex'),
        ...(spendSoFar ? { spend: spendSoFar } : {}),
      } as any,
    });
    // Guarded all the way down (`?.` on the method too): spec harnesses build this service with
    // partial stubs, and a gate that threw here would leave the run waiting on nobody.
    this.telegram?.notifyFlowWaiting?.({ flowName: flow?.name, question: gate.question })?.catch?.(() => undefined);
    void this.push?.send?.({ title: `${flow?.name || 'Your flow'} needs your OK`, body: `${gate.headline} — this cannot be undone.`.slice(0, 160), url: `/agent?focus=${runId}`, tag: `flow-ask-${runId}`, isAsk: true })?.catch?.(() => undefined);
  }

  /** Answer the open "Ask me" question and resume the run (Move B). */
  async answer(runId: string, answer: string) {
    const run = await this.prisma.flowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');
    if (run.status !== 'waiting' || !(run as any).waitNodeId) return { ok: false, message: 'This run is not waiting for an answer.' };
    // Atomically claim the waiting run so a double-tap (or web + Telegram) can't start two drivers on
    // the same run — duplicate Codex turns, duplicate documents, clobbered results. Only one wins. (BEA-791)
    const claim = await this.prisma.flowRun.updateMany({ where: { id: runId, status: 'waiting' }, data: { status: 'running' } });
    if (claim.count === 0) return { ok: false, message: 'This run is already being answered.' };
    // Silence the paused driver's lingering branch writes IMMEDIATELY — before the new driver even
    // reads the row — so a stale persist can't undo the answer we're about to write. (BEA-792)
    this.gens.set(runId, (this.gens.get(runId) || 0) + 1);
    const flow = run.flowId ? await this.prisma.flow.findUnique({ where: { id: run.flowId } }) : null;
    const results: Record<string, NodeResult> = this.parse(run.results) || {};
    const nodeId = (run as any).waitNodeId as string;
    const gate = results[nodeId]?.gate;
    if (gate) {
      /**
       * A gate, not an "Ask me" (BEA-1348). The answer is a permission, not an input:
       *  • yes — the permission is written down (with the exact arguments the owner was shown) and
       *    the step's result is CLEARED, so the walk runs it for real this time;
       *  • no  — nothing runs, and the step fails with a sentence that says why, so the rest of the
       *    run carries on knowing this part did not happen.
       */
      const decided = await this.serviceActions
        ?.answerGate?.(gate, answer, { runId, runKind: 'flow', nodeId, label: results[nodeId]?.label })
        .catch((e: any) => ({ approved: false, message: `That approval could not be saved: ${e?.message || e}` }));
      const label = results[nodeId]?.label || gate.actionName;
      if (decided?.approved) delete results[nodeId];
      else results[nodeId] = { status: 'failed', output: decided?.message || `You said no, so nothing was done: ${gate.headline}.`, kind: 'tool', label, gateRejected: true };
    } else {
      results[nodeId] = { status: 'done', output: String(answer || ''), kind: 'ask_user', label: results[nodeId]?.label || 'Ask me' };
    }
    await this.prisma.flowRun.update({ where: { id: runId }, data: { results: JSON.stringify(results), waitNodeId: null, waitQuestion: null, waitToken: null } });
    void this.execute(runId, flow).catch(async (e) => {
      this.log.error(`flow run ${runId} crashed on resume: ${e?.message || e}`);
      await this.prisma.flowRun.update({ where: { id: runId }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined);
    }).finally(() => this.freeJob(runId));
    return { ok: true };
  }

  /**
   * Give the job back once this flow run has really ENDED (BEA-1388). A driver settles on a pause as
   * well as on an ending, so the status decides: `running`/`waiting` keeps the lock (the run is still
   * a run), anything else releases it. A pause that outlives `RunLockService.TTL_MS` frees the job by
   * expiry instead, exactly as a parked agent run does — a flow waiting days must not wedge a
   * schedule. Never throws: a lock that cannot be freed here still frees itself at the timeout.
   */
  private async freeJob(flowRunId: string): Promise<void> {
    if (!this.locks) return;
    const r = await this.prisma.flowRun.findUnique({ where: { id: flowRunId } }).catch(() => null);
    if (r && (r.status === 'running' || r.status === 'waiting')) return;
    await this.locks.releaseForRun(flowRunId).catch(() => undefined);
  }

  /** Persist branch parts (when >1) + the final output as Documents; returns [{id, slug, title}]. */
  private async saveDocuments(flow: any, graph: any, incoming: Map<string, string[]>, results: Record<string, NodeResult>, finalOutput: string, incomplete = false) {
    const name = (flow.name || 'Flow').toString().slice(0, 80);
    const nodes = new Map<string, any>((graph.nodes || []).map((n: any) => [n.id, n]));
    const partIds = new Set<string>();
    for (const n of graph.nodes || []) if (n.data?.kind === 'merge') for (const s of incoming.get(n.id) || []) partIds.add(s);
    // title a branch part by its sub-question (walk upstream to the nearest subquestion node)
    const branchTitle = (sid: string): string => {
      let cur: string | undefined = sid; const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const n = nodes.get(cur);
        if (n?.data?.kind === 'subquestion') return (n.data?.sub || n.data?.label || 'Part').toString();
        cur = (incoming.get(cur) || [])[0];
      }
      return (nodes.get(sid)?.data?.label || 'Part').toString();
    };
    const docs: { id: string; slug: string; title: string }[] = [];
    if (partIds.size >= 2) {
      for (const sid of partIds) {
        const r = results[sid];
        if (r?.status !== 'done' || !r.output?.trim()) continue;
        const d = await this.saveDoc(`${name} — ${branchTitle(sid).slice(0, 90)}`, r.output, name, true); // a working part — auto-cleaned later (BEA-1085)
        if (d) docs.push(d);
      }
    }
    if (finalOutput?.trim()) {
      // Say it in the TITLE and the body when steps failed. The run row carries the caveat, but the
      // document is read on its own in /documents, where an incomplete answer is indistinguishable
      // from a complete one — the caveat has to travel with the file.
      const body = incomplete ? `> ⚠ Incomplete — some steps of this run failed, so parts of the answer are missing.\n\n${finalOutput}` : finalOutput;
      const d = await this.saveDoc(`${name} — result${incomplete ? ' (incomplete)' : ''}`, body, name);
      if (d) docs.push(d);
    }

    // ALWAYS keep the research as a markdown document, whatever the last step happened to be
    // (BEA-1193). The owner's rule, and this run is why: two searches gathered 12,400 characters,
    // the reasoning steps came back empty, an attached skill produced 125 characters — and every
    // one of those 12,400 was thrown away, because parts are only saved when they feed the merge
    // AND have content. A skill at the end must never be able to lose the work behind it.
    const md = this.researchMarkdown(name, graph, results, finalOutput);
    if (md) { const d = await this.saveDoc(`${name} — research`, md, name); if (d) docs.push(d); }
    return docs;
  }

  /**
   * Everything the run actually produced, in reading order, as one markdown document. Written even
   * when the merge or the final step returned nothing — especially then.
   */
  private researchMarkdown(name: string, graph: any, results: Record<string, NodeResult>, finalOutput: string): string | null {
    const parts: string[] = [];
    let kept = 0;
    for (const n of graph.nodes || []) {
      const r = results[n.id];
      const kind = n.data?.kind;
      // Only what actually WORKED is research. A failed node's `output` holds its error message, and
      // filing "the model returned nothing" under a research heading would be worse than saving
      // nothing at all — it reads like a finding. (Surfaced by BEA-1200's own tests.)
      const out = r?.status === 'failed' || r?.status === 'skipped' ? '' : (r?.output || '').trim();
      if (kind === 'question') { if (out) parts.push(`> ${out.replace(/\n+/g, ' ')}`); continue; }
      if (kind === 'subquestion') { if (out || n.data?.sub) parts.push(`\n## ${String(n.data?.sub || n.data?.label || 'Part').slice(0, 120)}`); continue; }
      if (!out) continue;
      if (kind === 'merge' || kind === 'output') {
        // Normally the merged text IS the result, added on its own below. But when there is no
        // result — the run failed after the merge — it is the most complete thing the run produced,
        // and skipping it here is how a real run lost 21,651 characters of combined research (BEA-1200).
        if (!finalOutput?.trim() && kind === 'merge' && out) { parts.push(`\n### The combined research\n\n${out}`); kept++; }
        continue;
      }
      parts.push(`\n### ${String(n.data?.label || kind || 'Step').slice(0, 80)}\n\n${out}`);
      kept++;
    }
    if (!kept) return null; // genuinely nothing was gathered — don't save an empty shell
    const head = `# ${name}\n`;
    const tail = finalOutput?.trim() ? `\n\n---\n\n## The finished result\n\n${finalOutput.trim()}` : `\n\n---\n\n_The final step produced nothing, so this document is the research it was built from._`;
    return `${head}${parts.join('\n')}${tail}`.slice(0, 200000);
  }

  /**
   * Is this an HTML page rather than markdown? (BEA-1199)
   *
   * A flow that ends in an HTML skill produces a whole page as its answer, and every one of them was
   * being filed as `kind: 'md'` — so the library showed 36KB of raw source instead of the report.
   */
  private looksHtml(content: string): boolean {
    const head = this.unfence(content).trimStart().slice(0, 200).toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html');
  }

  /**
   * Take off a markdown code fence, if the whole thing is wrapped in one.
   *
   * A model asked for "an HTML page" very often replies with ```html … ```. Stored as-is that is
   * neither valid markdown nor a page that renders — so strip the fence and keep the page.
   */
  private unfence(content: string): string {
    const t = (content || '').trim();
    const m = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(t);
    return m ? m[1] : content;
  }

  /** The words on the page, with the markup taken out — a description a person can read. */
  private visibleText(content: string): string {
    return (content || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async saveDoc(title: string, content: string, flowName: string, isPart = false): Promise<{ id: string; slug: string; title: string } | null> {
    try {
      const html = this.looksHtml(content);
      // Store the page itself, not the fence a model wrapped it in.
      if (html) content = this.unfence(content);
      // A description built by collapsing whitespace on HTML reads "<!doctype html> <html lang=…".
      const description = (html ? this.visibleText(content) : content.replace(/\s+/g, ' ')).slice(0, 180);
      // pass description + tags so DocumentsService skips its (paid) AI summarise pass
      const doc: any = await this.documents.create({ title: title.slice(0, 180), contentText: content, kind: html ? 'html' : 'md', description, tags: ['flow', flowName.slice(0, 40), ...(isPart ? ['flow-part'] : [])], noIndex: true });
      return { id: doc.id, slug: doc.slug, title: doc.title };
    } catch (e: any) { this.log.warn(`flow doc save failed: ${e?.message || e}`); return null; }
  }

  // Tools that genuinely need the agent engine (web/browse/connectors/external actions).
  // Tools that need REAL access and must run on the engine. Anything not in here (and not handled
  // directly above) falls through to a plain model call — fine for reasoning, wrong for a lookup,
  // so every catalog tool that touches your data or the outside world belongs in this set (BEA-1167).
  private static AGENT_TOOLS = new Set([
    // Only tools that need REAL ACCESS and genuine agency belong here — an engine turn averages
    // 118,000 tokens, as much as eight branches of real research.
    //
    // Deliberately absent, all handled directly instead:
    //  • web_search / web_read / web_search_meaning / deep_research (BEA-1194, BEA-1196) — the model
    //    must never decide how to search; it answered a 2025 question from 2021 training data.
    //  • save_document / save_capture / create_task / remember / telegram / whatsapp / search_rag /
    //    fetch_document (BEA-1203) — filing a document is not a decision. These were engine turns
    //    whose only job was to call our own API back.
    // The bare Google ids below are no longer offered by the catalog (BEA-1351 — Google comes
    // through the seam as svc:gmail.* etc.), but flows saved before that still carry them, and an
    // id dropped from this set would fall through to a plain model call that invents the answer.
    'gmail', 'calendar', 'drive', 'http',
    'docs', 'sheets', 'slides', 'tasks', 'forms', 'meet', 'chat', 'contacts',
    'cli',
  ]);

  /** The tool ids this flow's job may use — null when nobody has chosen, which blocks nothing. */
  private async allowedFor(flow: any): Promise<Set<string> | null> {
    const agentId = flow?.agentId;
    if (!agentId || !this.agent?.allowedTools) return null;
    const r = await this.agent.allowedTools(agentId).catch(() => null);
    return r && r.ids.length ? new Set(r.ids) : null;
  }

  private async runNode(node: any, input: string, inputs: string[], allowed?: Set<string> | null, agentId?: string | null, onLine?: (t: string) => void, onSpend?: (s: ResearchSpend) => void, researchFrom?: string, researchTo?: string, runId?: string): Promise<string> {
    const kind = node.data?.kind;
    const label = node.data?.label || '';
    const refId = node.data?.refId;
    // A tool or skill the owner did not tick simply does not run (BEA-1168). Saying so beats
    // quietly doing it anyway, and beats a silent blank that reads like the step worked.
    if (allowed && (kind === 'tool' || kind === 'skill') && refId && !allowed.has(refId)) {
      return `This step was skipped: "${label || refId}" is not in this agent's toolbox. Add it on the agent's page if it should be allowed.`;
    }
    switch (kind) {
      /**
       * The Question box. Normally it just is the flow's own question.
       *
       * When the run was started with material — a service event that woke it (BEA-1350) — the box
       * carries BOTH: the standing question the flow was built to answer, and what has just
       * happened. Replacing one with the other would lose half the job either way round.
       */
      case 'question': {
        const q = String(node.data?.sub || '');
        const given = String(input || '');
        if (q && given && given !== q) return `${q}\n\n${given}`;
        return q || given;
      }
      // Thread the whole research goal into every branch so a sub-search can't drift off-topic. (BEA-771)
      case 'subquestion': {
        const goal = (input || '').trim(); // upstream = the original question (+ prior branch findings)
        const focus = (node.data?.sub || '').trim();
        if (!focus) return goal;
        if (!goal) return focus;
        return `OVERALL RESEARCH GOAL (interpret every term and stay strictly within this):\n${goal}\n\nTHIS BRANCH FOCUSES ON:\n${focus}`;
      }
      case 'text': return node.data?.text || node.data?.sub || '';
      case 'note': return input; // a comment for the human, invisible to the run
      // Wait — a real pause before the next step (BEA-1073). Capped at 10 minutes inline; a longer
      // ambient wait belongs to a schedule/event trigger, not a blocking node.
      case 'wait': {
        const secs = Math.min(600, Math.max(0, Number(node.data?.seconds) || 0));
        if (secs > 0) await new Promise((r) => setTimeout(r, secs * 1000));
        return input;
      }
      // Filter — keep only the lines that match (BEA-1073). Empty match = pass everything.
      case 'filter': {
        const needle = String(node.data?.match || '').trim().toLowerCase();
        if (!needle) return input;
        const kept = (input || '').split('\n').filter((l) => l.toLowerCase().includes(needle));
        return kept.join('\n');
      }
      // If — evaluated in outputOf (it must set condFalse on the RESULT to steer the edges); by the
      // time runNode sees it the answer is just "pass the input through".
      case 'if': return input;
      case 'output': return input;
      case 'merge': return this.merge(node.data?.mode || 'ai', inputs, node.data?.goal, onLine);
      // search_brain is a fast direct lookup — never a slow agent turn (was timing out).
      case 'tool': {
        // An outside service (BEA-1345/1347) — run DIRECTLY, with no engine turn at all. Deciding
        // what to do next earns an engine turn (~118,000 tokens); calling an API does not, so this
        // never reaches `agentRun`. The only model call is the small capped one that fills the
        // action's arguments, inside the service below.
        //
        // Every road out of here except a real success THROWS. An `svc:` id is not in AGENT_TOOLS,
        // so anything that returned instead of throwing would fall through to askModel and hand
        // back an invented answer — and for a delete/merge/refund action that reads as "it
        // happened" when nothing did. That property is the reason BEA-1345 put a loud failure here
        // in the first place, and it survives now that the step really runs.
        if (isServiceToolId(refId)) {
          const svc = parseServiceToolId(refId);
          if (!this.serviceActions?.run) throw new Error(`Running ${svc?.service || 'outside service'} actions is not available on this server.`);
          return this.serviceActions.run(refId, input || node.data?.sub || '', {
            runId,
            runKind: 'flow',
            agentId: agentId || undefined,
            nodeId: node?.id,
            label,
            accountId: node.data?.accountId || node.data?.connectionId,
            args: node.data?.args,
            guidance: node.data?.guidance,
            onLine,
          });
        }
        if (refId === 'search_brain') return this.searchBrain(input || node.data?.sub || '');
        // AI News Daily (BEA-1259) — direct, like the Web group. These must NEVER fall through to
        // a plain model call: an unregistered tool id reaches askModel, which would cheerfully
        // describe collecting the news instead of collecting it.
        if (refId === 'news_collect' || refId === 'news_write' || refId === 'news_flag') {
          if (!this.news) throw new Error('AI News Daily is not available on this server');
          if (refId === 'news_collect') return this.news.collect();
          if (refId === 'news_write') return this.news.writeToday();
          return this.news.flagToday();
        }
        // Real research, direct — no engine turn (BEA-1194). A failure THROWS so the step is marked
        // failed with the reason, rather than quietly handing back model knowledge.
        if (refId === 'web_search' || refId === 'web_search_meaning' || refId === 'web_read') {
          if (!this.web) throw new Error('web research is not available on this server');
          const q = (input || node.data?.sub || '').trim();
          if (refId === 'web_read') return this.web.readPage(q);
          const byMeaning = refId === 'web_search_meaning';
          const rows = byMeaning ? await this.web.searchByMeaning(q) : await this.web.search(q);
          onLine?.(`   found ${rows.length} source${rows.length === 1 ? '' : 's'}`);
          return this.web.asMarkdown(q.slice(0, 120), rows, byMeaning ? 'by meaning' : 'web search');
        }
        // Our own deep research (BEA-1196): many searches, then the report, all on the flat-rate
        // engine. Direct like the rest of the Web group — the engine never picks how to search.
        if (refId === 'deep_research') {
          if (!this.deep) throw new Error('deep research is not available on this server');
          const q = (input || node.data?.sub || '').trim();
          const budget = { searches: Number(node.data?.maxSearches) || undefined, extracts: Number(node.data?.maxReads) || undefined };
          // Dates the owner set, if any (BEA-1209). On the node first, else the flow's own. Empty is
          // the normal case and the window is guessed from the question as before.
          const from = String(node.data?.researchFrom || researchFrom || '').trim() || undefined;
          const to = String(node.data?.researchTo || researchTo || '').trim() || undefined;
          try {
            const { report, spend } = await this.deep.run(q, { budget, onLine, from, to });
            onSpend?.(spend);
            return report;
          } catch (e: any) {
            // A failed attempt still spent credits, and this node may be set to retry. Record what it
            // cost before rethrowing, so the run's total is the truth rather than only the wins.
            if (e?.spend) onSpend?.(e.spend);
            throw e;
          }
        }
        // Work we can simply DO (BEA-1203). Saving a document, filing a note, creating a task,
        // remembering something, sending a message, looking in your own notes — none of these need a
        // model. Each was spawning a 118,000-token engine turn whose only job was to call our own
        // API back. One engine turn costs as much as eight branches of real research.
        {
          const done = await this.directTool(refId, node, input, onLine, runId);
          if (done !== null) return done;
        }
        if (FlowRunnerService.AGENT_TOOLS.has(refId)) {
          // Title the branch run by its sub-question, not a generic "Web search". (BEA-772)
          const focus = /THIS BRANCH FOCUSES ON:\s*([^\n]+)/.exec(input || '')?.[1]?.trim();
          const runTitle = focus ? focus.slice(0, 70) : `Flow · ${label}`;
          return this.agentRun(this.toolPrompt(refId, label, input) + this.guidance(node), runTitle, agentId, onLine);
        }
        return this.askModel(this.toolPrompt(refId, label, input) + this.guidance(node)); // unknown tool → reason directly
      }
      // Move A: run the REAL skill in Codex with its folder in the working dir; fall back to the model.
      case 'skill': {
        const slug = await this.skillSlug(refId);
        if (slug) {
          const p = `Use the "${label}" skill — its files are in your working directory; read SKILL.md and follow it. Do the following and reply with ONLY the finished result.${this.guidance(node)}\n\n${input}`;
          // A skill that cannot run FAILS. It used to fall back to a plain model asked to work "in
          // the style of" the skill — with none of its files — so you got an imitation of your own
          // skill and nothing said so. A named imitation is worse than an honest failure.
          return this.bridge.runSkillTurn(slug, p).catch((e: any) => {
            throw new Error(`the "${label}" skill could not run: ${String(e?.message || e).slice(0, 200)}`);
          });
        }
        // No skill folder installed anywhere — say so rather than pretending to be it.
        return `The "${label}" skill is not installed on the engine, so this step did nothing. Install it on the Skills page, or take this step out of the flow.`;
      }
      // Ask AI is pure reasoning over the upstream input — a direct model call, not a Codex turn.
      case 'ask_ai': {
        const p = (input || node.data?.sub || '').trim();
        return p ? this.askModel(`Based on the following, write a clear, well-structured answer. Be specific and useful; do not pad.\n\n${p}`, 'flow-node', onLine) : '';
      }
      default: return input;
    }
  }

  /**
   * Direct model call for a thinking block. THROWS with the reason when the model cannot answer
   * (BEA-1194) — this used to swallow every failure into '', which the flow then recorded as
   * "done, 0 chars". A step that could not think must say so, not look finished.
   */
  private async askModel(prompt: string, purpose: 'flow-node' | 'flow-merge' = 'flow-node', onLine?: (t: string) => void, maxTokens = 1500): Promise<string> {
    /**
     * Follow THE engine (BEA-1236).
     *
     * `completeDetailed`'s third argument is only a usage LABEL — it never picked a model. So this
     * step ran on the app's general setting, `qwen/qwen3.7-max`, which returned nothing twice in one
     * real run and killed two of three branches. Resolving the helper first is what makes the
     * owner's rule true here: choose Codex, and the thinking steps run on Codex.
     */
    const cfg = await this.llm.helperModel?.(purpose).catch(() => null);
    if (cfg && this.llm.completeWithModel) {
      const r = await this.llm.completeWithModel(cfg, prompt, maxTokens, purpose).catch((e: any) => ({ text: null, error: String(e?.message || e) } as any));
      if (r?.text?.trim()) {
        // Say when the answer did NOT come from the engine. completeWithModel walks the chain and,
        // if every engine is down, pays for a model — which is the right insurance but must never be
        // invisible (BEA-1201). Without this the owner sees a normal step and an unexplained bill.
        if (r.flatRate === false || (r.provider && r.provider !== cfg.provider)) {
          onLine?.(`   ⚠ your engine was unavailable — this step ran on ${r.model || 'another model'}${r.flatRate === false ? ' (paid)' : ''}`);
        }
        return r.text;
      }
      // No quiet hop to a different model — a step that could not think says so (BEA-1194).
      throw new Error(`${cfg.model} could not answer: ${String((r as any)?.error || 'it returned nothing').slice(0, 160)}`);
    }
    // Optional-call: some harnesses build this service with a partial llm stub.
    const d = await this.llm.completeDetailed?.(prompt, maxTokens, purpose).catch((e: any) => ({ text: null, error: String(e?.message || e) }));
    if (d?.text?.trim()) return d.text;
    if (!d) {
      const text = await this.llm.complete?.(prompt, maxTokens, purpose).catch(() => null);
      if (text?.trim()) return text;
    }
    throw new Error(d?.error || 'the thinking step produced nothing');
  }

  /**
   * Tell the owner the budget stopped something — ONCE a day, not once a call (BEA-1204).
   *
   * A message per refused step would be noise, and noise gets muted, and a muted warning is the
   * same as no warning. The whole point is that the day Codex ran dry, nobody was told at all.
   */
  private async announceBudget(reason: string, flowName?: string): Promise<void> {
    if (!this.budget?.shouldAnnounce?.()) return;
    const t: any = await this.budget.today?.().catch(() => null);
    const detail = t ? `\n\nToday: ${t.spent.toLocaleString()} of ${t.limit.toLocaleString()} tokens. You can raise it in Settings.` : '';
    const body = `⏹ ${flowName || 'A job'} ${reason}${detail}`;
    const chat = await this.telegram.ownerChatId?.().catch(() => null);
    if (chat) await this.telegram.send(chat, body, { parse_mode: undefined }).catch(() => undefined);
    this.log.warn(`budget stop: ${reason}`);
  }

  /**
   * Should this step be refused for budget reasons? Returns the message, or '' to carry on (BEA-1204).
   *
   * Steps that cost nothing — the tier-1 tools, a text block, a search we run ourselves — are never
   * blocked. Refusing to save a document because the AI budget is gone would be absurd.
   */
  private async budgetStop(kind: string, refId: string | undefined, runTokens: number): Promise<string> {
    if (!this.budget) return '';
    if (!this.costs(kind, refId)) return '';
    const runLimit = await this.budget.runLimit?.().catch(() => 0) ?? 0;
    if (runLimit > 0 && runTokens >= runLimit) {
      return `stopped: this run reached its token budget (${runTokens.toLocaleString()} of ${runLimit.toLocaleString()}). Everything gathered so far is kept.`;
    }
    const day: any = await this.budget.check?.(0).catch(() => ({ ok: true })) ?? { ok: true };
    if (!day.ok) return `stopped: ${day.reason}`;
    return '';
  }

  /** Does this step spend tokens at all? Tier-1 tools and plain text do not. */
  private costs(kind: string, refId?: string): boolean {
    if (kind === 'skill' || kind === 'ask_ai' || kind === 'merge') return true;
    if (kind !== 'tool' || !refId) return false;
    // Everything we do ourselves is free of tokens (BEA-1194, BEA-1203). Deep research and every
    // engine tool are not. An outside-service step is deliberately NOT in this free list: it costs
    // no engine turn, but it does make one small capped call to fill its arguments (BEA-1347), and
    // the charge is the honest size of that — a few hundred tokens, not 118,000.
    const free = new Set(['search_brain', 'search_rag', 'fetch_document', 'save_document', 'save_capture', 'create_task', 'remember', 'telegram', 'whatsapp', 'web_search', 'web_read', 'web_search_meaning', 'news_collect', 'news_write', 'news_flag']);
    return !free.has(refId);
  }

  /** What a finished step cost, well enough to budget with. */
  private stepCost(kind: string, refId: string | undefined, input: string, output: string): number {
    if (!this.costs(kind, refId)) return 0;
    if (kind === 'skill') return ENGINE_TURN_TOKENS; // skills run on the engine
    if (kind === 'tool' && refId && FlowRunnerService.AGENT_TOOLS.has(refId)) return ENGINE_TURN_TOKENS;
    return Math.ceil(((input || '').length + (output || '').length) / 4);
  }

  /**
   * The tools we can simply DO, with no model involved at all (BEA-1203).
   *
   * Returns the step's output, or `null` when this id is not one of ours — so the caller falls
   * through to the engine exactly as before.
   *
   * Every one of these was an engine turn. The My Brain MCP server makes the absurdity plain: for
   * `save_document` and `remember`, the engine's whole job was to call our own `/api/agent/tools/…`
   * endpoint back. 118,000 tokens to reach a service sitting in the same process.
   *
   * The line is agency versus transformation. Deciding what to do next earns an engine turn. Filing
   * a document does not.
   */
  private async directTool(refId: string, node: any, input: string, onLine?: (t: string) => void, runId?: string): Promise<string | null> {
    const text = (input || node?.data?.sub || '').trim();
    const say = onLine || (() => undefined);

    switch (refId) {
      case 'save_document': {
        if (!text) return 'There was nothing to save — the step received no text.';
        const title = this.titleFor(node, text, 'Flow result');
        const doc = await this.saveDoc(title, text, String(node?.data?.label || 'Flow'));
        if (!doc) return 'The document could not be saved.';
        say(`   💾 saved "${doc.title}"`);
        return `Saved to your documents as "${doc.title}".\n\n${text}`;
      }

      case 'save_capture': {
        if (!text) return 'There was nothing to file — the step received no text.';
        if (!this.items?.store) return 'Capture is not available on this server.';
        const title = this.titleFor(node, text, 'From a flow');
        const r: any = await this.items.store(text, 'flow', title);
        say(r?.deduped ? '   📥 already in your captures' : `   📥 filed "${title}"`);
        return r?.deduped ? `That was already in your captures, so nothing was filed again.\n\n${text}` : `Filed into your captures as "${title}".\n\n${text}`;
      }

      case 'create_task': {
        // One task per non-empty line, so a step that produced a list does not become one giant to-do.
        const lines = text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((l) => l.length > 2).slice(0, 20);
        if (!lines.length) return 'There was nothing to add — the step received no text.';
        if (!this.tasks?.create) return 'Tasks are not available on this server.';
        const made: string[] = [];
        for (const title of lines) {
          // `auto: true` would fire a paid model call per task to write a note. Not worth it here.
          const t: any = await this.tasks.create({ title }).catch(() => null);
          if (t?.title) made.push(t.title);
        }
        if (!made.length) return 'No tasks could be created from that.';
        say(`   ✅ added ${made.length} task${made.length === 1 ? '' : 's'}`);
        return `Added ${made.length} task${made.length === 1 ? '' : 's'}:\n${made.map((t) => `• ${t}`).join('\n')}`;
      }

      case 'remember': {
        if (!text) return 'There was nothing to remember — the step received no text.';
        await this.memory.enqueue?.(text, { refType: 'flow-memory', title: this.titleFor(node, text, 'Remembered from a flow'), tags: ['flow'] });
        say('   🧠 remembered');
        return `Saved to your long-term memory.\n\n${text}`;
      }

      case 'telegram': {
        if (!text) return 'There was nothing to send — the step received no text.';
        const chat = await this.telegram.ownerChatId?.().catch(() => null);
        if (!chat) return 'Telegram is not linked, so nothing was sent. Connect it in Settings → Connections.';
        // `send` defaults to HTML, which rejects any message containing < > or & — and model output
        // is full of them. Plain text is the only safe choice for arbitrary content.
        const parts = this.chunk(text, 3900);
        // `api()` does NOT throw when Telegram refuses (blocked bot, bad chat id) — it resolves with
        // ok:false. Swallowing that and still saying "sent" is the lie this project keeps fixing.
        for (const part of parts) {
          const res: any = await this.telegram.send(chat, part, { parse_mode: undefined }).catch(() => null);
          if (res && res.ok === false) return `Telegram refused the message${res?.description ? ` (${res.description})` : ''}, so it was not sent.`;
          if (res === null) return 'Telegram could not be reached, so the message was not sent.';
        }
        say('   📨 sent to Telegram');
        return `Sent to you on Telegram.${this.cutNote(text, parts)}\n\n${text}`;
      }

      case 'whatsapp': {
        if (!text) return 'There was nothing to send — the step received no text.';
        if (!this.postbox?.sendTemplate || !this.postbox?.sendText) return 'WhatsApp is not set up on this server.';
        const to = (await this.prisma.setting?.findUnique?.({ where: { key: 'alerts.whatsappNumber' } }).catch(() => null))?.value;
        if (!to) return 'No WhatsApp number is saved, so nothing was sent. Add one in Settings.';
        // Owner-bound → the approved template first, the full text as a second message when it is
        // longer than a template line (BEA-1362). Free text alone fails outside the 24-hour window,
        // and Postbox says "sent" before Meta fails it — so the template's verdict is the honest one.
        const body = text.slice(0, 3900);
        const r = await sendOwnerAlert(this.postbox, to, {
          firstName: await ownerFirstName(this.prisma),
          headline: this.titleFor(node, text, 'A message from your flow'),
          detail: text,
          path: runId ? `/flows/runs/${runId}` : '/flows',
          longBody: body,
        }).catch((e: any): OwnerAlertResult => ({ sent: false, error: String(e?.message || e) }));
        if (!r?.sent) return `WhatsApp failed: ${r?.error || 'the message could not be delivered'}${r?.note ? ` (${r.note})` : ''}. Nothing was sent.`;
        say('   📲 sent on WhatsApp');
        const how = r.via === 'text' ? `free text — ${r.note}` : 'template';
        const cut = body.length < text.length ? ` Only the first ${body.length} characters fitted — the rest is below but was not sent.` : '';
        const follow = r.followUp === 'failed' ? ' The longer follow-up text did not go through.' : '';
        return `Sent to you on WhatsApp (${how}).${cut}${follow}\n\n${text}`;
      }

      case 'search_rag': {
        if (!text) return 'There was nothing to look up — the step received no text.';
        const hits: any[] = await this.memory.searchRag?.(text, 10).catch(() => []) ?? [];
        say(`   🗒 ${hits.length} note${hits.length === 1 ? '' : 's'} found`);
        if (!hits.length) return 'Nothing in your raw notes matched that.';
        return hits.map((h, i) => `[${i + 1}] ${h.title || 'note'}${h.when ? ` (${String(h.when).slice(0, 10)})` : ''}\n${(h.content || '').slice(0, 600)}`).join('\n\n');
      }

      case 'fetch_document': {
        if (!text) return 'No document was named.';
        // A flow step is handed prose, not an id. Take an explicit id if the node has one, else a
        // cuid/uuid out of the text, else find the closest document by searching for it.
        let id = String(node?.data?.docId || '').trim() || (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(text) || [])[0] || '';
        if (!id) {
          const found: any = await this.documents.search?.(text.slice(0, 120)).catch(() => null);
          id = found?.documents?.[0]?.id || '';
        }
        if (!id) return 'No document matched that.';
        const doc: any = await this.documents.get?.(id).catch(() => null);
        if (!doc) return 'No document was found with that id.';
        say(`   📄 opened "${doc.title || 'Untitled'}"`);
        return `# ${doc.title || 'Untitled'}\n\n${(doc.contentText || doc.content || '').slice(0, 12000)}`;
      }

      default:
        return null; // not ours — the caller decides (engine turn, or a plain model call)
    }
  }

  /** A readable title for something a flow is filing. The node's label is usually generic ("Save to Documents"). */
  private titleFor(node: any, text: string, fallback: string): string {
    const explicit = String(node?.data?.title || '').trim();
    if (explicit) return explicit.slice(0, 180);
    const heading = /^\s*#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (heading) return heading.slice(0, 180);
    const firstLine = (text.split('\n').find((l) => l.trim().length > 3) || '').trim().replace(/[#*_`>]/g, '');
    if (firstLine) return firstLine.slice(0, 120);
    return fallback;
  }

  /** Says plainly when a message was cut short. Claiming to have sent text we dropped is a lie. */
  private cutNote(text: string, parts: string[]): string {
    const sent = parts.reduce((n, p) => n + p.length, 0);
    return sent < text.length ? ` Only the first ${sent} characters fitted — the rest is below but was not sent.` : '';
  }

  /** Split for services with a message-length cap (Telegram is 4096). */
  private chunk(text: string, size: number): string[] {
    if (text.length <= size) return [text];
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out.slice(0, 5); // five messages is already too many — never spam
  }

  /** Direct second-brain lookup (RAG + SuperMemory) — fast, replaces the agent-turn that timed out. */
  private async searchBrain(query: string): Promise<string> {
    const q = (query || '').trim();
    if (!q) return '';
    const hits = await this.memory.searchBrain(q, 10).catch(() => [] as any[]);
    if (!hits.length) return 'No relevant notes were found in your brain for this.';
    return hits.map((h: any, i: number) => `[${i + 1}] ${h.title || 'note'}${h.when ? ` (${String(h.when).slice(0, 10)})` : ''}\n${(h.content || '').slice(0, 600)}`).join('\n\n');
  }

  private guidance(node: any): string {
    const g = (node?.data?.guidance || '').trim();
    return g ? `\n\nExtra guidance: ${g}` : '';
  }

  private toolPrompt(toolId: string, label: string, input: string): string {
    const map: Record<string, string> = {
      search_brain: `Search my second brain (notes, documents, saved memories) and answer:\n${input}`,
      gmail: `Look at my Gmail and answer:\n${input}`,
      calendar: `Look at my calendar and answer:\n${input}`,
      drive: `Look in my Google Drive and answer:\n${input}`,
      http: `Make the appropriate external API / HTTP request to satisfy this, then return the result:\n${input}`,
      docs: `Look at my Google Docs and answer:\n${input}`,
      sheets: `Look at my Google Sheets and answer:\n${input}`,
      slides: `Look at my Google Slides and answer:\n${input}`,
      tasks: `Look at my Google Tasks and answer:\n${input}`,
      forms: `Look at my Google Forms and answer:\n${input}`,
      meet: `Look at my Google Meet meetings and answer:\n${input}`,
      chat: `Look at my Google Chat messages and answer:\n${input}`,
      contacts: `Look in my Google Contacts and answer:\n${input}`,
      cli: `Run the command line tool needed for this and return what it printed:\n${input}`,
    };
    return map[toolId] || `Use the ${label} tool for the following:\n${input}`;
  }

  private agentRun(prompt: string, title: string, agentId?: string | null, onLine?: (t: string) => void): Promise<string> {
    // Only one branch can hold the engine at a time. Say so, rather than looking frozen (BEA-1192).
    if (this.engineQueued > 0) onLine?.(`⏳ ${title} — waiting its turn on the engine`);
    // serialise on the engine so concurrent branches don't stall each other into timeouts
    return this.runOnEngine(async () => {
      const run = await this.agent.createRun({ title, input: prompt });
      onLine?.(`▶ ${title} — working`);
      const stopMirror = this.mirrorSteps(run.id, onLine);
      try {
        // allowAsk:false — a flow's tool node must never park its helper run on a question; flow
        // HITL happens through the flow's own ask_user NODE, not the agent tool. (BEA-795)
        // agentId threaded through so the helper run gets this job's toolbox and its
        // not-connected pre-flight check too, not just direct runs. (BEA-1168)
        await this.bridge.execute(run.id, { prompt, title, save: false, allowAsk: false, ...(agentId ? { agentId } : {}) });
      } catch (e: any) {
        // A thrown execute must never leave the branch run stuck on "running". (BEA-772)
        await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined);
        throw e;
      }
      finally { stopMirror(); }
      // `allowAsk:false` only removes the guidance text — the ask_user tool is still mounted for
      // every run, so the model can park anyway. That used to return '' and the branch carried on as
      // if the step had simply produced nothing, while a real question waited out of sight. Say it
      // plainly instead, so the merged answer shows the gap. (BEA-1191)
      const after: any = await this.agent.getRun(run.id).catch(() => null);
      if (after && ['awaiting_input', 'paused'].includes(after.status)) {
        return `This step stopped to ask a question and could not finish on its own. Open the run to answer it.`;
      }
      const r: any = await this.agent.getRun(run.id).catch(() => null);
      if (r?.status === 'failed') throw new Error(r.error || 'node failed');
      return r?.resultText || '';
    });
  }

  private async merge(mode: string, outputs: string[], goal?: string, onLine?: (t: string) => void): Promise<string> {
    const parts = outputs.filter(Boolean);
    if (!parts.length) return '';
    // Every part is a "MISSING" note — there is nothing to synthesise, so say so plainly rather than
    // paying for an engine turn to write "everything is missing" (BEA-1235).
    if (parts.every((p) => /^--- .*: MISSING\./m.test(p))) {
      return `No part of this research produced anything.\n\n${parts.join('\n')}`;
    }
    if (parts.length === 1) return parts[0];
    if (mode === 'raw') return parts.map((o, i) => `## Part ${i + 1}\n\n${o}`).join('\n\n');
    const goalBlock = (goal || '').trim() ? `The original question this must answer:\n"${goal!.trim()}"\n\n` : '';
    // Through the ENGINE, not the app default (BEA-1236). This call read `'flow-merge'` as a usage
    // LABEL only, so the step that combines every branch into the final report ran on whatever the
    // general `llm` setting was — the same qwen that returned nothing twice and killed two branches.
    // Registering the helper was not enough; the call site had to change too.
    const out = await this.askModel(
      // Cited synthesis over the branch findings, anchored to the original goal. (BEA-771)
      `${goalBlock}Write ONE clear, well-structured answer to the question above by synthesising the research parts below. Rules: stay strictly on the question's topic; keep every substantive finding; remove repetition; use headings where helpful; prefer points that more than one part supports; and KEEP the source citations/URLs from the parts inline so claims stay traceable. If the parts disagree or a key point is unverified, say so briefly. If a part is marked MISSING or is raw unsummarised research, use what it does contain and state plainly, near the top, which part is missing or incomplete — never present the answer as though every part arrived.\n\n${parts.map((p, i) => `--- Research part ${i + 1} ---\n${p}`).join('\n\n')}`,
      'flow-merge',
      onLine,
      1600, // a synthesis over every branch needs more room than a single thinking step
    );
    return out || parts.join('\n\n');
  }
}
