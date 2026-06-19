import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { ItemsService } from '../items/items.service';
import { PromptsService } from '../prompts/prompts.service';

@Injectable()
export class IdeasService {
  private readonly logger = new Logger(IdeasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly items: ItemsService,
    private readonly prompts: PromptsService,
  ) {}

  // ---- persist idea markdown files to a server folder (default /var/www/ideas) ----

  private ideasDir(): string {
    return process.env.IDEAS_MD_DIR || '/var/www/ideas';
  }

  private slugify(s: string): string {
    return (s || 'idea')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'idea';
  }

  /** Write the AI-organized idea (title + content + research prompt) as a .md. Creates the folder
   *  if missing; never throws — a failed write must not break idea create/edit. */
  private async writeIdeaFile(idea: { id: string; title: string; content: string; researchPrompt?: string | null }): Promise<void> {
    try {
      const dir = this.ideasDir();
      await fs.mkdir(dir, { recursive: true });
      const name = `${this.slugify(idea.title)}-${idea.id.slice(0, 8)}.md`;
      const md = `# ${idea.title || 'Untitled idea'}\n\n${(idea.content || '').trim()}\n\n---\n\n## Deep-research prompt\n\n${(idea.researchPrompt || '').trim()}\n`;
      await fs.writeFile(join(dir, name), md, 'utf8');
    } catch (e) {
      this.logger.warn(`Could not write idea md (${idea.id}): ${String((e as Error)?.message || e)}`);
    }
  }

  /** Write an uploaded research doc into the same folder, named after its idea. Never throws. */
  private async writeDocFile(ideaTitle: string, docTitle: string, content: string): Promise<void> {
    try {
      const dir = this.ideasDir();
      await fs.mkdir(dir, { recursive: true });
      const name = `${this.slugify(ideaTitle)}--${this.slugify(docTitle)}.md`;
      await fs.writeFile(join(dir, name), content, 'utf8');
    } catch (e) {
      this.logger.warn(`Could not write research doc md: ${String((e as Error)?.message || e)}`);
    }
  }

