import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

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

/** The fixed tool/connector nodes (agent-powered hybrid — every connected tool works via the agent). */
const TOOL_PALETTE = [
  { type: 'tool', id: 'search_brain', name: 'Search my brain', group: 'Brain', description: 'RAG + SuperMemory' },
  { type: 'tool', id: 'web_search', name: 'Web search', group: 'Web', description: 'Search the web' },
  { type: 'tool', id: 'web_read', name: 'Read a page', group: 'Web', description: 'Open + read a URL' },
  { type: 'tool', id: 'gmail', name: 'Gmail', group: 'Google', description: 'Read / search email' },
  { type: 'tool', id: 'calendar', name: 'Calendar', group: 'Google', description: 'Read your calendar' },
  { type: 'tool', id: 'drive', name: 'Drive', group: 'Google', description: 'Find / read files' },
  { type: 'tool', id: 'ask_ai', name: 'Ask AI', group: 'AI', description: 'A plain reasoning step' },
  { type: 'tool', id: 'http', name: 'HTTP request', group: 'API', description: 'Call any external API' },
  { type: 'tool', id: 'save_document', name: 'Save to Documents', group: 'Output', description: 'Save the result' },
  { type: 'tool', id: 'telegram', name: 'Send to Telegram', group: 'Output', description: 'Message you on Telegram' },
];

