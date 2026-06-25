import { Injectable } from '@nestjs/common';
import { randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';

// pdf-parse v1 has no types; the /lib import avoids its debug-mode file read on require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (b: Buffer) => Promise<{ text: string }> = require('pdf-parse/lib/pdf-parse.js');

const docsDir = () => join(process.env.DATA_DIR || '/app/data', 'documents');

export type UploadFile = { originalname: string; mimetype?: string; buffer: Buffer; size?: number };

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
    return this.insert({
      title,
      description: finalDesc,
      kind: input.kind || 'md',
      contentText: content,
      bytes: Buffer.byteLength(content, 'utf8'),
      tags,
    });
  }

  /** Shared insert — text docs and uploaded files both land here. */
  private async insert(data: { title: string; description: string | null; kind: string; tags: string[]; contentText?: string | null; filePath?: string | null; mime?: string | null; filename?: string | null; bytes?: number | null }) {
    const row = await this.prisma.document.create({
      data: {
        slug: this.slugify(data.title),
        title: data.title,
        description: data.description,
        kind: data.kind,
        contentText: data.contentText ?? null,
        filePath: data.filePath ?? null,
        mime: data.mime ?? null,
        filename: data.filename ?? null,
        bytes: data.bytes ?? null,
        tags: JSON.stringify(data.tags),
      },
    });
    return this.full(row);
  }

  /** Detect the document kind from a filename/mime. */
  private kindOf(name: string, mime?: string): 'md' | 'html' | 'pdf' | 'image' {
    const ext = extname(name || '').toLowerCase().replace('.', '');
    if ((mime || '').startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
    if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (mime === 'text/html' || ['html', 'htm'].includes(ext)) return 'html';
    return 'md';
  }

  /** Create a document from an uploaded file (md/html/pdf/image). (BEA-534) */
  async createFromUpload(file: UploadFile) {
    const name = file.originalname || 'upload';
    const kind = this.kindOf(name, file.mimetype);
    const title = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Untitled';

    if (kind === 'md' || kind === 'html') {
      const content = file.buffer.toString('utf8');
      return this.create({ title, contentText: content, kind });
    }

    // Binary: store on the volume, then summarise from extracted text (pdf) or just the name (image).
    await fs.mkdir(docsDir(), { recursive: true });
    const id = randomUUID();
    const filePath = join(docsDir(), `${id}${extname(name) || ''}`);
    await fs.writeFile(filePath, file.buffer);

    let description = '';
    let tags: string[] = [];
    if (kind === 'pdf') {
      const text = await pdfParse(file.buffer).then((r) => r.text || '').catch(() => '');
      if (text.trim()) {
        const ai = await this.summarize(text).catch(() => ({ description: '', tags: [] as string[] }));
        description = ai.description;
        tags = ai.tags;
      }
    }
    if (!description) description = kind === 'pdf' ? `PDF · ${name}` : `Image · ${name}`;

    return this.insert({
      title,
      description: description.slice(0, 200),
      kind,
      tags,
      filePath,
      mime: file.mimetype || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
      filename: name,
      bytes: file.size ?? file.buffer.length,
    });
  }

  // ---- Server-to-server ingest (BEA-535) ----

  private async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }
  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /** The current ingest token, creating one on first read so the Settings card always has something to show. */
  async ingestToken(): Promise<string> {
    const existing = await this.getSetting('documents.ingestToken');
    if (existing) return existing;
    const token = randomBytes(32).toString('hex');
    await this.setSetting('documents.ingestToken', token);
    return token;
  }
  async regenerateIngestToken(): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.setSetting('documents.ingestToken', token);
    return token;
  }
  /** Constant-time token check. Ingest stays disabled until a token exists. */
  async verifyIngestToken(provided: string | undefined | null): Promise<boolean> {
    const stored = await this.getSetting('documents.ingestToken');
    if (!stored || !provided) return false;
    const a = Buffer.from(stored);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Create a document from another server — a file or a JSON body — stamping originServer. */
  async ingest(args: { file?: UploadFile; title?: string; contentText?: string; kind?: string; tags?: string[]; sourceUrl?: string; originServer?: string }) {
    const doc = args.file ? await this.createFromUpload(args.file) : await this.create({ title: args.title, contentText: args.contentText, kind: args.kind, tags: args.tags });
    if (args.originServer || args.sourceUrl) {
      await this.prisma.document
        .update({ where: { id: doc.id }, data: { originServer: args.originServer?.slice(0, 120) || undefined, sourceUrl: args.sourceUrl?.slice(0, 500) || undefined } })
        .catch(() => undefined);
    }
    return doc;
  }

  /** Locate a stored binary file for streaming (open/preview/download). */
  async file(id: string) {
    const row = await this.prisma.document.findUnique({ where: { id } });
    if (!row || !row.filePath) return null;
    return { filePath: row.filePath, mime: row.mime || 'application/octet-stream', filename: row.filename || `${row.slug}${extname(row.filePath)}` };
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
    const row = await this.prisma.document.findUnique({ where: { id } }).catch(() => null);
    if (row?.filePath) await fs.unlink(row.filePath).catch(() => undefined);
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
