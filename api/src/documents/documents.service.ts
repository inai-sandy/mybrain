import { Injectable } from '@nestjs/common';
import { randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { ItemsService } from '../items/items.service';

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
  collectionId?: string | null;
};

// A cheap, fast model is plenty for a one-line summary + tags. (BEA-533)
const SUMMARY_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };

/** The Documents library (BEA-532): the user's own md/html files to share & re-use — NOT in memory. */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly items: ItemsService,
  ) {}

  /** Copy a document into Capture/memory (RAG + SuperMemory) on demand. (BEA-540) */
  async convertToCapture(id: string) {
    const row = await this.prisma.document.findUnique({ where: { id } });
    if (!row) throw new Error('Document not found.');
    const content = (row.contentText || '').trim();
    if (!content) throw new Error('This document has no text to remember (images can’t be sent to memory).');
    const tags = Array.from(new Set([...this.parseTags(row.tags), 'document']));
    const res = await this.items.store(content, 'document', row.title, row.sourceUrl || undefined, tags);
    return { ok: true, itemId: res.item.id, deduped: !!res.deduped };
  }

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
      collectionId: d.collectionId || null,
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

  /** A short snippet around the first occurrence of the query in the text. */
  private snippet(text: string, q: string): string | null {
    if (!text) return null;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return null;
    const start = Math.max(0, i - 60);
    const raw = text.slice(start, i + q.length + 80).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + raw + '…';
  }

  /** Full-text-ish search across title, description, tags AND content. (BEA-538) */
  async search(q: string) {
    const term = (q || '').trim();
    if (term.length < 2) return { documents: [] as ReturnType<DocumentsService['shape']>[] };
    const rows = await this.prisma.document.findMany({
      where: {
        OR: [
          { title: { contains: term } },
          { description: { contains: term } },
          { tags: { contains: term } },
          { contentText: { contains: term } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return {
      documents: rows.map((r) => ({ ...this.shape(r), snippet: this.snippet(r.contentText || '', term) })),
    };
  }

  // ---- Collections / folders (BEA-537) ----

  async listCollections() {
    const [rows, docs] = await Promise.all([
      this.prisma.documentCollection.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.document.findMany({ select: { collectionId: true } }),
    ]);
    const counts: Record<string, number> = {};
    for (const d of docs) if (d.collectionId) counts[d.collectionId] = (counts[d.collectionId] || 0) + 1;
    return { collections: rows.map((c) => ({ id: c.id, name: c.name, color: c.color || null, count: counts[c.id] || 0 })) };
  }

  createCollection(name: string, color?: string) {
    const n = (name || '').trim().slice(0, 80);
    if (!n) return null;
    return this.prisma.documentCollection.create({ data: { name: n, color: color?.trim().slice(0, 20) || null } });
  }

  renameCollection(id: string, name: string, color?: string) {
    const data: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim().slice(0, 80);
    if (typeof color === 'string') data.color = color.trim().slice(0, 20) || null;
    return this.prisma.documentCollection.update({ where: { id }, data }).catch(() => null);
  }

  /** Delete a collection but keep its documents (detach them). */
  async removeCollection(id: string) {
    await this.prisma.document.updateMany({ where: { collectionId: id }, data: { collectionId: null } });
    await this.prisma.documentCollection.delete({ where: { id } }).catch(() => null);
    return { ok: true };
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
    let pdfText = '';
    if (kind === 'pdf') {
      pdfText = await pdfParse(file.buffer).then((r) => r.text || '').catch(() => '');
      if (pdfText.trim()) {
        const ai = await this.summarize(pdfText).catch(() => ({ description: '', tags: [] as string[] }));
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
      // Keep the extracted PDF text so the doc is searchable; the viewer still renders the file, not this. (BEA-538)
      contentText: kind === 'pdf' && pdfText.trim() ? pdfText : null,
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

  // ---- Bulk actions (BEA-539) ----

  async bulkDelete(ids: string[]) {
    let n = 0;
    for (const id of ids || []) {
      await this.remove(id);
      n++;
    }
    return { ok: true, count: n };
  }

  async bulkAddTags(ids: string[], add: string[]) {
    const tagsToAdd = this.parseTags(add);
    if (!tagsToAdd.length) return { ok: true, count: 0 };
    const rows = await this.prisma.document.findMany({ where: { id: { in: ids || [] } }, select: { id: true, tags: true } });
    for (const r of rows) {
      const merged = Array.from(new Set([...this.parseTags(r.tags), ...tagsToAdd]));
      await this.prisma.document.update({ where: { id: r.id }, data: { tags: JSON.stringify(merged) } }).catch(() => null);
    }
    return { ok: true, count: rows.length };
  }

  async bulkSetCollection(ids: string[], collectionId: string | null) {
    const r = await this.prisma.document.updateMany({ where: { id: { in: ids || [] } }, data: { collectionId: collectionId || null } });
    return { ok: true, count: r.count };
  }

  async bulkSetShared(ids: string[], shared: boolean) {
    const r = await this.prisma.document.updateMany({ where: { id: { in: ids || [] } }, data: { shared } });
    return { ok: true, count: r.count };
  }

  /** Documents to put in an export zip (selected ids, or everything when empty). */
  async forExport(ids?: string[]) {
    const where = ids?.length ? { id: { in: ids } } : {};
    return this.prisma.document.findMany({ where, orderBy: { updatedAt: 'desc' } });
  }

  /** A safe, unique-ish zip entry name for a document. */
  exportName(d: { title: string; slug: string; kind: string; filePath?: string | null; filename?: string | null }): string {
    const base = (d.title || d.slug || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
    const ext = d.filePath ? extname(d.filename || d.filePath) || '' : d.kind === 'html' ? '.html' : '.md';
    return `${base}-${d.slug.slice(-6)}${ext}`;
  }

  /** Reject obviously-internal hosts before fetching a user-supplied URL (light SSRF guard). */
  private isBlockedHost(host: string): boolean {
    const h = host.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return false;
  }

  /** Import a document from a URL — fetch it, detect type, store + summarise. (BEA-536) */
  async importFromUrl(rawUrl: string) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('That doesn’t look like a valid link.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links are supported.');
    if (this.isBlockedHost(url.hostname)) throw new Error('That address isn’t allowed.');

    const res = await fetch(url.toString(), { redirect: 'follow', headers: { 'User-Agent': 'MyBrain-Documents/1.0' } }).catch(() => null);
    if (!res || !res.ok) throw new Error(`Could not fetch that link${res ? ` (HTTP ${res.status})` : ''}.`);
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    const nameFromPath = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
    const kind = this.kindOf(nameFromPath, mime);

    let doc;
    if (kind === 'md' || kind === 'html') {
      const content = buf.toString('utf8');
      let title = nameFromPath.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      if (kind === 'html') title = (content.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || title || url.hostname).trim();
      doc = await this.create({ title: title || url.hostname, contentText: content, kind });
    } else {
      doc = await this.createFromUpload({ originalname: nameFromPath, mimetype: mime, buffer: buf, size: buf.length });
    }
    await this.prisma.document.update({ where: { id: doc.id }, data: { sourceUrl: url.toString().slice(0, 500) } }).catch(() => undefined);
    return doc;
  }

  /** Locate a stored binary file for streaming (open/preview/download). */
  async file(id: string) {
    const row = await this.prisma.document.findUnique({ where: { id } });
    if (!row || !row.filePath) return null;
    return { filePath: row.filePath, mime: row.mime || 'application/octet-stream', filename: row.filename || `${row.slug}${extname(row.filePath)}` };
  }

  /** Public file stream for a SHARED binary doc, by slug. Returns null unless shared + has a file. (BEA-553) */
  async sharedFile(slug: string) {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !row.shared || !row.filePath) return null;
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
    if (patch.collectionId !== undefined) data.collectionId = patch.collectionId || null;
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