@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    private readonly llm: LlmService,
    private readonly promptsSvc?: PromptsService, // optional + LAST — spec files construct positionally
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
  async update(id: string, patch: { name?: string; question?: string; graph?: unknown; schedule?: unknown }) {
    const data: any = {};
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
        gmail: 'Check my Gmail for what is relevant.',
        calendar: 'Check my calendar.',
        drive: 'Find and read the relevant files in my Google Drive.',
        save_document: 'Save the result as a document.',
        telegram: 'Send the result to me on Telegram.',
        http: 'Make the appropriate external API / HTTP request and use the result.',
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
        const out = await this.llm.complete(
          tpl.replaceAll('{{task}}', (agent.prompt || '(empty)').slice(0, 2000)).replaceAll('{{flow}}', flowWords.slice(0, 3000)),
          900,
          'flow-sync-words',
        );
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
    const graph = await this.planFlow(f.question || f.name || '');
    const updated = await this.prisma.flow.update({ where: { id }, data: { graph: JSON.stringify(graph) } });
    return this.shape(updated);
  }

  /** The draggable node palette: your skills + the connected tools. */
  async palette() {
    const skills = (await this.skills.list()).map((s: any) => ({ type: 'skill', id: s.id, name: s.title, description: s.description }));
    return { generics: GENERIC_PALETTE, tools: TOOL_PALETTE, skills };
  }

  /** Break a question into independent sub-questions for the branches (BEA-644). */
  async decompose(question: string): Promise<string[]> {
    try {
      const out = await this.llm.complete(
        `Break the user's request into 2-5 INDEPENDENT sub-questions that can each be worked on separately, then combined into one answer. Request:\n"${question.slice(0, 600)}"\n\nReply with ONLY a JSON array of short sub-question strings, e.g. ["...","..."]. No prose.`,
        400,
        'flow-decompose',
      );
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
  async planFlow(question: string): Promise<{ nodes: any[]; edges: any[] }> {
    const q = (question || '').trim();
    const all = (await this.skills.list().catch(() => [])) as any[];
    // only offer skills actually deployed somewhere, and skip generic build/design skills for research
    const skills = all.filter((s) => (s.deployedTo || []).length);
    const skillById = new Map(skills.map((s) => [s.id, s.title]));
    const toolById = new Map(TOOL_PALETTE.map((t) => [t.id, t.name]));
    const skillList = skills.map((s) => `- skill:${s.id} — ${s.title}: ${(s.description || '').slice(0, 80)}`).join('\n');
    const toolList = TOOL_PALETTE.map((t) => `- tool:${t.id} — ${t.name}: ${t.description}`).join('\n');

    let plan: any = null;
    try {
      const out = await this.llm.complete(
        `You plan a visual workflow ("flow") that answers a request by splitting it into independent branches that run, then merge into one answer.\n\nRequest:\n"${q.slice(0, 800)}"\n\nSteps you may place in a branch (use the EXACT id):\nTOOLS:\n${toolList}\nSKILLS (only use one if its description is an OBVIOUS fit for THIS request — most tasks need NONE):\n${skillList || '(no skills)'}\n\nRules:\n- Plan 2-4 branches. Each branch = a short sub-question + 1-3 ordered steps.\n- Each sub-question MUST be self-contained: name the exact subject explicitly (e.g. the specific repo/product/person from the request), never a pronoun or a generic word that could be misread out of context.\n- For facts about the world, use web_search then ask_ai.\n- If the request is about the USER's own project, work, notes or context, INCLUDE one branch that uses search_brain then ask_ai.\n- Do NOT add a skill unless it clearly matches the request (e.g. don't use a UI/design skill for a research task). When unsure, use ask_ai.\n- End each branch with ask_ai so it produces written output.\n\nReply with ONLY JSON, no prose:\n{"branches":[{"subquestion":"...","steps":[{"kind":"tool","id":"web_search"},{"kind":"ask_ai"}]}],"merge":"ai"}\nkind is "tool"+id, "skill"+id, or "ask_ai" (no id). merge is "ai" or "raw".`,
        1100,
        'flow-plan',
      );
      const m = (out || '').match(/\{[\s\S]*\}/);
      if (m) plan = JSON.parse(m[0]);
    } catch { plan = null; }

    return this.buildGraph(q, plan, skillById, toolById);
  }

  private resolveStep(st: any, skillById: Map<string, string>, toolById: Map<string, string>): { kind: string; label: string; refId?: string } {
    const kind = st?.kind;
    const id = st?.id;
    if (kind === 'tool' && toolById.has(id)) return { kind: 'tool', label: toolById.get(id)!, refId: id };
    if (kind === 'skill' && skillById.has(id)) return { kind: 'skill', label: skillById.get(id)!, refId: id };
    return { kind: 'ask_ai', label: 'Ask AI' };
  }

  private buildGraph(question: string, plan: any, skillById: Map<string, string>, toolById: Map<string, string>): { nodes: any[]; edges: any[] } {
    const nodes: any[] = [];
    const edges: any[] = [];
    const CX = 320, COL = 240, ROW = 110;
    nodes.push({ id: 'question', type: 'box', position: { x: CX, y: 0 }, data: { kind: 'question', label: 'Question', sub: question.slice(0, 300) } });

    let branches: any[] = Array.isArray(plan?.branches) ? plan.branches.slice(0, 5) : [];
    if (!branches.length) branches = [{ subquestion: question.slice(0, 200), steps: [{ kind: 'ask_ai' }] }];
    const startX = branches.length > 1 ? CX - ((branches.length - 1) * COL) / 2 : CX;
    const lasts: string[] = [];
    let maxY = ROW;

    branches.forEach((br, i) => {
      const x = startX + i * COL;
      let y = ROW + 20;
      const sqId = `b${i}_sq`;
      nodes.push({ id: sqId, type: 'box', position: { x, y }, data: { kind: 'subquestion', label: `Branch ${i + 1}`, sub: String(br?.subquestion || '').slice(0, 200) } });
      edges.push({ id: `e_q_${sqId}`, source: 'question', target: sqId, animated: true });
      let prev = sqId;
      let steps: any[] = Array.isArray(br?.steps) ? br.steps.slice(0, 4) : [];
      if (!steps.length) steps = [{ kind: 'ask_ai' }];
      steps.forEach((st, j) => {
        y += ROW;
        const nidv = `b${i}_s${j}`;
        const r = this.resolveStep(st, skillById, toolById);
        nodes.push({ id: nidv, type: 'box', position: { x, y }, data: { kind: r.kind, label: r.label, refId: r.refId } });
        edges.push({ id: `e_${prev}_${nidv}`, source: prev, target: nidv, animated: true });
        prev = nidv;
      });
      lasts.push(prev);
      maxY = Math.max(maxY, y);
    });

    const mergeY = maxY + ROW + 20;
    nodes.push({ id: 'merge', type: 'box', position: { x: CX, y: mergeY }, data: { kind: 'merge', label: 'Merge', mode: plan?.merge === 'raw' ? 'raw' : 'ai', goal: question.slice(0, 500) } });
    lasts.forEach((l) => edges.push({ id: `e_${l}_merge`, source: l, target: 'merge', animated: true }));
    nodes.push({ id: 'output', type: 'box', position: { x: CX, y: mergeY + ROW }, data: { kind: 'output', label: 'Output' } });
    edges.push({ id: 'e_merge_output', source: 'merge', target: 'output', animated: true });
    return { nodes, edges };
  }
}
