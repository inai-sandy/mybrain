import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { AgentService } from '../agent/agent.service';

/** Generic building blocks (n8n-style utility nodes). `kind` drives the node's look/behaviour. */
const GENERIC_PALETTE = [
  { type: 'generic', kind: 'text', id: 'text', name: 'Text input', description: 'A fixed piece of text / value' },
  { type: 'generic', kind: 'note', id: 'note', name: 'Note', description: 'A comment on the canvas' },
  { type: 'generic', kind: 'if', id: 'if', name: 'If / condition', description: 'Branch on a condition' },
  { type: 'generic', kind: 'filter', id: 'filter', name: 'Filter', description: 'Keep only what matches' },
  { type: 'generic', kind: 'merge', id: 'merge_block', name: 'Merge', description: 'Combine outputs (AI / raw)' },
  { type: 'generic', kind: 'wait', id: 'wait', name: 'Wait', description: 'Pause for a set time' },
  { type: 'generic', kind: 'ask_user', id: 'ask_user', name: 'Ask me', description: 'Pause and ask you a question, then continue (answer in-app or later)' },
];

/**
 * The tool nodes come from the ONE catalog now (BEA-1167) — `ToolCatalogService`. This module used
 * to keep its own hard-coded list, which drifted from the agent's toolbox. Ids are unchanged, so
 * saved flows keep working.
 *
 * This is the safety net for when the catalog can't be reached (its probes call out to Google and
 * the engine host): the canvas and the planner keep the core tools rather than silently offering
 * none, which would quietly plan toolless flows.
 */
const FALLBACK_TOOLS = [
  { id: 'search_brain', name: 'Search my brain', group: 'Brain', description: 'Everything you have saved' },
  { id: 'web_search', name: 'Web search', group: 'Web', description: 'Search the live web' },
  { id: 'web_read', name: 'Read a page', group: 'Web', description: 'Open a link and read it' },
  { id: 'deep_research', name: 'Deep research', group: 'Web', description: 'Many searches, then a cited report' },
  { id: 'gmail', name: 'Gmail', group: 'Google', description: 'Read / search email' },
  { id: 'calendar', name: 'Calendar', group: 'Google', description: 'Read your calendar' },
  { id: 'drive', name: 'Drive', group: 'Google', description: 'Find / read files' },
  { id: 'ask_ai', name: 'Ask AI', group: 'AI', description: 'A plain reasoning step' },
  { id: 'http', name: 'HTTP request', group: 'Advanced', description: 'Call any external API' },
  { id: 'news_collect', name: 'Collect the AI news', group: 'News', description: 'Fetch, split and file every story' },
  { id: 'news_write', name: 'Write the edition', group: 'News', description: 'Headline, 60-second read, a section per category' },
  { id: 'news_flag', name: 'Pick what needs research', group: 'News', description: 'Shortlist what is worth a proper dig' },
  { id: 'save_document', name: 'Save to Documents', group: 'Output', description: 'Save the result' },
  { id: 'telegram', name: 'Send to Telegram', group: 'Messaging', description: 'Message you on Telegram' },
].map((t) => ({ ...t, type: 'tool', kind: 'tool' as const, connected: true }));

