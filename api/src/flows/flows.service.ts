import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';
import { LlmService } from '../llm/llm.service';

/** Generic building blocks (n8n-style utility nodes). `kind` drives the node's look/behaviour. */
const GENERIC_PALETTE = [
  { type: 'generic', kind: 'text', id: 'text', name: 'Text input', description: 'A fixed piece of text / value' },
  { type: 'generic', kind: 'note', id: 'note', name: 'Note', description: 'A comment on the canvas' },
  { type: 'generic', kind: 'if', id: 'if', name: 'If / condition', description: 'Branch on a condition' },
  { type: 'generic', kind: 'filter', id: 'filter', name: 'Filter', description: 'Keep only what matches' },
  { type: 'generic', kind: 'merge', id: 'merge_block', name: 'Merge', description: 'Combine outputs (AI / raw)' },
  { type: 'generic', kind: 'wait', id: 'wait', name: 'Wait', description: 'Pause for a set time' },
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
  ) {}

  private parse(s?: string | null): any {
    try { return s ? JSON.parse(s) : { nodes: [], edges: [] }; } catch { return { nodes: [], edges: [] }; }
  }
  private shape(f: any) {
    return { ...f, graph: this.parse(f.graph) };
  }

  async list() {
    const rows = await this.prisma.flow.findMany({ orderBy: { updatedAt: 'desc' }, take: 500 });
    return rows.map((f) => this.shape(f));
  }
  async get(id: string) {
    const f = await this.prisma.flow.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Flow not found');
    return this.shape(f);
  }
  async create(input: { name?: string; question?: string; graph?: unknown }) {
    const f = await this.prisma.flow.create({
      data: {
        name: input.name?.trim()?.slice(0, 120) || 'Untitled flow',
        question: input.question?.trim() || null,
        ...(input.graph ? { graph: JSON.stringify(input.graph) } : {}),
      },
    });
    return this.shape(f);
  }
  async update(id: string, patch: { name?: string; question?: string; graph?: unknown }) {
    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120) || 'Untitled flow';
    if (patch.question !== undefined) data.question = patch.question?.trim() || null;
    if (patch.graph !== undefined) data.graph = JSON.stringify(patch.graph || { nodes: [], edges: [] });
    const f = await this.prisma.flow.update({ where: { id }, data }).catch(() => { throw new NotFoundException('Flow not found'); });
    return this.shape(f);
  }
  async remove(id: string) {
    await this.prisma.flow.delete({ where: { id } }).catch(() => { throw new NotFoundException('Flow not found'); });
    return { ok: true };
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
}
