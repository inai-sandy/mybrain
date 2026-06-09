import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ChecklistItem = { text: string; done: boolean };

const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

/** Quick-capture notes (Keep style). Deliberately LOCAL ONLY — never written to RAG/SuperMemory. */
@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  private shape(n: any) {
    const parse = (s: any, fb: any) => {
      try {
        return s ? JSON.parse(s) : fb;
      } catch {
        return fb;
      }
    };
    return {
      id: n.id,
      title: n.title || '',
      content: n.content || '',
      checklist: parse(n.checklist, []) as ChecklistItem[],
      color: n.color || 'default',
      tags: parse(n.tags, []) as string[],
      pinned: !!n.pinned,
      archived: !!n.archived,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    };
  }

  private clean(data: any) {
    const color = COLORS.includes(data?.color) ? data.color : 'default';
    const tags = Array.isArray(data?.tags)
      ? [...new Set(data.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 12)
      : undefined;
    const checklist = Array.isArray(data?.checklist)
      ? data.checklist
          .map((c: any) => ({ text: String(c?.text ?? '').slice(0, 500), done: !!c?.done }))
          .filter((c: ChecklistItem) => c.text.trim().length > 0 || c.done)
          .slice(0, 100)
      : undefined;
    return {
      title: data?.title !== undefined ? String(data.title).slice(0, 200) : undefined,
      content: data?.content !== undefined ? String(data.content).slice(0, 20000) : undefined,
      checklist: checklist !== undefined ? JSON.stringify(checklist) : undefined,
      color: data?.color !== undefined ? color : undefined,
      tags: tags !== undefined ? JSON.stringify(tags) : undefined,
      pinned: data?.pinned !== undefined ? !!data.pinned : undefined,
      archived: data?.archived !== undefined ? !!data.archived : undefined,
    };
  }

  /** All notes (active or archived), pinned first then most-recently updated. Filtering/search is done client-side. */
  async list(archived = false) {
    const rows = await this.prisma.note.findMany({
      where: { archived: !!archived },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: 1000,
    });
    const all = rows.map((n) => this.shape(n));
    // facets so the UI can offer color/tag filters
    const colors = [...new Set(all.map((n) => n.color))];
    const tags = [...new Set(all.flatMap((n) => n.tags))].sort();
    return { notes: all, count: all.length, colors, tags };
  }

  async create(data: any) {
    const c = this.clean(data);
    if (!c.title?.trim() && !c.content?.trim() && (!c.checklist || c.checklist === '[]')) return null;
    const row = await this.prisma.note.create({
      data: {
        title: c.title || null,
        content: c.content || null,
        checklist: c.checklist || null,
        color: c.color || 'default',
        tags: c.tags || null,
        pinned: c.pinned ?? false,
        archived: c.archived ?? false,
      },
    });
    return this.shape(row);
  }

  async update(id: string, data: any) {
    const existing = await this.prisma.note.findUnique({ where: { id } });
    if (!existing) return null;
    const c = this.clean(data);
    const row = await this.prisma.note.update({
      where: { id },
      data: {
        title: c.title !== undefined ? c.title || null : existing.title,
        content: c.content !== undefined ? c.content || null : existing.content,
        checklist: c.checklist !== undefined ? c.checklist : existing.checklist,
        color: c.color !== undefined ? c.color : existing.color,
        tags: c.tags !== undefined ? c.tags : existing.tags,
        pinned: c.pinned !== undefined ? c.pinned : existing.pinned,
        archived: c.archived !== undefined ? c.archived : existing.archived,
      },
    });
    return this.shape(row);
  }

  async remove(id: string) {
    await this.prisma.note.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }
}
