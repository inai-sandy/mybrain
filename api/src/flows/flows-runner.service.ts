import { Injectable, Logger, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';
import { AgentService } from '../agent/agent.service';
import { LlmService } from '../llm/llm.service';
import { DocumentsService } from '../documents/documents.service';
import { MemoryService } from '../memory/memory.service';
import { SkillsService } from '../skills/skills.service';
import { TelegramService } from '../telegram/telegram.service';
import { FlowsService } from './flows.service';
import { randomBytes } from 'crypto';

type NodeResult = { status: 'running' | 'done' | 'failed' | 'skipped' | 'waiting'; output: string; kind?: string; label?: string };

/** Thrown to abort the graph walk when a flow pauses on an "Ask me" block (Move B). */
class PauseSignal { constructor(public nodeId: string) {} }

/**
 * FlowRunner (BEA-646) — runs a saved Flow's graph. Memoised async walk so independent branches run
 * in parallel; skill/tool/ask_ai nodes run through the agent engine; merge synthesises (AI or raw).
 */
@Injectable()
export class FlowRunnerService implements OnModuleInit {
  private readonly log = new Logger('FlowRunner');
  /** Runs cancelled in this process — checked before a live driver writes back, so a cancel sticks. */
  private cancelled = new Set<string>();
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
  ) {}

  onModuleInit() {
    // A flow run's driver (the execute() walk) lives in this process's memory. A restart
    // (deploy/crash/reboot — we docker rm -f on every ship) leaves 'running' rows with nothing to
    // advance them, and start()'s no-stacking guard then hands that dead run back on every future
    // Run click and schedule — the flow can never run again. Fail those orphans on boot. (BEA-776)
    this.reconcileOrphans().catch(() => undefined);
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
      const grade = agent.rubric && res.finalOutput ? await this.gradeOutput(agent.rubric, res.finalOutput) : null;
      c.running = false;
      c.lastRunId = res.runId || c.lastRunId;
      c.lastRunKind = 'flow';
      c.lastVerdict = grade?.verdict || (res.status !== 'done' ? 'fail' : 'partial');
      c.lastScore = grade?.score ?? null;
      c.lastCriteria = Array.isArray(grade?.criteria) ? grade.criteria : null;
      c.lastNotes = grade?.notes || null;
      c.lastRunAt = new Date().toISOString();
      await this.agent.setEvals(agentId, evals).catch(() => undefined);
    }
  }

  /** Run the agent's flow approach for one input (re-planned for that input), synchronously. */
  private async runForEval(realFlowId: string, input: string): Promise<{ runId: string; finalOutput: string; status: string }> {
    const fresh = await this.flows.planFlow(input).catch(() => ({ nodes: [], edges: [] }));
    const run = await this.prisma.flowRun.create({ data: { flowId: realFlowId, status: 'running', results: '{}' } });
    const synthetic = { id: realFlowId, name: 'Eval run', graph: JSON.stringify(fresh) };
    try { await this.execute(run.id, synthetic, { evalMode: true }); }
    catch (e: any) { await this.prisma.flowRun.update({ where: { id: run.id }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined); }
    const after = await this.prisma.flowRun.findUnique({ where: { id: run.id } });
    return { runId: run.id, finalOutput: after?.finalOutput || '', status: after?.status || 'failed' };
  }

  /** Grade a result against the Outcome (same rubric as agent runs). */
  private async gradeOutput(rubric: string, result: string): Promise<any | null> {
    try {
      const out = await this.llm.complete(
        `You grade an AI agent's result against the user's definition of done ("the Outcome"). Be strict but fair.\n\nThe Outcome:\n${rubric.slice(0, 1500)}\n\nThe agent's result:\n${result.slice(0, 3000)}\n\nReply with ONLY JSON, no prose:\n{"verdict":"pass|partial|fail","score":<0-100 integer>,"criteria":[{"text":"<short criterion>","met":true|false}],"notes":"<one short sentence>"}`,
        700, 'flow-eval-grade',
      );
      const m = (out || '').match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch { return null; }
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
  private runOnEngine<T>(fn: () => Promise<T>): Promise<T> {
    const out = this.engineChain.then(fn, fn);
    this.engineChain = out.then(() => undefined, () => undefined);
    return out;
  }

  private parse(s?: string | null): any { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
  private parseArr(s?: string | null): any[] { try { const a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
  private shape(r: any) { return { ...r, results: this.parse(r.results), documents: this.parseArr(r.documentIds), waitOptions: this.parseArr(r.waitOptions), terminal: this.parseArr(r.terminal) }; }

  /** A clean play-by-play line for the terminal, per node kind (workspace ②). */
  private termLine(node: any, output: string): string | null {
    const kind = node.data?.kind;
    const label = node.data?.label || '';
    const ref = node.data?.refId;
    if (kind === 'tool') {
      if (ref === 'search_brain') return '🧠 searched your brain';
      if (ref === 'web_search') return '🌐 searched the web';
      if (ref === 'web_read') return '📄 read the page(s)';
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
    return rows.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, finalOutput: r.finalOutput?.slice(0, 240) || null, documents: this.parseArr(r.documentIds) }));
  }

  async start(flowId: string): Promise<{ runId: string }> {
    const flow = await this.prisma.flow.findUnique({ where: { id: flowId } });
    if (!flow) throw new NotFoundException('Flow not found');
    // No stacking: if this flow already has a live run, return it instead of starting another. (BEA-772)
    const active = await this.prisma.flowRun.findFirst({ where: { flowId, status: { in: ['running', 'waiting'] } }, orderBy: { startedAt: 'desc' } });
    if (active) return { runId: active.id };
    const run = await this.prisma.flowRun.create({ data: { flowId, status: 'running', results: '{}' } });
    void this.execute(run.id, flow).catch(async (e) => {
      this.log.error(`flow run ${run.id} crashed: ${e?.message || e}`);
      await this.prisma.flowRun.update({ where: { id: run.id }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined);
      this.telegram.notifyFlowDone({ flowName: flow?.name, status: 'failed' }).catch(() => undefined);
    });
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
    const graph = this.parse(flow.graph);
    const nodes = new Map<string, any>((graph.nodes || []).map((n: any) => [n.id, n]));
    const incoming = new Map<string, string[]>();
    for (const n of graph.nodes || []) incoming.set(n.id, []);
    for (const e of graph.edges || []) if (incoming.has(e.target)) incoming.get(e.target)!.push(e.source);

    // Resume-safe (Move B): start from whatever finished before a pause/restart so we don't re-run it.
    const runRow = await this.prisma.flowRun.findUnique({ where: { id: runId } });
    const results: Record<string, NodeResult> = this.parse(runRow?.results) || {};
    const terminal: { text: string; at: number }[] = this.parseArr(runRow?.terminal);
    const memo = new Map<string, Promise<string>>();
    for (const [nid, rr] of Object.entries(results)) if ((rr as NodeResult)?.status === 'done') memo.set(nid, Promise.resolve((rr as NodeResult).output || ''));
    const persist = () => this.cancelled.has(runId) ? Promise.resolve(undefined) : this.prisma.flowRun.update({ where: { id: runId }, data: { results: JSON.stringify(results), terminal: JSON.stringify(terminal.slice(-300)) } }).catch(() => undefined);
    const term = (text: string) => { terminal.push({ text, at: Date.now() }); };
    if (!opts.evalMode && !terminal.length) term('▶ started');

    const outputOf = (nodeId: string): Promise<string> => {
      if (memo.has(nodeId)) return memo.get(nodeId)!;
      const p = (async (): Promise<string> => {
        const node = nodes.get(nodeId);
        if (!node) return '';
        const kind = node.data?.kind;
        const label = node.data?.label;
        if (node.data?.enabled === false) { results[nodeId] = { status: 'skipped', output: '', kind, label }; await persist(); return ''; }
        const ups = incoming.get(nodeId) || [];
        const upOuts = await Promise.all(ups.map((s) => outputOf(s)));
        const live = upOuts.filter(Boolean);
        const input = live.join('\n\n');
        // "Ask me" block — pause durably until the user answers (Move B). An already-answered one
        // is seeded in the memo above, so reaching here means it still needs an answer.
        if (kind === 'ask_user') {
          // In eval mode there's no one to answer — skip it so the regression test doesn't hang.
          if (opts.evalMode) { results[nodeId] = { status: 'skipped', output: '', kind, label }; await persist(); return ''; }
          await this.pauseForInput(runId, flow, node, input, results);
          throw new PauseSignal(nodeId);
        }
        results[nodeId] = { status: 'running', output: '', kind, label }; await persist();
        try {
          const output = await this.runNode(node, input, live);
          results[nodeId] = { status: 'done', output, kind, label };
          const line = this.termLine(node, output);
          if (line) term(`${line}`);
          await persist();
          return output;
        } catch (e: any) {
          if (e instanceof PauseSignal) throw e;
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

    let finalOutput = '';
    for (const n of terminals) { const r = results[n.id]; if (r?.output) finalOutput = r.output; }

    // Save the outputs as Documents you can browse later (Agent↔Flow merge ④) — but not for eval runs.
    // If the run was cancelled while this driver was mid-flight, don't resurrect it as 'done'. (BEA-776)
    if (this.cancelled.has(runId)) { this.cancelled.delete(runId); return; }
    const docs = opts.evalMode ? [] : await this.saveDocuments(flow, graph, incoming, results, finalOutput);
    if (!opts.evalMode) term('✓ done');

    await this.prisma.flowRun.update({ where: { id: runId }, data: { status: 'done', finalOutput, results: JSON.stringify(results), documentIds: JSON.stringify(docs), terminal: JSON.stringify(terminal.slice(-300)), endedAt: new Date(), waitNodeId: null, waitQuestion: null, waitToken: null } });

    // Notify on a background/long run so you know it's ready even if you walked away (workspace ⑥).
    if (!opts.evalMode && runRow?.startedAt && Date.now() - new Date(runRow.startedAt).getTime() > 60_000) {
      this.telegram.notifyFlowDone({ flowName: flow?.name, status: 'done', snippet: finalOutput }).catch(() => undefined);
    }
  }

  /** Persist the pause (status 'waiting') + notify the user (Move B). */
  private async pauseForInput(runId: string, flow: any, node: any, input: string, results: Record<string, NodeResult>) {
    const label = node.data?.label || 'Ask me';
    const base = node.data?.question || node.data?.sub || node.data?.text || 'Your input is needed to continue.';
    const question = input ? `${base}\n\n${input.slice(0, 1500)}` : base;
    const options = Array.isArray(node.data?.options) ? node.data.options : [];
    const kind = node.data?.askKind || (options.length ? 'choice' : 'free_text');
    results[node.id] = { status: 'waiting', output: '', kind: 'ask_user', label };
    await this.prisma.flowRun.update({
      where: { id: runId },
      data: { status: 'waiting', results: JSON.stringify(results), waitNodeId: node.id, waitQuestion: question, waitKind: kind, waitOptions: JSON.stringify(options), waitToken: randomBytes(16).toString('hex') },
    });
    this.telegram.notifyFlowWaiting({ flowName: flow?.name, question }).catch(() => undefined);
  }

  /** Answer the open "Ask me" question and resume the run (Move B). */
  async answer(runId: string, answer: string) {
    const run = await this.prisma.flowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');
    if (run.status !== 'waiting' || !(run as any).waitNodeId) return { ok: false, message: 'This run is not waiting for an answer.' };
    const flow = run.flowId ? await this.prisma.flow.findUnique({ where: { id: run.flowId } }) : null;
    const results: Record<string, NodeResult> = this.parse(run.results) || {};
    const nodeId = (run as any).waitNodeId as string;
    results[nodeId] = { status: 'done', output: String(answer || ''), kind: 'ask_user', label: results[nodeId]?.label || 'Ask me' };
    await this.prisma.flowRun.update({ where: { id: runId }, data: { status: 'running', results: JSON.stringify(results), waitNodeId: null, waitQuestion: null, waitToken: null } });
    void this.execute(runId, flow).catch(async (e) => {
      this.log.error(`flow run ${runId} crashed on resume: ${e?.message || e}`);
      await this.prisma.flowRun.update({ where: { id: runId }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined);
    });
    return { ok: true };
  }

  /** Persist branch parts (when >1) + the final output as Documents; returns [{id, slug, title}]. */
  private async saveDocuments(flow: any, graph: any, incoming: Map<string, string[]>, results: Record<string, NodeResult>, finalOutput: string) {
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
        const d = await this.saveDoc(`${name} — ${branchTitle(sid).slice(0, 90)}`, r.output, name);
        if (d) docs.push(d);
      }
    }
    if (finalOutput?.trim()) { const d = await this.saveDoc(`${name} — result`, finalOutput, name); if (d) docs.push(d); }
    return docs;
  }

  private async saveDoc(title: string, content: string, flowName: string): Promise<{ id: string; slug: string; title: string } | null> {
    try {
      // pass description + tags so DocumentsService skips its (paid) AI summarise pass
      const doc: any = await this.documents.create({ title: title.slice(0, 180), contentText: content, kind: 'md', description: content.replace(/\s+/g, ' ').slice(0, 180), tags: ['flow', flowName.slice(0, 40)] });
      return { id: doc.id, slug: doc.slug, title: doc.title };
    } catch (e: any) { this.log.warn(`flow doc save failed: ${e?.message || e}`); return null; }
  }

  // Tools that genuinely need the agent engine (web/browse/connectors/external actions).
  private static AGENT_TOOLS = new Set(['web_search', 'web_read', 'gmail', 'calendar', 'drive', 'save_document', 'telegram', 'http']);

  private async runNode(node: any, input: string, inputs: string[]): Promise<string> {
    const kind = node.data?.kind;
    const label = node.data?.label || '';
    const refId = node.data?.refId;
    switch (kind) {
      case 'question': return node.data?.sub || input || '';
      // Thread the whole research goal into every branch so a sub-search can't drift off-topic. (BEA-771)
      case 'subquestion': {
        const goal = (input || '').trim(); // upstream = the original question (+ prior branch findings)
        const focus = (node.data?.sub || '').trim();
        if (!focus) return goal;
        if (!goal) return focus;
        return `OVERALL RESEARCH GOAL (interpret every term and stay strictly within this):\n${goal}\n\nTHIS BRANCH FOCUSES ON:\n${focus}`;
      }
      case 'text': return node.data?.text || node.data?.sub || '';
      case 'note': case 'wait': case 'if': case 'filter': return input; // pass-through (v0)
      case 'output': return input;
      case 'merge': return this.merge(node.data?.mode || 'ai', inputs, node.data?.goal);
      // search_brain is a fast direct lookup — never a slow agent turn (was timing out).
      case 'tool':
        if (refId === 'search_brain') return this.searchBrain(input || node.data?.sub || '');
        if (FlowRunnerService.AGENT_TOOLS.has(refId)) {
          // Title the branch run by its sub-question, not a generic "Web search". (BEA-772)
          const focus = /THIS BRANCH FOCUSES ON:\s*([^\n]+)/.exec(input || '')?.[1]?.trim();
          const runTitle = focus ? focus.slice(0, 70) : `Flow · ${label}`;
          return this.agentRun(this.toolPrompt(refId, label, input) + this.guidance(node), runTitle);
        }
        return this.askModel(this.toolPrompt(refId, label, input) + this.guidance(node)); // unknown tool → reason directly
      // Move A: run the REAL skill in Codex with its folder in the working dir; fall back to the model.
      case 'skill': {
        const slug = await this.skillSlug(refId);
        if (slug) {
          const p = `Use the "${label}" skill — its files are in your working directory; read SKILL.md and follow it. Do the following and reply with ONLY the finished result.${this.guidance(node)}\n\n${input}`;
          return this.bridge.runSkillTurn(slug, p).catch(() => this.askModel(`Carry out the following in the style/approach of the "${label}" skill. Reply with only the finished result.${this.guidance(node)}\n\n${input}`));
        }
        return this.askModel(`Carry out the following in the style/approach of the "${label}" skill. Reply with only the finished result.${this.guidance(node)}\n\n${input}`);
      }
      // Ask AI is pure reasoning over the upstream input — a direct model call, not a Codex turn.
      case 'ask_ai': {
        const p = (input || node.data?.sub || '').trim();
        return p ? this.askModel(`Based on the following, write a clear, well-structured answer. Be specific and useful; do not pad.\n\n${p}`) : '';
      }
      default: return input;
    }
  }

  /** Direct model call (fast, no engine) for reasoning blocks. */
  private async askModel(prompt: string): Promise<string> {
    return (await this.llm.complete(prompt, 1500, 'flow-node').catch(() => '')) || '';
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
      web_search: `You are researching one part of a larger goal (stated below). Search the web for THIS part, staying strictly within the overall goal — interpret every ambiguous term the way the goal intends (e.g. a name may be a specific GitHub repo or product named in the goal, not a generic word). Answer concisely and cite the sources (URLs) you actually used.\n\n${input}`,
      web_read: `Open and read the most relevant page(s) for this — staying within the overall goal stated below — then answer with citations:\n${input}`,
      gmail: `Look at my Gmail and answer:\n${input}`,
      calendar: `Look at my calendar and answer:\n${input}`,
      drive: `Look in my Google Drive and answer:\n${input}`,
      save_document: `Save the following as a document in my library, then confirm with the title:\n${input}`,
      telegram: `Send the following to me on Telegram, then confirm:\n${input}`,
      http: `Make the appropriate external API / HTTP request to satisfy this, then return the result:\n${input}`,
    };
    return map[toolId] || `Use the ${label} tool for the following:\n${input}`;
  }

  private agentRun(prompt: string, title: string): Promise<string> {
    // serialise on the engine so concurrent branches don't stall each other into timeouts
    return this.runOnEngine(async () => {
      const run = await this.agent.createRun({ title, input: prompt });
      try {
        await this.bridge.execute(run.id, { prompt, title, save: false });
      } catch (e: any) {
        // A thrown execute must never leave the branch run stuck on "running". (BEA-772)
        await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'failed', error: String(e?.message || e), endedAt: new Date() } }).catch(() => undefined);
        throw e;
      }
      const r: any = await this.agent.getRun(run.id).catch(() => null);
      if (r?.status === 'failed') throw new Error(r.error || 'node failed');
      return r?.resultText || '';
    });
  }

  private async merge(mode: string, outputs: string[], goal?: string): Promise<string> {
    const parts = outputs.filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    if (mode === 'raw') return parts.map((o, i) => `## Part ${i + 1}\n\n${o}`).join('\n\n');
    const goalBlock = (goal || '').trim() ? `The original question this must answer:\n"${goal!.trim()}"\n\n` : '';
    const out = await this.llm.complete(
      // Cited synthesis over the branch findings, anchored to the original goal. (BEA-771)
      `${goalBlock}Write ONE clear, well-structured answer to the question above by synthesising the research parts below. Rules: stay strictly on the question's topic; keep every substantive finding; remove repetition; use headings where helpful; prefer points that more than one part supports; and KEEP the source citations/URLs from the parts inline so claims stay traceable. If the parts disagree or a key point is unverified, say so briefly.\n\n${parts.map((p, i) => `--- Research part ${i + 1} ---\n${p}`).join('\n\n')}`,
      1600,
      'flow-merge',
    );
    return out || parts.join('\n\n');
  }
}
