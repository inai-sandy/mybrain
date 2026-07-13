import { Injectable } from '@nestjs/common';
import { randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcryptjs';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { ItemsService } from '../items/items.service';
import { buildTitleCardSvg, svgToPng, extractOwnOgImage } from './documents-og';
import TurndownService from 'turndown';

// Shared HTML→Markdown converter for the raw share link (BEA-970). ATX headings + fenced code.
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
const htmlToMarkdown = (html: string): string => {
  try { return turndown.turndown(html || ''); } catch { return html || ''; }
};

// pdf-parse v1 has no types; the /lib import avoids its debug-mode file read on require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (b: Buffer) => Promise<{ text: string }> = require('pdf-parse/lib/pdf-parse.js');

const docsDir = () => join(process.env.DATA_DIR || '/app/data', 'documents');
const sitesDir = () => join(docsDir(), 'sites');

// Content types for serving extracted site assets. (BEA-587)
const SITE_MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', txt: 'text/plain',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', map: 'application/json',
  xml: 'application/xml', webmanifest: 'application/manifest+json', wasm: 'application/wasm',
};
const siteMime = (name: string) => SITE_MIME[extname(name).toLowerCase().replace('.', '')] || 'application/octet-stream';

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

  /** The model that writes doc title/description/tags — user-choosable (default Haiku). (BEA-554) */
  async documentsModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'documents.llm' } });
    if (!row) return SUMMARY_MODEL;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : SUMMARY_MODEL;
    } catch {
      return SUMMARY_MODEL;
    }
  }
  async setDocumentsModel(provider: string, model: string) {
    const cfg = this.llm.agentConfig(provider, model);
    await this.prisma.setting.upsert({ where: { key: 'documents.llm' }, create: { key: 'documents.llm', value: JSON.stringify(cfg) }, update: { value: JSON.stringify(cfg) } });
    return cfg;
  }
  documentsModels() {
    return this.llm.listOpenRouterModels(['anthropic/', 'openai/', 'google/']);
  }

  /** AI vision: describe an uploaded image → {description, tags}. Falls back to {} on large/unsupported. (BEA-555) */
  async summarizeImage(buffer: Buffer, mime: string): Promise<{ description: string; tags: string[] }> {
    if (!buffer?.length || buffer.length > 5 * 1024 * 1024) return { description: '', tags: [] }; // skip very large images
    const base64 = buffer.toString('base64');
    const prompt =
      `Look at this image and describe it for a library card, in simple plain English.\n` +
      `Return ONLY JSON: {"description":"a clear ≤200-character description of what the image shows","tags":["3-6 short lowercase tags"]}.`;
    const raw = (await this.llm.completeImage(await this.documentsModel(), prompt, { dataUrl: `data:${mime};base64,${base64}`, mediaType: mime, base64 }, 300, 'document-image-summary'))?.trim() || '';
    try {
      const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      return { description: String(j?.description || '').trim().slice(0, 200), tags: this.parseTags(j?.tags) };
    } catch {
      return { description: '', tags: [] };
    }
  }

  /** AI read: a ≤200-char description + a few topic tags for a document's content. (BEA-533) */
  async summarize(content: string): Promise<{ description: string; tags: string[] }> {
    const text = (content || '').trim();
    if (!text) return { description: '', tags: [] };
    const prompt =
      `Read this document and describe it for a library card, in simple plain English.\n` +
      `Return ONLY JSON: {"description":"a clear summary of what this document is, at most 200 characters","tags":["3-6 short lowercase topic tags"]}.\n\nDOCUMENT:\n${text.slice(0, 6000)}`;
    const raw = (await this.llm.completeWith(await this.documentsModel(), prompt, 300, 'document-summary'))?.trim() || '';
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
      shortCode: d.shortCode || null,
      title: d.title,
      description: d.description || null,
      kind: d.kind,
      tags: this.parseTags(d.tags),
      collectionId: d.collectionId || null,
      shared: !!d.shared,
      starred: !!d.starred,
      allowDownload: !!d.allowDownload,
      hasPassword: !!d.sharePassword,
      expiresAt: d.expiresAt || null,
      viewCount: d.viewCount ?? 0,
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
  // ---- Smart keyword search: ranked + typo-tolerant, fully in-process (no AI). (BEA-590) ----

  private tokenize(s: string): string[] {
    return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 1);
  }

  /** True if edit distance(a, b) <= max. Banded DP with an early-out. */
  private editDistanceLE(a: string, b: string, max: number): boolean {
    if (Math.abs(a.length - b.length) > max) return false;
    let prevRow = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      const curRow = [j];
      let rowMin = j;
      for (let i = 1; i <= a.length; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const v = Math.min(prevRow[i] + 1, curRow[i - 1] + 1, prevRow[i - 1] + cost);
        curRow[i] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return false;
      prevRow = curRow;
    }
    return prevRow[a.length] <= max;
  }

  /** A query token "fuzzily" appears in text if some word is within a small edit distance. */
  private fuzzyHit(text: string, token: string): boolean {
    const max = token.length >= 6 ? 2 : 1;
    const words = text.match(/[a-z0-9]+/g) || [];
    for (const w of words) {
      if (Math.abs(w.length - token.length) > max) continue;
      if (this.editDistanceLE(w, token, max)) return true;
    }
    return false;
  }

  private bestSnippet(text: string, tokens: string[]): string | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const tk of tokens) {
      const i = lower.indexOf(tk);
      if (i >= 0) {
        const start = Math.max(0, i - 60);
        const raw = text.slice(start, i + tk.length + 80).replace(/\s+/g, ' ').trim();
        return (start > 0 ? '…' : '') + raw + '…';
      }
    }
    return null;
  }

  /** Score one document against the query tokens. Returns 0 to exclude. */
  private scoreDoc(r: any, tokens: string[], required: number): number {
    const title = (r.title || '').toLowerCase();
    const tags = this.parseTags(r.tags).join(' ').toLowerCase();
    const desc = (r.description || '').toLowerCase();
    const content = (r.contentText || '').toLowerCase();
    let total = 0;
    let matched = 0;
    for (const tk of tokens) {
      let best = 0;
      if (title.includes(tk)) best = Math.max(best, title.startsWith(tk) ? 7.2 : 6);
      if (tags.includes(tk)) best = Math.max(best, 4);
      if (desc.includes(tk)) best = Math.max(best, 2);
      if (content.includes(tk)) best = Math.max(best, 1);
      // typo tolerance on the short, important fields only (keeps it fast)
      if (best === 0 && tk.length >= 4) {
        if (this.fuzzyHit(title, tk)) best = 3;
        else if (this.fuzzyHit(tags, tk)) best = 2.5;
        else if (this.fuzzyHit(desc, tk)) best = 1.5;
      }
      if (best > 0) {
        matched++;
        total += best;
      }
    }
    if (matched < required) return 0;
    return total + matched * 0.1;
  }

  /** Ranked, typo-tolerant search across title, tags, description and content. (BEA-538/590) */
  async search(q: string) {
    const term = (q || '').trim();
    if (term.length < 2) return { documents: [] as (ReturnType<DocumentsService['shape']> & { snippet: string | null })[] };
    const tokens = this.tokenize(term);
    if (!tokens.length) return { documents: [] };
    // Require all tokens for 1-2 word queries; allow one miss for longer queries.
    const required = tokens.length <= 2 ? tokens.length : tokens.length - 1;
    const rows = await this.prisma.document.findMany();
    const scored: { r: any; score: number }[] = [];
    for (const r of rows) {
      const score = this.scoreDoc(r, tokens, required);
      if (score > 0) scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.r.updatedAt < b.r.updatedAt ? 1 : -1));
    return {
      documents: scored.slice(0, 100).map(({ r }) => ({ ...this.shape(r), snippet: this.bestSnippet(r.contentText || '', tokens) })),
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
    return { collections: rows.map((c) => ({ id: c.id, name: c.name, color: c.color || null, icon: (c as any).icon || null, count: counts[c.id] || 0 })) };
  }

  createCollection(name: string, color?: string, icon?: string) {
    const n = (name || '').trim().slice(0, 80);
    if (!n) return null;
    return this.prisma.documentCollection.create({ data: { name: n, color: color?.trim().slice(0, 20) || null, icon: icon?.trim().slice(0, 40) || null } });
  }

  renameCollection(id: string, name: string, color?: string, icon?: string) {
    const data: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim().slice(0, 80);
    if (typeof color === 'string') data.color = color.trim().slice(0, 20) || null;
    if (typeof icon === 'string') data.icon = icon.trim().slice(0, 40) || null;
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
  private async insert(data: { title: string; description: string | null; kind: string; tags: string[]; contentText?: string | null; filePath?: string | null; mime?: string | null; filename?: string | null; bytes?: number | null; siteEntry?: string | null }) {
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
        siteEntry: data.siteEntry ?? null,
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

  /** multer/busboy decode multipart filenames as latin1, so a name like "Report — Final.md" arrives
   *  mojibaked ("Report â€" Final"). Re-decode as UTF-8 to recover it (ASCII names are unchanged). (BEA-801) */
  private fixFilename(name: string): string {
    try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
  }

  /** Create a document from an uploaded file (md/html/pdf/image). (BEA-534) */
  async createFromUpload(file: UploadFile) {
    const name = this.fixFilename(file.originalname || 'upload');
    const ext = extname(name).toLowerCase();
    if (ext === '.zip' || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed') {
      return this.createFromZip(file);
    }
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
    } else if (kind === 'image') {
      const ai = await this.summarizeImage(file.buffer, file.mimetype || 'image/png').catch(() => ({ description: '', tags: [] as string[] }));
      description = ai.description;
      tags = ai.tags;
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

  /** Unzip a multi-file site into its own folder; keep the original zip for download. (BEA-587) */
  async createFromZip(file: UploadFile) {
    const name = this.fixFilename(file.originalname || 'site.zip');
    const title = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Site';
    const id = randomUUID();
    const dir = join(sitesDir(), id);

    let zip: AdmZip;
    try {
      zip = new AdmZip(file.buffer);
    } catch {
      throw new Error('That file is not a valid ZIP.');
    }
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length === 0) throw new Error('The ZIP is empty.');
    if (entries.length > 2000) throw new Error('That ZIP has too many files (max 2000).');
    const totalBytes = entries.reduce((n, e) => n + (e.header?.size || 0), 0);
    if (totalBytes > 80 * 1024 * 1024) throw new Error('That site is too big (max 80 MB unzipped).');

    await fs.mkdir(dir, { recursive: true });
    const htmlFiles: string[] = [];
    for (const e of entries) {
      // Normalise + guard against path traversal / absolute paths.
      const rel = e.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
      const dest = resolve(dir, rel);
      if (dest !== dir && !dest.startsWith(dir + sep)) continue; // skip anything that escapes the folder
      await fs.mkdir(join(dest, '..'), { recursive: true });
      await fs.writeFile(dest, e.getData());
      if (/\.html?$/i.test(rel)) htmlFiles.push(rel);
    }
    if (htmlFiles.length === 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error('No HTML page found in that ZIP.');
    }
    // Entry = root index.html if present, else the shallowest .html, else the first.
    const entry =
      htmlFiles.find((f) => f.toLowerCase() === 'index.html') ||
      [...htmlFiles].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];

    // Keep the original zip for download.
    await fs.mkdir(docsDir(), { recursive: true });
    const zipPath = join(docsDir(), `${id}.zip`);
    await fs.writeFile(zipPath, file.buffer);

    const row = await this.prisma.document.create({
      data: {
        id,
        slug: this.slugify(title),
        title,
        description: `Site · ${entries.length} files`,
        kind: 'site',
        filePath: zipPath,
        mime: 'application/zip',
        filename: name,
        bytes: file.size ?? file.buffer.length,
        siteEntry: entry,
        tags: JSON.stringify([]),
      },
    });
    return this.full(row);
  }

  private resolveSitePath(id: string, entry: string | null, rel?: string) {
    const dir = join(sitesDir(), id);
    const wanted = rel && rel.trim() ? rel.replace(/\\/g, '/').replace(/^\/+/, '') : entry || 'index.html';
    const dest = resolve(dir, wanted);
    if (dest !== dir && !dest.startsWith(dir + sep)) return null; // traversal guard
    return { filePath: dest, mime: siteMime(dest) };
  }

  /** Owner: stream a file from an extracted site folder. (BEA-587) */
  async siteFile(id: string, rel?: string) {
    const row = await this.prisma.document.findUnique({ where: { id } });
    if (!row || row.kind !== 'site') return null;
    const p = this.resolveSitePath(id, row.siteEntry, rel);
    if (!p) return null;
    if (!(await fs.stat(p.filePath).then((s) => s.isFile()).catch(() => false))) return null;
    return p;
  }

  /** Public: stream a file from a SHARED site folder (honours expiry; password-protected sites stay closed for now). (BEA-587) */
  async sharedSiteFile(slug: string, rel?: string) {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || row.kind !== 'site' || !this.isLive(row) || row.sharePassword) return null;
    const p = this.resolveSitePath(row.id, row.siteEntry, rel);
    if (!p) return null;
    if (!(await fs.stat(p.filePath).then((s) => s.isFile()).catch(() => false))) return null;
    return p;
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

  /** A shared doc is "live" when shared and not past its expiry. (BEA-585) */
  private isLive(row: { shared: boolean; expiresAt?: Date | null }): boolean {
    if (!row.shared) return false;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return false;
    return true;
  }

  // Short-lived unlock tokens for password-protected shares (in-memory; single instance). (BEA-585)
  private unlockTokens = new Map<string, { slug: string; exp: number }>();
  private mintUnlockToken(slug: string): string {
    const t = randomBytes(18).toString('base64url');
    this.unlockTokens.set(t, { slug, exp: Date.now() + 2 * 3600 * 1000 });
    return t;
  }
  private tokenValid(slug: string, token?: string): boolean {
    if (!token) return false;
    const e = this.unlockTokens.get(token);
    return !!e && e.slug === slug && e.exp > Date.now();
  }

  /** Public file stream for a SHARED binary doc, by slug. Honours expiry + password (via token). (BEA-553/585) */
  async sharedFile(slug: string, token?: string) {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !this.isLive(row) || !row.filePath) return null;
    if (row.sharePassword && !this.tokenValid(slug, token)) return null;
    return { filePath: row.filePath, mime: row.mime || 'application/octet-stream', filename: row.filename || `${row.slug}${extname(row.filePath)}` };
  }

  /** Full document incl. content, for the in-app viewer/editor. */
  private full(d: any) {
    return { ...this.shape(d), contentText: d.contentText || '', siteEntry: d.siteEntry || null };
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
    if (row?.kind === 'site') await fs.rm(join(sitesDir(), id), { recursive: true, force: true }).catch(() => undefined);
    await this.prisma.document.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  /** Star / unstar a document. (BEA-596) */
  async setStarred(id: string, starred: boolean) {
    const row = await this.prisma.document.update({ where: { id }, data: { starred } }).catch(() => null);
    return row ? this.shape(row) : null;
  }

  async setShared(id: string, shared: boolean) {
    const row = await this.prisma.document.update({ where: { id }, data: { shared } }).catch(() => null);
    if (!row) return null;
    // Mint a short code the first time a doc is shared. (BEA-584)
    if (shared && !row.shortCode) {
      const code = await this.mintShortCode(id);
      return this.shape({ ...row, shortCode: code });
    }
    return this.shape(row);
  }

  /** A short, URL-safe code; retried for uniqueness. (BEA-584) */
  private genShortCode(): string {
    const c = randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    return (c || randomUUID().replace(/-/g, '')).slice(0, 7);
  }

  private async mintShortCode(id: string): Promise<string> {
    for (let i = 0; i < 6; i++) {
      const code = this.genShortCode();
      const clash = await this.prisma.document.findUnique({ where: { shortCode: code } });
      if (!clash) {
        await this.prisma.document.update({ where: { id }, data: { shortCode: code } }).catch(() => null);
        return code;
      }
    }
    const fallback = randomUUID().replace(/-/g, '').slice(0, 10);
    await this.prisma.document.update({ where: { id }, data: { shortCode: fallback } }).catch(() => null);
    return fallback;
  }

  /** Rename the public link (slug). Validates format + uniqueness. (BEA-584) */
  async setSlug(id: string, raw: string) {
    const slug = (raw || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (slug.length < 2) throw new Error('A link name needs at least 2 letters or numbers.');
    const clash = await this.prisma.document.findFirst({ where: { slug, NOT: { id } } });
    if (clash) throw new Error('That link name is already taken — try another.');
    const row = await this.prisma.document.update({ where: { id }, data: { slug } }).catch(() => null);
    if (!row) throw new Error('Document not found.');
    return this.shape(row);
  }

  /** Public read by slug — returns the content, or an {expired}/{locked} marker, or null if not shared. (BEA-585) */
  async getShared(slug: string) {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !row.shared) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return { expired: true, title: row.title };
    // Count the open (best-effort, fire-and-forget). A locked page still counts as a visit. (BEA-586)
    void this.prisma.document.update({ where: { id: row.id }, data: { viewCount: { increment: 1 } } }).catch(() => undefined);
    if (row.sharePassword) return { locked: true, title: row.title, kind: row.kind, allowDownload: !!row.allowDownload };
    return { title: row.title, description: row.description || null, kind: row.kind, contentText: row.contentText || '', siteEntry: row.siteEntry || null, allowDownload: !!row.allowDownload, updatedAt: row.updatedAt };
  }

  /**
   * Raw markdown of a shared doc, for the direct AI/Claude-readable link (BEA-970).
   * Mirrors the share gates: null (→404) when not shared, expired, password-protected,
   * or not a text doc. HTML docs are converted to markdown; md docs served as-is.
   */
  async sharedRaw(slug: string): Promise<{ content: string } | null> {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !row.shared) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
    if (row.sharePassword) return null; // password-protected shares get no plain-text bypass
    if (row.kind !== 'md' && row.kind !== 'html') return null; // only text docs have a markdown form
    // Count the open, best-effort — consistent with getShared(). (BEA-586)
    void this.prisma.document.update({ where: { id: row.id }, data: { viewCount: { increment: 1 } } }).catch(() => undefined);
    const src = row.contentText || '';
    return { content: row.kind === 'html' ? htmlToMarkdown(src) : src };
  }

  /** Link-preview meta for a shared doc (BEA-900). Null when not shared/live. */
  async ogMeta(slug: string, origin: string): Promise<{ title: string; description: string; image: string; url: string } | null> {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !this.isLive(row)) return null;
    const ogPng = `${origin}/api/documents/public/${encodeURIComponent(slug)}/og.png`;
    let image = ogPng;
    // HTML/site docs may carry their own og:image — respect it; otherwise use the generated title card.
    if ((row.kind === 'html' || row.kind === 'site') && !row.sharePassword) {
      const own = extractOwnOgImage(row.contentText || '');
      if (own) image = own;
    }
    const rawDesc = row.description || (row.sharePassword ? '' : (row.contentText || ''));
    const desc = rawDesc.replace(/[#*_`>[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Shared from My Brain';
    return { title: row.title || 'Shared document', description: desc, image, url: `${origin}/d/${slug}` };
  }

  /** Generated title-card PNG for a shared doc (BEA-900). Null when not shared/live or render fails. */
  async ogImagePng(slug: string): Promise<Buffer | null> {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !this.isLive(row)) return null;
    try { return svgToPng(buildTitleCardSvg({ title: row.title, kind: row.kind })); } catch { return null; }
  }

  /** Verify a share password; on success return the content + a file-unlock token. (BEA-585) */
  async unlockShared(slug: string, password: string) {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !this.isLive(row)) return { ok: false as const, reason: 'gone' };
    if (row.sharePassword) {
      const ok = await bcrypt.compare(password || '', row.sharePassword);
      if (!ok) return { ok: false as const, reason: 'bad' };
    }
    return {
      ok: true as const,
      token: this.mintUnlockToken(slug),
      title: row.title,
      description: row.description || null,
      kind: row.kind,
      contentText: row.contentText || '',
      siteEntry: row.siteEntry || null,
      allowDownload: !!row.allowDownload,
      updatedAt: row.updatedAt,
    };
  }

  /** Public download of a shared doc — only when live, password-cleared, AND downloads are allowed. (BEA-597) */
  async sharedDownload(slug: string, token?: string) {
    const row = await this.prisma.document.findUnique({ where: { slug } });
    if (!row || !this.isLive(row) || !row.allowDownload) return null;
    if (row.sharePassword && !this.tokenValid(slug, token)) return null;
    const base = (row.title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
    if (row.filePath) {
      return { filePath: row.filePath, mime: row.mime || 'application/octet-stream', filename: row.filename || `${base}${extname(row.filePath)}` };
    }
    const ext = row.kind === 'html' ? 'html' : 'md';
    return { content: row.contentText || '', mime: row.kind === 'html' ? 'text/html' : 'text/markdown', filename: `${base}.${ext}` };
  }

  /** Set/clear a share password, expiry and/or download permission. (BEA-585/597) */
  async setProtection(id: string, opts: { password?: string | null; expiresAt?: string | null; allowDownload?: boolean }) {
    const data: Record<string, unknown> = {};
    if (opts.password !== undefined) data.sharePassword = opts.password ? await bcrypt.hash(opts.password, 10) : null;
    if (opts.expiresAt !== undefined) data.expiresAt = opts.expiresAt ? new Date(opts.expiresAt) : null;
    if (opts.allowDownload !== undefined) data.allowDownload = !!opts.allowDownload;
    const row = await this.prisma.document.update({ where: { id }, data }).catch(() => null);
    return row ? this.shape(row) : null;
  }

  /** Resolve a short code to its public slug (only while live). (BEA-584/585) */
  async resolveShortCode(code: string): Promise<{ slug: string } | null> {
    const row = await this.prisma.document.findUnique({ where: { shortCode: code } });
    if (!row || !this.isLive(row)) return null;
    return { slug: row.slug };
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