  /** Attach an uploaded research doc to an idea: store it as a Capture item, then link it. */
  async addDoc(ideaId: string, content: string, title: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId } });
    if (!idea) return null;
    const { item } = await this.items.store(content, 'upload', title || 'Research notes', undefined, ['research']);
    await this.prisma.item.update({ where: { id: item.id }, data: { ideaId } });
    await this.writeDocFile(idea.title, title || 'Research notes', content);
    return { id: item.id, title: item.title };
  }

  /** Turn a raw brain-dump into {title, content, research} via the default model. */
  private async craft(dump: string): Promise<{ title: string; content: string; research: string } | null> {
    const tmpl = await this.prompts.get('ideas.organize');
    const prompt = `${tmpl}\n\nBrain-dump:\n${dump.slice(0, 6000)}`;
    const text = await this.llm.complete(prompt, 1200, 'idea-organize');
    if (!text) return null;
    try {
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      return {
        title: String(json.title || '').trim().slice(0, 120),
        content: String(json.content || '').trim(),
        research: String(json.research || '').trim(),
      };
    } catch {
      return null;
    }
  }

  private snippet(content: string): string {
    return (content || '').replace(/[#*`>_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  async create(dump: string) {
    const clean = (dump || '').trim();
    const crafted = await this.craft(clean);
    const title = crafted?.title || clean.split('\n')[0].slice(0, 80) || 'Untitled idea';
    const content = crafted?.content || clean;
    const research = crafted?.research || `Research this idea thoroughly and produce a structured Markdown report.\n\n${clean}`;
    const researchPrompt = `/deep-research\n\n${research}`;
    const idea = await this.prisma.idea.create({ data: { rawDump: clean, title, content, researchPrompt, status: 'open' } });
    await this.writeIdeaFile({ id: idea.id, title, content, researchPrompt });
    // Index the idea text (replace-on-edit, linked to the row) so it's searchable by meaning. (BEA-342)
    await this.memory.indexEntity({ refType: 'idea', refId: idea.id, title, content: `${title}\n\n${content}`, tags: ['idea'], prevSupermemoryId: (idea as any).supermemoryId, prevRagId: (idea as any).ragId });
    return { id: idea.id, title, snippet: this.snippet(content), researchPrompt, status: 'open', createdAt: idea.createdAt, linkedCount: 0 };
  }

  async list() {
    const ideas = await this.prisma.idea.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    const counts = await this.prisma.item.groupBy({ by: ['ideaId'], where: { ideaId: { not: null } }, _count: { _all: true } });
    const cmap = new Map(counts.map((c) => [c.ideaId, c._count._all]));
    return ideas.map((i) => ({
      id: i.id,
      title: i.title,
      snippet: this.snippet(i.content),
      researchPrompt: i.researchPrompt,
      status: i.status,
      createdAt: i.createdAt,
      completedAt: i.completedAt,
      linkedCount: cmap.get(i.id) || 0,
    }));
  }

  async get(id: string) {
    const i = await this.prisma.idea.findUnique({ where: { id } });
    if (!i) return null;
    const docs = await this.prisma.item.findMany({ where: { ideaId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true, createdAt: true } });
    return {
      id: i.id,
      title: i.title,
      content: i.content,
      researchPrompt: i.researchPrompt,
      status: i.status,
      createdAt: i.createdAt,
      completedAt: i.completedAt,
      docs,
    };
  }

  async setStatus(id: string, status: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id } });
    if (!idea) return null;
    const done = status === 'done';
    await this.prisma.idea.update({ where: { id }, data: { status: done ? 'done' : 'open', completedAt: done ? new Date() : null } });
    return { status: done ? 'done' : 'open' };
  }

  async update(id: string, data: { title?: string; content?: string }) {
    const idea = await this.prisma.idea.findUnique({ where: { id } });
    if (!idea) return null;
    await this.prisma.idea.update({
      where: { id },
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 120) : idea.title,
        content: typeof data.content === 'string' ? data.content : idea.content,
      },
    });
    const fresh = await this.prisma.idea.findUnique({ where: { id } });
    if (fresh) await this.writeIdeaFile(fresh);
    return this.get(id);
  }

  // ---- agentic workflow (node stack) ----

  private shapeWorkflow(w: any) {
    let nodes: any[] = [];
    try {
      nodes = JSON.parse(w.nodes || '[]');
    } catch {
      nodes = [];
    }
    return { id: w.id, ideaId: w.ideaId, name: w.name, nodes, customPrompt: w.customPrompt ?? null, updatedAt: w.updatedAt };
  }

  async getWorkflow(ideaId: string) {
    const w = await this.prisma.ideaWorkflow.findUnique({ where: { ideaId } });
    return w ? this.shapeWorkflow(w) : { ideaId, name: 'Workflow', nodes: [] as any[] };
  }

  /** Validate + persist the node list. Only 'skill' and 'text' node types are accepted (v1). */
  async saveWorkflow(ideaId: string, data: { name?: string; nodes?: any[]; customPrompt?: string | null }) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId } });
    if (!idea) return null;
    const clean = (Array.isArray(data.nodes) ? data.nodes : [])
      .map((n: any) => {
        const type = n?.type === 'text' ? 'text' : n?.type === 'skill' ? 'skill' : null;
        if (!type) return null;
        const id = String(n.id || '').slice(0, 60) || Math.random().toString(36).slice(2);
        if (type === 'skill') return { id, type, skill: String(n.skill || '').slice(0, 120), slug: n.slug ? String(n.slug).slice(0, 120) : null };
        return { id, type, text: String(n.text || '').slice(0, 4000) };
      })
      .filter(Boolean)
      .slice(0, 50);
    const name = (data.name || 'Workflow').toString().trim().slice(0, 80) || 'Workflow';
    const customPrompt = data.customPrompt === undefined ? undefined : data.customPrompt ? String(data.customPrompt).slice(0, 8000) : null;
    const w = await this.prisma.ideaWorkflow.upsert({
      where: { ideaId },
      create: { ideaId, name, nodes: JSON.stringify(clean), customPrompt: customPrompt ?? null },
      update: { name, nodes: JSON.stringify(clean), ...(customPrompt === undefined ? {} : { customPrompt }) },
    });
    return this.shapeWorkflow(w);
  }
}
