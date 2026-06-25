import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';

export type DocInput = {
  title?: string;
  contentText?: string;
  description?: string;
  kind?: string;
  tags?: string[];
};

// A cheap, fast model is plenty for a one-line summary + tags. (BEA-533)
const SUMMARY_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };

/** The Documents library (BEA-532): the user's own md/html files to share & re-use — NOT in memory. */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  /** AI read: a ≤200-char description + a few topic tags for a document's content. (BEA-533) */
  async summarize(content: string): Promise<{ description: string; tags: string[] }> {
    const text = (content || '').trim();
    if (!text) return { description: '', tags: [] };
    const prompt =
      `Read this document and describe it for a library card, in simple plain English.\n` +
      `Return ONLY JSON: {"description":"a clear summary of what this document is, at most 200 characters","tags":["3-6 short lowercase topic tags"]}.\n\nDOCUMENT:\n${text.slice(0, 6000)}`;
    const raw = (await this.llm.completeWith(SUMMARY_MODEL, prompt, 300, 'document-summary'))?.trim() || '';
    try {
      const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      return { description: String(j?.description || '').trim().slice(0, 200), tags: this.parseTags(j?.tags) };
    } catch {
      return { description: this.autoDescription(text), tags: [] };
    }
  }

  private slugify(title: string): string {
    const base = (title || 'document')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'document';
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  /** A plain, non-AI description fallback: first ~200 chars of the content, markdown stripped. */
  private autoDescription(content: string): string {
    return (content || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`~\[\]()!|-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  private parseTags(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean).slice(0, 30);
    try {
      const j = JSON.parse(String(raw || '[]'));
      return Array.isArray(j) ? j.map((t) => String(t).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private shape(d: any) {
    return {
      id: d.id,
      slug: d.slug,
      title: d.title,
      description: d.description || null,
      kind: d.kind,
      tags: this.parseTags(d.tags),
      shared: !!d.shared,
      bytes: d.bytes ?? (d.contentText ? Buffer.byteLength(d.contentText, 'utf8') : null),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }

  /** List for the library — newest first, no content (keeps the payload small). */
  async list() {
    const rows = await this.prisma.document.findMany({ orderBy: { updatedAt: 'desc' } });
    return { documents: rows.map((r) => this.shape(r)) };
  }

  async create(input: DocInput) {
    const title = (input.title || 'Untitled').trim().slice(0, 200) || 'Untitled';
    const content = input.contentText || '';
    let description = input.description?.trim() || '';
    let tags = this.parseTags(input.tags);
    // Auto-fill what the user left blank with a cheap AI pass (editable afterwards). (BEA-533)
    if ((!description || tags.length === 0) && content.trim()) {
      const ai = await this.summarize(content).catch(() => ({ description: '', tags: [] as string[] }));
      if (!description) description = ai.description;
      if (tags.length === 0) tags = ai.tags;
    }
    const finalDesc = (description || this.autoDescription(content)).slice(0, 200) || null;
    const row = await this.prisma.document.create({
      data: {
        slug: this.slugify(title),
        title,
        description: finalDesc,
        kind: input.kind || 'md',
        contentText: content,
        bytes: Buffer.byteLength(content, 'utf8'),
        tags: JSON.stringify(tags),
      },
    });
    return this.full(row);
  }

  /** Full document incl. content, for the in-app viewer/editor. */
  private full(d: any) {
    return { ...this.shape(d), contentText: d.contentText || '' };
  }

  async get(id: string) {
    const row = await this.prisma.document.findUnique({ where: { id } });
    return row ? this.full(row) : null;
  }

  async update(id: string, patch: DocInput) {
    const data: Record<string, unknown> = {};
    if (typeof patch.title === 'string') data.title = patch.title.trim().slice(0, 200) || 'Untitled';
    if (typeof patch.contentText === 'string') {
      data.contentText = patch.contentText;
      data.bytes = Buffer.byteLength(patch.contentText, 'utf8');
    }
    if (typeof patch.description === 'string') data.description = patch.description.trim().slice(0, 200) || null;
    if (patch.tags) data.tags = JSON.stringify(this.parseTags(patch.tags));
    const row = await this.prisma.document.update({ where: { id }, data }).catch(() => null);
    return row ? this.full(row) : null;
  }

  async remove(id: string) {
    await this.prisma.document.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  async setShared(id: string, shared: boolean) {
    const row = await this.prisma.document.update({ where: { id }, data: { shared } }).catch(() => null);
    return row ? this.shape(row) : null;
  }

  /** Public read by slug — only returns the doc if the owner has shared it. */
  async getShared(slug: string) {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !row.shared) return null;
    return { title: row.title, description: row.description || null, kind: row.kind, contentText: row.contentText || '', updatedAt: row.updatedAt };
  }

  /** Raw content + a download filename, for the download button. */
  async raw(id: string) {
    const row = await this.prisma.document.findUnique({ where: { id } });
    if (!row) return null;
    const ext = row.kind === 'html' ? 'html' : 'md';
    const base = (row.title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
    return { filename: `${base}.${ext}`, content: row.contentText || '', mime: row.kind === 'html' ? 'text/html' : 'text/markdown' };
  }
}
