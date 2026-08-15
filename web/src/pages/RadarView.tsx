import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { timeAgo } from './Agents';

/**
 * AI News Daily — the v4.1 TIMELINE design (BEA-1324, approved mockup 06127fbe).
 *
 * The page is the day itself: a numbered Hot-now list on top, then every story on a
 * time axis — HH:MM and a dot on the left, one compact rich card on the right. One
 * single centered column, no grids, no spine line. Scores and category words never
 * appear on cards; "translated" is a small word in the meta line. Cards expand in
 * place (smooth grid-rows collapse) to the reports timeline, source links and Share.
 */

type RadarRow = {
  id: string;
  title: string;
  titleOriginal: string;
  translated: boolean;
  url: string;
  source: string;
  category: string;
  aiScore: number;
  /** For multi-source stories: the reports timeline [{name,url,title,at}], time-ordered. */
  sources: { name: string; url: string; title?: string; at?: string }[];
  isPick: boolean;
  whyItMatters: string | null;
  publishedAt: string;
  heat: number;
};

type RadarStatus = {
  lastSyncAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  total: number;
  pendingTranslation: number;
  categories: string[];
  sources: string[];
};

/** The list endpoint pages at 100; the API prunes at 48h (~900 rows max), ten pages covers it. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** The feed renders this many cards before "Show more". */
const FEED_STEP = 60;

/** "agent_workflow" → "Agent workflow" — the radar's labels are snake_case. */
function prettyLabel(v: string): string {
  const s = v.replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : v;
}

/**
 * Source names arrive from the radar's built-in Chinese feeds ("X：通义千问 / Qwen
 * (@Alibaba_Qwen)"). This page promises English, so keep the Latin part when one
 * exists and only fall back to the original full name.
 */
