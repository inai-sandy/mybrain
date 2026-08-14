import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Languages, RefreshCw, Sparkles, AlertTriangle } from 'lucide-react';
import { DataTable, Column } from '../ui/DataTable';
import { timeAgo } from './Agents';

/**
 * The Radar tab on /news (BEA-1313) — the live, always-English AI news radar.
 *
 * All heavy lifting happened before this page: the collector fork gathers and dedupes
 * on GitHub (BEA-1311 syncs it in, translating anything Chinese), and the engine writes
 * the picks' one-liners on an hourly check (BEA-1312/1314). This view only reads: Today's picks on top,
 * every story in the shared DataTable below, and the per-feed health strip at the end.
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
  /** For multi-source stories this is the TIMELINE — who reported it, when, in order. */
  sources: { name: string; url: string; title?: string; at?: string }[];
  isPick: boolean;
  /** How many outlets carry the story (1 = single-source, 2+ = hot). */
  heat: number;
  whyItMatters: string | null;
  publishedAt: string;
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

type SiteHealth = { site_id: string; site_name: string; ok: boolean; item_count: number; error: string | null };

/**
 * The list endpoint pages at 100. The API prunes rows unseen for 48h, which bounds the
 * table at roughly ~900 rows worst case — ten pages always covers the whole window, so
 * the header count, the filters, and the loaded rows can never drift apart.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** "agent_workflow" → "Agent workflow" — the radar's labels are snake_case. */
function prettyLabel(v: string): string {
  const s = v.replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : v;
}

