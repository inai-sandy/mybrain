import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { ItemsService } from '../items/items.service';
import { PromptsService } from '../prompts/prompts.service';

@Injectable()
export class IdeasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly items: ItemsService,
    private readonly prompts: PromptsService,
  ) {}

  /** Attach an uploaded research doc to an idea: store it as a Capture item, then link it. */
  async addDoc(ideaId: string, content: string, title: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId } });
    if (!idea) return null;
    const { item } = await this.items.store(content, 'upload', title || 'Research notes', undefined, ['research']);
    await this.prisma.item.update({ where: { id: item.id }, data: { ideaId } });
    return { id: item.id, title: item.title };
  }

  /** Turn a raw brain-dump into {title, content, research} via the default model. */
  private async craft(dump: string): Promise<{ title: string; content: string; research: string } | null> {
    const tmpl = await this.prompts.get('ideas.organize');
    const prompt = `${tmpl}\n\nBrain-dump:\n${dump.slice(0, 6000)}`;
    const text = await this.llm.complete(prompt, 1200);
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
    // Index the idea text so even un-researched ideas are searchable by meaning (stamped "idea").
    await this.memory.enqueue(`${title}\n\n${content}`, { title, tags: ['idea'] });
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
    return this.get(id);
  }
}
