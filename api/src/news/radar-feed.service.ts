import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { decodeEntities } from './feed-parse';

export type RadarSyncResult = {
  ok: boolean;
  /** Items the radar offered us this sync (24h items + daily picks). */
  fetched: number;
  /** Rows written for the first time. */
  stored: number;
  /** Rows we already had — lastSeenAt bumped, nothing duplicated. */
  known: number;
  /** Titles converted to English during this sync. */
  translated: number;
  /** Non-English titles we could not translate — hidden until a later sync succeeds. */
  pending: number;
  /** Items dropped by the source blocklist. */
  blocked: number;
  /** Old rows removed — the radar is a rolling window, not an archive. */
  pruned: number;
  /** Items we could not write down. Never silently zero. */
  failed: number;
  message?: string;
};

type RadarListParams = {
  search?: string;
  category?: string;
  source?: string;
  picksOnly?: boolean;
  sort?: 'time' | 'score';
  page?: number;
  pageSize?: number;
};

/** Anything CJK — the radar's built-in Chinese sources produce these titles. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * Syncs the AI Radar collector fork (inai-sandy/ai-news-radar → GitHub Pages JSON)
 * into the RadarItem table (BEA-1311).
 *
 * The collector does the heavy lifting on GitHub (fetch, dedupe, score); this service
 * only mirrors its JSON and enforces one promise the collector cannot: everything the
 * UI shows is English. A title in Chinese is translated at sync time and the item is
 * hidden until that has actually happened.
 */
@Injectable()
export class RadarFeedService implements OnModuleInit, OnModuleDestroy {
  static readonly BASE_URL = process.env.RADAR_BASE_URL || 'https://inai-sandy.github.io/ai-news-radar/data';
  /** The fork's workflow runs hourly (cron minute 17), so hourly here matches it. */
  static readonly POLL_MS = 60 * 60 * 1000;
  /** Politeness cap per sync on the free translate endpoint; the rest stay pending and retry. */
  static readonly TRANSLATE_CAP = 60;
  /**
   * Rows unseen for this long are deleted. The radar is a rolling live window (the daily
   * paper is the archive); without this the table grows forever and quietly drifts away
   * from what the view's capped fetch can show (review finding, BEA-1313).
   */
  static readonly RETENTION_MS = 48 * 60 * 60 * 1000;