@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    private readonly llm: LlmService,
    private readonly promptsSvc?: PromptsService, // optional + LAST — spec files construct positionally
    private readonly catalog?: ToolCatalogService, // the one tool catalog (BEA-1167)
    private readonly agentSvc?: AgentService, // to narrow planning to the job's toolbox (BEA-1174)
  ) {}

  private parse(s?: string | null): any {
    try { return s ? JSON.parse(s) : { nodes: [], edges: [] }; } catch { return { nodes: [], edges: [] }; }
  }
  private shape(f: any) {
    return { ...f, graph: this.parse(f.graph), schedule: f.schedule ? this.parse(f.schedule) : null };
  }

  async list(agentId?: string) {
    const rows = await this.prisma.flow.findMany({ where: agentId ? { agentId } : undefined, orderBy: { updatedAt: 'desc' }, take: 500 });
    return rows.map((f) => this.shape(f));
  }
  async get(id: string) {
    const f = await this.prisma.flow.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Flow not found');
    return this.shape(f);
  }
  async create(input: { name?: string; question?: string; graph?: unknown; agentId?: string }) {
    const f = await this.prisma.flow.create({
      data: {
        name: input.name?.trim()?.slice(0, 120) || 'Untitled flow',
        question: input.question?.trim() || null,
        agentId: input.agentId?.trim() || null,
        ...(input.graph ? { graph: JSON.stringify(input.graph) } : {}),
      },
    });
    return this.shape(f);
  }
  async update(id: string, patch: { name?: string; question?: string; graph?: unknown; schedule?: unknown; locked?: boolean }) {
    const data: any = {};
    // A locked flow's SHAPE is protected here too, not just from Auto-plan (BEA-1259). The canvas
    // saves through this same endpoint on every edit, so guarding only planAndSave would have left
    // the lock trivially bypassed: open AI News Daily, nudge one node, and the hand-drawn steps are
    // gone. Renaming stays allowed — it changes nothing about what runs.
    if (patch.graph !== undefined || patch.schedule !== undefined) {
      const current = await this.prisma.flow.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Flow not found');
      if ((current as any).locked && patch.locked !== false) {
        throw new BadRequestException(
          `"${current.name}" is a locked flow — its steps and schedule are fixed. Unlock it first if you really want to change them.`,
        );
      }
    }
    if (patch.locked !== undefined) data.locked = Boolean(patch.locked);
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120) || 'Untitled flow';
    if (patch.question !== undefined) data.question = patch.question?.trim() || null;
    if (patch.graph !== undefined) data.graph = JSON.stringify(patch.graph || { nodes: [], edges: [] });
    if (patch.schedule !== undefined) { data.schedule = patch.schedule ? JSON.stringify(patch.schedule) : null; data.lastFiredKey = null; }
    const f = await this.prisma.flow.update({ where: { id }, data }).catch(() => { throw new NotFoundException('Flow not found'); });
    return this.shape(f);
  }
  async remove(id: string) {
    await this.prisma.flow.delete({ where: { id } }).catch(() => { throw new NotFoundException('Flow not found'); });
    return { ok: true };
  }

  /** Flows with a schedule set — for the per-minute FlowScheduler (Stage 3). */
  async listSchedulable() {
    const rows = await this.prisma.flow.findMany({ where: { NOT: { schedule: null } } });
    return rows.map((f) => ({ id: f.id, name: f.name, schedule: this.parse(f.schedule), lastFiredKey: f.lastFiredKey }));
  }
  async markFired(id: string, key: string) {
    await this.prisma.flow.update({ where: { id }, data: { lastFiredKey: key } }).catch(() => undefined);
  }

  /**
   * One source of truth for "how this flow runs" (BEA-669): the structured process AND the
   * Claude-Code-flavored copy-prompt are both derived from describeFlow, so they always match.
   */
  async getPrompt(id: string): Promise<{ prompt: string; process: any }> {
    const f = await this.prisma.flow.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Flow not found');
    const process = this.describeFlow(f);
    return { prompt: this.buildPrompt(process), process };
  }

  /** A step phrased as a Claude Code action (so the copy-prompt reproduces the flow). */
  private stepAction(node: any): string {
    const k = node?.data?.kind;
    const label = node?.data?.label || '';
    // A node can carry extra guidance the user typed/picked (e.g. deep-research at "Level 2") — surface it.
    const guidance = (node?.data?.guidance ?? '').toString().trim();
    const withGuidance = (s: string) => (s && guidance ? `${s} (${guidance})` : s);
    if (k === 'text') { const t = (node?.data?.text || node?.data?.sub || '').toString().trim(); return t ? `Use this input: "${t.slice(0, 200)}"` : ''; }
    if (k === 'ask_ai') return 'Write up a clear, well-structured answer for this part.';
    if (k === 'skill') return withGuidance(`Use the "${label}" skill — read its SKILL.md and follow it.`);
    if (k === 'ask_user') { const q = (node?.data?.question || node?.data?.sub || 'a decision').toString().trim(); return `Pause and ask me: "${q.slice(0, 160)}" — wait for my answer before continuing.`; }
    if (k === 'note' || k === 'wait' || k === 'if' || k === 'filter') return '';
    if (k === 'tool') {
      const map: Record<string, string> = {
        search_brain: 'Search my second brain (my notes, documents and saved memories) for what is relevant.',
        web_search: 'Search the web for the facts you need.',
        web_read: 'Open and read the most relevant page(s).',
        deep_research: 'Research this properly: break it into sub-questions, search many sources, read the best pages and write it up with citations.',
        gmail: 'Check my Gmail for what is relevant.',
        calendar: 'Check my calendar.',
        drive: 'Find and read the relevant files in my Google Drive.',
        save_document: 'Save the result as a document.',
        telegram: 'Send the result to me on Telegram.',
        http: 'Make the appropriate external API / HTTP request and use the result.',
        news_collect: 'Pull the AI news feed, split every story out of it and file each one into a category.',
        news_write: "Write the day's edition from the categorised stories: a headline, the 60-second read, and a section per category.",
        news_flag: 'Shortlist the few stories worth researching properly, for the end of the edition.',
      };
      return withGuidance(map[node?.data?.refId] || `Use the ${label} tool.`);
    }
    return '';
  }

  /** Walk the graph into the real execution plan: Task → branches[{question, steps}] → merge → output. */
  private describeFlow(f: any): { task: string; parallel: boolean; branches: { title: string; question: string; steps: string[] }[]; merge: string; finishing: string[]; hasAskUser: boolean } {
    const g = this.parse(f.graph);
    const nodes = new Map<string, any>((g.nodes || []).map((n: any) => [n.id, n]));
    const out = new Map<string, string[]>();
    for (const e of g.edges || []) { if (!out.has(e.source)) out.set(e.source, []); out.get(e.source)!.push(e.target); }
    const isEnd = (n: any) => n && (n.data?.kind === 'merge' || n.data?.kind === 'output');

    const qNode = (g.nodes || []).find((n: any) => n.data?.kind === 'question');
    const mergeNode = (g.nodes || []).find((n: any) => n.data?.kind === 'merge');
    const task = (f.question || qNode?.data?.sub || f.name || '').toString().trim();
    const roots = qNode ? (out.get(qNode.id) || []) : (g.nodes || []).filter((n: any) => n.data?.kind === 'subquestion').map((n: any) => n.id);
    const hasAskUser = (g.nodes || []).some((n: any) => n.data?.kind === 'ask_user' && n.data?.enabled !== false);

    const branches: { title: string; question: string; steps: string[] }[] = [];
    let i = 1;
    for (const rootId of roots) {
      const chain: any[] = [];
      let cur: string | null = rootId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const n = nodes.get(cur);
        if (!n || isEnd(n)) break;
        if (n.data?.enabled !== false) chain.push(n);
        const nexts = out.get(cur) || [];
        cur = nexts.find((t) => !isEnd(nodes.get(t))) ?? null;
      }
      if (!chain.length) continue;
      const head = chain[0];
      let question = '';
      let stepNodes = chain;
      if (head.data?.kind === 'subquestion') { question = (head.data?.sub || head.data?.label || '').toString().trim(); stepNodes = chain.slice(1); }
      const steps = stepNodes.map((s) => this.stepAction(s)).filter(Boolean);
      branches.push({ title: `Branch ${i}`, question, steps });
      i++;
    }

    // Finishing steps: anything wired AFTER the Merge, before the Output (e.g. a formatter skill).
    // The executor runs these (it walks backwards from Output), so the plan must show them too.
    const finishing: string[] = [];
    if (mergeNode) {
      let cur: string | null = mergeNode.id;
      const seen = new Set<string>([mergeNode.id]);
      while (cur) {
        const nexts = (out.get(cur) || []).map((t) => nodes.get(t)).filter(Boolean);
        const next = nexts.find((n) => n.data?.kind !== 'output' && !seen.has(n.id));
        if (!next) break;
        seen.add(next.id);
        if (next.data?.enabled !== false) { const a = this.stepAction(next); if (a) finishing.push(a); }
        cur = next.id;
      }
    }

    return { task, parallel: branches.length > 1, branches, merge: mergeNode?.data?.mode || 'ai', finishing, hasAskUser };
  }

  /** Render the Claude-Code copy-prompt from the same plan (so it mirrors the process exactly). */
  private buildPrompt(p: { task: string; parallel: boolean; branches: { question: string; steps: string[] }[]; merge: string; finishing?: string[]; hasAskUser: boolean }): string {
    const lines: string[] = [`Task: ${p.task || '(describe the task)'}`, ''];
    if (!p.branches.length) {
      lines.push('Do this and give a clear, well-structured answer. Use your tools (web search, reading pages, etc.) as needed.');
      return lines.join('\n');
    }
    lines.push(p.parallel ? 'Work through these parts (they are independent):' : 'Steps:', '');
    p.branches.forEach((b, idx) => {
      lines.push(`Part ${idx + 1}${b.question ? ` — ${b.question}` : ''}`);
      if (b.steps.length) b.steps.forEach((s, j) => lines.push(`   ${j + 1}. ${s}`));
      else lines.push('   1. Work this part out and write it up.');
      lines.push('');
    });
    lines.push(p.merge === 'raw'
      ? 'Finally, present each part one after another, each under its own heading.'
      : 'Finally, combine all the parts into one clear, well-structured answer with no repetition.');
    if (p.finishing && p.finishing.length) {
      lines.push('', 'Then, as finishing steps applied to that combined answer:');
      p.finishing.forEach((s, j) => lines.push(`   ${j + 1}. ${s}`));
    }
    return lines.join('\n');
  }

  /**
   * Canvas → words sync, preview (BEA-1065): the owner drag-edited the flow; rewrite the linked
   * agent's plain-words Task to match the new graph. Nothing is saved — the UI shows old vs new
   * plus a plain-English change list, and calls syncAgentApply only on confirm.
   */
  async syncAgentPreview(id: string): Promise<{ oldTask: string; newTask: string; changes: string[] }> {
    const f = await this.prisma.flow.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Flow not found');
    if (!f.agentId) throw new BadRequestException('This flow is not linked to an agent.');
    const agent = await this.prisma.agent.findUnique({ where: { id: f.agentId } });
    if (!agent) throw new NotFoundException('The linked agent no longer exists.');
    const flowWords = this.buildPrompt(this.describeFlow(f));
    let newTask = '';
    let changes: string[] = [];
    try {
      const tpl = (await this.promptsSvc?.get('flow.syncWords').catch(() => '')) || '';
      if (tpl) {
        const syncPrompt = tpl.replaceAll('{{task}}', (agent.prompt || '(empty)').slice(0, 2000)).replaceAll('{{flow}}', flowWords.slice(0, 3000));
        const out = (this.llm as any).completeHelper ? await (this.llm as any).completeHelper('sync-words', syncPrompt, 900, 'flow-sync-words') : await this.llm.complete(syncPrompt, 900, 'flow-sync-words');
        const m = (out || '').match(/\{[\s\S]*\}/);
        if (m) {
          const g = JSON.parse(m[0]);
          newTask = String(g.task || '').trim().slice(0, 4000);
          changes = (Array.isArray(g.changes) ? g.changes : []).slice(0, 6).map((c: any) => String(c).slice(0, 200));
        }
      }
    } catch { /* fall through to the word-for-word fallback */ }
    if (!newTask) {
      newTask = flowWords.slice(0, 4000);
      changes = ['Changed: the Task now follows the flow word-for-word (the rewriter was unavailable).'];
    }
    return { oldTask: agent.prompt || '', newTask, changes };
  }

  /** Canvas → words sync, apply: write the confirmed new Task onto the linked agent. */
  async syncAgentApply(id: string, task: string) {
    const f = await this.prisma.flow.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Flow not found');
    if (!f.agentId) throw new BadRequestException('This flow is not linked to an agent.');
    const t = (task || '').trim().slice(0, 4000);
    if (!t) throw new BadRequestException('The new Task is empty.');
    await this.prisma.agent.update({ where: { id: f.agentId }, data: { prompt: t } })
      .catch(() => { throw new NotFoundException('The linked agent no longer exists.'); });
    return { ok: true };
  }

  /** Plan a full flow from this flow's question/task and overwrite its graph (Agent↔Flow merge ②). */
  async planAndSave(id: string) {
    const f = await this.prisma.flow.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Flow not found');
    // A locked flow is hand-drawn and correct (BEA-1259). Auto-plan would replace its real steps
    // with generic search branches and quietly throw the working pipeline away — the same failure
    // as BEA-1246, where one press downgraded a research flow to a single index. Refuse, in words.
    if ((f as any).locked) {
      throw new BadRequestException(
        `"${f.name}" is a locked flow — it was drawn by hand and Auto-plan would replace its steps. Unlock it first if you really want it re-planned.`,
      );
    }
    // Plan within the job's toolbox (BEA-1174): a drawn step the job isn't allowed to run would be
    // a picture that lies — it would simply be refused at run time.
    const allowed = (f as any).agentId
      ? (await this.agentSvc?.allowedTools?.((f as any).agentId).catch(() => null))?.ids || null
      : null;
    const graph = await this.planFlow(f.question || f.name || '', allowed);
    const updated = await this.prisma.flow.update({ where: { id }, data: { graph: JSON.stringify(graph) } });
    return this.shape(updated);
  }

  /**
   * The draggable node palette. Served from the ONE catalog (BEA-1167) so the canvas and the agent
   * toolbox can never drift apart. MCP servers are left out: a canvas block for a server (rather
   * than for a tool it offers) would have nothing to do.
   */
  async palette() {
    const cat = await this.catalog?.catalog().catch(() => null);
    if (!cat) {
      // Catalog unavailable — fall back to the core tools so the canvas is never empty.
      const skills = (await this.skills.list().catch(() => [])).map((s: any) => ({ type: 'skill', id: s.id, name: s.title, description: s.description }));
      return { generics: GENERIC_PALETTE, tools: FALLBACK_TOOLS, skills };
    }
    const tools = cat.tools
      .filter((t) => t.kind === 'tool')
      .map((t) => ({ type: 'tool', id: t.id, name: t.name, group: t.group, description: t.description, connected: t.connected, connectHint: t.connectHint, connectPath: t.connectPath }));
    const skills = cat.tools
      .filter((t) => t.kind === 'skill')
      .map((t) => ({ type: 'skill', id: t.id, name: t.name, description: t.description, connected: t.connected }));
    return { generics: GENERIC_PALETTE, tools, skills };
  }

  /** Break a question into independent sub-questions for the branches (BEA-644). */
  async decompose(question: string): Promise<string[]> {
    try {
      const decomposePrompt = `Break the user's request into 2-5 INDEPENDENT sub-questions that can each be worked on separately, then combined into one answer. Request:\n"${question.slice(0, FlowsService.QUESTION_MAX)}"\n\nReply with ONLY a JSON array of short sub-question strings, e.g. ["...","..."]. No prose.`;
      const out = (this.llm as any).completeHelper
        ? await (this.llm as any).completeHelper('flow-decompose', decomposePrompt, 400, 'flow-decompose')
        : await this.llm.complete(decomposePrompt, 400, 'flow-decompose');
      const m = (out || '').match(/\[[\s\S]*\]/);
      if (!m) return [];
      const arr = JSON.parse(m[0]);
      return Array.isArray(arr) ? arr.slice(0, 6).map((s: any) => String(s).trim().slice(0, 200)).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Plan a COMPLETE flow from a question/task (Agent↔Flow merge ②): independent branches,
   * each a chain of the right tools/skills, into a merge + output. Returns a graph {nodes, edges}.
   */
  async planFlow(question: string, allowedToolIds?: string[] | null): Promise<{ nodes: any[]; edges: any[] }> {
    const q = (question || '').trim();
    const all = (await this.skills.list().catch(() => [])) as any[];
    // only offer skills actually deployed somewhere, and skip generic build/design skills for research
    const skills = all.filter((s) => (s.deployedTo || []).length);
    const skillById = new Map(skills.map((s) => [s.id, s.title]));
    // Only offer tools that are actually connected — planning a Gmail step with no Google account
    // attached just produces a flow that fails halfway (BEA-1167).
    const cat = await this.catalog?.catalog().catch(() => null);
    let usable: any[] = cat ? cat.tools.filter((t) => t.kind === 'tool' && t.connected) : FALLBACK_TOOLS;
    // Narrow to the job's own toolbox when it has one.
    if (allowedToolIds && allowedToolIds.length) {
      const allow = new Set(allowedToolIds);
      const narrowed = usable.filter((t: any) => allow.has(t.id));
      if (narrowed.length) usable = narrowed;
    }
    const toolById = new Map<string, string>(usable.map((t) => [t.id, t.name] as [string, string]));
    // The Web tools only — the skill→tool collision remap is scoped to these (BEA-1250), because
    // only there is a same-named skill guaranteed unable to do what its name promises.
    const webTools = new Set<string>(usable.filter((t: any) => t.group === 'Web').map((t: any) => t.id as string));
    const skillList = skills.map((s) => `- skill:${s.id} — ${s.title}: ${(s.description || '').slice(0, 80)}`).join('\n');
    const toolList = usable.map((t) => `- tool:${t.id} — ${t.name}: ${t.description}`).join('\n');

    // A job's task is usually numbered steps with a schedule in front ("1. Every Monday at 8am,
    // search for…"). The planner handles a GOAL far better than an instruction list, so if the
    // first attempt comes back with nothing we condense and ask once more. Without this the flow
    // silently falls back to a single "Ask AI" box — a picture that teaches you nothing. (BEA-1174)
    const condense = (t: string) =>
      t.replace(/^\s*\d+[.)]\s*/gm, '')
        .replace(/\bevery (monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|weekday|week|morning)\b[^,.]*/gi, '')
        .replace(/\bat \d{1,2}(:\d{2})?\s*(am|pm)\b/gi, '')
        .split(/[\n.]/).map((x) => x.trim()).filter(Boolean).join('. ')
        .slice(0, 400);

    let plan: any = null;
    try {
      // The planner prompt lives in the registry (Settings → Prompts → Agents) so the owner can
      // tune it. Its default deliberately does NOT add search_brain unless explicitly asked (BEA-1096).
      const tpl = (await this.promptsSvc?.get('flow.plan').catch(() => '')) || '';
      if (!tpl) return this.buildGraph(q, null, skillById, toolById, webTools, true);
      const planPrompt = tpl.replaceAll('{{question}}', q.slice(0, FlowsService.QUESTION_MAX)).replaceAll('{{tools}}', toolList).replaceAll('{{skills}}', skillList || '(no skills)');
      const out = (this.llm as any).completeHelper ? await (this.llm as any).completeHelper('flow-plan', planPrompt, 2200, 'flow-plan') : await this.llm.complete(planPrompt, 2200, 'flow-plan');
      const m = (out || '').match(/\{[\s\S]*\}/);
      if (m) plan = JSON.parse(m[0]);
    } catch { plan = null; }

    if (!Array.isArray(plan?.branches) || !plan.branches.length) {
      const short = condense(q);
      if (short && short !== q.slice(0, 400)) {
        try {
          const tpl2 = (await this.promptsSvc?.get('flow.plan').catch(() => '')) || '';
          const p2 = tpl2.replaceAll('{{question}}', short).replaceAll('{{tools}}', toolList).replaceAll('{{skills}}', skillList || '(no skills)');
          const out2 = (this.llm as any).completeHelper ? await (this.llm as any).completeHelper('flow-plan', p2, 2200, 'flow-plan') : await this.llm.complete(p2, 2200, 'flow-plan');
          const m2 = (out2 || '').match(/\{[\s\S]*\}/);
          if (m2) plan = JSON.parse(m2[0]);
        } catch { /* keep the fallback graph */ }
      }
    }

    // BEA-1253: a bare fallback and a real one-branch plan look identical on the canvas. Carry the
    // difference through so the picture can say which one this is.
    // A non-empty array is not the same as a usable plan. `{"branches":[{}]}` and
    // `{"branches":[null]}` both parse, both pass an Array.isArray/length check, and both fall
    // through buildGraph to exactly the same blank Ask-AI box as a total failure — unflagged. Any
    // branch that carries neither a sub-question nor a step is not a branch.
    const branches: any[] = Array.isArray(plan?.branches) ? plan.branches : [];
    const planFailed = !branches.length || !branches.some((b: any) => String(b?.subquestion || '').trim() || b?.steps?.length);
    return this.buildGraph(q, plan, skillById, toolById, webTools, planFailed);
  }

  /** "deep-research", "Deep research" and `deep_research` are all the same words. */
  /** Shown on the canvas and in the run log when a graph is a stand-in rather than a plan. */
  static readonly PLAN_FAILED_NOTE = 'Planning failed — this is a bare fallback, not a plan. Press Auto-plan to try again.';

  private static normName(s: string): string {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  private resolveStep(st: any, skillById: Map<string, string>, toolById: Map<string, string>, webTools?: Set<string>): { kind: string; label: string; refId?: string; note?: string } {
    const kind = st?.kind;
    const id = st?.id;
    if (kind === 'tool' && toolById.has(id)) return { kind: 'tool', label: toolById.get(id)!, refId: id };
    if (kind === 'skill' && skillById.has(id)) {
      // A skill that shares its NAME with a WEB tool is a trap, not a choice (BEA-1250). The owner
      // has a Claude-Code skill called "deep-research"; the planner picked it for a research task —
      // obviously, given the name — and the branch ran on the engine, which cannot search the web
      // (BEA-1202) or write files. It refused politely and a third of the research vanished.
      //
      // Scoped to the Web group on purpose: only there does the engine's no-search rule make the
      // skill INCAPABLE of what its name promises. A skill called "Gmail" that does its own triage
      // is a legitimate choice and must not be overridden by a coincidence of naming.
      //
      // The swap is written onto the node (`note` → canvas `sub`), never silent — quiet
      // substitutions are the bug class this codebase keeps paying for.
      //
      // If the web tools are NOT connected they are absent from toolById, no remap can fire, and
      // the planner prompt ("skills cannot search") is the only defence left.
      const skillTitle = skillById.get(id)!;
      const skillName = FlowsService.normName(skillTitle);
      for (const [toolId, toolName] of toolById) {
        if (!webTools?.has(toolId)) continue;
        if (FlowsService.normName(toolId) === skillName || FlowsService.normName(toolName) === skillName) {
          return { kind: 'tool', label: toolName, refId: toolId, note: `Swapped in for the "${skillTitle}" skill — skills run on the engine and cannot search the web` };
        }
      }
      return { kind: 'skill', label: skillTitle, refId: id };
    }
    return { kind: 'ask_ai', label: 'Ask AI' };
  }

  /**
   * A research question is LONG, and every point in it matters (BEA-1241).
   *
   * The owner's real question was 1,254 characters over ten numbered points. It was clipped in five
   * separate places — the planner saw 600, the auto-planner 800, the canvas node 300, the merge goal
   * 500 — so points 4 to 10 never reached a single search, and the run was then marked down for not
   * answering them. Nothing said the question had been shortened.
   *
   * This cap exists only so a pasted novel cannot blow a prompt. It is far above any real question.
   */
  private static readonly QUESTION_MAX = 8000;

  /**
   * `planFailed` marks a graph the planner never produced (BEA-1253). Without it, a failed plan and
   * a genuine single-branch plan are the same picture: one Ask-AI box, a 200 from the endpoint, no
   * toast, nothing to tell the owner that the thing he is looking at is a stand-in. He would run it
   * and wonder why the answer was thin.
   */
  private buildGraph(question: string, plan: any, skillById: Map<string, string>, toolById: Map<string, string>, webTools?: Set<string>, planFailed = false): { nodes: any[]; edges: any[] } {
    const nodes: any[] = [];
    const edges: any[] = [];
    const CX = 320, COL = 240, ROW = 110;
    nodes.push({
      id: 'question',
      type: 'box',
      position: { x: CX, y: 0 },
      data: {
        kind: 'question',
        label: 'Question',
        sub: question.slice(0, FlowsService.QUESTION_MAX),
        ...(planFailed ? { planFailed: true, warn: FlowsService.PLAN_FAILED_NOTE } : {}),
      },
    });

    let branches: any[] = Array.isArray(plan?.branches) ? plan.branches.slice(0, 5) : [];
    if (!branches.length) branches = [{ subquestion: question.slice(0, FlowsService.QUESTION_MAX), steps: [{ kind: 'ask_ai' }] }];
    const startX = branches.length > 1 ? CX - ((branches.length - 1) * COL) / 2 : CX;
    const lasts: string[] = [];
    let maxY = ROW;

    branches.forEach((br, i) => {
      const x = startX + i * COL;
      let y = ROW + 20;
      const sqId = `b${i}_sq`;
      nodes.push({ id: sqId, type: 'box', position: { x, y }, data: { kind: 'subquestion', label: `Branch ${i + 1}`, sub: String(br?.subquestion || '').slice(0, FlowsService.QUESTION_MAX) } });
      edges.push({ id: `e_q_${sqId}`, source: 'question', target: sqId, animated: true });
      let prev = sqId;
      let steps: any[] = Array.isArray(br?.steps) ? br.steps.slice(0, 4) : [];
      if (!steps.length) steps = [{ kind: 'ask_ai' }];
      steps.forEach((st, j) => {
        y += ROW;
        const nidv = `b${i}_s${j}`;
        const r = this.resolveStep(st, skillById, toolById, webTools);
        nodes.push({ id: nidv, type: 'box', position: { x, y }, data: { kind: r.kind, label: r.label, refId: r.refId, ...(r.note ? { sub: r.note } : {}) } });
        edges.push({ id: `e_${prev}_${nidv}`, source: prev, target: nidv, animated: true });
        prev = nidv;
      });
      lasts.push(prev);
      maxY = Math.max(maxY, y);
    });

    const mergeY = maxY + ROW + 20;
    nodes.push({ id: 'merge', type: 'box', position: { x: CX, y: mergeY }, data: { kind: 'merge', label: 'Merge', mode: plan?.merge === 'raw' ? 'raw' : 'ai', goal: question.slice(0, FlowsService.QUESTION_MAX) } });
    lasts.forEach((l) => edges.push({ id: `e_${l}_merge`, source: l, target: 'merge', animated: true }));
    nodes.push({ id: 'output', type: 'box', position: { x: CX, y: mergeY + ROW }, data: { kind: 'output', label: 'Output' } });
    edges.push({ id: 'e_merge_output', source: 'merge', target: 'output', animated: true });
    return { nodes, edges };
  }
}
