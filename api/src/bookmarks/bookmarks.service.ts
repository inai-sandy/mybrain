import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { SummarizerService } from './summarizer.service';
import { RaindropClient, RaindropItem } from './raindrop.client';
import { InstagramEnricher } from './instagram.service';
import { ItemsService } from '../items/items.service';
import { looseJsonParse } from '../common/llm-json';

/** Bookmarks live alongside other items on disk so the existing view/delete endpoints work. */
function itemsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'items');
}

const DEFAULT_SINCE_DAYS = 90;

/** lowercase, trim, dedupe; keep Raindrop order; cap at 12. */
export function cleanTags(tags: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const v = String(t || '').toLowerCase().trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.slice(0, 12);
}

type ExistingRow = { id: string; sourceUrl: string | null; readFailed: boolean; readAttempts: number; supermemoryId: string | null; ragId: string | null; filePath: string | null };

/** How many failed reads a bookmark gets before the sync stops paying to retry it. (BEA-841) */
export const MAX_READ_ATTEMPTS = 5;

/** Retry an unreadable bookmark only while it has tries left — dead links must not cost money every hour forever. (BEA-841) */
export function shouldRetry(row: { readFailed: boolean; readAttempts: number }): boolean {
  return row.readFailed && (row.readAttempts || 0) < MAX_READ_ATTEMPTS;
}