  private readonly log = new Logger('RadarFeed');
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private sourceHealthCache: { at: number; body: unknown } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    // LAST on purpose (house rule): spec harnesses build services positionally with fewer args.
    @Optional() private readonly llm?: LlmService,
  ) {}

  onModuleInit() {
    // Sync on boot as well as hourly — deploys restart the container often, and without this
    // the radar would sit an hour stale after every deploy.
    this.sync().catch((e) => this.log.error(`first sync failed: ${e?.message || e}`));
    this.timer = setInterval(() => {
      this.sync().catch((e) => this.log.error(`sync failed: ${e?.message || e}`));
    }, RadarFeedService.POLL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Overridable in tests so the sync can be exercised without the network. */
  protected async fetchJson(file: string): Promise<any> {
    const res = await fetch(`${RadarFeedService.BASE_URL}/${file}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Free Google translate endpoint — the same one the radar itself uses, pointed at
   * English. Returns null on any failure; overridable in tests.
   */
  protected async translateText(text: string): Promise<string | null> {
    try {
      const q = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'en', dt: 't', q: text });
      const res = await fetch(`https://translate.googleapis.com/translate_a/single?${q}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const out = (Array.isArray(data?.[0]) ? data[0] : [])
        .map((seg: any) => (Array.isArray(seg) && seg[0] ? String(seg[0]) : ''))
        .join('')
        .trim();
      return out || null;
    } catch {
      return null;
    }
  }

  /** Google first, engine fallback (named helper — never the loose general model), else null. */
  private async toEnglish(text: string): Promise<string | null> {
    const direct = await this.translateText(text);
    if (direct && !CJK_RE.test(direct)) return direct;
    const viaEngine = await this.llm?.completeHelper?.(
      'radar-translate',
      `Translate this AI-news headline to plain English. Reply with ONLY the translated headline, nothing else.\n\n${text}`,
      120,
      'radar-translate',
    ).catch(() => null);
    const cleaned = String(viaEngine || '').trim();
    return cleaned && !CJK_RE.test(cleaned) ? cleaned : null;
  }

  /** Sources whose items we drop entirely — comma list, matched case-insensitively. */
  private blocklist(): string[] {
    return String(process.env.RADAR_SOURCE_BLOCKLIST || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Pick the first candidate that is already fully English. The radar serves titles with
   * raw HTML entities in them ("Gemini&#8217;s") — seen in the first real sync — so every
   * candidate is decoded before it can become a stored title.
   */
  private englishCandidate(candidates: Array<string | null | undefined>): string | null {
    for (const c of candidates) {
      const t = decodeEntities(String(c || '')).trim();
      if (t && !CJK_RE.test(t)) return t;
    }
    return null;
  }

  /** The radar's picks join both languages as "中文 / English" — try the halves too. */
  private titleCandidates(raw: any): Array<string | null> {
    const first = Array.isArray(raw?.sources) && raw.sources.length ? raw.sources[0] : null;
    const base = [raw?.title_en, raw?.title_original, first?.title_en, first?.title_original, raw?.title];
    const joined = String(raw?.title || '');
    if (joined.includes(' / ')) base.push(...joined.split(' / '));
    return base;
  }

  async sync(): Promise<RadarSyncResult> {
    if (this.syncing) return { ok: false, fetched: 0, stored: 0, known: 0, translated: 0, pending: 0, blocked: 0, pruned: 0, failed: 0, message: 'sync already running' };
    this.syncing = true;
    try {
      return await this.doSync();
    } finally {
      this.syncing = false;
    }
  }

  private async doSync(): Promise<RadarSyncResult> {
    const counts: RadarSyncResult = { ok: true, fetched: 0, stored: 0, known: 0, translated: 0, pending: 0, blocked: 0, pruned: 0, failed: 0 };
    const now = new Date();

    // latest-24h.json is the sync's backbone — without it we change nothing and say so.
    let latest: any;
    try {
      latest = await this.fetchJson('latest-24h.json');
    } catch (e: any) {
      const message = `radar unreachable: ${e?.message || e}`;
      this.log.warn(message);
      await this.saveState(now, null, message, counts).catch(() => undefined);
      return { ...counts, ok: false, message };
    }

    // daily-brief.json is best-effort: without it we just have no picks this hour.
    let brief: any = null;
    let briefError: string | null = null;
    try {
      brief = await this.fetchJson('daily-brief.json');
    } catch (e: any) {
      briefError = `daily-brief unreachable: ${e?.message || e}`;
      this.log.warn(briefError);
    }

    // stories-merged.json is best-effort too (BEA-1323): it tells us how many outlets
    // carry a story (heat) and gives the story's TIMELINE — who reported it, when, in
    // order. Without it items simply stay heat=1 with whatever sources they had.
    const storyHeat = new Map<string, { heat: number; timeline: string }>();
    // Whether the merged file was actually read this sync — heat may only DECAY when we
    // know the story really left the file, never because the file was unreachable.
    let mergedOk = false;
    try {
      const mergedFile = await this.fetchJson('stories-merged.json');
      mergedOk = true;
      for (const st of Array.isArray(mergedFile?.stories) ? mergedFile.stories : []) {
        const sid = String(st?.story_id || '').trim();
        const entries = Array.isArray(st?.sources) ? st.sources : [];
        if (!sid || entries.length < 2) continue;
        const timeline = entries
          .map((s: any) => ({
            name: String(s?.source || s?.source_name || '').trim(),
            url: String(s?.url || '').trim(),
            title: this.englishCandidate([s?.title_en, s?.title_original, s?.title]) || '',
            at: String(s?.published_at || '').trim(),
          }))
          .filter((s: any, i: number, arr: any[]) => s.url && arr.findIndex((o) => o.url === s.url) === i) // upstream repeats outlets sometimes
          .sort((a: any, b: any) => (a.at < b.at ? -1 : 1));
        // Heat = the DEDUPED timeline length, so the 🔥 badge can never contradict the
        // visible source list (upstream's source_count counts the repeats).
        if (timeline.length < 2) continue;
        const value = { heat: timeline.length, timeline: JSON.stringify(timeline) };
        // Index by the story id (matches picks) AND by every member item's id — the
        // 24-hour feed's items carry NO story_id, so this is how they find their story.
        storyHeat.set(sid, value);
        for (const s of entries) {
          const itemId = String(s?.id || '').trim();
          if (itemId) storyHeat.set(itemId, value);
        }
      }
    } catch (e: any) {
      this.log.warn(`stories-merged unreachable: ${e?.message || e}`);
    }

    const blocklist = this.blocklist();
    type Incoming = {
      id: string; url: string; source: string; category: string; aiScore: number; storyId: string;
      sources: string; isPick: boolean; publishedAt: Date; english: string | null; original: string;
    };
    const incoming = new Map<string, Incoming>();

    for (const it of Array.isArray(latest?.items) ? latest.items : []) {
      const id = String(it?.id || '').trim();
      const url = String(it?.url || '').trim();
      if (!id || !url) { counts.failed += 1; continue; }
      counts.fetched += 1;
      const source = String(it?.source || it?.site_name || '').trim();
      if (blocklist.includes(source.toLowerCase())) { counts.blocked += 1; continue; }
      const original = decodeEntities(String(it?.title_original || it?.title || '')).trim();
      incoming.set(id, {
        id, url, source,
        category: String(it?.ai_label || '').trim(),
        aiScore: Number(it?.ai_score) || 0,
        storyId: String(it?.story_id || '').trim(),
        sources: '[]',
        isPick: false,
        publishedAt: this.asDate(it?.published_at, now),
        english: this.englishCandidate(this.titleCandidates(it)),
        original,
      });
    }

    for (const pick of Array.isArray(brief?.items) ? brief.items : []) {
      const id = String(pick?.story_id || pick?.id || '').trim();
      const url = String(pick?.url || pick?.primary_url || '').trim();
      if (!id || !url) { counts.failed += 1; continue; }
      counts.fetched += 1;
      const source = String(pick?.source || pick?.source_name || '').trim();
      if (blocklist.includes(source.toLowerCase())) { counts.blocked += 1; continue; }
      const outlets = (Array.isArray(pick?.sources) ? pick.sources : [])
        .map((s: any) => ({ name: String(s?.source || s?.source_name || s?.site_name || '').trim(), url: String(s?.url || '').trim() }))
        .filter((s: any) => s.url);
      const original = decodeEntities(String(pick?.title || '')).trim();
      incoming.set(id, {
        id, url, source,
        category: String(pick?.ai_label || pick?.category || '').trim(),
        aiScore: Number(pick?.ai_score) || 0,
        storyId: id,
        sources: JSON.stringify(outlets),
        isPick: true,
        publishedAt: this.asDate(pick?.published_at || pick?.first_seen_at, now),
        english: this.englishCandidate(this.titleCandidates(pick)),
        original,
      });
    }

    // Which of these do we already have, and which of those are still hidden? One query,
    // then create/update with honest counts. (The two feeds' id spaces are disjoint by
    // construction — item shas vs story ids — so `fetched` counts each item once.)
    const ids = [...incoming.keys()];
    const existingRows = await this.prisma.radarItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, pendingTranslation: true },
    });
    const existing = new Map<string, { pendingTranslation: boolean }>(
      existingRows.map((r: any) => [r.id, { pendingTranslation: !!r.pendingTranslation }]),
    );

    let translatedBudget = RadarFeedService.TRANSLATE_CAP;
    for (const item of incoming.values()) {
      const known = existing.has(item.id) ? existing.get(item.id) : null;
      // Heat and the timeline come from the merged-stories map, keyed by the story id
      // (picks ARE stories, so their own id matches too).
      const hot = storyHeat.get(item.storyId || item.id);
      try {
        if (known) {
          // A known row only moves forward: bump lastSeenAt, refresh score/pick status.
          // Its title is only revisited while the row is still hidden — a row that already
          // shows a good English title is left alone, and NOT counted as pending.
          const data: any = { lastSeenAt: now, aiScore: item.aiScore };
          if (item.isPick) {
            data.isPick = true;
            data.sources = item.sources;
          }
          if (hot) {
            data.heat = hot.heat;
            data.sources = hot.timeline; // the timeline is richer than the brief's outlet list
          } else if (mergedOk) {
            // The merged file was read and this story is no longer in it — the story has
            // COOLED. Without this, an item still in the 24h feed would keep yesterday's
            // 🔥 forever (review finding). An unreachable file never decays anything.
            data.heat = 1;
            if (!item.isPick) data.sources = '[]';
          }
          if (known.pendingTranslation) {
            let title = item.english;
            let translated = false;
            if (!title && translatedBudget > 0) {
              translatedBudget -= 1;
              title = await this.toEnglish(item.original);
              translated = !!title;
            }
            if (title) {
              data.title = title;
              data.translated = translated;
              data.pendingTranslation = false;
              counts.translated += 1;
            } else {
              // Still hidden — pending here is a true statement about the stored row.
              counts.pending += 1;
            }
          }
          await this.prisma.radarItem.update({ where: { id: item.id }, data });
          counts.known += 1;
        } else {
          let title = item.english;
          let translated = false;
          let pendingTranslation = false;
          if (!title) {
            if (translatedBudget > 0) {
              translatedBudget -= 1;
              title = await this.toEnglish(item.original);
            }
            if (title) {
              translated = true;
              counts.translated += 1;
            } else {
              // Never shown untranslated: keep the original as the stored title but hide the row.
              title = item.original;
              pendingTranslation = true;
              counts.pending += 1;
            }
          }
          await this.prisma.radarItem.create({
            data: {
              id: item.id, title, titleOriginal: item.original, translated, pendingTranslation,
              url: item.url, source: item.source, category: item.category, aiScore: item.aiScore,
              storyId: item.storyId, sources: hot ? hot.timeline : item.sources, isPick: item.isPick,
              heat: hot ? hot.heat : 1,
              publishedAt: item.publishedAt, firstSeenAt: now, lastSeenAt: now,
            },
          });
          counts.stored += 1;
        }
      } catch (e: any) {
        counts.failed += 1;
        this.log.warn(`could not write ${item.id}: ${e?.message || e}`);
      }
    }

    // Picks mirror the CURRENT daily brief: anything that dropped out stops being a pick.
    // Skipped when the brief was unreachable — stale picks beat no picks for an hour.
    if (brief && Array.isArray(brief.items)) {
      const briefIds = brief.items.map((p: any) => String(p?.story_id || p?.id || '').trim()).filter(Boolean);
      await this.prisma.radarItem
        .updateMany({ where: { isPick: true, id: { notIn: briefIds } }, data: { isPick: false } })
        .catch((e: any) => this.log.warn(`could not clear old picks: ${e?.message || e}`));
    }

    // Retry titles that a previous sync left pending — items this sync did not offer again.
    if (translatedBudget > 0) {
      const stale = await this.prisma.radarItem.findMany({
        where: { pendingTranslation: true, id: { notIn: ids } },
        take: Math.min(translatedBudget, 30),
      });
      for (const row of stale) {
        const english = await this.toEnglish(row.titleOriginal);
        if (!english) continue;
        try {
          await this.prisma.radarItem.update({ where: { id: row.id }, data: { title: english, translated: true, pendingTranslation: false } });
          counts.translated += 1;
          counts.pending = Math.max(0, counts.pending);
        } catch (e: any) {
          this.log.warn(`could not finish translating ${row.id}: ${e?.message || e}`);
        }
      }
    }

    // Prune the rolling window — only after a successful fetch, so an outage can never
    // erase the stories we are showing as "stale but real".
    try {
      const cutoff = new Date(now.getTime() - RadarFeedService.RETENTION_MS);
      const gone = await this.prisma.radarItem.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
      counts.pruned = Number(gone?.count) || 0;
    } catch (e: any) {
      this.log.warn(`prune failed: ${e?.message || e}`);
    }

    counts.message = briefError || undefined;
    await this.saveState(now, now, briefError, counts).catch((e) => this.log.warn(`state save failed: ${e?.message || e}`));
    this.log.log(`sync: fetched ${counts.fetched}, stored ${counts.stored}, known ${counts.known}, translated ${counts.translated}, pending ${counts.pending}, blocked ${counts.blocked}, failed ${counts.failed}`);
    return counts;
  }

  private asDate(value: unknown, fallback: Date): Date {
    const d = new Date(String(value || ''));
    return Number.isNaN(d.getTime()) ? fallback : d;
  }

  private async saveState(at: Date, okAt: Date | null, error: string | null, counts: RadarSyncResult): Promise<void> {
    const data = { lastSyncAt: at, lastError: error, counts: JSON.stringify(counts), ...(okAt ? { lastOkAt: okAt } : {}) };
    await this.prisma.radarSync.upsert({ where: { id: 'singleton' }, update: data, create: { id: 'singleton', ...data } });
  }

  /** The list the Radar view reads. Pending (untranslated) items are never returned. */
  async list(params: RadarListParams) {
    const page = Math.max(1, Math.floor(Number(params.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.pageSize) || 20)));
    const where: any = { pendingTranslation: false };
    if (params.search) where.title = { contains: String(params.search) };
    if (params.category) where.category = String(params.category);
    if (params.source) where.source = String(params.source);
    if (params.picksOnly) where.isPick = true;
    const orderBy = params.sort === 'score' ? [{ aiScore: 'desc' as const }, { publishedAt: 'desc' as const }] : [{ publishedAt: 'desc' as const }];
    const [total, rows] = await Promise.all([
      this.prisma.radarItem.count({ where }),
      this.prisma.radarItem.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const items = rows.map((r: any) => ({ ...r, sources: this.parseJson(r.sources, []) }));
    return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  /** Distinct filter values for the view's dropdowns, plus the sync state. */
  async status() {
    const [state, categories, sources, total, pending] = await Promise.all([
      this.prisma.radarSync.findUnique({ where: { id: 'singleton' } }),
      this.prisma.radarItem.findMany({ where: { pendingTranslation: false, category: { not: '' } }, distinct: ['category'], select: { category: true }, orderBy: { category: 'asc' } }),
      this.prisma.radarItem.findMany({ where: { pendingTranslation: false, source: { not: '' } }, distinct: ['source'], select: { source: true }, orderBy: { source: 'asc' } }),
      this.prisma.radarItem.count({ where: { pendingTranslation: false } }),
      this.prisma.radarItem.count({ where: { pendingTranslation: true } }),
    ]);
    return {
      lastSyncAt: state?.lastSyncAt || null,
      lastOkAt: state?.lastOkAt || null,
      lastError: state?.lastError || null,
      counts: this.parseJson(state?.counts, {}),
      total,
      pendingTranslation: pending,
      categories: categories.map((c: any) => c.category),
      sources: sources.map((s: any) => s.source),
    };
  }

  /**
   * The radar anyone may read — no login (BEA-1325). A deliberately separate shape, like the
   * public paper (BEA-1261): each item is mapped field by field, so a private column added to
   * RadarItem later can never leak through a spread nobody re-checked.
   */
  async publicList(params: { page?: number; pageSize?: number }) {
    const r = await this.list({ page: params.page, pageSize: params.pageSize, sort: 'time' });
    return {
      ...r,
      items: r.items.map((it: any) => ({
        id: it.id,
        title: it.title,
        titleOriginal: it.titleOriginal,
        translated: it.translated,
        url: it.url,
        source: it.source,
        category: it.category,
        aiScore: it.aiScore,
        sources: it.sources,
        isPick: it.isPick,
        whyItMatters: it.whyItMatters,
        publishedAt: it.publishedAt,
        heat: it.heat,
      })),
    };
  }

  /** Public status: what the filters need and when the news was last fresh — never our error text. */
  async publicStatus() {
    const s = await this.status();
    return { lastOkAt: s.lastOkAt, total: s.total, categories: s.categories, sources: s.sources };
  }

  /**
   * Today's hottest headlines, one line per STORY — shared by the /radar card text and the
   * card image (BEA-1326). Member items of one merged story share its heat, so the same
   * headline arrives more than once — seen on the first live card. Deduped by title.
   */
  async hotTitles(take = 3): Promise<string[]> {
    const rows = await this.prisma.radarItem
      .findMany({ where: { pendingTranslation: false, heat: { gte: 2 } }, orderBy: [{ heat: 'desc' }, { publishedAt: 'desc' }], take: 10, select: { title: true } })
      .catch(() => []);
    const seen = new Set<string>();
    return rows
      .map((r: any) => String(r.title || '').trim())
      .filter((t: string) => t && !seen.has(t.toLowerCase()) && (seen.add(t.toLowerCase()), true))
      .slice(0, take);
  }

  /** The share card a crawler reads for /radar — today's hottest stories, or a plain line. */
  async ogMeta(origin: string) {
    const titles = await this.hotTitles(3);
    return {
      title: 'AI News Daily — My Brain',
      description: (titles.length ? `Hot now: ${titles.join(' · ')}` : 'AI news from around the world — refreshed every hour, in English.').slice(0, 180),
      url: `${origin}/radar`,
      // A real generated image (BEA-1326), not the static default — today's hot list, drawn hourly.
      image: `${origin}/api/og/radar/card.png`,
    };
  }

  /** Per-feed health for the view's Sources strip — proxied with a short cache. */
  async sourceHealth() {
    const FIVE_MIN = 5 * 60 * 1000;
    if (this.sourceHealthCache && Date.now() - this.sourceHealthCache.at < FIVE_MIN) return this.sourceHealthCache.body;
    try {
      const body = await this.fetchJson('source-status.json');
      this.sourceHealthCache = { at: Date.now(), body };
      return body;
    } catch (e: any) {
      // Stale cache beats an error here — the strip is informational.
      if (this.sourceHealthCache) return this.sourceHealthCache.body;
      return { error: `source status unavailable: ${e?.message || e}` };
    }
  }

  private parseJson(value: unknown, fallback: any) {
    try {
      return JSON.parse(String(value ?? ''));
    } catch {
      return fallback;
    }
  }
}
