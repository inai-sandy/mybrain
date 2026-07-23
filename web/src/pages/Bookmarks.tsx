import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, Search, RefreshCw, ExternalLink, Eye, Youtube, Link2, Share2, Play, LayoutGrid, List, FolderPlus, X, Trash2, Plus, Loader2 } from 'lucide-react';
import { DataTable, Column } from '../ui/DataTable';
import { FOLDER_ICON_NAMES, FOLDER_ICONS, DEFAULT_FOLDER_ICON, FolderGlyph } from '../ui/folderIcons';
import { StoreBadges } from '../ui/StoreBadges';
import { useToast } from '../ui/Toast';
import { ShareDialog } from '../ui/ShareDialog';

type BM = {
  id: string;
  title: string;
  sourceUrl: string | null;
  summary: string | null;
  tags: string[];
  readFailed: boolean;
  createdAt: string;
  thumbnail: string | null;
  supermemory: boolean;
  rag: boolean;
  chunked: boolean;
  shared: boolean;
  folderId?: string | null;
};

type Folder = { id: string; name: string; color: string | null; icon?: string | null; count: number };

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

/** Per-bookmark folder picker. (BEA-612) */
function FolderMenu({ b, folders, onAssign }: { b: BM; folders: Folder[]; onAssign: (id: string, folderId: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const cur = folders.find((f) => f.id === b.folderId) || null;
  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} title={cur ? `Folder: ${cur.name}` : 'Add to folder'} className={iconBtn + (cur ? ' text-emerald-600' : ' hover:text-emerald-600')}>
        <FolderGlyph name={cur?.icon || 'Folder'} size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-48 max-h-64 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-1 shadow-xl">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">Move to folder</div>
            {folders.length === 0 && <div className="px-2 py-1.5 text-xs text-zinc-400">No folders yet — use “Manage folders”.</div>}
            {folders.map((f) => (
              <button key={f.id} onClick={() => { onAssign(b.id, f.id); setOpen(false); }} className={'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (b.folderId === f.id ? 'text-emerald-600' : '')}>
                <FolderGlyph name={f.icon} size={14} /> <span className="truncate">{f.name}</span>
              </button>
            ))}
            {b.folderId && <button onClick={() => { onAssign(b.id, null); setOpen(false); }} className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"><X size={13} /> Remove from folder</button>}
          </div>
        </>
      )}
    </div>
  );
}