/**
 * Source names arrive from the radar's built-in Chinese feeds ("X：通义千问 / Qwen
 * (@Alibaba_Qwen)", "公众号：智谱（GLM）"). This page promises English, so keep the
 * Latin part when one exists and only fall back to the original full name.
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

export function RadarView() {
  const [rows, setRows] = useState<RadarRow[] | null>(null);
  const [status, setStatus] = useState<RadarStatus | null>(null);
  const [health, setHealth] = useState<SiteHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const st = await fetch('/api/news/radar/status').then((r) => {
        if (!r.ok) throw new Error('status');
        return r.json();
      });
      const collected: RadarRow[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const d = await fetch(`/api/news/radar?page=${page}&pageSize=${PAGE_SIZE}`).then((r) => {
          if (!r.ok) throw new Error('list');
          return r.json();
        });
        collected.push(...(Array.isArray(d?.items) ? d.items : []));
        if (collected.length >= (d?.total || 0) || !(d?.items || []).length) break;
      }
      setStatus(st);
      setRows(collected);
    } catch {
      // Our words, not the browser's. `rows` is deliberately left untouched here, so
      // stories from a previous load stay on screen under the stale-data banner.
      setError('The radar could not be loaded. Check your connection and try again.');
    }
    // The health strip is informational — its failure must never block the stories.
    fetch('/api/news/radar/sources')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setHealth(Array.isArray(d?.sites) ? d.sites : null))
      .catch(() => setHealth(null));
  }, []);

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
      setNotice(`Synced: ${d.stored ?? 0} new, ${d.known ?? 0} already known${d.translated ? `, ${d.translated} translated` : ''}.`);
      await load();
    } catch {
      setNotice('The sync did not finish — the radar may be unreachable. Existing stories are untouched.');
    } finally {
      setSyncing(false);
    }
  };

  const picks = useMemo(() => (rows || []).filter((r) => r.isPick).sort((a, b) => b.aiScore - a.aiScore), [rows]);

  // The mockup's control chrome (BEA-1320): one-tap category chips + pill controls,
  // driving the shared DataTable through its external-controls mode.
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sortMode, setSortMode] = useState<'time' | 'score' | 'hot'>('time');
  // Curated (default) = the good stuff: picks, hot multi-source stories, high scores.
  // One tap to All — the whole rolling window. (BEA-1323)
  const [curated, setCurated] = useState(true);
  // Memoised so unrelated re-renders (health polls, notices) don't churn the table's memo.
  const tableControls = useMemo(
    () => ({
      search,
      filters: { category, source: sourceFilter },
      sort:
        sortMode === 'score' ? { key: 'aiScore', dir: -1 as const }
        : sortMode === 'hot' ? { key: 'heat', dir: -1 as const }
        : { key: 'publishedAt', dir: -1 as const },
    }),
    [search, category, sourceFilter, sortMode],
  );
  const listRows = useMemo(
    () => (curated ? (rows || []).filter((r) => r.isPick || r.heat >= 2 || r.aiScore >= 0.8) : rows || []),
    [rows, curated],
  );
  // Hot now: multi-source stories, hottest first. Picks stay in their own section above.
  // Every member item of a story carries the same heat + timeline, so the section
  // dedupes by timeline — one card per STORY, not one per outlet.
  const hotNow = useMemo(() => {
    const seen = new Set<string>();
    const out: RadarRow[] = [];
    const sorted = (rows || []).filter((r) => r.heat >= 2 && !r.isPick).sort((a, b) => b.heat - a.heat || (a.publishedAt < b.publishedAt ? 1 : -1));
    for (const r of sorted) {
      const key = (r.sources || []).map((s) => s.url).sort().join('|') || r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= 6) break;
    }
    return out;
  }, [rows]);

  const columns: Column<RadarRow>[] = [
    {
      key: 'title',
      label: 'Story',
      width: '52%',
      render: (r) => (
        <a href={r.url} target="_blank" rel="noreferrer" className="group inline-flex items-start gap-1.5 font-medium text-zinc-800 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400">
          <span className="min-w-0 break-words">{r.title}</span>
          <ExternalLink size={13} className="mt-0.5 shrink-0 text-zinc-300 group-hover:text-indigo-400 dark:text-zinc-600" />
        </a>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      width: '22%',
      render: (r) => <SourceBadges row={r} />,
    },
    // Sorting has ONE control — the dropdown (it also serves the mobile cards). Making
    // these headers clickable too would leave the dropdown showing a sort that is no
    // longer the active one.
    {
      key: 'aiScore',
      label: 'Score',
      width: '13%',
      render: (r) => <ScorePill score={r.aiScore} />,
    },
    {
      key: 'publishedAt',
      label: 'When',
      width: '13%',
      render: (r) => <span className="whitespace-nowrap text-zinc-500">{timeAgo(r.publishedAt)}</span>,
    },
  ];

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
    <div>
      {/* Sync bar */}
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500">
        <span>
          {status?.total ?? (rows || []).length} stories
          {status?.lastOkAt ? ` · synced ${timeAgo(status.lastOkAt)}` : ''}
        </span>
        {status?.pendingTranslation ? <span>· {status.pendingTranslation} awaiting translation</span> : null}
        <button
          onClick={syncNow}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 font-medium text-zinc-600 hover:text-indigo-600 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-indigo-400"
        >
          <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {notice && <span className="text-zinc-500">{notice}</span>}
      </div>

      {/* A radar problem shows itself — stale data with a note beats an empty page. */}
      {(status?.lastError || error) && (rows || []).length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {error || 'The last sync hit a problem — showing the stories we already have.'}
            {status?.lastOkAt ? ` Last good sync ${timeAgo(status.lastOkAt)}.` : ''}
          </span>
        </div>
      )}

      {(rows || []).length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <Sparkles size={30} className="mx-auto mb-3 text-zinc-300 dark:text-zinc-600" />
          <p className="font-semibold">The radar is warming up</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
            It refreshes itself every hour. The first stories will appear after the next sync — or tap “Sync now”.
          </p>
        </div>
      ) : (
        <>
          {/* Today's picks */}
          {picks.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Today’s picks</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {picks.map((p) => (
                  <PickCard key={p.id} pick={p} />
                ))}
              </div>
            </section>
          )}

          {/* Hot now — stories several outlets carry at once, hottest first. (BEA-1323) */}
          {hotNow.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Hot now</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {hotNow.map((r) => (
                  <HotCard key={r.id} row={r} />
                ))}
              </div>
            </section>
          )}

          {/* All stories — the shared house list wearing the mockup's chrome */}
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">All stories</h2>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="flex rounded-[10px] border border-zinc-200 bg-white p-[3px] text-xs dark:border-zinc-800 dark:bg-zinc-900">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  aria-pressed={curated === v}
                  onClick={() => setCurated(v)}
                  className={
                    'rounded-lg px-3 py-[4px] transition-colors ' +
                    (curated === v ? 'bg-indigo-500 font-semibold text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
                  }
                >
                  {v ? 'Curated' : 'All'}
                </button>
              ))}
            </div>
            <input
              aria-label="Search stories"
              placeholder="Search stories…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-[150px] flex-1 rounded-[10px] border border-zinc-200 bg-white px-3 py-[7px] text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
            />
            <select
              aria-label="Source"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-[10px] border border-zinc-200 bg-white px-3 py-[7px] text-xs text-zinc-600 outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <option value="">Source: all</option>
              {(status?.sources || []).map((s) => (
                <option key={s} value={s}>{prettySource(s)}</option>
              ))}
            </select>
            <select
              aria-label="Sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value === 'score' ? 'score' : e.target.value === 'hot' ? 'hot' : 'time')}
              className="rounded-[10px] border border-zinc-200 bg-white px-3 py-[7px] text-xs text-zinc-600 outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <option value="time">Sort: Newest</option>
              <option value="hot">Sort: Hot</option>
              <option value="score">Sort: Score</option>
            </select>
          </div>

          {/* One-tap category chips — horizontally scrollable on phones. */}
          <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
            {['', ...(status?.categories || [])].map((c) => (
              <button
                key={c || 'all'}
                aria-pressed={category === c}
                // Distinct from the Curated|All toggle's "All" for screen readers.
                aria-label={c ? undefined : 'All categories'}
                onClick={() => setCategory(c)}
                className={
                  'whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ' +
                  (category === c
                    ? 'border-indigo-400 bg-indigo-500/15 font-medium text-indigo-600 dark:border-indigo-500 dark:text-indigo-300'
                    : 'border-zinc-200 bg-zinc-50 text-zinc-500 hover:text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:text-zinc-200')
                }
              >
                {c ? prettyLabel(c) : 'All'}
              </button>
            ))}
          </div>

          <DataTable<RadarRow>
            columns={columns}
            rows={listRows}
            controls={tableControls}
            pageSize={20}
            tableLayoutFixed
            emptyText="No stories match — clear the search or filters."
            renderCard={(r) => <StoryCard row={r} />}
          />

          {/* Per-feed health */}
          {health && health.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Sources</h2>
              <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-xl border border-zinc-200 bg-white p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                {health.map((s) => (
                  <span key={s.site_id} className="inline-flex items-center gap-1.5" title={s.error || `${s.item_count} items`}>
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                    {s.site_name}
                    <span className="text-zinc-400 dark:text-zinc-500">{s.ok ? s.item_count : 'stale'}</span>
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ScorePill({ score }: { score: number }) {
  // The daily brief carries no score — a "0.00" pill is noise, not information.
  if (!score || score <= 0) return null;
  const hi = score >= 0.8;
  return (
    <span
      className={
        'inline-block rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums ' +
        (hi ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400')
      }
    >
      {score.toFixed(2)}
    </span>
  );
}

function TranslatedMark({ row }: { row: RadarRow }) {
  if (!row.translated) return null;
  return (
    <span
      title={`Translated — original: ${row.titleOriginal}`}
      className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-500 dark:bg-rose-950/40 dark:text-rose-400"
    >
      <Languages size={10} /> translated
    </span>
  );
}

function SourceBadges({ row }: { row: RadarRow }) {
  const extra = (row.sources?.length || 0) - 1;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="max-w-full truncate rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" title={row.source}>
        {prettySource(row.source) || '—'}
      </span>
      {extra > 0 && <span className="text-[11px] font-medium text-indigo-500">+{extra} sources</span>}
      {/* The category is filterable, so each row shows which one it belongs to. */}
      {row.category && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{prettyLabel(row.category)}</span>}
      <TranslatedMark row={row} />
    </span>
  );
}

function PickCard({ pick }: { pick: RadarRow }) {
  return (
    <div className="rounded-xl border border-indigo-200/70 bg-gradient-to-b from-indigo-50/70 to-white p-4 dark:border-indigo-900/50 dark:from-indigo-950/30 dark:to-zinc-900">
      <a href={pick.url} target="_blank" rel="noreferrer" className="font-semibold leading-snug text-zinc-900 hover:text-indigo-600 dark:text-zinc-50 dark:hover:text-indigo-400">
        {pick.title}
      </a>
      {pick.whyItMatters ? (
        <p className="mt-1.5 text-sm leading-relaxed text-indigo-900/80 dark:text-indigo-200/90">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">why it matters</span>
          {pick.whyItMatters}
        </p>
      ) : (
        <p className="mt-1.5 text-xs italic text-zinc-400 dark:text-zinc-500">The one-line note arrives within the hour.</p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <SourceBadges row={pick} />
        <ScorePill score={pick.aiScore} />
        <span>{timeAgo(pick.publishedAt)}</span>
      </div>
      <Timeline row={pick} />
    </div>
  );
}

/** A Hot-now story: several outlets at once, with its timeline one tap away. (BEA-1323) */
function HotCard({ row }: { row: RadarRow }) {
  return (
    <div className="rounded-xl border border-amber-200/70 bg-gradient-to-b from-amber-50/60 to-white p-4 dark:border-amber-900/40 dark:from-amber-950/20 dark:to-zinc-900">
      <a href={row.url} target="_blank" rel="noreferrer" className="font-semibold leading-snug text-zinc-900 hover:text-indigo-600 dark:text-zinc-50 dark:hover:text-indigo-400">
        {row.title}
      </a>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span className="rounded-md bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">🔥 {row.heat} sources</span>
        <SourceBadges row={row} />
        <ScorePill score={row.aiScore} />
        <span>{timeAgo(row.publishedAt)}</span>
      </div>
      <Timeline row={row} />
    </div>
  );
}

/**
 * Who reported the story, in order — the part Sandeep liked on the upstream site.
 * Collapsed behind one tap; every entry links to that outlet's version.
 */
function Timeline({ row }: { row: RadarRow }) {
  const [open, setOpen] = useState(false);
  const entries = (row.sources || []).filter((s) => s.url);
  if (entries.length < 2) return null;
  return (
    <div className="mt-2">
      <button
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-semibold text-indigo-500 hover:text-indigo-400"
      >
        {open ? 'Hide timeline' : `Timeline · ${entries.length} reports ›`}
      </button>
      {open && (
        <ol className="mt-1.5 space-y-1 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {entries.map((s, i) => (
            <li key={i} className="text-[11.5px] leading-snug">
              <a href={s.url} target="_blank" rel="noreferrer" className="text-zinc-600 hover:text-indigo-500 dark:text-zinc-300">
                <span className="font-semibold">{prettySource(s.name) || 'source'}</span>
                {s.at ? <span className="text-zinc-400 dark:text-zinc-500"> · {timeAgo(s.at)}</span> : null}
                {s.title ? <span className="text-zinc-400 dark:text-zinc-500"> — {s.title}</span> : null}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StoryCard({ row }: { row: RadarRow }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
      <a href={row.url} target="_blank" rel="noreferrer" className="text-sm font-medium leading-snug text-zinc-800 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400">
        {row.title}
      </a>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <SourceBadges row={row} />
        <ScorePill score={row.aiScore} />
        <span>{timeAgo(row.publishedAt)}</span>
      </div>
    </div>
  );
}

function RadarSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-4 w-56 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="h-28 rounded-xl bg-zinc-100 dark:bg-zinc-900" />
        <div className="h-28 rounded-xl bg-zinc-100 dark:bg-zinc-900" />
      </div>
      <div className="h-64 rounded-xl bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}