@Injectable()
export class BookmarksService implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private prog = { imported: 0, flagged: 0, total: 0, startedAt: '' };
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly summarizer: SummarizerService,
    private readonly raindrop: RaindropClient,
    private readonly instagram: InstagramEnricher,
    private readonly items: ItemsService, // LAST on purpose — keeps positional wiring stable (BEA-1049)
  ) {}

  private bookmarksDir() {
    return join(process.env.DATA_DIR || '/app/data', 'bookmarks');
  }

  /** Download an image to our volume so it never expires; returns the served path. (BEA-609) */
  private async cacheImage(itemId: string, url: string): Promise<string | null> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return null;
      await fs.mkdir(this.bookmarksDir(), { recursive: true });
      await fs.writeFile(join(this.bookmarksDir(), `${itemId}.jpg`), buf);
      return `/api/bookmarks/${itemId}/image`;
    } catch {
      return null;
    }
  }

  /** The cached image file path for a bookmark, if we have one. */
  async imageFile(itemId: string): Promise<string | null> {
    const p = join(this.bookmarksDir(), `${itemId}.jpg`);
    return (await fs.stat(p).then((s) => s.isFile()).catch(() => false)) ? p : null;
  }

  /** Re-enrich already-imported Instagram bookmarks: real caption + permanent cached image. (BEA-610) */
  async backfillInstagram(limit?: number): Promise<{ scanned: number; enriched: number; failed: number; samples: { url: string; caption: string; image: boolean }[] }> {
    if (!(await this.instagram.configured())) return { scanned: 0, enriched: 0, failed: 0, samples: [{ url: '', caption: 'Apify token not configured', image: false }] };
    const all = await this.prisma.item.findMany({ where: { source: 'raindrop' } });
    // Only IG bookmarks that aren't already on a cached image — so retries are cheap and idempotent. (BEA-610)
    const ig = all.filter((i) => this.instagram.isInstagram(i.sourceUrl || '') && !(i.thumbnail || '').startsWith('/api/bookmarks/'));
    const slice = typeof limit === 'number' && limit > 0 ? ig.slice(0, limit) : ig;
    let enriched = 0;
    let failed = 0;
    const samples: { url: string; caption: string; image: boolean }[] = [];
    for (const it of slice) {
      const res = await this.instagram.enrich(it.sourceUrl || '').catch(() => null);
      if (!res || (!res.caption && !res.imageUrl)) {
        failed++;
        continue;
      }
      const tags = (() => { try { return JSON.parse(it.tags || '[]'); } catch { return []; } })();
      const summary = (res.caption || it.summary || '').trim();
      const thumbnail = (res.imageUrl && (await this.cacheImage(it.id, res.imageUrl).catch(() => null))) || it.thumbnail;
      // refresh the stored markdown + memory so search + the detail view show the real caption
      if (it.filePath) {
        const md = this.buildMarkdown({ link: it.sourceUrl || '', title: it.title || '', tags, created: (it.createdAt as any)?.toISOString?.() || '' } as RaindropItem, summary, false);
        await fs.writeFile(it.filePath, md, 'utf8').catch(() => undefined);
      }
      await this.memory.deleteDoc(it.supermemoryId, it.ragId).catch(() => undefined);
      await this.prisma.memoryOutbox.deleteMany({ where: { itemId: it.id } }).catch(() => undefined);
      await this.prisma.item.update({ where: { id: it.id }, data: { summary: this.shortDesc(summary), thumbnail, readFailed: false, supermemoryId: null, ragId: null } });
      await this.memory.enqueue(this.buildMemoryText(it.title || '', summary, tags, it.sourceUrl || undefined), { itemId: it.id, title: it.title || undefined, tags: [...tags, 'bookmark'] });
      enriched++;
      if (samples.length < 5) samples.push({ url: it.sourceUrl || '', caption: this.shortDesc(summary).slice(0, 90), image: !!res.imageUrl });
    }
    return { scanned: slice.length, enriched, failed, samples };
  }

  onModuleInit() {
    // Check once a minute whether an auto-sync is due (cheap; the real work only fires when due).
    this.tick = setInterval(() => this.autoTick().catch(() => undefined), 60_000);
    // One-time backfill of existing Instagram bookmarks once an Apify token is present. (BEA-610)
    setTimeout(() => this.runOnceIgBackfill().catch(() => undefined), 20_000);
    // One-time auto-filing of the existing unfiled backlog. (BEA-1046)
    setTimeout(() => this.runOnceOrganize().catch(() => undefined), 30_000);
  }

  /** Organize the pre-existing backlog exactly once (gated by a Setting flag). (BEA-1046) */
  private async runOnceOrganize(): Promise<void> {
    const flag = 'bookmarks.autoFolderV1';
    const done = await this.prisma.setting.findUnique({ where: { key: flag } }).catch(() => null);
    if (done?.value === 'done') return;
    if (!(await this.summarizer.hasKey())) return; // wait until OpenRouter is connected
    const res = await this.organize().catch(() => null);
    if (res) {
      // eslint-disable-next-line no-console
      console.log(`[bookmark-folders] one-time backfill: filed ${res.filed}, left ${res.left}, created ${res.foldersCreated}`);
      await this.prisma.setting.upsert({ where: { key: flag }, create: { key: flag, value: 'done' }, update: { value: 'done' } }).catch(() => undefined);
    }
  }

  /** Re-enrich existing Instagram bookmarks exactly once (gated by a Setting flag). (BEA-610) */
  private async runOnceIgBackfill(): Promise<void> {
    const flag = 'bookmarks.igBackfillV1';
    const done = await this.prisma.setting.findUnique({ where: { key: flag } }).catch(() => null);
    if (done?.value === 'done') return;
    if (!(await this.instagram.configured())) return; // wait until the token is added
    const res = await this.backfillInstagram().catch(() => null);
    if (res) {
      // eslint-disable-next-line no-console
      console.log(`[ig-backfill] enriched ${res.enriched}/${res.scanned} (failed ${res.failed})`);
      await this.prisma.setting.upsert({ where: { key: flag }, create: { key: flag, value: 'done' }, update: { value: 'done' } }).catch(() => undefined);
    }
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  /** Auto-sync config (default ON, hourly). */
  async getAutoSync(): Promise<{ enabled: boolean; intervalMinutes: number }> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'bookmarks.autosync' } });
    if (row) {
      try {
        const v = JSON.parse(row.value);
        return { enabled: !!v.enabled, intervalMinutes: Number(v.intervalMinutes) || 60 };
      } catch {
        /* ignore */
      }
    }
    return { enabled: true, intervalMinutes: 60 };
  }

  async setAutoSync(enabled: boolean, intervalMinutes: number): Promise<void> {
    const value = JSON.stringify({ enabled: !!enabled, intervalMinutes: Math.max(15, Number(intervalMinutes) || 60) });
    await this.prisma.setting.upsert({ where: { key: 'bookmarks.autosync' }, create: { key: 'bookmarks.autosync', value }, update: { value } });
  }

  /** Fire a sync when enabled, keys present, not already running, and the interval has elapsed. */
  private async autoTick(): Promise<void> {
    if (this.running) return;
    const cfg = await this.getAutoSync();
    if (!cfg.enabled) return;
    if (!(await this.raindrop.hasKey()) || !(await this.summarizer.hasKey())) return;
    const last = await this.lastSync();
    if (last) {
      const lastMs = Date.parse(last);
      if (Number.isFinite(lastMs) && Date.now() - lastMs < cfg.intervalMinutes * 60_000) return; // not due yet
    }
    await this.start();
  }

  // ---- content helpers -----------------------------------------------------

  /** Lightweight server-side page read for non-video links (no third-party reader). */
  private async fetchPageText(url: string): Promise<string | null> {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; MyBrainBot/1.0)' } });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!/html|text|xml/i.test(ct)) return null;
      const html = await r.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.length > 200 ? text : null;
    } catch {
      return null;
    }
  }

  /** Summary built from Raindrop metadata only — used when the page/video can't be read. */
  fallbackSummary(b: RaindropItem): string {
    const parts: string[] = [];
    if (b.excerpt) parts.push(b.excerpt);
    if (b.note) parts.push(`Note: ${b.note}`);
    const base = parts.join('\n\n').trim();
    return base || `Saved link: ${b.title}.`;
  }

  /** First ~200 chars of the summary, on one line — the list "basic description". */
  shortDesc(s: string): string {
    const one = s.replace(/\s+/g, ' ').trim();
    if (one.length <= 200) return one;
    return one.slice(0, 197).replace(/\s+\S*$/, '') + '…';
  }

  /**
   * What we send to the memory stores. Plain text leading with the TITLE — never a bare URL,
   * because SuperMemory auto-crawls content that starts with a URL (storing page junk instead of our summary).
   */
  buildMemoryText(title: string, summary: string, tags: string[], url?: string): string {
    // Title first (never a bare URL — that makes SuperMemory crawl the page). Link goes at the END, labeled.
    const meta = [tags.length ? `Tags: ${tags.join(', ')}` : '', url ? `Link: ${url}` : ''].filter(Boolean).join('\n');
    return `${title}\n\n${summary}${meta ? `\n\n${meta}` : ''}`;
  }

  /** Pull the summary body back out of a stored .md file (for re-indexing without re-summarizing). */
  private extractSummary(md: string): string {
    const lines = md.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('**Source:**'));
    const body = (idx >= 0 ? lines.slice(idx + 1) : lines).filter((l) => !l.trim().startsWith('>'));
    return body.join('\n').trim();
  }

  /** YouTube video id from common URL shapes. */
  private youtubeId(url: string): string | null {
    const m = (url || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/i);
    return m ? m[1] : null;
  }

  /** Best card thumbnail: YouTube poster for videos, else the Raindrop cover image. */
  private thumbFor(url: string, cover?: string): string | null {
    const yt = this.youtubeId(url);
    if (yt) return `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
    return cover && cover.trim() ? cover.trim() : null;
  }

  /** The .md file: URL on the first line, then title / tags / date, then the summary. */
  buildMarkdown(b: RaindropItem, summary: string, readFailed: boolean): string {
    const tagLine = b.tags.length ? b.tags.join(', ') : '—';
    const date = (b.created || '').slice(0, 10) || 'unknown';
    const kind = this.summarizer.isVideo(b.link) ? 'YouTube' : 'Raindrop';
    const flag = readFailed
      ? `\n> ⚠️ This page/video couldn't be read — the summary is based on the title, tags and your note.\n`
      : '';
    return `${b.link}\n\n# ${b.title}\n\n**Tags:** ${tagLine}  \n**Saved:** ${date}  \n**Source:** ${kind}\n${flag}\n${summary}\n`;
  }

  /** Produce a summary for one bookmark: YouTube → Gemini video; else fetch page → Gemini text. */
  private async makeSummary(b: RaindropItem): Promise<{ summary: string; readFailed: boolean }> {
    if (this.summarizer.isVideo(b.link)) {
      const s = await this.summarizer.summarizeYouTube(b.link, b.title);
      if (s) return { summary: s, readFailed: false };
      return { summary: this.fallbackSummary(b), readFailed: true };
    }
    // 1) Let Gemini read the URL directly (handles share links, redirects, JS pages…).
    const direct = await this.summarizer.summarizeUrl(b.link, b.title);
    if (direct) return { summary: direct, readFailed: false };
    // 2) Fallback: our own server-side HTML fetch → Gemini text.
    const text = await this.fetchPageText(b.link);
    if (text) {
      const s = await this.summarizer.summarizeText(b.title, text);
      return { summary: s || this.fallbackSummary(b), readFailed: false };
    }
    // 3) Couldn't read it at all → metadata summary + flag.
    return { summary: this.fallbackSummary(b), readFailed: true };
  }

  // ---- status / listing ----------------------------------------------------

  async lastSync(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'bookmarks.lastSync' } });
    return row?.value || null;
  }

  async count(): Promise<number> {
    return this.prisma.item.count({ where: { source: { in: ['raindrop', 'bookmark'] } } });
  }

  getState() {
    return { running: this.running, imported: this.prog.imported, flagged: this.prog.flagged, total: this.prog.total };
  }

  async listItems() {
    const rows = await this.prisma.item.findMany({ where: { source: { in: ['raindrop', 'bookmark'] } }, orderBy: { createdAt: 'desc' }, take: 1000 });
    return rows.map((i) => ({
      id: i.id,
      title: i.title,
      sourceUrl: i.sourceUrl,
      summary: i.summary,
      tags: i.tags ? (JSON.parse(i.tags) as string[]) : [],
      readFailed: i.readFailed,
      createdAt: i.createdAt,
      thumbnail: i.thumbnail,
      supermemory: !!i.supermemoryId,
      rag: !!i.ragId,
      chunked: !!i.supermemoryId, // SuperMemory chunks server-side
      shared: i.shared,
      folderId: i.folderId || null,
    }));
  }

  // ---- Bookmark folders (My-Brain-owned, independent of Raindrop). (BEA-611) ----

  async listFolders() {
    const [rows, items] = await Promise.all([
      this.prisma.bookmarkFolder.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.item.findMany({ where: { source: { in: ['raindrop', 'bookmark'] } }, select: { folderId: true } }),
    ]);
    const counts: Record<string, number> = {};
    for (const it of items) if (it.folderId) counts[it.folderId] = (counts[it.folderId] || 0) + 1;
    return { folders: rows.map((f) => ({ id: f.id, name: f.name, color: f.color || null, icon: f.icon || null, count: counts[f.id] || 0 })) };
  }

  async createFolder(name: string, color?: string, icon?: string) {
    const n = (name || '').trim().slice(0, 80);
    if (!n) return null;
    return this.prisma.bookmarkFolder.create({ data: { name: n, color: color?.trim().slice(0, 20) || null, icon: icon?.trim().slice(0, 40) || null } });
  }

  async renameFolder(id: string, name?: string, color?: string, icon?: string) {
    const data: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim().slice(0, 80);
    if (typeof color === 'string') data.color = color.trim().slice(0, 20) || null;
    if (typeof icon === 'string') data.icon = icon.trim().slice(0, 40) || null;
    return this.prisma.bookmarkFolder.update({ where: { id }, data }).catch(() => null);
  }

  /** Delete a folder but keep its bookmarks (just unfile them). */
  async removeFolder(id: string) {
    await this.prisma.item.updateMany({ where: { folderId: id }, data: { folderId: null } });
    await this.prisma.bookmarkFolder.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  /** Move bookmark(s) into a folder (or null to unfile). */
  async setFolder(ids: string[], folderId: string | null) {
    const r = await this.prisma.item.updateMany({ where: { id: { in: ids || [] }, source: { in: ['raindrop', 'bookmark'] } }, data: { folderId: folderId || null } });
    return { ok: true, count: r.count };
  }

  /**
   * Delete bookmark(s) for good — by explicit id only, and only rows that ARE bookmarks, so a stray
   * id can never take out a document. Row + summary file + brain entries (via the one true item
   * delete) + our cached image. (BEA-1049)
   */
  async removeMany(ids: string[]): Promise<{ ok: boolean; deleted: number }> {
    const rows = await this.prisma.item.findMany({ where: { id: { in: ids || [] }, source: { in: ['raindrop', 'bookmark'] } }, select: { id: true } });
    for (const r of rows) {
      await this.items.remove(r.id);
      await fs.unlink(join(this.bookmarksDir(), `${r.id}.jpg`)).catch(() => undefined); // cached IG image, if any
    }
    return { ok: true, deleted: rows.length };
  }

  // ---- Rediscover: forgotten bookmarks come back, one TOPIC at a time. (BEA-1048) ----

  /** The owner opened this bookmark — remember it, so Rediscover stops suggesting it. */
  async markOpened(id: string): Promise<{ ok: boolean }> {
    await this.prisma.item.updateMany({ where: { id, source: { in: ['raindrop', 'bookmark'] } }, data: { lastOpenedAt: new Date() } }).catch(() => undefined);
    return { ok: true };
  }

  /**
   * A hand of forgotten bookmarks from ONE topic (a folder), rotating daily — the owner's call
   * (2026-07-23): Rediscover picks by topic. `shift` moves to the next topic (the ↻ control).
   * "Forgotten" = not opened in the last 30 days (or ever); oldest-untouched first, so the pile
   * actually drains instead of showing the same faces.
   */
  async rediscover(shift = 0): Promise<{ topic: { id: string; name: string; icon: string | null } | null; items: any[]; topics: number }> {
    const folders = await this.prisma.bookmarkFolder.findMany({ orderBy: { name: 'asc' } });
    const counts = await this.prisma.item.groupBy({ by: ['folderId'], where: { source: { in: ['raindrop', 'bookmark'] }, folderId: { not: null } }, _count: true }).catch(() => [] as any[]);
    const byId: Record<string, number> = {};
    for (const c of counts as any[]) if (c.folderId) byId[c.folderId] = c._count;
    const topics = folders.filter((f) => (byId[f.id] || 0) >= 3); // a topic needs enough in it to be worth a band
    if (!topics.length) return { topic: null, items: [], topics: 0 };
    // Deterministic daily rotation (IST day), shifted by the refresh control.
    const IST_OFFSET_MIN = 330;
    const dayN = Math.floor((Date.now() + IST_OFFSET_MIN * 60000) / 86400000);
    const topic = topics[(((dayN + Math.trunc(shift)) % topics.length) + topics.length) % topics.length];
    const cutoff = new Date(Date.now() - 30 * 86400000);
    const rows = await this.prisma.item.findMany({
      where: { source: { in: ['raindrop', 'bookmark'] }, folderId: topic.id, OR: [{ lastOpenedAt: null }, { lastOpenedAt: { lt: cutoff } }] },
      orderBy: [{ lastOpenedAt: 'asc' }, { createdAt: 'asc' }],
      take: 8,
    });
    return {
      topic: { id: topic.id, name: topic.name, icon: topic.icon || null },
      items: rows.map((i) => ({ id: i.id, title: i.title, sourceUrl: i.sourceUrl, summary: i.summary, thumbnail: i.thumbnail, createdAt: i.createdAt })),
      topics: topics.length,
    };
  }

  // ---- automatic filing: folders fill themselves. (BEA-1046) ---------------

  /** Never more than this many folders — broad areas stay broad. */
  static readonly FOLDER_CAP = 12;

  /**
   * File every unfiled bookmark into a BROAD folder, fully automatically — the owner's call
   * (2026-07-23): manual filing never happened, so the AI does it. Rules: reuse existing folders,
   * invent only broad new ones (cap {@link FOLDER_CAP} total), and when unsure leave the bookmark
   * unfiled ("Others") rather than guess wrong. Manual moves are respected — only folderId=null
   * rows are ever touched.
   */
  async organize(): Promise<{ filed: number; left: number; foldersCreated: number }> {
    const zero = { filed: 0, left: 0, foldersCreated: 0 };
    if (!(await this.summarizer.hasKey())) return zero;
    const unfiled = await this.prisma.item.findMany({
      where: { source: { in: ['raindrop', 'bookmark'] }, folderId: null },
      select: { id: true, title: true, summary: true, tags: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!unfiled.length) return zero;
    const folders = await this.prisma.bookmarkFolder.findMany();
    let filed = 0;
    let foldersCreated = 0;

    for (let i = 0; i < unfiled.length; i += 40) {
      const batch = unfiled.slice(i, i + 40);
      const canCreate = Math.max(0, BookmarksService.FOLDER_CAP - folders.length);
      const lines = batch
        .map((b) => {
          const tags = (() => { try { return (JSON.parse(b.tags || '[]') as string[]).join(', '); } catch { return ''; } })();
          return `${b.id} | ${(b.title || '').slice(0, 120)}${tags ? ` | tags: ${tags}` : ''} | ${(b.summary || '').slice(0, 140)}`;
        })
        .join('\n');
      const prompt =
        `You organize a personal bookmark library into folders.\n` +
        `Existing folders: ${folders.map((f) => f.name).join(', ') || '(none yet)'}.\n` +
        `Rules:\n` +
        `- Folders are BROAD areas only (like "AI", "Hardware", "Marketing", "Health"). Never specific ones (not "Claude skills", not "mmWave radar").\n` +
        `- Prefer an existing folder whenever it fits.\n` +
        `- You may invent at most ${canCreate} NEW broad folder name(s), one or two plain words each.\n` +
        `- If nothing fits confidently, use exactly "Others".\n` +
        `Bookmarks (id | title | tags | summary):\n${lines}\n\n` +
        `Reply with ONLY JSON: {"assignments":[{"id":"<id>","folder":"<folder name or Others>"}]} — one entry per bookmark.`;
      const out = looseJsonParse(await this.summarizer.complete(prompt, 3000).catch(() => null));
      const assignments: any[] = Array.isArray(out?.assignments) ? out.assignments : [];
      const batchIds = new Set(batch.map((b) => b.id));
      for (const a of assignments) {
        const id = String(a?.id || '');
        const name = String(a?.folder || '').trim();
        if (!batchIds.has(id) || !name || /^others?$/i.test(name)) continue; // unsure → stays in Others, never a wrong guess
        let folder = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
        if (!folder) {
          if (folders.length >= BookmarksService.FOLDER_CAP) continue; // cap wins over a new name
          folder = await this.prisma.bookmarkFolder.create({ data: { name: name.slice(0, 40) } }).catch(() => null as any);
          if (!folder) continue;
          folders.push(folder);
          foldersCreated++;
        }
        // Only fill EMPTY folder slots — a manual move done mid-run must never be overwritten.
        const r = await this.prisma.item.updateMany({ where: { id, folderId: null }, data: { folderId: folder.id } });
        filed += r.count;
      }
    }
    const left = unfiled.length - filed;
    if (filed) console.log(`[bookmark-folders] filed ${filed}, left ${left} in Others, created ${foldersCreated} folder(s)`);
    return { filed, left, foldersCreated };
  }

  /** Backfill thumbnails for existing bookmarks (YouTube poster from the URL; Raindrop cover for the rest). */
  async backfillThumbnails(): Promise<{ updated: number }> {
    const coverByLink = new Map<string, string>();
    try {
      const recent = await this.raindrop.recent(90);
      for (const b of recent) if (b.cover) coverByLink.set(b.link, b.cover);
    } catch {
      /* ignore — YouTube thumbnails still resolve from the URL alone */
    }
    const items = await this.prisma.item.findMany({ where: { source: 'raindrop' }, select: { id: true, sourceUrl: true, thumbnail: true } });
    let updated = 0;
    for (const it of items) {
      const thumb = this.thumbFor(it.sourceUrl || '', coverByLink.get(it.sourceUrl || ''));
      if (thumb && thumb !== it.thumbnail) {
        await this.prisma.item.update({ where: { id: it.id }, data: { thumbnail: thumb } });
        updated++;
      }
    }
    return { updated };
  }

  /**
   * Re-write every bookmark's memory in BOTH stores using the crawl-safe text format.
   * Fixes prior SuperMemory docs that stored crawled page junk + the writes that failed.
   * Reuses the existing summaries from the .md files (no re-summarizing).
   */
  async reindexMemory(): Promise<{ reindexed: number }> {
    const items = await this.prisma.item.findMany({ where: { source: 'raindrop' } });
    let n = 0;
    for (const it of items) {
      const md = it.filePath ? await fs.readFile(it.filePath, 'utf8').catch(() => '') : '';
      const summary = this.extractSummary(md) || it.summary || it.title || '';
      const tags = it.tags ? (JSON.parse(it.tags) as string[]) : [];
      await this.memory.deleteDoc(it.supermemoryId, it.ragId);
      await this.prisma.memoryOutbox.deleteMany({ where: { itemId: it.id } }).catch(() => undefined);
      await this.prisma.item.update({ where: { id: it.id }, data: { supermemoryId: null, ragId: null } });
      await this.memory.enqueue(this.buildMemoryText(it.title || '', summary, tags, it.sourceUrl || undefined), { itemId: it.id, title: it.title || undefined, tags: [...tags, 'bookmark'] });
      n++;
    }
    return { reindexed: n };
  }

  /** Find bookmarks by meaning (semantic stores ranked, mapped back to real bookmarks; keyword safety net). */
  async search(q: string, limit = 20) {
    const all = await this.listItems();
    const query = q.trim();
    if (!query) return all.slice(0, limit);

    let ranked: string[] = [];
    try {
      const res = await this.memory.searchBoth(query);
      const sm = Array.isArray((res as any).supermemory) ? (res as any).supermemory : [];
      const rg = Array.isArray((res as any).rag) ? (res as any).rag : [];
      ranked = [...sm, ...rg].map((r) => JSON.stringify(r).toLowerCase());
    } catch {
      ranked = [];
    }

    const tokens = this.tokenize(query);
    const scored = all
      .map((it) => {
        const url = (it.sourceUrl || '').toLowerCase();
        const title = (it.title || '').toLowerCase();
        // Semantic boost: keep the existing "found by meaning" ranking from the memory stores.
        let semIdx = -1;
        for (let i = 0; i < ranked.length; i++) {
          if ((url && ranked[i].includes(url)) || (title.length > 6 && ranked[i].includes(title))) {
            semIdx = i;
            break;
          }
        }
        const semScore = semIdx >= 0 ? 1000 - semIdx : 0;
        // Ranked + typo-tolerant keyword score (like Documents, BEA-590/613).
        const kwScore = this.keywordScore(it, tokens);
        return { it, score: semScore * 10 + kwScore };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.it);
  }

  // ---- Ranked + typo-tolerant keyword search, in-process (no AI). (BEA-613) ----
  private tokenize(s: string): string[] {
    return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 1);
  }
  private editDistanceLE(a: string, b: string, max: number): boolean {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      const cur = [j];
      let rowMin = j;
      for (let i = 1; i <= a.length; i++) {
        const v = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur[i] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return false;
      prev = cur;
    }
    return prev[a.length] <= max;
  }
  private fuzzyHit(text: string, token: string): boolean {
    const max = token.length >= 6 ? 2 : 1;
    for (const w of text.match(/[a-z0-9]+/g) || []) {
      if (Math.abs(w.length - token.length) <= max && this.editDistanceLE(w, token, max)) return true;
    }
    return false;
  }
  /** Weighted, typo-tolerant keyword score for one bookmark. (title/tags > summary > url) */
  private keywordScore(it: { title?: string | null; summary?: string | null; sourceUrl?: string | null; tags: string[] }, tokens: string[]): number {
    if (!tokens.length) return 0;
    const title = (it.title || '').toLowerCase();
    const tags = (it.tags || []).join(' ').toLowerCase();
    const summary = (it.summary || '').toLowerCase();
    const url = (it.sourceUrl || '').toLowerCase();
    let total = 0;
    let matched = 0;
    for (const tk of tokens) {
      let best = 0;
      if (title.includes(tk)) best = Math.max(best, title.startsWith(tk) ? 7.2 : 6);
      if (tags.includes(tk)) best = Math.max(best, 4);
      if (summary.includes(tk)) best = Math.max(best, 2);
      if (url.includes(tk)) best = Math.max(best, 1);
      if (best === 0 && tk.length >= 4) {
        if (this.fuzzyHit(title, tk)) best = 3;
        else if (this.fuzzyHit(tags, tk)) best = 2.5;
      }
      if (best > 0) {
        matched++;
        total += best;
      }
    }
    // Require all tokens for short queries, allow one miss for longer ones.
    const required = tokens.length <= 2 ? tokens.length : tokens.length - 1;
    if (matched < required) return 0;
    return total + matched * 0.1;
  }

  // ---- add a link by hand (no Raindrop needed). (BEA-1050) -----------------

  /** The page's <title>, for a link added by hand. Falls back to the hostname. */
  private async pageTitle(url: string): Promise<string> {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; MyBrainBot/1.0)' } });
      const html = await r.text();
      const m = html.match(/<title[^>]*>([^<]{1,300})/i);
      if (m) {
        const t = m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 200);
      }
    } catch {
      /* fall through to the hostname */
    }
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url.slice(0, 200);
    }
  }

  /**
   * Save one URL straight into Bookmarks — same treatment as a synced bookmark: AI summary,
   * thumbnail, brain indexing. Raindrop stops being the only door in. (BEA-1050)
   */
  async addManual(rawUrl: string, note?: string): Promise<{ ok: boolean; code?: string; message?: string; id?: string; title?: string }> {
    let url: URL;
    try {
      url = new URL(String(rawUrl || '').trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error('not http');
    } catch {
      return { ok: false, code: 'bad_url', message: 'That does not look like a web link — it should start with https://' };
    }
    const link = url.toString();
    const dup = await this.prisma.item.findFirst({ where: { sourceUrl: link, source: { in: ['raindrop', 'bookmark'] } }, select: { id: true, title: true } });
    if (dup) return { ok: false, code: 'exists', message: `Already saved as “${dup.title || link}”.` };
    if (!(await this.summarizer.hasKey())) return { ok: false, code: 'no_model', message: 'Connect OpenRouter (for summaries) in Settings first.' };

    const title = await this.pageTitle(link);
    const b: RaindropItem = { id: 0, title, link, excerpt: '', note: (note || '').trim().slice(0, 500), tags: [], created: new Date().toISOString(), cover: '' } as any;
    let { summary, readFailed } = await this.makeSummary(b);
    const ig = this.instagram.isInstagram(link) ? await this.instagram.enrich(link).catch(() => null) : null;
    if (ig?.caption) {
      summary = ig.caption;
      readFailed = false;
    }
    if (b.note) summary = `${summary}\n\nNote: ${b.note}`; // the owner's words always survive on the summary

    const item = await this.prisma.item
      .create({
        data: {
          contentHash: createHash('sha256').update(`bookmark:${link}`).digest('hex'),
          source: 'bookmark',
          title: title.slice(0, 200),
          summary: this.shortDesc(summary),
          sourceUrl: link,
          tags: JSON.stringify([]),
          readFailed,
          readAttempts: readFailed ? 1 : 0,
          thumbnail: this.thumbFor(link, ''),
        },
      })
      .catch(() => null);
    if (!item) return { ok: false, code: 'exists', message: 'Already saved.' };

    const dir = itemsDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, `${item.id}.md`);
    await fs.writeFile(filePath, this.buildMarkdown(b, summary, readFailed), 'utf8');
    const data: { filePath: string; thumbnail?: string } = { filePath };
    if (ig?.imageUrl) {
      const cached = await this.cacheImage(item.id, ig.imageUrl).catch(() => null);
      if (cached) data.thumbnail = cached;
    }
    await this.prisma.item.update({ where: { id: item.id }, data });
    await this.memory.enqueue(this.buildMemoryText(title, summary, [], link), { itemId: item.id, title, tags: ['bookmark'] });
    void this.organize().catch(() => undefined); // a hand-added link files itself too (BEA-1046)
    return { ok: true, id: item.id, title };
  }

  // ---- the sync job --------------------------------------------------------

  /** Bookmarks from the last `sinceDays` that still need work: never-imported OR previously unreadable (retry). */
  private async eligible(sinceDays: number): Promise<{ list: RaindropItem[]; existing: Map<string, ExistingRow> }> {
    const recent = await this.raindrop.recent(sinceDays);
    const rows = (await this.prisma.item.findMany({
      where: { source: 'raindrop' },
      select: { id: true, sourceUrl: true, readFailed: true, readAttempts: true, supermemoryId: true, ragId: true, filePath: true },
    })) as ExistingRow[];
    const existing = new Map<string, ExistingRow>(rows.map((r) => [r.sourceUrl || '', r]));
    const list = recent.filter((b) => b.link && (!existing.has(b.link) || shouldRetry(existing.get(b.link)!)));
    return { list, existing };
  }

  /** Import (or re-summarize) one bookmark. Returns the outcome for progress counting. */
  private async importOne(b: RaindropItem, dir: string, existing: Map<string, ExistingRow>): Promise<'imported' | 'flagged' | 'skip'> {
    let { summary, readFailed } = await this.makeSummary(b);
    // Instagram: replace the login-walled page summary with the REAL caption, and remember the media image. (BEA-609)
    const ig = this.instagram.isInstagram(b.link) ? await this.instagram.enrich(b.link).catch(() => null) : null;
    if (ig?.caption) {
      summary = ig.caption;
      readFailed = false;
    }
    const md = this.buildMarkdown(b, summary, readFailed);
    const tags = cleanTags(b.tags);
    const ex = existing.get(b.link);

    if (ex) {
      // Retry/upgrade an existing (previously unreadable) bookmark in place — no duplicate, refresh memory.
      const filePath = ex.filePath || join(dir, `${ex.id}.md`);
      await fs.writeFile(filePath, md, 'utf8');
      await this.memory.deleteDoc(ex.supermemoryId, ex.ragId);
      await this.prisma.memoryOutbox.deleteMany({ where: { itemId: ex.id } }).catch(() => undefined);
      const thumbnail = (ig?.imageUrl && (await this.cacheImage(ex.id, ig.imageUrl).catch(() => null))) || this.thumbFor(b.link, b.cover);
      await this.prisma.item.update({
        where: { id: ex.id },
        // A failed retry burns one attempt; a successful read clears the count for good. (BEA-841)
        data: { summary: this.shortDesc(summary), tags: JSON.stringify(tags), readFailed, readAttempts: readFailed ? { increment: 1 } : 0, filePath, thumbnail, supermemoryId: null, ragId: null },
      });
      await this.memory.enqueue(this.buildMemoryText(b.title, summary, tags, b.link), { itemId: ex.id, title: b.title, tags: [...tags, 'bookmark'] });
      return readFailed ? 'flagged' : 'imported';
    }

    const contentHash = createHash('sha256').update(`raindrop:${b.link}`).digest('hex');
    const created = new Date(b.created);
    const item = await this.prisma.item
      .create({
        data: {
          contentHash,
          source: 'raindrop',
          title: b.title.slice(0, 200),
          summary: this.shortDesc(summary),
          sourceUrl: b.link,
          tags: JSON.stringify(tags),
          readFailed,
          readAttempts: readFailed ? 1 : 0, // first failed read = first attempt spent (BEA-841)
          thumbnail: this.thumbFor(b.link, b.cover),
          ...(isNaN(created.getTime()) ? {} : { createdAt: created }),
        },
      })
      .catch(() => null);
    if (!item) return 'skip';

    const filePath = join(dir, `${item.id}.md`);
    await fs.writeFile(filePath, md, 'utf8');
    const data: { filePath: string; thumbnail?: string } = { filePath };
    if (ig?.imageUrl) {
      const cached = await this.cacheImage(item.id, ig.imageUrl).catch(() => null);
      if (cached) data.thumbnail = cached;
    }
    await this.prisma.item.update({ where: { id: item.id }, data });
    await this.memory.enqueue(this.buildMemoryText(b.title, summary, tags, b.link), { itemId: item.id, title: b.title, tags: [...tags, 'bookmark'] });
    return readFailed ? 'flagged' : 'imported';
  }

  /** Process a list of bookmarks, updating live progress. Used by the background job (and tests). */
  async importBatch(list: RaindropItem[], existing: Map<string, ExistingRow> = new Map(), cap = list.length): Promise<{ imported: number; flagged: number }> {
    const dir = itemsDir();
    await fs.mkdir(dir, { recursive: true });
    let imported = 0;
    let flagged = 0;
    for (const b of list.slice(0, cap)) {
      const r = await this.importOne(b, dir, existing);
      if (r === 'skip') continue;
      imported++;
      if (r === 'flagged') flagged++;
      this.prog.imported = imported;
      this.prog.flagged = flagged;
    }
    return { imported, flagged };
  }

  /**
   * Kick off a background sync of the last `sinceDays` of Raindrop bookmarks.
   * Returns immediately; progress is read via getState()/status. Idempotent while running.
   */
  async start(opts: { sinceDays?: number } = {}): Promise<{ ok: boolean; started?: boolean; running?: boolean; total?: number; code?: string; message?: string }> {
    if (!(await this.raindrop.hasKey())) return { ok: false, code: 'no_raindrop', message: 'Connect Raindrop in Settings first.' };
    if (!(await this.summarizer.hasKey())) return { ok: false, code: 'no_model', message: 'Connect OpenRouter (for Gemini summaries) in Settings first.' };
    if (this.running) return { ok: true, started: false, running: true, total: this.prog.total };

    const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
    let work: { list: RaindropItem[]; existing: Map<string, ExistingRow> };
    try {
      work = await this.eligible(sinceDays);
    } catch {
      return { ok: false, code: 'raindrop_error', message: 'Could not reach Raindrop — check the key and try again.' };
    }

    this.running = true;
    this.prog = { imported: 0, flagged: 0, total: work.list.length, startedAt: new Date().toISOString() };
    void this.runJob(work.list, work.existing);
    return { ok: true, started: true, running: true, total: work.list.length };
  }

  private async runJob(list: RaindropItem[], existing: Map<string, ExistingRow>) {
    try {
      await this.importBatch(list, existing);
    } catch {
      /* swallow — the job is best-effort; dedup makes a re-run safe */
    } finally {
      this.running = false;
      const lastSync = new Date().toISOString();
      await this.prisma.setting
        .upsert({ where: { key: 'bookmarks.lastSync' }, create: { key: 'bookmarks.lastSync', value: lastSync }, update: { value: lastSync } })
        .catch(() => undefined);
      // New arrivals file themselves — only when something actually arrived, so the hourly
      // no-op sync never spends an AI call. (BEA-1046)
      if (this.prog.imported > 0) await this.organize().catch(() => undefined);
    }
  }
}