export function prettySource(name: string): string {
  if (!/[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(name)) return name;
  const latin = name
    .replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿]+/g, ' ')
    .replace(/[（）：:/·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return latin.length >= 2 ? latin : name;
}

/**
 * The names for the Sources footer (BEA-1328): English where possible, no leftover "( )"
 * artefacts from CJK stripping, deduped, alphabetical.
 */
export function sourceDisplayNames(sources: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources || []) {
    const clean = prettySource(s).replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** 14:32 — the clock time that sits on the axis next to each card. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** One story per STORY in the hot list — member items share the same timeline. */
function storyKey(r: RadarRow): string {
  return (r.sources || []).map((s) => s.url).sort().join('|') || r.id;
}

/**
 * One card per STORY in the feed (BEA-1327). The collector follows several feeds that are
 * the same site under different names (Hacker News alone arrives four ways), so one story
 * lands as several raw items. Collapse rows that share a merged timeline — or, when a pair
 * carries no merged data, the same title. Rows keep their order; when a duplicate group
 * contains a pick, the pick survives, because it is the row with the why-it-matters line.
 */
export function dedupeStories(rows: RadarRow[]): RadarRow[] {
  const at = new Map<string, number>();
  const out: RadarRow[] = [];
  for (const r of rows) {
    const own = storyKey(r);
    const titleKey = `title:${(r.title || '').trim().toLowerCase()}`;
    // A row WITH a merged timeline only ever matches its own story — two different clusters
    // that happen to share a generic headline ("Weekly AI roundup") must both stay on the
    // page. The title is a fallback for rows the merger did not cluster (review fix).
    const candidates = (r.sources || []).length ? [own] : [own, titleKey];
    const hit = candidates.map((k) => at.get(k)).find((i) => i !== undefined);
    if (hit !== undefined) {
      if (r.isPick && !out[hit].isPick) out[hit] = r;
      continue;
    }
    at.set(own, out.length);
    if (!at.has(titleKey)) at.set(titleKey, out.length);
    out.push(r);
  }
  return out;
}

export function RadarView({ publicMode = false }: { publicMode?: boolean } = {}) {
  const toast = useToast();
  const [rows, setRows] = useState<RadarRow[] | null>(null);
  const [status, setStatus] = useState<RadarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The controls row: Curated|All, chips, and the two icons.
  const [curated, setCurated] = useState(true);
  const [category, setCategory] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(FEED_STEP);

  // The public page (BEA-1325) reads the no-login routes; they return the same shape,
  // minus the sync-error text a visitor has no use for.
  const base = publicMode ? '/api/news/public/radar' : '/api/news/radar';

  const load = useCallback(async () => {
    setError(null);
    try {
      const st = await fetch(`${base}/status`).then((r) => {
        if (!r.ok) throw new Error('status');
        return r.json();
      });
      const collected: RadarRow[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const d = await fetch(`${base}?page=${page}&pageSize=${PAGE_SIZE}`).then((r) => {
          if (!r.ok) throw new Error('list');
          return r.json();
        });
        collected.push(...(Array.isArray(d?.items) ? d.items : []));
        if (collected.length >= (d?.total || 0) || !(d?.items || []).length) break;
      }
      setStatus(st);
      setRows(collected);
    } catch {
      // Our words, not the browser's. `rows` stays untouched so stories from a previous
      // load remain on screen under the stale-data note.
      setError('The radar could not be loaded. Check your connection and try again.');
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const r = await fetch('/api/news/radar/sync', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false) throw new Error(d?.message || 'sync failed');
      setNotice(`Synced: ${d.stored ?? 0} new, ${d.known ?? 0} known${d.translated ? `, ${d.translated} translated` : ''}.`);
      await load();
    } catch {
      setNotice('The sync did not finish — the radar may be unreachable. Existing stories are untouched.');
    } finally {
      setSyncing(false);
    }
  };

  // Hot now — the numbered overview, independent of the feed's filters, like the site
  // this design follows. One row per story, hottest first.
  const hotList = useMemo(() => {
    const seen = new Set<string>();
    const out: RadarRow[] = [];
    const sorted = (rows || []).filter((r) => r.heat >= 2).sort((a, b) => b.heat - a.heat || (a.publishedAt < b.publishedAt ? 1 : -1));
    for (const r of sorted) {
      const key = storyKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= 8) break;
    }
    return out;
  }, [rows]);

  // The feed: chronological, newest first — the day, hour by hour.
  const feed = useMemo(() => {
    let r = rows || [];
    if (curated) r = r.filter((x) => x.isPick || x.heat >= 2 || x.aiScore >= 0.8);
    if (category) r = r.filter((x) => x.category === category);
    if (sourceFilter) r = r.filter((x) => x.source === sourceFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((x) => x.title.toLowerCase().includes(q) || x.source.toLowerCase().includes(q));
    }
    // One card per story — the raw items behind it stay reachable in the card's reports list.
    // Re-sorted afterwards: when a pick replaces its newer duplicate, its own (older) clock
    // time must also move the card, or the hour-by-hour axis lies (review fix).
    return dedupeStories([...r].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)))
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  }, [rows, curated, category, sourceFilter, search]);

  // The count line compares stories to stories — the raw item total would overstate the
  // universe now that the feed collapses duplicates (review fix).
  const totalStories = useMemo(() => dedupeStories(rows || []).length, [rows]);

  // The Sources footer (BEA-1328) — owner's choice: a simple, quiet list, nothing clickable.
  const sourceNames = useMemo(() => sourceDisplayNames(status?.sources || []), [status?.sources]);

  // A changed filter lands the reader back at the top of the feed.
  useEffect(() => {
    setLimit(FEED_STEP);
  }, [curated, category, sourceFilter, search]);

  /** The single glowing card: the highest-scored pick in the current feed. */
  const topPickId = useMemo(() => {
    const picks = feed.filter((r) => r.isPick);
    if (!picks.length) return null;
    return picks.reduce((a, b) => (b.aiScore > a.aiScore ? b : a)).id;
  }, [feed]);

  if (rows === null && !error) return <RadarSkeleton />;

  if (error && !(rows || []).length) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
        <p>{error}</p>
        <button onClick={load} className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[660px]">
      {/* Controls — one slim row */}
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex rounded-[10px] border border-zinc-200 bg-white p-[2px] text-[11.5px] dark:border-zinc-800 dark:bg-zinc-900">
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              aria-pressed={curated === v}
              onClick={() => setCurated(v)}
              className={
                'rounded-lg px-3 py-[4px] transition-colors ' +
                (curated === v ? 'bg-indigo-500/15 font-semibold text-indigo-600 dark:text-indigo-300' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
              }
            >
              {v ? 'Curated' : 'All'}
            </button>
          ))}
        </div>
        <div className="flex flex-1 gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {['', ...(status?.categories || [])].map((c) => (
            <button
              key={c || 'all'}
              aria-pressed={category === c}
              aria-label={c ? undefined : 'All categories'}
              onClick={() => setCategory(c)}
              className={
                'whitespace-nowrap rounded-full border px-3 py-1 text-[11.5px] transition-colors ' +
                (category === c
                  ? 'border-indigo-400 bg-indigo-500/15 font-medium text-indigo-600 dark:border-indigo-500 dark:text-indigo-300'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-500 hover:text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:text-zinc-200')
              }
            >
              {c ? prettyLabel(c) : 'All'}
            </button>
          ))}
        </div>
        <button
          aria-label="Search stories"
          aria-pressed={searchOpen}
          onClick={() => { setSearchOpen((o) => !o); if (searchOpen) setSearch(''); }}
          className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[10px] border border-zinc-200 bg-white text-zinc-500 hover:text-indigo-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        >
          <Search size={14} />
        </button>
        <button
          aria-label="Filter by source"
          aria-pressed={filterOpen}
          onClick={() => setFilterOpen((o) => !o)}
          className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[10px] border border-zinc-200 bg-white text-zinc-500 hover:text-indigo-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        >
          <SlidersHorizontal size={14} />
        </button>
      </div>

      {/* The search field and source filter unfold under the icons — smooth, no jumps. */}
      <div className={'grid transition-[grid-template-rows] duration-200 ' + (searchOpen || filterOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex gap-2 pb-1.5 pt-1">
            {searchOpen && (
              <input
                autoFocus
                aria-label="Search stories"
                placeholder="Search stories…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-w-0 flex-1 rounded-[10px] border border-zinc-200 bg-white px-3 py-[6px] text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
              />
            )}
            {filterOpen && (
              <select
                aria-label="Source"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="rounded-[10px] border border-zinc-200 bg-white px-3 py-[6px] text-xs text-zinc-600 outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
              >
                <option value="">Source: all</option>
                {(status?.sources || []).map((s) => (
                  <option key={s} value={s}>{prettySource(s)}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      <div className="mb-4 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span>
          {feed.length} of {totalStories} stories
          {status?.lastOkAt ? ` · synced ${timeAgo(status.lastOkAt)}` : ''}
        </span>
        {!publicMode && (
          <button
            onClick={syncNow}
            disabled={syncing}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-[3px] font-medium text-zinc-600 hover:text-indigo-600 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-indigo-400"
          >
            <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        {!publicMode && notice && <span>{notice}</span>}
      </div>

      {(status?.lastError || error) && (rows || []).length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
          {error || 'The last sync hit a problem — showing the stories we already have.'}
          {status?.lastOkAt ? ` Last good sync ${timeAgo(status.lastOkAt)}.` : ''}
        </div>
      )}

      {(rows || []).length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <Sparkles size={30} className="mx-auto mb-3 text-zinc-300 dark:text-zinc-600" />
          <p className="font-semibold">The radar is warming up</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
            It refreshes itself every hour. The first stories will appear after the next sync{publicMode ? '.' : ' — or tap “Sync now”.'}
          </p>
        </div>
      ) : (
        <>
          {/* HOT NOW — the numbered overview */}
          {hotList.length > 0 && (
            <section className="mb-2">
              <h2 className="mb-2 px-0.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-zinc-500">Hot now · by heat</h2>
              <div className="rounded-2xl border border-indigo-300/50 bg-gradient-to-b from-white to-zinc-50 px-4 py-1 shadow-[0_0_0_1px_rgba(99,102,241,0.25),0_8px_32px_rgba(99,102,241,0.10)] dark:border-indigo-900/60 dark:from-zinc-900 dark:to-zinc-950">
                {hotList.map((r, i) => (
                  <a
                    key={r.id}
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-baseline gap-3 border-b border-zinc-100 py-2.5 last:border-b-0 dark:border-zinc-800"
                  >
                    <span className="w-6 flex-none text-xs font-extrabold text-indigo-500 dark:text-indigo-400">#{i + 1}</span>
                    <span className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-zinc-800 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-300">{r.title}</span>
                    <span className="flex-none whitespace-nowrap text-[11px] text-zinc-400">
                      <b className="font-bold text-amber-500">🔥 {r.heat}</b> · {timeAgo(r.publishedAt)}
                    </span>
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* THE TIMELINE */}
          <h2 className="mb-2.5 mt-6 px-0.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-zinc-500">Today, hour by hour</h2>
          <div className="relative pl-[52px] sm:pl-[60px]">
            {feed.slice(0, limit).map((r) => (
              <TimelineCard key={r.id} row={r} top={r.id === topPickId} toast={toast} />
            ))}
          </div>

          {feed.length > limit && (
            <button
              onClick={() => setLimit((l) => l + FEED_STEP)}
              className="mx-auto mb-2 block rounded-[10px] border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-600 hover:text-indigo-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-indigo-400"
            >
              Show more · {feed.length - limit} left
            </button>
          )}
          {feed.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-400">No stories match — clear the search or filters.</p>
          )}
        </>
      )}

      {sourceNames.length > 0 && <SourcesFooter names={sourceNames} />}
    </div>
  );
}

/**
 * The Sources footer, variant A of the approved mockup — owner's final choice (BEA-1329):
 * every feed as a small pill in the house chip style, always visible.
 */
function SourcesFooter({ names }: { names: string[] }) {
  return (
    <footer className="mt-10 border-t border-zinc-200 pb-2 pt-4 dark:border-zinc-800">
      <h2 className="mb-2.5 px-0.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-zinc-500">
        Sources · <span className="text-indigo-500 dark:text-indigo-400">{names.length}</span>
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {names.map((n) => (
          <span key={n} className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-[3px] text-[10.5px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
            {n}
          </span>
        ))}
      </div>
    </footer>
  );
}

/** One dot on the day: the time, and the story's card. */
function TimelineCard({ row, top, toast }: { row: RadarRow; top: boolean; toast: (kind: 'success' | 'error', msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const quiet = !row.isPick && row.heat < 2;
  const reports = (row.sources || []).filter((s) => s.url);

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: row.title, url: row.url });
      } else {
        await navigator.clipboard.writeText(`${row.title}\n${row.url}`);
        toast('success', 'Link copied');
      }
    } catch (e: any) {
      // Dismissing the native share sheet is not an error; anything else deserves words.
      if (e?.name !== 'AbortError') toast('error', 'Could not share the link');
    }
  };

  return (
    <div className="relative mb-3">
      <span className="absolute -left-[52px] w-9 pt-[15px] text-right text-[10.5px] tabular-nums text-zinc-400 sm:-left-[60px] dark:text-zinc-500">
        {clockTime(row.publishedAt)}
      </span>
      <span
        aria-hidden
        className={
          'absolute top-[19px] rounded-full ' +
          (quiet ? '-left-[13px] h-1.5 w-1.5 bg-zinc-300 dark:bg-zinc-700' : '-left-[14px] h-[7px] w-[7px] bg-indigo-500')
        }
      />
      <div
        className={
          'rounded-[14px] border bg-gradient-to-b from-white to-zinc-50 px-[15px] py-3 dark:from-zinc-900 dark:to-zinc-950 ' +
          (top
            ? 'border-indigo-300/60 shadow-[0_0_0_1px_rgba(99,102,241,0.35),0_8px_32px_rgba(99,102,241,0.14)] dark:border-indigo-900/70'
            : 'border-zinc-200 dark:border-zinc-800')
        }
      >
        {row.isPick ? (
          <p className="mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-indigo-500 dark:text-indigo-300">
            {top ? '★ Top pick' : '★ Pick'}
          </p>
        ) : row.heat >= 2 ? (
          <p className="mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-amber-500">🔥 {row.heat} outlets</p>
        ) : null}

        <a
          href={row.url}
          target="_blank"
          rel="noreferrer"
          className={
            'block font-bold leading-[1.4] tracking-[-0.01em] text-zinc-900 hover:text-indigo-600 dark:text-zinc-50 dark:hover:text-indigo-300 ' +
            (top ? 'text-[15px]' : 'text-[13.5px]')
          }
        >
          {row.title}
        </a>

        {row.whyItMatters && <p className="mt-1.5 text-xs leading-[1.5] text-zinc-600 dark:text-zinc-300">{row.whyItMatters}</p>}

        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
            <b className="font-semibold text-zinc-500 dark:text-zinc-400" title={row.source}>{prettySource(row.source)}</b>
            {reports.length > 1 ? ` +${reports.length - 1}` : ''} · {timeAgo(row.publishedAt)}
            {row.translated && <span className="text-rose-400" title={row.titleOriginal}> · translated</span>}
          </span>
          <button
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="text-[11px] font-semibold text-indigo-500 hover:text-indigo-400 dark:text-indigo-400"
          >
            {open ? '⌃ Close' : '⌄ Story'}
          </button>
        </div>

        {/* The expanded area collapses via 0fr grid rows — everything stays in the DOM
            and the motion is one smooth height animation, no jumps. */}
        <div className={'grid transition-[grid-template-rows] duration-200 ' + (open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <div className="min-h-0 overflow-hidden" aria-hidden={!open}>
            <div className="mt-3 border-t border-zinc-100 pt-2.5 dark:border-zinc-800">
              {reports.length > 1 && (
                <ol className="ml-1 border-l-2 border-indigo-900/40 pl-3.5">
                  {reports.map((s, i) => (
                    <li key={i} className="relative py-[3px] text-[11.5px] leading-snug text-zinc-500 dark:text-zinc-400">
                      <span aria-hidden className="absolute -left-[19px] top-[9px] h-1.5 w-1.5 rounded-full bg-indigo-500" />
                      <b className="font-semibold text-zinc-600 dark:text-zinc-300">{prettySource(s.name) || 'source'}</b>
                      {s.at ? ` · ${clockTime(s.at)}` : ''}
                      {s.title ? <span className="text-zinc-400 dark:text-zinc-500"> — {s.title}</span> : null}
                    </li>
                  ))}
                </ol>
              )}
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {(reports.length ? reports : [{ name: row.source, url: row.url }]).map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    tabIndex={open ? undefined : -1}
                    className="rounded-[9px] border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[11.5px] text-zinc-500 hover:text-indigo-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400"
                  >
                    {prettySource(s.name) || 'open'} ↗
                  </a>
                ))}
              </div>
              <div className="mt-2.5">
                <button onClick={share} tabIndex={open ? undefined : -1} className="text-[11.5px] font-semibold text-indigo-500 hover:text-indigo-400 dark:text-indigo-400">
                  ⤴ Share
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RadarSkeleton() {
  return (
    <div className="mx-auto max-w-[660px] animate-pulse space-y-3">
      <div className="h-7 w-64 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-40 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      <div className="h-24 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      <div className="h-24 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}