function Card({ b, onOpen, onShare, folders, onAssign }: { b: BM; onOpen: (id: string) => void; onShare: (b: BM) => void; folders: Folder[]; onAssign: (id: string, folderId: string | null) => void }) {
  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-emerald-600 transition-colors';
  const yt = isYouTube(b.sourceUrl);
  const Icon = yt ? Youtube : Link2;
  const chip = yt ? 'text-red-500 bg-red-500/10' : 'text-emerald-500 bg-emerald-500/10';
  const date = shortDate(b.createdAt);
  return (
    <div className="group h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-emerald-500/40 hover:shadow-md transition-all flex flex-col">
      {b.thumbnail && (
        <button onClick={() => onOpen(b.id)} title="Open in app" className="relative mb-3 block w-full rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800 aspect-video">
          <img
            src={b.thumbnail}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={(e) => {
              const p = e.currentTarget.parentElement as HTMLElement | null;
              if (p) p.style.display = 'none';
            }}
          />
          {yt && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-black/60 p-2.5">
                <Play size={20} className="text-white fill-white" />
              </span>
            </span>
          )}
        </button>
      )}
      {/* Title row — source chip + title (opens the in-app page) + meta line (matches the document card) */}
      <div className="flex items-start gap-3">
        <div className={'shrink-0 rounded-lg p-2 ' + chip}>
          <Icon size={18} />
        </div>
        <button onClick={() => onOpen(b.id)} title="Open in app" className="min-w-0 flex-1 text-left">
          <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600">{b.title}</h3>
          <p className="mt-0.5 text-xs text-zinc-400">
            {yt ? 'YouTube' : 'Link'}
            {date && <> · {date}</>}
            {b.readFailed && <> · <span className="text-amber-600">couldn't read</span></>}
          </p>
        </button>
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
          <FolderMenu b={b} folders={folders} onAssign={onAssign} />
          <button onClick={() => onShare(b)} title="Share" className={iconBtn + (b.shared ? ' text-emerald-600' : '')}>
            <Share2 size={16} />
          </button>
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

function Row({ b, onOpen, onShare, folders, onAssign }: { b: BM; onOpen: (id: string) => void; onShare: (b: BM) => void; folders: Folder[]; onAssign: (id: string, folderId: string | null) => void }) {
  const yt = isYouTube(b.sourceUrl);
  const Icon = yt ? Youtube : Link2;
  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-emerald-600 transition-colors';
  return (
    <div className="group flex gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 hover:border-emerald-500/40 transition-all">
      <button onClick={() => onOpen(b.id)} title="Open in app" className="relative shrink-0 w-24 sm:w-28 aspect-video rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
        {b.thumbnail ? (
          <img src={b.thumbnail} alt="" loading="lazy" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        ) : (
          <Icon size={18} className="text-zinc-400" />
        )}
        {yt && b.thumbnail && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/60 p-1.5"><Play size={13} className="text-white fill-white" /></span>
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1 flex flex-col">
        <div className="flex items-start gap-2">
          <button onClick={() => onOpen(b.id)} title="Open in app" className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold text-sm leading-snug line-clamp-1 group-hover:text-emerald-600">{b.title}</h3>
          </button>
          <div className="flex items-center gap-0.5 shrink-0">
            <FolderMenu b={b} folders={folders} onAssign={onAssign} />
            <button onClick={() => onShare(b)} title="Share" className={iconBtn + (b.shared ? ' text-emerald-600' : '')}><Share2 size={15} /></button>
            <button onClick={() => onOpen(b.id)} title="Open in app" className={iconBtn}><Eye size={15} /></button>
            <a href={b.sourceUrl || '#'} target="_blank" rel="noreferrer" title="Open original" className={iconBtn}><ExternalLink size={15} /></a>
          </div>
        </div>
        {b.summary && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 line-clamp-1">{b.summary}</p>}
        <div className="mt-auto pt-1.5 flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {b.tags.slice(0, 3).map((t) => <Chip key={t} t={t} />)}
            {b.readFailed && <span className="text-[10px] text-amber-600">· couldn't read</span>}
          </div>
          <StoreBadges supermemory={b.supermemory} rag={b.rag} chunked={b.chunked} />
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
  const [sharing, setSharing] = useState<BM | null>(null);
  const onShare = (b: BM) => setSharing(b);
  const [view, setView] = useState<'grid' | 'list'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('bm.view') === 'grid' ? 'grid' : 'list'));
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>('all'); // all | others | <folderId>
  const [tagFilter, setTagFilter] = useState('');
  const [managing, setManaging] = useState(false);
  const [addingLink, setAddingLink] = useState(false); // BEA-1050
  function changeView(v: 'grid' | 'list') {
    setView(v);
    try {
      localStorage.setItem('bm.view', v);
    } catch {
      /* ignore */
    }
  }
  const renderItem = (b: BM) => (view === 'list' ? <Row b={b} onOpen={onOpen} onShare={onShare} folders={folders} onAssign={assignFolder} /> : <Card b={b} onOpen={onOpen} onShare={onShare} folders={folders} onAssign={assignFolder} />);
  const gridCls = view === 'list' ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2';

  async function load() {
    // NOTE: no setLoading(true) on refresh — keep current content on screen so scroll position survives
    try {
      const [r1, r2, r3] = await Promise.all([fetch('/api/bookmarks'), fetch('/api/bookmarks/status'), fetch('/api/bookmarks/folders')]);
      if (r1.ok) setItems((await r1.json()).items || []);
      if (r2.ok) setStatus(await r2.json());
      if (r3.ok) setFolders((await r3.json()).folders || []);
    } finally {
      setLoading(false);
    }
  }
  async function reloadFolders() {
    const r = await fetch('/api/bookmarks/folders');
    if (r.ok) setFolders((await r.json()).folders || []);
  }
  async function assignFolder(id: string, folderId: string | null) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, folderId } : x))); // optimistic
    await fetch('/api/bookmarks/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], folderId }) }).catch(() => undefined);
    reloadFolders();
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
  const othersCount = items.filter((i) => !i.folderId).length;
  const shown = (activeFolder === 'all' ? items : activeFolder === 'others' ? items.filter((i) => !i.folderId) : items.filter((i) => i.folderId === activeFolder)).filter((i) => !tagFilter || (i.tags || []).includes(tagFilter));

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
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden shrink-0">
            <button onClick={() => changeView('grid')} title="Grid view" className={'p-2 ' + (view === 'grid' ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')}>
              <LayoutGrid size={16} />
            </button>
            <button onClick={() => changeView('list')} title="List view" className={'p-2 ' + (view === 'list' ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')}>
              <List size={16} />
            </button>
          </div>
          <span className="hidden md:inline text-xs text-zinc-400 whitespace-nowrap">
            {status?.count ? `${status.count} saved` : ''}
            {status?.lastSync ? ` · synced ${shortDate(status.lastSync)}` : ''}
          </span>
          <button onClick={sync} disabled={syncing} className={btn + ' flex-1 sm:flex-none justify-center min-w-0'}>
            <RefreshCw size={16} className={(syncing ? 'animate-spin ' : '') + 'shrink-0'} />
            {progress ? (
              <span className="truncate">Syncing… {progress.imported}/{progress.total}</span>
            ) : syncing ? (
              <span className="truncate">Starting…</span>
            ) : (
              <>
                <span className="sm:hidden">Sync</span>
                <span className="hidden sm:inline">Sync last 3 months</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* One controls row: Search · Folder · Manage · Tag (BEA-614) */}
      <form onSubmit={ask} className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. cloud SEO skills I saved"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-sm outline-none focus:border-emerald-500"
          />
        </div>
        <button type="submit" disabled={asking} className={btn + ' shrink-0'}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
        {results !== null && (
          <button type="button" onClick={() => { setResults(null); setQ(''); }} className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm">
            Clear
          </button>
        )}
        <select aria-label="Folder" value={activeFolder} onChange={(e) => setActiveFolder(e.target.value)} className="shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm outline-none focus:border-emerald-500 max-w-[12rem]">
          <option value="all">📁 All ({items.length})</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.count})</option>)}
          <option value="others">Others / unfiled ({othersCount})</option>
        </select>
        <button type="button" onClick={() => setManaging(true)} title="Manage folders" className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-2 text-sm text-zinc-500 hover:text-emerald-600 inline-flex items-center gap-1"><FolderPlus size={15} /></button>
        {allTags.length > 0 && (
          <select aria-label="Filter by tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm outline-none focus:border-emerald-500 max-w-[9rem]">
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
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
            <div className={gridCls}>
              {results.map((b) => <div key={b.id}>{renderItem(b)}</div>)}
            </div>
          )}
        </div>
      ) : (
        <DataTable<BM>
          columns={cols}
          rows={shown}
          loading={loading}
          filters={[]}
          renderCard={(b) => renderItem(b)}
          gridClassName={gridCls}
          cardsOnly
          pageSize={12}
          emptyText={
            status?.count
              ? 'No bookmarks match.'
              : 'No bookmarks yet — connect Raindrop in Settings, then tap “Sync last 3 months”.'
          }
        />
      )}

      {/* Save any URL by hand — Raindrop stops being the only door in. (BEA-1050) */}
      <button onClick={() => setAddingLink(true)} className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-emerald-500 md:bottom-8 md:right-8">
        <Plus className="h-4 w-4" /> Add link
      </button>
      {addingLink && <AddLinkModal onClose={() => setAddingLink(false)} onSaved={() => { setAddingLink(false); load(); }} />}

      {sharing && (
        <ShareDialog
          id={sharing.id}
          title={sharing.title}
          initialShared={sharing.shared}
          onClose={() => setSharing(null)}
          onChanged={() => load()}
        />
      )}
      {managing && <ManageBookmarkFolders folders={folders} onClose={() => setManaging(false)} onChanged={reloadFolders} />}
    </div>
  );
}

