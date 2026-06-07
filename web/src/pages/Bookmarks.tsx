import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, Search, RefreshCw, ExternalLink, Eye, Youtube, Link2 } from 'lucide-react';
import { DataTable, Column, Filter } from '../ui/DataTable';
import { StoreBadges } from '../ui/StoreBadges';
import { useToast } from '../ui/Toast';

type BM = {
  id: string;
  title: string;
  sourceUrl: string | null;
  summary: string | null;
  tags: string[];
  readFailed: boolean;
  createdAt: string;
  supermemory: boolean;
  rag: boolean;
  chunked: boolean;
};

const isYouTube = (u: string | null) => !!u && /youtube\.com|youtu\.be/.test(u);

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (d.toDateString() === new Date().toDateString()) return 'today';
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function Chip({ t }: { t: string }) {
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
      {t}
    </span>
  );
}

function Card({ b, onOpen }: { b: BM; onOpen: (id: string) => void }) {
  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-emerald-600 transition-colors';
  const yt = isYouTube(b.sourceUrl);
  const Icon = yt ? Youtube : Link2;
  const chip = yt ? 'text-red-500 bg-red-500/10' : 'text-emerald-500 bg-emerald-500/10';
  const date = shortDate(b.createdAt);
  return (
    <div className="group h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-emerald-500/40 hover:shadow-md transition-all flex flex-col">
      {/* Title row — source chip + title (links to original) + meta line (matches the document card) */}
      <div className="flex items-start gap-3">
        <div className={'shrink-0 rounded-lg p-2 ' + chip}>
          <Icon size={18} />
        </div>
        <a href={b.sourceUrl || '#'} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
          <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600">{b.title}</h3>
          <p className="mt-0.5 text-xs text-zinc-400">
            {yt ? 'YouTube' : 'Link'}
            {date && <> · {date}</>}
            {b.readFailed && <> · <span className="text-amber-600">couldn't read</span></>}
          </p>
        </a>
      </div>

      {b.summary && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400 line-clamp-3">{b.summary}</p>}

      {b.tags?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {b.tags.slice(0, 3).map((t) => <Chip key={t} t={t} />)}
          {b.tags.length > 3 && <Chip t={`+${b.tags.length - 3}`} />}
        </div>
      )}

      <div className="mt-auto pt-3 border-t border-zinc-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-y-2 gap-x-2">
        <StoreBadges supermemory={b.supermemory} rag={b.rag} chunked={b.chunked} />
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => onOpen(b.id)} title="Open summary in app" className={iconBtn}>
            <Eye size={16} />
          </button>
          <a href={b.sourceUrl || '#'} target="_blank" rel="noreferrer" title="Open original link" className={iconBtn}>
            <ExternalLink size={16} />
          </a>
        </div>
      </div>
    </div>
  );
}

export function Bookmarks() {
  const [items, setItems] = useState<BM[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ lastSync: string | null; count: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ imported: number; total: number } | null>(null);
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [results, setResults] = useState<BM[] | null>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const onOpen = (id: string) => navigate(`/doc/${id}`);

  async function load() {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([fetch('/api/bookmarks'), fetch('/api/bookmarks/status')]);
      if (r1.ok) setItems((await r1.json()).items || []);
      if (r2.ok) setStatus(await r2.json());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  // If a sync is already running (e.g. page reopened), resume showing live progress.
  useEffect(() => {
    (async () => {
      const r = await fetch('/api/bookmarks/status');
      if (!r.ok) return;
      const s = await r.json();
      if (s.running && !syncing) {
        setSyncing(true);
        setProgress({ imported: s.imported || 0, total: s.total || 0 });
        const final = await pollUntilDone();
        setSyncing(false);
        setProgress(null);
        await load();
        if (final) toast('success', `Done — ${final.imported} bookmark${final.imported === 1 ? '' : 's'} summarized`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll status every 3s until the background job finishes; returns the final status.
  async function pollUntilDone(): Promise<{ imported: number; flagged: number } | null> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const r = await fetch('/api/bookmarks/status');
      if (!r.ok) return null;
      const s = await r.json();
      setProgress({ imported: s.imported || 0, total: s.total || 0 });
      if (!s.running) return s;
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const r = await fetch('/api/bookmarks/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('error', d.message || 'Sync failed');
        return;
      }
      if (d.total === 0) {
        toast('success', 'Already up to date — no new bookmarks to pull.');
        await load();
        return;
      }
      toast('success', `Reading ${d.total} bookmark${d.total === 1 ? '' : 's'} in the background…`);
      setProgress({ imported: 0, total: d.total });
      const final = await pollUntilDone();
      await load();
      if (final) {
        const flagged = final.flagged ? ` · ${final.flagged} couldn't be read` : '';
        toast('success', `Done — ${final.imported} bookmark${final.imported === 1 ? '' : 's'} summarized${flagged}`);
      }
    } catch {
      toast('error', 'Sync failed');
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setAsking(true);
    try {
      const r = await fetch(`/api/bookmarks/search?q=${encodeURIComponent(q.trim())}`);
      const d = await r.json().catch(() => ({ items: [] }));
      setResults(d.items || []);
    } catch {
      toast('error', 'Search failed');
      setResults([]);
    } finally {
      setAsking(false);
    }
  }

  const allTags = useMemo(() => Array.from(new Set(items.flatMap((i) => i.tags || []))).sort(), [items]);
  const cols: Column<BM>[] = [
    { key: 'title', label: 'Title' },
    { key: 'summary', label: 'Summary' },
  ];
  const filters: Filter[] = allTags.length
    ? [{ key: 'tags', label: 'Tag', options: allTags.map((t) => ({ value: t, label: t })), match: (row: BM, val: string) => (row.tags || []).includes(val) }]
    : [];

  const btn = 'inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2">
            <Bookmark className="text-emerald-600" /> Bookmarks
          </h1>
          <p className="text-zinc-500 text-sm">Ask in plain English — your saved links, found by meaning.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-400 whitespace-nowrap">
            {status?.count ? `${status.count} saved` : ''}
            {status?.lastSync ? ` · synced ${shortDate(status.lastSync)}` : ''}
          </span>
          <button onClick={sync} disabled={syncing} className={btn}>
            <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />{' '}
            {progress ? `Syncing… ${progress.imported}/${progress.total}` : syncing ? 'Starting…' : 'Sync last 3 months'}
          </button>
        </div>
      </div>

      <form onSubmit={ask} className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. cloud SEO skills I saved"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-sm outline-none focus:border-emerald-500"
          />
        </div>
        <button type="submit" disabled={asking} className={btn}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
        {results !== null && (
          <button type="button" onClick={() => { setResults(null); setQ(''); }} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm">
            Clear
          </button>
        )}
      </form>

      {results !== null ? (
        <div>
          <div className="text-sm text-zinc-500 mb-2">
            {results.length} match{results.length === 1 ? '' : 'es'} for “{q}”
          </div>
          {results.length === 0 ? (
            <div className="py-10 text-center text-zinc-400">No matches — try different words, or Sync more bookmarks.</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {results.map((b) => <Card key={b.id} b={b} onOpen={onOpen} />)}
            </div>
          )}
        </div>
      ) : (
        <DataTable<BM>
          columns={cols}
          rows={items}
          loading={loading}
          filters={filters}
          renderCard={(b) => <Card b={b} onOpen={onOpen} />}
          cardsOnly
          pageSize={12}
          emptyText={
            status?.count
              ? 'No bookmarks match.'
              : 'No bookmarks yet — connect Raindrop in Settings, then tap “Sync last 3 months”.'
          }
        />
      )}
    </div>
  );
}
