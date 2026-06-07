import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { RaindropClient, RaindropItem } from './raindrop.client';
import { TavilyClient } from './tavily.client';

/** Bookmarks live alongside other items on disk so the existing view/delete/sync endpoints work. */
function itemsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'items');
}

const DEFAULT_SINCE_DAYS = 90;
const MAX_PER_RUN = Number(process.env.BOOKMARKS_MAX_PER_RUN) || 25;

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

export type SyncResult = {
  ok: boolean;
  code?: string;
  message?: string;
  imported?: number;
  skipped?: number;
  flagged?: number;
  total?: number;
  remaining?: number;
  lastSync?: string;
};

@Injectable()
export class BookmarksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly raindrop: RaindropClient,
    private readonly tavily: TavilyClient,
  ) {}

  /** A ~250-word plain-prose summary of the page text via the configured LLM (null if unavailable). */
  async longSummary(title: string, pageText: string): Promise<string | null> {
    const doc = pageText.slice(0, 8000);
    const prompt =
      `Write a clear, self-contained summary of the web page below in about 250 words (do not exceed 280). ` +
      `Use plain prose — no markdown headings, no bullet lists. Capture what the page is about, its key points / tools / steps, ` +
      `and who would find it useful, so it can be found later by meaning.\n\nTitle: ${title}\n\nPage content:\n${doc}`;
    const text = await this.llm.complete(prompt, 500);
    return text ? text.trim() : null;
  }

  /** Summary built from Raindrop metadata only — used when the page can't be read or no model is set. */
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
    const flag = readFailed
      ? `\n> ⚠️ The page couldn't be fully read — this summary is based on the title, tags and your note.\n`
      : '';
    return `${b.link}\n\n# ${b.title}\n\n**Tags:** ${tagLine}  \n**Saved:** ${date}  \n**Source:** Raindrop\n${flag}\n${summary}\n`;
  }

  async lastSync(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'bookmarks.lastSync' } });
    return row?.value || null;
  }

  /** All stored bookmarks (newest first) shaped for the page. */
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
    }));
  }

  /**
   * Find bookmarks by MEANING. Uses the semantic stores (SuperMemory + RAG) to rank,
   * then maps the ranked snippets back to real bookmark items by matching their link/title
   * (every bookmark's summary — which we indexed — starts with its URL + title).
   * Keyword overlap is a safety net so the box always returns sensible results.
   */
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
        // Semantic rank: earliest store snippet that mentions this bookmark's link or title.
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

  async count(): Promise<number> {
    return this.prisma.item.count({ where: { source: 'raindrop' } });
  }

  /**
   * Pull the last `sinceDays` of Raindrop bookmarks, read each with Tavily, summarize to a .md,
   * and index stamped "bookmark". Capped per run to stay within request limits; returns counts.
   */
  async sync(opts: { sinceDays?: number; cap?: number } = {}): Promise<SyncResult> {
    if (!(await this.raindrop.hasKey()))
      return { ok: false, code: 'no_raindrop', message: 'Connect Raindrop in Settings first.' };
    if (!(await this.tavily.hasKey()))
      return { ok: false, code: 'no_tavily', message: 'Connect Tavily in Settings first.' };

    const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
    const maxPerRun = opts.cap ?? MAX_PER_RUN;

    let recent: RaindropItem[];
    try {
      recent = await this.raindrop.recent(sinceDays);
    } catch {
      return { ok: false, code: 'raindrop_error', message: 'Could not reach Raindrop — check the key and try again.' };
    }

    // Dedup against bookmarks already pulled in (by original link).
    const existing = await this.prisma.item.findMany({ where: { source: 'raindrop' }, select: { sourceUrl: true } });
    const have = new Set(existing.map((e) => e.sourceUrl).filter(Boolean));
    const eligible = recent.filter((b) => b.link && !have.has(b.link));

    const dir = itemsDir();
    await fs.mkdir(dir, { recursive: true });

    let imported = 0;
    let flagged = 0;
    for (const b of eligible) {
      if (imported >= maxPerRun) break;

      const pageText = await this.tavily.extract(b.link);
      let summary: string | null = null;
      if (pageText) summary = await this.longSummary(b.title, pageText);
      // Flag only when the PAGE itself couldn't be read (not merely a missing model).
      const readFailed = !pageText;
      if (!summary) summary = this.fallbackSummary(b);

      const md = this.buildMarkdown(b, summary, readFailed);
      const contentHash = createHash('sha256').update(`raindrop:${b.link}`).digest('hex');
      const tags = cleanTags(b.tags);
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
      if (!item) continue; // unique (link) clash → already imported

      const filePath = join(dir, `${item.id}.md`);
      await fs.writeFile(filePath, md, 'utf8');
      await this.prisma.item.update({ where: { id: item.id }, data: { filePath } });

      // Summary only (no full page text), stamped "bookmark" in both stores.
      await this.memory.enqueue(md, { itemId: item.id, title: b.title, tags: [...tags, 'bookmark'] });

      imported++;
      if (readFailed) flagged++;
    }

    const remaining = Math.max(0, eligible.length - imported);
    const lastSync = new Date().toISOString();
    await this.prisma.setting
      .upsert({
        where: { key: 'bookmarks.lastSync' },
        create: { key: 'bookmarks.lastSync', value: lastSync },
        update: { value: lastSync },
      })
      .catch(() => undefined);

    return { ok: true, imported, skipped: recent.length - eligible.length, flagged, total: recent.length, remaining, lastSync };
  }
}
