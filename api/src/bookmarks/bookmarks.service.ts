import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { SummarizerService } from './summarizer.service';
import { RaindropClient, RaindropItem } from './raindrop.client';

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

type ExistingRow = { id: string; sourceUrl: string | null; readFailed: boolean; supermemoryId: string | null; ragId: string | null; filePath: string | null };

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
  ) {}

  onModuleInit() {
    // Check once a minute whether an auto-sync is due (cheap; the real work only fires when due).
    this.tick = setInterval(() => this.autoTick().catch(() => undefined), 60_000);
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
    const text = await this.fetchPageText(b.link);
    if (text) {
      const s = await this.summarizer.summarizeText(b.title, text);
      // page WAS read; if the model hiccupped, fall back to metadata but don't flag as unreadable.
      return { summary: s || this.fallbackSummary(b), readFailed: false };
    }
    return { summary: this.fallbackSummary(b), readFailed: true };
  }

  // ---- status / listing ----------------------------------------------------

  async lastSync(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'bookmarks.lastSync' } });
    return row?.value || null;
  }

  async count(): Promise<number> {
    return this.prisma.item.count({ where: { source: 'raindrop' } });
  }

  getState() {
    return { running: this.running, imported: this.prog.imported, flagged: this.prog.flagged, total: this.prog.total };
  }

  async listItems() {
    const rows = await this.prisma.item.findMany({ where: { source: 'raindrop' }, orderBy: { createdAt: 'desc' }, take: 1000 });
    return rows.map((i) => ({
      id: i.id,
      title: i.title,
      sourceUrl: i.sourceUrl,
      summary: i.summary,
      tags: i.tags ? (JSON.parse(i.tags) as string[]) : [],
      readFailed: i.readFailed,
      createdAt: i.createdAt,
      supermemory: !!i.supermemoryId,
      rag: !!i.ragId,
      chunked: !!i.supermemoryId, // SuperMemory chunks server-side
    }));
  }

  /** Re-queue any failed memory writes (e.g. the few bookmark SuperMemory writes that errored). */
  async retryFailedMemory(): Promise<{ retried: number }> {
    return this.memory.retryFailed();
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

    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const scored = all
      .map((it) => {
        const url = (it.sourceUrl || '').toLowerCase();
        const title = (it.title || '').toLowerCase();
        let semIdx = -1;
        for (let i = 0; i < ranked.length; i++) {
          if ((url && ranked[i].includes(url)) || (title.length > 6 && ranked[i].includes(title))) {
            semIdx = i;
            break;
          }
        }
        const semScore = semIdx >= 0 ? 1000 - semIdx : 0;
        const hay = (title + ' ' + (it.summary || '') + ' ' + it.tags.join(' ')).toLowerCase();
        const kwScore = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        return { it, score: semScore * 10 + kwScore };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.it);
  }

  // ---- the sync job --------------------------------------------------------

  /** Bookmarks from the last `sinceDays` that still need work: never-imported OR previously unreadable (retry). */
  private async eligible(sinceDays: number): Promise<{ list: RaindropItem[]; existing: Map<string, ExistingRow> }> {
    const recent = await this.raindrop.recent(sinceDays);
    const rows = (await this.prisma.item.findMany({
      where: { source: 'raindrop' },
      select: { id: true, sourceUrl: true, readFailed: true, supermemoryId: true, ragId: true, filePath: true },
    })) as ExistingRow[];
    const existing = new Map<string, ExistingRow>(rows.map((r) => [r.sourceUrl || '', r]));
    const list = recent.filter((b) => b.link && (!existing.has(b.link) || existing.get(b.link)!.readFailed));
    return { list, existing };
  }

  /** Import (or re-summarize) one bookmark. Returns the outcome for progress counting. */
  private async importOne(b: RaindropItem, dir: string, existing: Map<string, ExistingRow>): Promise<'imported' | 'flagged' | 'skip'> {
    const { summary, readFailed } = await this.makeSummary(b);
    const md = this.buildMarkdown(b, summary, readFailed);
    const tags = cleanTags(b.tags);
    const ex = existing.get(b.link);

    if (ex) {
      // Retry/upgrade an existing (previously unreadable) bookmark in place — no duplicate, refresh memory.
      const filePath = ex.filePath || join(dir, `${ex.id}.md`);
      await fs.writeFile(filePath, md, 'utf8');
      await this.memory.deleteDoc(ex.supermemoryId, ex.ragId);
      await this.prisma.memoryOutbox.deleteMany({ where: { itemId: ex.id } }).catch(() => undefined);
      await this.prisma.item.update({
        where: { id: ex.id },
        data: { summary: this.shortDesc(summary), tags: JSON.stringify(tags), readFailed, filePath, supermemoryId: null, ragId: null },
      });
      await this.memory.enqueue(md, { itemId: ex.id, title: b.title, tags: [...tags, 'bookmark'] });
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
          ...(isNaN(created.getTime()) ? {} : { createdAt: created }),
        },
      })
      .catch(() => null);
    if (!item) return 'skip';

    const filePath = join(dir, `${item.id}.md`);
    await fs.writeFile(filePath, md, 'utf8');
    await this.prisma.item.update({ where: { id: item.id }, data: { filePath } });
    await this.memory.enqueue(md, { itemId: item.id, title: b.title, tags: [...tags, 'bookmark'] });
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
    }
  }
}
