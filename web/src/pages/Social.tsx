import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw, Share2 } from 'lucide-react';
import { Column, DataTable, Filter, SortOption } from '../ui/DataTable';
import { Skeleton } from '../ui/Skeleton';
import { CHIP, CreditStrip, GHOST_BTN, NoKeyNotice, Notice, Overview, Platform, PlatformLogo, PRIMARY_BTN, SpecNotice, num, plural } from './social/socialShared';

/**
 * `/social` — the platform grid (BEA-1356). Design: `specs/SOCIAL.md`.
 *
 * Every platform the provider reports (generated from the vendor's spec — never a hand list), each
 * with its mark and its endpoint count, under a header that shows the credit balance, today's
 * spend and the daily ceiling. Tools (`/tools`) is where the key gets connected; this is where the
 * social data gets USED — tap a platform to see every endpoint and run any of them right there.
 */

type Row = Platform & { _search: string; _kinds: string; _tags: string };

const KIND_LABELS: Record<string, string> = {
  profile: 'Profiles',
  posts: 'Posts & videos',
  comments: 'Comments',
  transcript: 'Transcripts',
  search: 'Search',
  ads: 'Ad libraries',
  followers: 'Followers & audience',
};

export function Social() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (refresh = false) => {
    try {
      const r = await fetch('/api/social' + (refresh ? '?refresh=1' : ''));
      if (!r.ok) throw new Error('failed');
      setData(await r.json());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const platforms = data?.platforms || [];
  const rows: Row[] = useMemo(
    () => platforms.map((p) => ({
      ...p,
      _search: [p.name, p.slug, p.description, ...(p.tags || []), ...(p.kinds || [])].filter(Boolean).join(' '),
      _kinds: (p.kinds || []).join(' '),
      _tags: (p.tags || []).join(' '),
    })),
    [platforms],
  );

  const columns: Column<Row>[] = useMemo(() => [{ key: '_search', label: 'Platform' }], []);

  const filters: Filter[] = useMemo(() => {
    // Built from the platforms themselves, so no choice can come back empty.
    const counts = new Map<string, number>();
    for (const p of platforms) for (const k of p.kinds || []) counts.set(k, (counts.get(k) || 0) + 1);
    return [
      {
        key: '_kinds',
        label: 'Has',
        options: Object.keys(KIND_LABELS).filter((k) => counts.has(k)).map((k) => ({ value: k, label: `${KIND_LABELS[k]} (${counts.get(k)})` })),
        match: (r: Row, v: string) => (r.kinds || []).includes(v),
      },
    ];
  }, [platforms]);

  const sortOptions: SortOption[] = [
    { label: 'Most endpoints', key: 'actionCount', dir: -1 },
    { label: 'Name A–Z', key: 'name', dir: 1 },
  ];

  const status = data?.status;
  const total = platforms.reduce((n, p) => n + num(p.actionCount), 0);

  return (
    <div className="space-y-5 pb-16">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><Share2 className="text-emerald-500" /> Social</h1>
          <p className="text-zinc-500 text-sm">
            Every social platform your agents can read from. Pick one, run any endpoint right there, keep what comes back.
          </p>
        </div>
        {!loading && !failed && (
          <button
            onClick={() => { setLoading(true); load(true); }}
            title="Check again"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <RefreshCw size={15} /> <span className="hidden sm:inline">Check again</span>
          </button>
        )}
      </header>

      {loading && <LoadingState />}

      {!loading && failed && (
        <Notice
          tone="warn"
          icon={<AlertTriangle size={20} />}
          title="We could not load Social"
          body="Something went wrong on the way to the server. Nothing has changed — try again in a moment."
          action={<button onClick={() => { setLoading(true); load(true); }} className={PRIMARY_BTN}><RefreshCw size={15} /> Try again</button>}
        />
      )}

      {!loading && !failed && data && (
        <>
          <CreditStrip balance={data.balance} spentToday={data.spentToday} ceiling={data.ceiling} status={status} />

          {status && !status.configured && <NoKeyNotice />}

          {status && status.configured && !status.reachable && (
            <Notice
              tone="warn"
              icon={<AlertTriangle size={20} />}
              title="We cannot reach Scrape Creators right now"
              body={(status.message || 'It did not answer.') + ' The platforms are still listed below; runs will work again once it answers.'}
              action={
                <>
                  <button onClick={() => { setLoading(true); load(true); }} className={PRIMARY_BTN}><RefreshCw size={15} /> Try again</button>
                  <Link to="/settings/connections" className={GHOST_BTN}>Check the key</Link>
                </>
              }
            />
          )}

          <SpecNotice spec={data.spec} onRetry={() => { setLoading(true); load(true); }} />

          {platforms.length === 0 ? (
            <Notice
              tone="warn"
              icon={<AlertTriangle size={20} />}
              title="No platforms to show yet"
              body="Their endpoint list has not been read yet — it is fetched at start-up and once a day. Try again in a moment."
              action={<button onClick={() => { setLoading(true); load(true); }} className={PRIMARY_BTN}><RefreshCw size={15} /> Try again</button>}
            />
          ) : (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-500">
                Platforms
                <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-500 dark:bg-zinc-800" data-testid="platform-count">{platforms.length}</span>
                <span className="text-xs font-normal text-zinc-400">· {plural(total, 'endpoint')} in all</span>
              </h2>
              <DataTable<Row>
                columns={columns}
                rows={rows}
                filters={filters}
                sortOptions={sortOptions}
                defaultSort={{ key: 'actionCount', dir: -1 }}
                renderCard={(p) => <PlatformCard p={p} />}
                cardsOnly
                gridClassName="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                pageSize={30}
                emptyText="No platform matches that. Try a shorter word, or clear the filter."
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function PlatformCard({ p }: { p: Platform }) {
  const more = Math.max(0, (p.tags || []).length - 2);
  return (
    <Link
      to={`/social/${p.slug}`}
      className="group flex h-full w-full min-w-0 flex-col rounded-xl border border-zinc-200 bg-white p-4 text-left transition-all hover:border-emerald-500/40 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
      data-testid="platform-card"
    >
      <div className="flex min-w-0 items-start gap-3">
        <PlatformLogo p={p} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold leading-snug group-hover:text-emerald-600">{p.name}</h3>
          <p className="mt-0.5 truncate text-xs text-zinc-400">{plural(num(p.actionCount), 'endpoint')}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {(p.tags || []).slice(0, 2).map((t) => (
          <span key={t} className={CHIP + ' bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}>{t}</span>
        ))}
        {more > 0 && <span className={CHIP + ' bg-zinc-100 text-zinc-400 dark:bg-zinc-800'}>+{more}</span>}
      </div>
      <div className="mt-auto flex items-end justify-between gap-2 pt-3 text-xs">
        <span className="min-w-0 truncate text-zinc-400">{(p.kinds || []).map((k) => KIND_LABELS[k] || k).slice(0, 3).join(' · ') || 'Read-only'}</span>
        <span className="shrink-0 font-medium text-emerald-600 group-hover:underline">Open</span>
      </div>
    </Link>
  );
}

/** Shimmering stand-ins in the real shape — never a bare spinner or a blank screen. */
function LoadingState() {
  return (
    <div className="space-y-4" data-testid="social-loading">
      <CreditStrip balance={null} spentToday={0} ceiling={null} loading />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-full sm:w-64" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <Skeleton className="mt-3 h-4 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default Social;
