import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Engine run types (formerly in the now-removed hermes.client).
export type RunStep = { label: string; status?: string; detail?: string; kind?: string };
export interface HermesRunHandlers {
  onStep?: (step: RunStep) => void;
  onClarify?: (q: { requestId?: string; question: string; choices?: string[] }) => Promise<string>;
  onApproval?: (a: { command?: string; description?: string }) => Promise<string>;
}
export interface HermesRunResult { sessionId: string; finalText: string; status: string; error?: string; usage?: any }
import { AgentService } from '../agent/agent.service';
import { DocumentsService } from '../documents/documents.service';
import { TelegramService } from '../telegram/telegram.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { PushService } from '../push/push.service';
import { AlertsService } from '../push/alerts.service';
import { PromptsService } from '../prompts/prompts.service';
import { SkillsService } from '../skills/skills.service';

const HUMAN_WAIT_MS = 20 * 60 * 1000; // how long a mid-run question stays open before the default is applied
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CODEX_RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';
const codexToolLabel = (n?: string) => (n === 'mybrain' ? 'Used your brain' : n ? `Used ${n}` : 'Used a tool');

export type StartRunInput = {
  prompt: string;
  title?: string;
  agentId?: string;
  saveCollectionId?: string | null;
  /** Save the final answer as a Document (default true). */
  save?: boolean;
  /** Quick mode: skip recall + learn-after + document save, just reply concisely (BEA-630). */
  quick?: boolean;
  /** Run depth (BEA-695): quick = fast single turn, no save; standard = research+save. (deep = flow, routed by callers) */
  depth?: 'quick' | 'standard' | 'deep';
  /** The Outcome (definition of done) to grade this run against (BEA-641). */
  rubric?: string;
  /** Offer the durable ask_user tool (BEA-795). Flows + evals set false — they must never park. */
  allowAsk?: boolean;
  /** Run inside this deployed skill's folder (single-skill agents, BEA-1079). */
  skill?: string;
};

/**
 * HermesBridgeService (BEA-618) — orchestrates one agent run on Hermes and mirrors it into our
 * shell: streams the engine's steps into the AgentRun (the run screen polls those), and saves the
 * result into Documents. Hermes is the doer; My Brain owns the record + the output.
 */