/** Paste a URL, we read + summarize + index it like a synced bookmark. (BEA-1050) */
function AddLinkModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/bookmarks/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim(), note: note.trim() || undefined }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('error', d.message || 'Could not save that link');
        return;
      }
      toast('success', `Saved and summarized — “${d.title || url.trim()}”`);
      onSaved();
    } catch {
      toast('error', 'Could not save that link');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold">Add a link</h3>
          <button onClick={onClose} disabled={busy} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-50"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} autoFocus placeholder="https://…" inputMode="url"
            className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why you're saving it (optional)"
            className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500 resize-none" />
          <button onClick={save} disabled={!url.trim() || busy} className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2.5 text-sm font-medium disabled:opacity-50">
            {busy ? (<><Loader2 size={15} className="animate-spin" /> Reading the page…</>) : 'Save to Bookmarks'}
          </button>
          {busy && <p className="text-center text-xs text-zinc-400">The AI is reading and summarizing it — usually under half a minute.</p>}
        </div>
      </div>
    </div>
  );
}

/** Pick a folder icon — a small centered modal (can't be clipped). */
function IconPicker({ value, onPick }: { value?: string | null; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Choose icon" className="shrink-0 p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><FolderGlyph name={value} size={18} /></button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className="w-full max-w-xs rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h4 className="text-sm font-semibold">Choose an icon</h4><button onClick={() => setOpen(false)} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={16} /></button></div>
            <div className="grid grid-cols-6 gap-1.5 max-h-64 overflow-y-auto">
              {FOLDER_ICON_NAMES.map((n) => {
                const Ic = FOLDER_ICONS[n];
                return <button key={n} type="button" onClick={() => { onPick(n); setOpen(false); }} className={'grid aspect-square place-items-center rounded-md hover:bg-emerald-500/10 ' + (value === n ? 'bg-emerald-500/15 text-emerald-600' : 'text-zinc-500')}><Ic size={18} /></button>;
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Create / rename / delete bookmark folders. (BEA-612) */
function ManageBookmarkFolders({ folders, onClose, onChanged }: { folders: Folder[]; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<Folder[]>(folders);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState<string>(DEFAULT_FOLDER_ICON);
  const toast = useToast();
  async function reload() {
    const r = await fetch('/api/bookmarks/folders');
    if (r.ok) setList((await r.json()).folders || []);
    onChanged();
  }
  async function create() {
    if (!newName.trim()) return;
    const r = await fetch('/api/bookmarks/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim(), icon: newIcon }) });
    if (r.ok) { setNewName(''); setNewIcon(DEFAULT_FOLDER_ICON); reload(); } else toast('error', 'Could not create');
  }
  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/bookmarks/folders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    reload();
  }
  async function remove(id: string) {
    await fetch(`/api/bookmarks/folders/${id}`, { method: 'DELETE' });
    toast('success', 'Folder removed (bookmarks kept)');
    reload();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3"><h3 className="font-bold">Bookmark folders</h3><button onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button></div>
        <div className="flex gap-2 mb-4">
          <IconPicker value={newIcon} onPick={setNewIcon} />
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="New folder name" className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          <button onClick={create} disabled={!newName.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 text-sm disabled:opacity-50">Add</button>
        </div>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {list.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No folders yet.</p>}
          {list.map((f) => (
            <div key={f.id} className="flex items-center gap-2">
              <IconPicker value={f.icon} onPick={(icon) => patch(f.id, { icon })} />
              <input defaultValue={f.name} onBlur={(e) => e.target.value.trim() && e.target.value !== f.name && patch(f.id, { name: e.target.value.trim() })} className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-emerald-500" />
              <span className="text-xs text-zinc-400 w-8 text-right">{f.count}</span>
              <button onClick={() => remove(f.id)} title="Delete" className="p-1.5 rounded-md text-zinc-400 hover:text-rose-500"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