@Injectable()
export class HermesBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('HermesBridge');
  private resumeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly resuming = new Set<string>();

  constructor(
    private readonly agent: AgentService,
    private readonly documents: DocumentsService,
    private readonly telegram: TelegramService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly push: PushService,
    // Optional so test harnesses that build with fewer args keep working.
    private readonly alerts?: AlertsService,
    private readonly prompts?: PromptsService,
    private readonly skillsSvc?: SkillsService,
  ) {}

  onModuleInit() {
    // Resume sweeper (BEA-795): wakes parked runs whose question has been answered. DB-backed, so
    // an answer given days later — or before a restart — still resumes the run.
    this.resumeTimer = setInterval(() => void this.resumeTick().catch(() => undefined), 5_000);
    if (typeof this.resumeTimer.unref === 'function') this.resumeTimer.unref();
  }

  onModuleDestroy() {
    if (this.resumeTimer) clearInterval(this.resumeTimer);
  }

  /** Where agent outputs go when nothing specific is set: a dedicated "Agent outputs" collection (kept separate from real Documents). */
  private async defaultCollectionId(): Promise<string | null> {
    try {
      const res: any = await this.documents.listCollections();
      const cols = res?.collections || res || [];
      const existing = cols.find((c: any) => c.name === 'Agent outputs');
      if (existing) return existing.id;
      const created: any = await this.documents.createCollection('Agent outputs', '#6366f1', '🤖');
      return created?.id || created?.collection?.id || null;
    } catch {
      return null;
    }
  }

  /**
   * Research-first guidance appended to the task (BEA-692): research the topic, THEN consult the
   * user's brain via the search_brain tool, reconciling and trusting the user's own notes for their
   * own terms. Replaces the old "pre-inject the brain recall" behaviour.
   */
  private researchGuidance(quick: boolean, brainAvailable: boolean): string {
    const brainStep = brainAvailable
      ? '\n2. THEN check the user\'s own second brain — call the search_brain tool to find anything they\'ve already saved on this, and weave it in / reconcile it with your research.'
      : '';
    const trust = brainAvailable
      ? ' Treat the user\'s own notes as authoritative for THEIR terms, projects, people and decisions — if something is the user\'s own concept or framework, research it on their terms; never lead with "I couldn\'t verify X" when X is the user\'s own thing.'
      : '';
    if (quick) {
      return `\n\nAnswer concisely. Research the topic (don\'t rely on memory alone)${brainAvailable ? '; quickly check the user\'s brain with the search_brain tool if it helps' : ''}.${trust} Keep it short. Do not save anything.`;
    }
    return `\n\n---\nHow to approach this:\n1. Research the topic properly FIRST — use web search and read sources, combined with what you know. Be thorough; don\'t stop at a single search.${brainStep}\n3. Give a clear, well-structured answer. **Cite your sources inline** as [1], [2]… and end with a short "Sources" list (web links + which brain notes you used) so the reader can verify. Don\'t state facts you couldn\'t support.${trust}`;
  }

  /**
   * Durable ask-the-user guidance (BEA-795): the model can pause the run on a real question via the
   * mybrain ask_user MCP tool; the run parks durably and resumes when the user answers — even days
   * later. How eagerly it may ask follows the autonomy setting.
   */
  private askGuidance(runId: string, autonomy: string): string {
    const base =
      `\n\nAsking the user: you may ask the user a question mid-task with the mybrain ask_user tool — pass runId "${runId}". ` +
      `Reading and searching NEVER need permission — never ask before looking something up or researching. ` +
      `But before ANY action you cannot take back (sending a message to a real person, deleting something, spending money), you MUST ask first and put the exact message/action in the tool's \`draft\` field so the user can approve, edit, or reject it. ` +
      `If the tool replies that the user is not available, END YOUR TURN immediately with a one-line note that you are waiting; the run pauses safely and you will be resumed with their answer. Never invent an answer to your own question.`;
    if (autonomy === 'autopilot') return `${base}\nBeyond that: never ask — use your best judgment, and simply SKIP irreversible actions instead of asking.`;
    if (autonomy === 'balanced') return `${base}\nBeyond that: only ask when a wrong guess would waste the whole run; otherwise proceed on your best judgment.`;
    return `${base}\nBeyond that: ask whenever a real decision, preference, or fact only the user knows would change the result (autonomy: cautious). Don't ask about trivia.`;
  }

  private lastStaleSweep = 0;

  /** BEA-795: find parked runs whose question has been answered and resume each exactly once. */
  async resumeTick() {
    // Gentle auto-pause of questions that waited past the TTL (BEA-1068) — checked every 10 min,
    // notified exactly once per pause.
    if (Date.now() - this.lastStaleSweep > 600_000) {
      this.lastStaleSweep = Date.now();
      const paused = await this.agent.pauseStaleAsks().catch(() => [] as any[]);
      for (const p of paused) {
        await this.telegram.notifyAgentPaused({ runTitle: p.title || 'Your agent', question: p.question, waitedHours: p.waitedHours }).catch(() => undefined);
        await this.push?.send({ title: `${p.title || 'Your agent'} paused itself`, body: `Waited ${p.waitedHours}h for: ${String(p.question).slice(0, 120)}`, url: '/agent', tag: `pause-${p.runId}`, isAsk: true }).catch(() => undefined);
      }
    }
    const runs = await this.agent.listResumable().catch(() => [] as any[]);
    for (const run of runs) {
      if (this.resuming.has(run.id)) continue;
      const sessionId = run.sessionId || undefined; // read before the claim clears the marker
      if (!(await this.agent.claimResume(run.id).catch(() => false))) continue;
      this.resuming.add(run.id);
      this.resumeRun(run, sessionId)
        .catch(async (e) => {
          this.log.error(`resume of run ${run.id} crashed: ${e?.message || e}`);
          await this.agent.finishRun(run.id, { status: 'failed', error: friendlyError(e?.message || String(e)) }).catch(() => undefined);
        })
        .finally(() => this.resuming.delete(run.id));
    }
  }

  /** Continue a parked run's engine session with the user's answer (fresh session if none was kept). */
  private async resumeRun(run: any, sessionId?: string) {
    const cfg = await this.agent.engineSettings();
    const agentRow: any = run.agentId ? await this.agent.getAgent(run.agentId).catch(() => null) : null;
    const answered = (run.waitpoints || [])
      .filter((w: any) => w.status === 'answered')
      .sort((a: any, b: any) => new Date(a.answeredAt || 0).getTime() - new Date(b.answeredAt || 0).getTime());
    const wp = answered[answered.length - 1];
    const raw = typeof wp?.answer === 'string' ? wp.answer : JSON.stringify(wp?.answer ?? 'proceed');
    // Typed answers read as instructions, not just values (BEA-1067): approve/reject/edited-draft.
    const answer =
      wp?.kind === 'approve_edit_reject'
        ? raw === 'approve'
          ? 'APPROVED — go ahead exactly as drafted.'
          : raw === 'reject'
            ? 'NO — do not do it; adjust your approach or finish without it.'
            : `EDITED the draft — use this exact version instead:\n${raw}`
        : raw;
    await this.agent.appendStep(run.id, { label: 'You answered — resuming', status: 'done', detail: String(raw).slice(0, 200) }).catch(() => undefined);
    const input: StartRunInput = {
      prompt: run.input || '',
      title: run.title || undefined,
      agentId: run.agentId || undefined,
      rubric: agentRow?.rubric || undefined,
      saveCollectionId: agentRow?.collectionId ?? null,
      depth: run.depth === 'quick' ? 'quick' : 'standard',
    };
    // With a kept session the engine remembers the task; without one, restate it so the fresh
    // session is self-contained.
    const prompt =
      `${sessionId ? '' : `The task:\n${run.input || ''}\n\n`}You asked the user: "${wp?.question || ''}"\n` +
      `The user answered: "${answer}"\n\nContinue the task from where you stopped, take the answer into account, and complete it.` +
      this.askGuidance(run.id, cfg.autonomy);
    await this.driveTurn(run.id, input, cfg, prompt, sessionId);
  }

  /** Learn-after: propose a few durable facts from the result (the user keeps/forgets later). */
  private async proposeLearnings(runId: string, result: string): Promise<void> {
    try {
      const out = await this.llm.complete(
        `Read this agent result and list up to 3 SHORT durable facts worth remembering long-term — about the user, their projects, or useful knowledge they gathered. One per line, plain text, no bullets or numbering. If nothing is worth keeping, output nothing.\n\nResult:\n${result.slice(0, 2500)}`,
        200,
        'agent-learn',
      );
      const facts = (out || '').split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter((s) => s.length > 3).slice(0, 3);
      if (facts.length) {
        await this.agent.setLearnings(runId, facts.map((text) => ({ text, status: 'proposed' })));
        await this.agent.appendStep(runId, { label: `Noted ${facts.length} thing${facts.length > 1 ? 's' : ''} I learned`, status: 'done' }).catch(() => undefined);
      }
    } catch { /* learnings are best-effort */ }
  }

  /** Grade-and-iterate (BEA-641): score the result against the agent's Outcome (definition of done). */
  private async gradeRun(rubric: string, result: string): Promise<any | null> {
    try {
      const out = await this.llm.complete(
        `You grade an AI agent's result against the user's definition of done ("the Outcome"). Be strict but fair.\n\nThe Outcome:\n${rubric.slice(0, 1500)}\n\nThe agent's result:\n${result.slice(0, 3000)}\n\nReply with ONLY JSON, no prose:\n{"verdict":"pass|partial|fail","score":<0-100 integer>,"criteria":[{"text":"<short criterion>","met":true|false}],"notes":"<one short sentence>"}`,
        400,
        'agent-grade',
      );
      const m = (out || '').match(/\{[\s\S]*\}/);
      if (!m) return null;
      const g = JSON.parse(m[0]);
      const verdict = ['pass', 'partial', 'fail'].includes(g.verdict) ? g.verdict : 'partial';
      const score = Math.max(0, Math.min(100, Math.round(Number(g.score) || 0)));
      const criteria = Array.isArray(g.criteria) ? g.criteria.slice(0, 8).map((c: any) => ({ text: String(c.text || '').slice(0, 160), met: !!c.met })) : [];
      return { verdict, score, criteria, notes: String(g.notes || '').slice(0, 240) };
    } catch {
      return null;
    }
  }

  /** Pause the run on a durable question, notify over Telegram, and wait for the answer (or the timeout default). */
  private async askHuman(runId: string, runTitle: string | undefined, q: { question: string; kind: string; options?: unknown; defaultValue?: string }, timeoutMs = HUMAN_WAIT_MS): Promise<string> {
    const wp = await this.agent.ask(runId, { question: q.question, kind: q.kind as any, options: q.options ?? [], defaultValue: q.defaultValue, expiresInMs: timeoutMs });
    await this.agent.appendStep(runId, { label: 'Asked you', status: 'awaiting', detail: q.question }).catch(() => undefined);
    await this.telegram.pushAgentQuestion({ runTitle, waitpointId: wp.id, question: q.question, kind: wp.kind, options: wp.options }).catch(() => undefined);
    // poll the durable waitpoint until it's answered (here or on Telegram) or the timeout sweeper applies the default
    for (let i = 0; i < timeoutMs / 2000 + 60; i++) {
      await sleep(2000);
      const cur = await this.agent.getWaitpoint(wp.resumeToken).catch(() => null);
      if (!cur) continue;
      if (cur.status === 'answered') { await this.agent.appendStep(runId, { label: 'You answered', status: 'done', detail: String(cur.answer) }).catch(() => undefined); return String(cur.answer ?? q.defaultValue ?? 'proceed'); }
      if (cur.status === 'expired' || cur.status === 'cancelled') break;
    }
    return q.defaultValue ?? 'proceed';
  }

  /**
   * The "describe it" box (BEA-1063, replacing the thin BEA-643 draft): one plain sentence in, a
   * COMPLETE agent out — name, icon, colour, category, a numbered step plan, Outcome, autonomy,
   * depth, a schedule when the idea implies one, and test cases. Nothing is created here; the user
   * reviews the draft card and saves.
   */
  async draftAgent(idea: string): Promise<any> {
    const fallback = { name: 'New agent', icon: '🤖', color: null, category: null, description: '', prompt: idea.trim().slice(0, 2000), rubric: '', autonomy: 'cautious', defaultDepth: 'standard', schedule: null, scheduleText: null, evals: [] as string[] };
    try {
      const tpl = (await this.prompts?.get('agent.metaDraft').catch(() => '')) || '';
      const prompt = tpl
        ? tpl.replaceAll('{{idea}}', idea.slice(0, 600))
        : `Turn this idea into a config for a small AI agent. The user said:\n"${idea.slice(0, 600)}"\nReply with ONLY JSON: {"name":"...","task":"...","outcome":["..."],"evals":["..."]}`;
      const out = await this.llm.complete(prompt, 1100, 'agent-draft');
      const m = (out || '').match(/\{[\s\S]*\}/);
      if (!m) return fallback;
      const g = JSON.parse(m[0]);
      const CATS = ['Daily', 'Research', 'People', 'Brain care', 'Other'];
      const sched = g.schedule && typeof g.schedule === 'object' && ['day', 'weekday', 'week', 'hour'].includes(g.schedule.every) ? g.schedule : null;
      return {
        name: String(g.name || 'New agent').slice(0, 80),
        icon: typeof g.icon === 'string' && g.icon.trim() ? g.icon.trim().slice(0, 4) : '🤖',
        color: typeof g.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(g.color.trim()) ? g.color.trim() : null,
        category: CATS.includes(g.category) ? g.category : null,
        description: String(g.description || '').slice(0, 200),
        prompt: String(g.task || idea).trim().slice(0, 2000),
        rubric: Array.isArray(g.outcome) ? g.outcome.map((s: any) => `- ${String(s).trim()}`).join('\n').slice(0, 1500) : String(g.outcome || '').slice(0, 1500),
        autonomy: ['cautious', 'balanced', 'autopilot'].includes(g.autonomy) ? g.autonomy : 'cautious',
        defaultDepth: g.depth === 'quick' ? 'quick' : 'standard',
        schedule: sched,
        scheduleText: sched ? String(g.scheduleText || '').slice(0, 80) || null : null,
        evals: Array.isArray(g.evals) ? g.evals.slice(0, 5).map((s: any) => String(s).trim().slice(0, 200)).filter(Boolean) : [],
      };
    } catch {
      return fallback;
    }
  }

  /** Design (or redesign) an agent's mini-interface spec from the approved blocks (BEA-1082). */
  async generateUi(agentId: string): Promise<any> {
    const a: any = await this.agent.getAgent(agentId);
    const fallback = { headline: `Run ${a.name}`, inputs: a.schedule ? [] : [{ key: 'ask', label: 'What should it work on?', type: 'text', placeholder: 'Type it in your own words…' }], view: 'report', runLabel: 'Run →' };
    try {
      const tpl = (await this.prompts?.get('agent.uiSpec').catch(() => '')) || '';
      if (!tpl) return this.saveUi(agentId, fallback);
      const out = await this.llm.complete(
        tpl.replaceAll('{{name}}', a.name || '').replaceAll('{{description}}', a.description || '').replaceAll('{{task}}', (a.prompt || '').slice(0, 800)),
        400,
        'agent-ui-spec',
      );
      const m = (out || '').match(/\{[\s\S]*\}/);
      if (!m) return this.saveUi(agentId, fallback);
      const g = JSON.parse(m[0]);
      const TYPES = ['topic', 'text', 'url', 'contact', 'date', 'choice'];
      const spec = {
        headline: String(g.headline || fallback.headline).slice(0, 120),
        inputs: (Array.isArray(g.inputs) ? g.inputs : []).slice(0, 2).map((i: any) => ({
          key: String(i.key || 'ask').replace(/[^a-z0-9_]/gi, '').slice(0, 30) || 'ask',
          label: String(i.label || 'Input').slice(0, 60),
          type: TYPES.includes(i.type) ? i.type : 'text',
          placeholder: String(i.placeholder || '').slice(0, 120),
          ...(i.type === 'choice' && Array.isArray(i.options) ? { options: i.options.slice(0, 6).map((o: any) => String(o).slice(0, 40)) } : {}),
        })),
        view: ['report', 'brief', 'checklist', 'plain'].includes(g.view) ? g.view : 'report',
        runLabel: String(g.runLabel || 'Run →').slice(0, 30),
      };
      return this.saveUi(agentId, spec);
    } catch {
      return this.saveUi(agentId, fallback);
    }
  }

  private async saveUi(agentId: string, spec: any) {
    await this.agent.updateAgent(agentId, { ui: spec } as any).catch(() => undefined);
    return spec;
  }

  /** "Saved by agents" (BEA-700): everything agents wrote — Documents (tag 'agent') + brain learnings. */
  async listSavedByAgents(): Promise<{ documents: any[]; brainLearnings: { id: string; title: string }[] }> {
    let documents: any[] = [];
    try {
      const res: any = await this.documents.list();
      const rows = res?.documents || res || [];
      documents = rows
        .filter((d: any) => (Array.isArray(d.tags) ? d.tags : []).includes('agent'))
        .map((d: any) => ({ id: d.id, title: d.title, snippet: (d.description || '').slice(0, 160), when: d.createdAt || d.updatedAt }));
    } catch { /* */ }
    const brainLearnings = await this.memory.listRagByTag('learning').catch(() => []);
    return { documents, brainLearnings };
  }

  /** Undo one agent-saved Document. */
  async deleteSavedDocument(id: string) {
    await this.documents.remove(id);
    return { ok: true };
  }

  /** Clear ALL kept agent learnings from both brain stores (no per-item provenance to undo singly yet). */
  async clearAgentLearnings() {
    return this.memory.purgeByTag('learning');
  }

  /**
   * Replay (BEA-1070): re-run a finished run on the SAME captured input, against the agent's
   * CURRENT definition. The new run is linked back via its first step.
   */
  async replayRun(runId: string) {
    const old: any = await this.agent.getRun(runId); // throws NotFound if missing
    if (['running', 'awaiting_input', 'paused'].includes(old.status)) return { ok: false, message: 'That run is still in progress — nothing to replay yet.' };
    if (!old.input) return { ok: false, message: 'That run kept no input, so it cannot be replayed.' };
    const agentRow: any = old.agentId ? await this.agent.getAgent(old.agentId).catch(() => null) : null;
    const depth = old.depth === 'quick' ? 'quick' : 'standard';
    const input: StartRunInput = {
      prompt: old.input,
      title: old.title || 'Agent run',
      agentId: old.agentId || undefined,
      rubric: agentRow?.rubric || undefined,
      saveCollectionId: agentRow?.collectionId ?? null,
      depth,
    };
    const run = await this.agent.createRun({ agentId: old.agentId ?? null, title: input.title, input: old.input, depth });
    // The link step goes in BEFORE the engine fires — appending after raced execute()'s own first
    // step (read-modify-write on the step log) and could lose the write.
    await this.agent.appendStep(run.id, { label: '↻ Replay of an earlier run', status: 'info', detail: `original: ${old.title || old.id} · ${new Date(old.startedAt).toLocaleString()}` }).catch(() => undefined);
    this.execute(run.id, input).catch(async (e) => {
      this.log.error(`replay run ${run.id} crashed: ${e?.message || e}`);
      await this.agent.finishRun(run.id, { status: 'failed', error: friendlyError(e?.message || String(e)) }).catch(() => undefined);
    });
    return run;
  }

  /**
   * Attach an agent's skills to its run (BEA-1079): each attached skill's instructions ride in the
   * prompt (up to 3), and a single-skill agent runs INSIDE that skill's folder so its assets and
   * scripts are actually available.
   */
  async applyAgentSkills(agent: any, input: StartRunInput): Promise<StartRunInput> {
    const ids: string[] = Array.isArray(agent?.skills) ? agent.skills : [];
    if (!ids.length || !this.skillsSvc) return input;
    const rows = (await Promise.all(ids.slice(0, 3).map((id) => this.skillsSvc!.get(id).catch(() => null)))).filter(Boolean) as any[];
    if (!rows.length) return input;
    const block = rows.map((r) => `## Skill: ${r.title}\n${String(r.content || r.description || '').slice(0, 2500)}`).join('\n\n');
    const out: StartRunInput = { ...input, prompt: `${input.prompt}\n\n[Skills you must follow]\n${block}` };
    if (rows.length === 1) {
      const dep = typeof rows[0].deployments === 'string' ? (() => { try { return JSON.parse(rows[0].deployments || '{}'); } catch { return {}; } })() : rows[0].deployments || {};
      out.skill = dep.sandy || rows[0].slug || dep.hermes || dep.beakn || undefined;
    }
    return out;
  }

  /** Create the run row and kick off execution in the background; returns immediately. */
  async startRun(input: StartRunInput) {
    const depth = input.depth ?? (input.quick ? 'quick' : 'standard');
    const run = await this.agent.createRun({ agentId: input.agentId ?? null, title: input.title || 'Agent run', input: input.prompt, depth });
    // fire-and-forget — the run screen polls GET /api/agent/runs/:id for live progress.
    // execute() awaits appendStep/engineSettings before its own try, so a transient DB error there
    // would leave the run stuck 'running'. Always finalize on any escape. (BEA-799)
    this.execute(run.id, input).catch(async (e) => {
      this.log.error(`run ${run.id} crashed: ${e?.message || e}`);
      await this.agent.finishRun(run.id, { status: 'failed', error: friendlyError(e?.message || String(e)) }).catch(() => undefined);
    });
    return run;
  }

  /**
   * Run-evals (BEA-642): run every saved eval case for an agent, grade each against the Outcome,
   * and record the verdict on the case. Runs in the BACKGROUND, persisting after each so the UI streams.
   */
  /** Suggest realistic eval inputs from the agent's Task + Outcome (Evals ③); appends, deduped. */
  async suggestEvals(agentId: string): Promise<{ added: number }> {
    const agent: any = await this.agent.getAgent(agentId).catch(() => null);
    if (!agent) return { added: 0 };
    let arr: any[] = [];
    try {
      const out = await this.llm.complete(
        `An AI agent runs this Task:\n"${(agent.prompt || '').slice(0, 600)}"\nIts Outcome (what a good result looks like):\n"${(agent.rubric || '').slice(0, 400)}"\n\nSuggest 4 realistic, varied example INPUTS to test this agent on. Reply with ONLY a JSON array of short input strings, no prose.`,
        500, 'suggest-evals',
      );
      const m = (out || '').match(/\[[\s\S]*\]/);
      if (m) arr = JSON.parse(m[0]);
    } catch { arr = []; }
    const existing: any[] = Array.isArray(agent.evals) ? agent.evals : [];
    const seen = new Set(existing.map((e) => String(e.input || '').trim().toLowerCase()));
    const fresh = (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean).filter((s) => !seen.has(s.toLowerCase())).slice(0, 5);
    if (!fresh.length) return { added: 0 };
    const next = [...existing, ...fresh.map((input) => ({ id: 'ev_' + Math.random().toString(36).slice(2, 9), input }))];
    await this.agent.setEvals(agentId, next).catch(() => undefined);
    return { added: fresh.length };
  }

  async runEvals(agentId: string): Promise<void> {
    const agent: any = await this.agent.getAgent(agentId).catch(() => null);
    const evals: any[] = Array.isArray(agent?.evals) ? agent.evals : [];
    if (!agent || !evals.length) return;
    // clear stale flags from any interrupted previous run
    for (const c of evals) c.running = false;
    await this.agent.setEvals(agentId, evals).catch(() => undefined);

    for (const c of evals) {
      if (!c?.input) continue;
      c.running = true; // UI shows a spinner on the one in progress
      await this.agent.setEvals(agentId, evals).catch(() => undefined);

      let r = await this.runOneEval(agentId, agent, c);
      // an engine failure/timeout (not a graded fail) → auto-retry once so you don't have to re-run by hand
      if (r?.status === 'failed') r = await this.runOneEval(agentId, agent, c);

      c.running = false;
      c.lastRunId = r?.runId ?? c.lastRunId;
      c.lastVerdict = r?.grade?.verdict || (r?.status === 'failed' ? 'fail' : 'partial');
      c.lastScore = r?.grade?.score ?? null;
      c.lastCriteria = Array.isArray(r?.grade?.criteria) ? r.grade.criteria : null; // per-criterion detail (Evals ②)
      c.lastNotes = r?.grade?.notes || null;
      c.lastRunAt = new Date().toISOString();
      await this.agent.setEvals(agentId, evals).catch(() => undefined); // persist as we go
    }
  }

  /** Run one eval case once; returns {runId, status, grade} (never throws). */
  private async runOneEval(agentId: string, agent: any, c: any): Promise<{ runId?: string; status?: string; grade?: any }> {
    try {
      const run = await this.agent.createRun({ agentId, title: `Eval — ${agent.name}`, input: c.input });
      const prompt = agent.prompt ? `${agent.prompt}\n\n[Test input] ${c.input}` : c.input;
      await this.execute(run.id, { prompt, title: `Eval — ${agent.name}`, agentId, rubric: agent.rubric, save: false, allowAsk: false });
      const r: any = await this.agent.getRun(run.id).catch(() => null);
      return { runId: run.id, status: r?.status, grade: r?.grade };
    } catch {
      return { status: 'failed' };
    }
  }

  /** Synchronous variant (used by tests / callers that want to await the whole run). */
  /**
   * F2 (BEA-660): run a turn through the host Codex directly (no Hermes), via the codex-runner /run.
   * Same HermesRunResult shape so execute() is engine-agnostic. Tool calls surface as steps.
   */
  /** One live step from a raw engine event, in plain words — or null for noise. (BEA-1084) */
  private liveLabel(ev: any): string | null {
    if (!ev) return null;
    if (ev.type === 'mcp_tool_call') {
      const t = ev.tool || ev.name;
      if (!ev.tool && ev.name === 'mybrain') return '🧠 Used your brain'; // old runner: server name only
      if (t === 'search_brain') return '🧠 Searched your brain';
      if (t === 'save_document') return '💾 Saved a document';
      if (t === 'remember') return '📌 Remembered a fact';
      if (t === 'ask_user') return '✋ Asked you';
      if (t === 'get_answer') return null; // answer polling — noise
      return `🔧 Used ${t || 'a tool'}`;
    }
    if (ev.type === 'web_search') return ev.query ? `🌐 Searched: ${String(ev.query).slice(0, 60)}` : '🌐 Searched the web';
    if (ev.type === 'command_execution') return '💻 Ran a command';
    return null; // agent_message / reasoning — the answer, not a step
  }

  private async runViaCodex(prompt: string, handlers: HermesRunHandlers, opts: { title?: string; model?: string; sessionId?: string; skill?: string; bypass?: boolean }): Promise<HermesRunResult> {
    // Live play-by-play (BEA-1084): when someone is watching steps, ask the runner to STREAM its
    // events (ndjson) and append each step the moment it happens — the run screen's poll turns
    // that into a live feed. Headless calls (skills) keep the old single-JSON reply.
    const stream = !!handlers.onStep;
    try {
      const r = await fetch(`${CODEX_RUNNER}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, model: opts.model, sandbox: 'read-only', sessionId: opts.sessionId, skill: opts.skill, bypass: opts.bypass, timeoutMs: 240000, stream }),
        signal: AbortSignal.timeout(250000),
      });
      const ctype = r.headers.get('content-type') || '';
      if (stream && r.ok && ctype.includes('ndjson') && r.body) {
        let result: any = null;
        let buf = '';
        const dec = new TextDecoder();
        for await (const chunk of r.body as any) {
          buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let m: any;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.type === 'ev') {
              const label = this.liveLabel(m.ev);
              if (label) handlers.onStep?.({ label, status: 'done', kind: 'tool' });
            } else if (m.type === 'result') result = m;
          }
        }
        if (!result) return { sessionId: undefined as any, finalText: '', status: 'error', error: 'The engine stream ended without a result.' };
        if (result.error && !result.text) return { sessionId: result.sessionId, finalText: '', status: 'error', error: result.error };
        return { sessionId: result.sessionId, finalText: String(result.text || ''), status: 'ok', error: undefined, usage: result.usage };
      }
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) return { sessionId: d?.sessionId, finalText: '', status: 'error', error: d?.error || 'Codex run failed' };
      for (const ev of d.events || []) {
        const label = this.liveLabel(ev) || (ev.type === 'mcp_tool_call' ? codexToolLabel(ev.name) : null);
        if (label) handlers.onStep?.({ label, status: 'done', kind: 'tool' });
      }
      return { sessionId: d.sessionId, finalText: String(d.text || ''), status: 'ok', error: undefined, usage: d.usage };
    } catch (e: any) {
      return { sessionId: undefined, finalText: '', status: 'error', error: String((e && e.message) || e) };
    }
  }

  /**
   * Move A (BEA-664): run a skill block in Codex with the skill's REAL folder in the working dir.
   * Lightweight (no AgentRun row) — used by the flow runner's skill nodes.
   */
  async runSkillTurn(skillSlug: string, prompt: string, opts: { model?: string } = {}): Promise<string> {
    // skills run sandboxed (workspace-write in the per-run skill folder) — no bypass needed now that
    // the host's bubblewrap sandbox works (BEA-665).
    const r = await this.runViaCodex(prompt, {}, { model: opts.model, skill: skillSlug });
    if (r.status === 'error') throw new Error(r.error || 'skill run failed');
    return r.finalText || '';
  }

  async execute(runId: string, input: StartRunInput) {
    // Depth drives behaviour: quick = fast single turn, no save; standard = research + save. (deep runs
    // as a flow, routed by callers — never reaches here.) Legacy `quick` bool maps to depth. (BEA-695)
    const depth = input.depth ?? (input.quick ? 'quick' : 'standard');
    const quick = depth === 'quick';
    await this.agent.appendStep(runId, { label: quick ? 'Starting up (quick answer)' : 'Starting up', status: 'done' });
    const cfg = await this.agent.engineSettings();
    // Research FIRST, brain SECOND (BEA-692). We no longer pre-inject a RAG recall as the opening
    // context (that made the agent "start with the brain"). Instead it researches the topic, then
    // consults the user's brain via the search_brain tool and reconciles — trusting the user's own
    // notes for their own terms. cfg.recall just means "the brain is available as a tool".
    let prompt = input.prompt + this.researchGuidance(quick, cfg.recall);
    // The durable ask_user tool (BEA-795) — offered unless the caller runs headless (flows, evals).
    if (input.allowAsk !== false) prompt += this.askGuidance(runId, cfg.autonomy);
    // Ground the run in "what's fresh" (BEA-1077) — real runs only; flows/evals stay lean.
    if (input.allowAsk !== false && cfg.recall) prompt += await this.agent.freshContext().catch(() => '');
    await this.driveTurn(runId, input, cfg, prompt);
  }

  /**
   * Drive ONE engine turn and land its outcome: park (the model asked the user — BEA-795), fail,
   * or grade + learn + save + finish. Shared by first turns (execute) and resumes (resumeRun).
   */
  private async driveTurn(runId: string, input: StartRunInput, cfg: any, prompt: string, sessionId?: string) {
    const depth = input.depth ?? (input.quick ? 'quick' : 'standard');
    const quick = depth === 'quick';
    const timeoutMs = cfg.askTimeoutMin * 60_000;

    const handlers: HermesRunHandlers = {
      onStep: (s) => void this.agent.appendStep(runId, s).catch(() => undefined),
      // BEA-620: the agent pauses and asks YOU (durable waitpoint + Telegram), then resumes —
      // gated by the autonomy setting.
      onApproval: async (a) => {
        if (cfg.autonomy === 'autopilot') {
          await this.agent.appendStep(runId, { label: 'Skipped a risky action (autopilot)', status: 'info', detail: a.command }).catch(() => undefined);
          return 'deny'; // never auto-run risky things, even on autopilot
        }
        const ans = await this.askHuman(runId, input.title, {
          question: `Allow this action?\n${a.command || a.description || 'a tool action'}`,
          kind: 'approve_edit_reject',
          options: { command: a.command, description: a.description },
          defaultValue: 'reject',
        }, timeoutMs);
        return ans === 'approve' ? 'once' : 'deny';
      },
      onClarify: async (q) => {
        const choices = q.choices && q.choices.length ? q.choices : undefined;
        const fallback = choices ? choices[0] : 'Use your best judgment and proceed.';
        if (cfg.autonomy !== 'cautious') {
          // balanced + autopilot proceed with the best guess rather than stopping to ask
          await this.agent.appendStep(runId, { label: 'Decided without asking', status: 'info', detail: q.question }).catch(() => undefined);
          return fallback;
        }
        return this.askHuman(runId, input.title, {
          question: q.question,
          kind: choices ? 'choice' : 'free_text',
          options: choices || [],
          defaultValue: fallback,
        }, timeoutMs);
      },
    };

    // Terminal-style heartbeat: gpt-5.5 on Codex answers in one lump with no streaming, so without
    // this the run looks frozen for a minute+. Log that we sent it, then a "still working" tick.
    await this.agent.appendStep(runId, { label: `Sent to ${cfg.model || 'gpt-5.5'} · Codex`, status: 'running', kind: 'log' }).catch(() => undefined);
    const startedAt = Date.now();
    // Phone push on landing (BEA-1088): failures always; successes only when the run took long
    // enough that you probably walked away. Headless runs (flows/evals, allowAsk:false) never push.
    const notifyEnd = async (status: 'done' | 'failed', detail?: string) => {
      if (input.allowAsk === false) return;
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (status === 'failed') {
        await this.push?.send({ title: `${input.title || 'Agent run'} failed`, body: (detail || 'The run hit a problem.').slice(0, 140), url: `/agent/runs/${runId}`, tag: `run-${runId}` }).catch(() => undefined);
        await this.alerts?.runFailed(input.title || 'Agent run', detail || 'The run hit a problem.', `/agent/runs/${runId}`).catch(() => undefined); // WhatsApp (BEA-1071)
      } else if (secs > 60) {
        await this.push?.send({ title: `${input.title || 'Agent run'} finished ✓`, body: (detail || 'The result is ready.').slice(0, 140), url: `/agent/runs/${runId}`, tag: `run-${runId}` }).catch(() => undefined);
      }
    };
    const heartbeat = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      void this.agent.appendStep(runId, { label: `Still working… ${fmtElapsed(s)}`, status: 'running', kind: 'log' }).catch(() => undefined);
    }, 15_000);

    let result;
    try {
      result = await this.runViaCodex(prompt, handlers, { title: input.title, model: cfg.model || undefined, sessionId, skill: input.skill });
    } catch (e: any) {
      clearInterval(heartbeat);
      await this.agent.finishRun(runId, { status: 'failed', error: friendlyError(e?.message) });
      await notifyEnd('failed', friendlyError(e?.message));
      return;
    }
    clearInterval(heartbeat);

    // Durable ask (BEA-795): the model called ask_user and its turn ended while the question is
    // still open — PARK the run on its engine session instead of finishing (finishRun would cancel
    // the pending question). The resume sweeper continues it when the answer lands. Parking wins
    // even over a turn error (e.g. the turn timed out mid-wait): the question must survive.
    const askedRun: any = await this.agent.getRun(runId).catch(() => null);
    if (askedRun?.status === 'awaiting_input') {
      await this.agent.parkRun(runId, result.sessionId);
      await this.agent.appendStep(runId, { label: 'Paused — waiting for your answer', status: 'awaiting' }).catch(() => undefined);
      const wp = (askedRun.waitpoints || []).filter((w: any) => w.status === 'pending').pop();
      if (wp) {
        await this.telegram.pushAgentQuestion({ runTitle: input.title, waitpointId: wp.id, question: wp.question, kind: wp.kind, options: wp.options }).catch(() => undefined);
        // Phone push (BEA-1088): a direct ask always delivers; tapping lands on the exact card.
        await this.push?.send({ title: `${input.title || 'Your agent'} needs you`, body: String(wp.question).slice(0, 160), url: `/agent?focus=${wp.id}`, tag: `ask-${wp.id}`, isAsk: true }).catch(() => undefined);
      }
      return;
    }

    if (result.status === 'error') {
      await this.agent.finishRun(runId, { status: 'failed', error: friendlyError(result.error) });
      await notifyEnd('failed', friendlyError(result.error));
      return;
    }

    let text = (result.finalText || '').trim();
    await this.agent.appendStep(runId, { label: `Answer received · ${text.length.toLocaleString()} chars · ${fmtElapsed(Math.round((Date.now() - startedAt) / 1000))}`, status: 'done', kind: 'log' }).catch(() => undefined);
    // Log Codex token usage as the flat-rate 'agent' feature so Usage can show its "included" value. (BEA-716)
    if (result.usage) await this.llm.recordUsage('agent', cfg.model || 'codex', result.usage).catch(() => undefined);
    // Self-check against the Outcome + ONE auto-retry on a fail (BEA-696). Grade the answer; if it
    // fails the user's definition of done, revise once with the grader's notes and keep the better one.
    let gradeJson: string | undefined;
    if (!quick && input.rubric && text) {
      await this.agent.appendStep(runId, { label: 'Checking against your Outcome', status: 'running', kind: 'log' }).catch(() => undefined);
      let g = await this.gradeRun(input.rubric, text);
      if (g) await this.agent.appendStep(runId, { label: `Outcome: ${g.verdict} · ${g.score}/100`, status: g.verdict === 'fail' ? 'failed' : g.verdict === 'partial' ? 'info' : 'done' }).catch(() => undefined);
      if (g && g.verdict === 'fail') {
        await this.agent.appendStep(runId, { label: 'Revising once to meet your Outcome', status: 'running', kind: 'log' }).catch(() => undefined);
        const revisePrompt = `Your previous answer did NOT meet the user's definition of done. Fix it.\n\nThe Outcome (definition of done):\n${input.rubric}\n\nWhat was wrong: ${g.notes || 'it fell short of the Outcome'}\n\nYour previous answer:\n${text}\n\nProduce a better answer that fully meets every part of the Outcome. Keep the inline citations/sources.`;
        const r2 = await this.runViaCodex(revisePrompt, handlers, { title: input.title, model: cfg.model || undefined }).catch(() => null);
        const text2 = (r2?.finalText || '').trim();
        if (text2) {
          const g2 = await this.gradeRun(input.rubric, text2);
          if (g2 && (g2.score || 0) >= (g.score || 0)) { text = text2; g = g2; }
          await this.agent.appendStep(runId, { label: `Revised · ${g?.verdict} · ${g?.score}/100`, status: g?.verdict === 'fail' ? 'failed' : 'done' }).catch(() => undefined);
        }
      }
      if (g) gradeJson = JSON.stringify(g);
    }
    // If the user cancelled while this turn was still running, discard the result — don't propose
    // learnings, save a document, or flip the run back to 'done'. (BEA-793)
    const cur: any = await this.agent.getRun(runId).catch(() => null);
    if (cur?.status === 'cancelled') {
      await this.agent.appendStep(runId, { label: 'Cancelled — result discarded', status: 'failed' }).catch(() => undefined);
      return;
    }
    // Learn-after runs on the FINAL (possibly revised) text. Quick skips it.
    if (!quick && text && cfg.learn) await this.proposeLearnings(runId, text);
    if (!quick && input.save !== false && text) {
      try {
        const doc = await this.documents.create({
          title: input.title || 'Agent result',
          contentText: text,
          kind: 'md',
          collectionId: input.saveCollectionId ?? cfg.outputCollectionId ?? (await this.defaultCollectionId()),
          tags: ['agent'],
        });
        await this.agent.attachOutput(runId, doc.id);
        await this.agent.appendStep(runId, { label: 'Saved to Documents', status: 'done', detail: doc.title });
        await this.agent.finishRun(runId, { status: 'done', outputDocId: doc.id, resultText: text, grade: gradeJson });
        await notifyEnd('done', doc.title);
        return;
      } catch (e: any) {
        await this.agent.appendStep(runId, { label: 'Could not save the document', status: 'failed', detail: e?.message }).catch(() => undefined);
      }
    }
    await this.agent.finishRun(runId, { status: 'done', resultText: text, grade: gradeJson });
    await notifyEnd('done', text.slice(0, 120));
  }
}

/** Format seconds as m:ss for the terminal heartbeat. */
function fmtElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function friendlyError(msg?: string): string {
  if (!msg) return 'The agent engine hit a problem.';
  if (/timed out/i.test(msg)) return 'The agent took too long and was stopped.';
  if (/login|ws-ticket|unreachable|ECONN|fetch failed/i.test(msg)) return 'Could not reach the agent engine (Hermes). Is it running?';
  return msg;
}
