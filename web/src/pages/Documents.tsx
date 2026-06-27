import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Plus, Eye, Download, Share2, Trash2, Pencil, X, Sparkles, Upload, Link2, Search, Brain, LayoutGrid, List, ArrowLeft, FolderPlus, Folder } from 'lucide-react';
import { FOLDER_ICON_NAMES, DEFAULT_FOLDER_ICON, FOLDER_ICONS, FolderGlyph } from '../ui/folderIcons';
import { KindBadge } from '../ui/kindBadge';
import { DataTable, Column } from '../ui/DataTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DocumentShareDialog } from '../ui/DocumentShareDialog';
import { MarkdownEditor } from '../ui/MarkdownEditor';
import { useToast } from '../ui/Toast';

// TipTap is heavy — load the WYSIWYG editor on demand so it stays out of the main bundle. (BEA-556)
const RichTextEditor = lazy(() => import('../ui/RichTextEditor').then((m) => ({ default: m.RichTextEditor })));

export type DocItem = {
  id: string;
  slug: string;
  shortCode?: string | null;
  title: string;
  description: string | null;
  kind: string;
  tags: string[];
  collectionId: string | null;
  shared: boolean;
  hasPassword?: boolean;
  expiresAt?: string | null;
  viewCount?: number;
  siteEntry?: string | null;
  bytes: number | null;
  snippet?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Collection = { id: string; name: string; color: string | null; icon?: string | null; count: number };

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === new Date().toDateString()) return 'today';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function Chip({ t }: { t: string }) {
  return <span className="shrink-0 whitespace-nowrap text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">{t}</span>;
}

export function Documents() {
  const [items, setItems] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [del, setDel] = useState<DocItem | null>(null);
  const [sharing, setSharing] = useState<DocItem | null>(null);
  const [editing, setEditing] = useState<DocItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [managing, setManaging] = useState(false);
  const [results, setResults] = useState<DocItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDel, setBulkDel] = useState(false);
  const [view, setView] = useState<'cards' | 'list'>(() => (localStorage.getItem('docsView') === 'list' ? 'list' : 'cards'));
  const [tagFilter, setTagFilter] = useState('');
  const [sortKey, setSortKey] = useState('updatedAt:-1');
  const [addOpen, setAddOpen] = useState(false);

  // Folder + search live in the URL so Back / refresh / deep-link restore where you were. (BEA-592)
  const [params, setParams] = useSearchParams();
  const openFolder = params.get('folder'); // null = folder grid; 'others' = uncategorised; else collection id
  const q = params.get('q') ?? '';
  const searching = q.trim().length >= 2;

  function setQ(v: string) {
    // Search updates with replace so typing doesn't pile up history entries.
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set('q', v);
        else n.delete('q');
        return n;
      },
      { replace: true },
    );
  }
  function setOpenFolder(v: string | null, replace = false) {
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set('folder', v);
        else n.delete('folder');
        n.delete('q'); // entering/leaving a folder clears any active search
        return n;
      },
      { replace },
    );
  }

  function changeView(v: 'cards' | 'list') {
    setView(v);
    localStorage.setItem('docsView', v);
  }
  const fileInput = useRef<HTMLInputElement>(null);

  function toggleSel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function clearSel() {
    setSelected(new Set());
  }
  async function bulk(path: string, extra: Record<string, unknown> = {}) {
    const ids = [...selected];
    if (!ids.length) return;
    const r = await fetch(`/api/documents/bulk/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, ...extra }) });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      toast('success', `${d.count ?? ids.length} updated`);
      clearSel();
      load();
    } else toast('error', 'Could not update');
  }
  async function exportZip() {
    const ids = [...selected];
    const r = await fetch('/api/documents/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    if (!r.ok) {
      toast('error', 'Export failed');
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `documents-${ids.length}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function bulkRemove() {
    setBulkDel(false);
    await bulk('delete');
  }
  async function bulkToMemory() {
    const ids = [...selected];
    if (!ids.length) return;
    let ok = 0;
    for (const id of ids) {
      const r = await fetch(`/api/documents/${id}/convert`, { method: 'POST' }).catch(() => null);
      if (r?.ok) ok++;
    }
    toast(ok ? 'success' : 'error', ok ? `${ok} added to memory` : 'Could not add (images have no text)');
    clearSel();
  }
  const toast = useToast();
  const navigate = useNavigate();

  async function load() {
    const [d, c] = await Promise.all([
      fetch('/api/documents').then((r) => (r.ok ? r.json() : { documents: [] })),
      fetch('/api/documents/collections').then((r) => (r.ok ? r.json() : { collections: [] })),
    ]);
    setItems(d.documents || []);
    setCollections(c.collections || []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!searching) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`/api/documents/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json())
        .then((d) => setResults(d.documents || []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, searching]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/documents/upload', { method: 'POST', body: fd }).catch(() => null);
      if (r?.ok) ok++;
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    toast(ok ? 'success' : 'error', ok ? `Uploaded ${ok} file${ok > 1 ? 's' : ''}` : 'Upload failed');
    load();
  }

  async function remove(it: DocItem) {
    setDel(null);
    const r = await fetch(`/api/documents/${it.id}`, { method: 'DELETE' });
    if (r.ok) {
      toast('success', 'Deleted');
      load();
    } else toast('error', 'Could not delete');
  }

  const allTags = Array.from(new Set(items.flatMap((i) => i.tags || []))).sort();
  const cols: Column<DocItem>[] = [
    { key: 'title', label: 'Title' },
    { key: 'description', label: 'Description' },
  ];
  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';

  function card(r: DocItem) {
    return (
      <div className={'group relative h-full rounded-xl border bg-white dark:bg-zinc-900 p-4 hover:shadow-md transition-all flex flex-col ' + (selected.has(r.id) ? 'border-emerald-500 ring-1 ring-emerald-500/40' : 'border-zinc-200 dark:border-zinc-800 hover:border-emerald-500/40')}>
        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} onClick={(e) => e.stopPropagation()} title="Select" className={'absolute top-3 right-3 z-10 h-4 w-4 accent-emerald-600 ' + (selected.size ? '' : 'opacity-0 group-hover:opacity-100 transition-opacity')} />
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg p-2 text-emerald-500 bg-emerald-500/10"><FileText size={18} /></div>
          <button onClick={() => navigate(`/documents/${r.id}`)} className="min-w-0 flex-1 text-left pr-6">
            <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600">{r.title}</h3>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400">
              <KindBadge kind={r.kind} />
              <span className="truncate">{shortDate(r.updatedAt)}{r.shared && ' · shared'}{r.shared && (r.viewCount ?? 0) > 0 ? ` · ${r.viewCount} views` : ''}</span>
            </p>
          </button>
        </div>
        {r.description && <p className="mt-2 text-xs text-zinc-500 line-clamp-2">{r.description}</p>}
        {r.snippet && <p className="mt-1.5 text-xs text-zinc-400 italic line-clamp-2 border-l-2 border-emerald-500/40 pl-2">{r.snippet}</p>}
        {r.tags?.length > 0 && (
          <div className="mt-3 flex flex-nowrap items-center gap-1.5 overflow-hidden">
            {r.tags.slice(0, 4).map((t) => <Chip key={t} t={t} />)}
            {r.tags.length > 4 && <Chip t={`+${r.tags.length - 4}`} />}
          </div>
        )}
        <div className="mt-auto pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-end gap-0.5">
          <button onClick={() => navigate(`/documents/${r.id}`)} title="Open" className={iconBtn + ' hover:text-emerald-600'}><Eye size={16} /></button>
          <a href={`/api/documents/${r.id}/download`} title="Download" className={iconBtn + ' hover:text-emerald-600'}><Download size={16} /></a>
          <button onClick={() => setEditing(r)} title="Edit" className={iconBtn + ' hover:text-emerald-600'}><Pencil size={16} /></button>
          <button onClick={() => setSharing(r)} title="Share" className={iconBtn + ' hover:text-emerald-600'}><Share2 size={16} /></button>
          <button onClick={() => setDel(r)} title="Delete" className={iconBtn + ' hover:text-red-500'}><Trash2 size={16} /></button>
        </div>
      </div>
    );
  }

  /** 3-line bookmarks-style row (List view): title / meta / tags, tick on the right. (BEA-583/589) */
  function row(r: DocItem) {
    return (
      <div className={'group flex items-start gap-2.5 rounded-xl border bg-white dark:bg-zinc-900 px-3 py-2.5 transition-all ' + (selected.has(r.id) ? 'border-emerald-500 ring-1 ring-emerald-500/40' : 'border-zinc-200 dark:border-zinc-800 hover:border-emerald-500/40 hover:shadow-sm')}>
        <div className="shrink-0 mt-0.5 rounded-lg p-1.5 text-emerald-500 bg-emerald-500/10"><FileText size={16} /></div>
        <button onClick={() => navigate(`/documents/${r.id}`)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold leading-tight truncate group-hover:text-emerald-600">{r.title}</h3>
            {r.shared && <span className="shrink-0 text-[10px] text-emerald-600">shared</span>}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-400">
            <KindBadge kind={r.kind} />
            <span className="truncate">{shortDate(r.updatedAt)}{r.shared && (r.viewCount ?? 0) > 0 ? ` · ${r.viewCount} views` : ''}{r.description ? ` · ${r.description}` : ''}</span>
          </p>
          <div className="mt-1 flex flex-nowrap items-center gap-1.5 h-[18px] overflow-hidden">
            {r.tags?.length ? (
              <>
                {r.tags.slice(0, 4).map((t) => <Chip key={t} t={t} />)}
                {r.tags.length > 4 && <Chip t={`+${r.tags.length - 4}`} />}
              </>
            ) : (
              <span className="text-[10px] text-zinc-300 dark:text-zinc-600">no tags</span>
            )}
          </div>
        </button>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} onClick={(e) => e.stopPropagation()} title="Select" className={'h-4 w-4 accent-emerald-600 ' + (selected.size ? '' : 'opacity-0 group-hover:opacity-100 transition-opacity')} />
          <div className="flex items-center gap-0.5">
            <button onClick={() => navigate(`/documents/${r.id}`)} title="Open" className={iconBtn + ' hover:text-emerald-600'}><Eye size={16} /></button>
            <a href={`/api/documents/${r.id}/download`} title="Download" className={iconBtn + ' hidden sm:inline-flex hover:text-emerald-600'}><Download size={16} /></a>
            <button onClick={() => setEditing(r)} title="Edit" className={iconBtn + ' hidden sm:inline-flex hover:text-emerald-600'}><Pencil size={16} /></button>
            <button onClick={() => setSharing(r)} title="Share" className={iconBtn + ' hover:text-emerald-600'}><Share2 size={16} /></button>
            <button onClick={() => setDel(r)} title="Delete" className={iconBtn + ' hover:text-red-500'}><Trash2 size={16} /></button>
          </div>
        </div>
      </div>
    );
  }

  const currentFolder = collections.find((c) => c.id === openFolder) || null;
  const othersCount = items.filter((i) => !i.collectionId).length;
  const folderRows = openFolder === 'others' ? items.filter((i) => !i.collectionId) : items.filter((i) => i.collectionId === openFolder);

  const viewToggle = (
    <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 p-0.5">
      <button onClick={() => changeView('cards')} title="Card view" aria-label="Card view" className={'p-1.5 rounded-md transition-colors ' + (view === 'cards' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200')}><LayoutGrid size={15} /></button>
      <button onClick={() => changeView('list')} title="List view" aria-label="List view" className={'p-1.5 rounded-md transition-colors ' + (view === 'list' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200')}><List size={15} /></button>
    </div>
  );

  // Tag filter + sort are owned by the unified controls row (so they share one line). (BEA-589)
  function applyControls(rows: DocItem[]): DocItem[] {
    let r = rows;
    if (tagFilter) r = r.filter((d) => (d.tags || []).includes(tagFilter));
    const [key, dir] = sortKey.split(':');
    const d = Number(dir) as 1 | -1;
    r = [...r].sort((a, b) => {
      const av = key === 'title' ? a.title.toLowerCase() : a.updatedAt;
      const bv = key === 'title' ? b.title.toLowerCase() : b.updatedAt;
      return (av > bv ? 1 : av < bv ? -1 : 0) * d;
    });
    return r;
  }

  function filesView(rows: DocItem[], mode: 'search' | 'folder') {
    return (
      <DataTable<DocItem>
        columns={cols}
        rows={applyControls(rows)}
        loading={loading}
        filters={[]}
        sortOptions={[]}
        searchable={false}
        renderCard={view === 'list' ? row : card}
        cardsOnly
        gridClassName={view === 'list' ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2'}
        pageSize={12}
        emptyText={mode === 'search' ? `No documents match "${q.trim()}".` : 'No documents in this folder yet — hit New Document to add one.'}
      />
    );
  }

  function folderTile(key: string, glyph: ReactNode, name: string, count: number, onClick: () => void) {
    return (
      <button key={key} onClick={onClick} className="group rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 text-left hover:border-emerald-500/50 hover:shadow-md transition-all">
        <div className="flex items-center justify-between">
          {glyph}
          <span className="text-xs text-zinc-400">{count}</span>
        </div>
        <p className="mt-3 font-semibold leading-tight truncate group-hover:text-emerald-600">{name}</p>
      </button>
    );
  }

  function foldersGrid() {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {collections.map((c) =>
          folderTile(
            c.id,
            <div className="rounded-lg p-2 bg-emerald-500/10 text-emerald-600" style={c.color ? { color: c.color } : undefined}><FolderGlyph name={c.icon} /></div>,
            c.name,
            c.count,
            () => setOpenFolder(c.id),
          ),
        )}
        {folderTile(
          '__others__',
          <div className="rounded-lg p-2 bg-zinc-500/10 text-zinc-500"><Folder size={22} /></div>,
          'Others',
          othersCount,
          () => setOpenFolder('others'),
        )}
        <button onClick={() => setManaging(true)} className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 grid place-items-center text-zinc-400 hover:text-emerald-600 hover:border-emerald-500/50 transition-colors min-h-[112px]">
          <span className="flex flex-col items-center gap-1 text-sm"><FolderPlus size={20} /> New folder</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header — title/subtitle hidden on phones (BEA-589); actions collapse to a + menu on phones. */}
      <div className="flex items-center justify-between gap-3">
        <div className="hidden sm:block">
          <h1 className="text-xl font-bold flex items-center gap-2"><FileText size={20} className="text-emerald-600" /> Documents</h1>
          <p className="text-sm text-zinc-500">Your own files to write, share and re-use — kept out of memory unless you convert one to Capture.</p>
        </div>
        <input ref={fileInput} type="file" multiple accept=".md,.markdown,.txt,.html,.htm,.pdf,.zip,image/*,application/zip" className="hidden" onChange={(e) => upload(e.target.files)} />
        <div className="hidden sm:flex shrink-0 items-center gap-2 ml-auto">
          <button onClick={() => setImporting(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Link2 size={16} /> Import URL</button>
          <button onClick={() => fileInput.current?.click()} disabled={uploading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"><Upload size={16} /> {uploading ? 'Uploading…' : 'Upload'}</button>
          <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm font-medium"><Plus size={16} /> New Document</button>
        </div>
        {/* Mobile + menu */}
        <div className="relative sm:hidden ml-auto">
          <button onClick={() => setAddOpen((o) => !o)} aria-label="Add" className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm font-medium"><Plus size={18} /></button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} />
              <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-1 shadow-xl">
                <button onClick={() => { setAddOpen(false); setCreating(true); }} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Plus size={15} /> New document</button>
                <button onClick={() => { setAddOpen(false); fileInput.current?.click(); }} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Upload size={15} /> Upload</button>
                <button onClick={() => { setAddOpen(false); setImporting(true); }} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Link2 size={15} /> Import URL</button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Unified controls row: Search · Tags · Sort · View (BEA-589) */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 pl-9 pr-9 py-2 text-sm outline-none focus:border-emerald-500" />
          {q && <button onClick={() => setQ('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"><X size={15} /></button>}
        </div>
        {(searching || openFolder !== null) && (
          <>
            {allTags.length > 0 && (
              <select aria-label="Filter by tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2 py-2 text-sm outline-none focus:border-emerald-500 max-w-[7rem]">
                <option value="">All tags</option>
                {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            <select aria-label="Sort" value={sortKey} onChange={(e) => setSortKey(e.target.value)} className="shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2 py-2 text-sm outline-none focus:border-emerald-500">
              <option value="updatedAt:-1">Newest</option>
              <option value="updatedAt:1">Oldest</option>
              <option value="title:1">Title A–Z</option>
            </select>
            {viewToggle}
          </>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm shadow-sm">
          <span className="font-medium text-emerald-700 dark:text-emerald-300">{selected.size} selected</span>
          <div className="flex-1" />
          <select onChange={(e) => { if (e.target.value) bulk('collection', { collectionId: e.target.value === '__none__' ? null : e.target.value }); e.target.value = ''; }} className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs">
            <option value="">Move to…</option>
            <option value="__none__">No collection</option>
            {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={() => { const t = window.prompt('Add tag(s), comma separated'); if (t?.trim()) bulk('tag', { tags: t.split(',').map((x) => x.trim()).filter(Boolean) }); }} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs hover:bg-white dark:hover:bg-zinc-900">Add tag</button>
          <button onClick={() => bulk('share', { shared: true })} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs hover:bg-white dark:hover:bg-zinc-900">Share</button>
          <button onClick={exportZip} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs hover:bg-white dark:hover:bg-zinc-900"><Download size={13} /> Zip</button>
          <button onClick={bulkToMemory} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs hover:bg-white dark:hover:bg-zinc-900"><Brain size={13} /> To Memory</button>
          <button onClick={() => setBulkDel(true)} className="inline-flex items-center gap-1 rounded-lg border border-rose-300 dark:border-rose-700 text-rose-600 px-2.5 py-1 text-xs hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 size={13} /> Delete</button>
          <button onClick={clearSel} className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 px-1">Clear</button>
        </div>
      )}

      {searching ? (
        filesView(results, 'search')
      ) : openFolder === null ? (
        foldersGrid()
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button onClick={() => { setOpenFolder(null, true); clearSel(); }} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft size={15} /> Folders</button>
            <span className="text-zinc-300 dark:text-zinc-700">/</span>
            <h2 className="font-semibold flex items-center gap-1.5">
              <FolderGlyph name={openFolder === 'others' ? 'Folder' : currentFolder?.icon} size={16} className="text-emerald-600" />
              {openFolder === 'others' ? 'Others' : currentFolder?.name || 'Folder'}
            </h2>
          </div>
          {filesView(folderRows, 'folder')}
        </>
      )}

      {(creating || editing) && (
        <DocEditor
          doc={editing}
          collections={collections}
          defaultCollectionId={openFolder && openFolder !== 'others' ? openFolder : null}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
      {managing && <ManageCollections collections={collections} onClose={() => setManaging(false)} onChanged={load} />}
      <ConfirmDialog open={bulkDel} title={`Delete ${selected.size} document${selected.size === 1 ? '' : 's'}?`} message="These will be permanently removed." confirmLabel="Delete" onCancel={() => setBulkDel(false)} onConfirm={bulkRemove} />
      {importing && <ImportUrlModal onClose={() => setImporting(false)} onDone={(id) => { setImporting(false); load(); if (id) navigate(`/documents/${id}`); }} />}
      <ConfirmDialog open={!!del} title="Delete this document?" message={del ? `"${del.title}" will be permanently removed.` : ''} confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={() => del && remove(del)} />
      {sharing && <DocumentShareDialog id={sharing.id} title={sharing.title} slug={sharing.slug} shortCode={sharing.shortCode} initialShared={sharing.shared} hasPassword={sharing.hasPassword} expiresAt={sharing.expiresAt} viewCount={sharing.viewCount} onClose={() => setSharing(null)} onChanged={() => load()} />}
    </div>
  );
}

/** Create / rename / delete collections. (BEA-537) */
/** Small popover to pick a folder icon. (BEA-588) */
function IconMenu({ value, onPick }: { value?: string | null; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button type="button" onClick={() => setOpen((o) => !o)} title="Choose icon" className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><FolderGlyph name={value} size={18} /></button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 grid w-56 max-h-56 grid-cols-6 gap-1 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-2 shadow-xl">
            {FOLDER_ICON_NAMES.map((n) => {
              const Ic = FOLDER_ICONS[n];
              return (
                <button key={n} type="button" onClick={() => { onPick(n); setOpen(false); }} className={'grid place-items-center p-1.5 rounded-md hover:bg-emerald-500/10 ' + (value === n ? 'bg-emerald-500/15 text-emerald-600' : 'text-zinc-500')}><Ic size={18} /></button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ManageCollections({ collections, onClose, onChanged }: { collections: Collection[]; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<Collection[]>(collections);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState<string>(DEFAULT_FOLDER_ICON);
  const [del, setDel] = useState<Collection | null>(null);
  const toast = useToast();

  async function reload() {
    const r = await fetch('/api/documents/collections');
    if (r.ok) setList((await r.json()).collections || []);
    onChanged();
  }
  async function create() {
    if (!newName.trim()) return;
    const r = await fetch('/api/documents/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim(), icon: newIcon }) });
    if (r.ok) {
      setNewName('');
      setNewIcon(DEFAULT_FOLDER_ICON);
      reload();
    } else toast('error', 'Could not create');
  }
  async function rename(c: Collection, name: string) {
    if (!name.trim() || name === c.name) return;
    await fetch(`/api/documents/collections/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    reload();
  }
  async function changeIcon(c: Collection, icon: string) {
    await fetch(`/api/documents/collections/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ icon }) });
    reload();
  }
  async function remove(c: Collection) {
    setDel(null);
    await fetch(`/api/documents/collections/${c.id}`, { method: 'DELETE' });
    toast('success', 'Collection removed (documents kept)');
    reload();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold">Collections</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <div className="flex gap-2 mb-4">
          <IconMenu value={newIcon} onPick={setNewIcon} />
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="New folder name" className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          <button onClick={create} disabled={!newName.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 text-sm disabled:opacity-50">Add</button>
        </div>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {list.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No folders yet.</p>}
          {list.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <IconMenu value={c.icon} onPick={(icon) => changeIcon(c, icon)} />
              <input defaultValue={c.name} onBlur={(e) => rename(c, e.target.value)} className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-emerald-500" />
              <span className="text-xs text-zinc-400 w-8 text-right">{c.count}</span>
              <button onClick={() => setDel(c)} title="Delete" className="p-1.5 rounded-md text-zinc-400 hover:text-rose-500"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        <ConfirmDialog open={!!del} title="Delete this collection?" message={del ? `"${del.name}" will be removed. Its ${del.count} document${del.count === 1 ? '' : 's'} stay — they just leave the collection.` : ''} confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={() => del && remove(del)} />
      </div>
    </div>
  );
}

/** Import a document from a URL. (BEA-536) */
function ImportUrlModal({ onClose, onDone }: { onClose: () => void; onDone: (id?: string) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function go() {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/documents/import-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        toast('success', 'Imported');
        onDone(d.id);
      } else toast('error', d.message || 'Could not import that link');
    } catch {
      toast('error', 'Could not import that link');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold flex items-center gap-2"><Link2 size={18} className="text-emerald-600" /> Import from a URL</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-3">Paste a link to a page or file (md, html, pdf, image). I'll fetch it, save it, and write a description + tags.</p>
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="https://…" autoFocus className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={go} disabled={busy || !url.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">{busy ? 'Importing…' : 'Import'}</button>
        </div>
      </div>
    </div>
  );
}

/** Simple create/edit modal (title + markdown + tags). The CodeMirror editor + AI summary arrive next issue. */
export function DocEditor({ doc, collections = [], defaultCollectionId = null, onClose, onSaved }: { doc: DocItem | null; collections?: Collection[]; defaultCollectionId?: string | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(doc?.title || '');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState(doc?.description || '');
  const [tags, setTags] = useState((doc?.tags || []).join(', '));
  const [collectionId, setCollectionId] = useState<string>(doc?.collectionId || defaultCollectionId || '');
  const [richMode, setRichMode] = useState(true); // Notion-style WYSIWYG by default (BEA-556)
  const [cols, setCols] = useState<Collection[]>(collections);
  const [busy, setBusy] = useState(false);
  const [filling, setFilling] = useState(false);
  const [loaded, setLoaded] = useState(!doc);
  const toast = useToast();
  const isBinary = doc?.kind === 'pdf' || doc?.kind === 'image';

  useEffect(() => {
    if (collections.length === 0) {
      fetch('/api/documents/collections').then((r) => r.json()).then((d) => setCols(d.collections || [])).catch(() => undefined);
    }
  }, [collections.length]);

  async function newCollection() {
    const name = window.prompt('New collection name');
    if (!name?.trim()) return;
    const r = await fetch('/api/documents/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    if (r.ok) {
      const c = await r.json();
      setCols((prev) => [...prev, { id: c.id, name: c.name, color: c.color || null, count: 0 }]);
      setCollectionId(c.id);
    }
  }

  useEffect(() => {
    if (doc) {
      fetch(`/api/documents/${doc.id}`)
        .then((r) => r.json())
        .then((d) => {
          setContent(d.contentText || '');
          setDescription(d.description || '');
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [doc]);

  async function autoFill() {
    if (!content.trim()) {
      toast('error', 'Write something first');
      return;
    }
    setFilling(true);
    try {
      const r = await fetch('/api/documents/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentText: content }) });
      const d = await r.json();
      if (d.description) setDescription(d.description);
      if (Array.isArray(d.tags) && d.tags.length) setTags(d.tags.join(', '));
      toast('success', 'Filled in with AI');
    } catch {
      toast('error', 'Could not auto-fill');
    } finally {
      setFilling(false);
    }
  }

  async function save() {
    if (!title.trim()) {
      toast('error', 'Give it a title');
      return;
    }
    setBusy(true);
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    const body: Record<string, unknown> = { title: title.trim(), description: description.trim(), tags: tagList, collectionId: collectionId || null };
    if (!isBinary) body.contentText = content;
    const r = doc
      ? await fetch(`/api/documents/${doc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setBusy(false);
    if (r.ok) {
      toast('success', doc ? 'Saved' : 'Document created');
      onSaved();
    } else toast('error', 'Could not save');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-3xl max-h-[92vh] flex-col rounded-xl bg-white dark:bg-zinc-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 p-4">
          <h3 className="font-bold">{doc ? 'Edit document' : 'New document'}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-medium outline-none focus:border-emerald-500" />
          {!loaded ? (
            <p className="text-sm text-zinc-400 py-8 text-center">Loading…</p>
          ) : isBinary ? (
            <p className="text-sm text-zinc-500 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-2">This is a {doc?.kind?.toUpperCase()} file — you can edit its title, description and tags here.</p>
          ) : (
            <div className="space-y-2">
              <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 p-0.5 text-xs">
                <button type="button" onClick={() => setRichMode(true)} className={'px-2.5 py-1 rounded-md transition-colors ' + (richMode ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>Rich</button>
                <button type="button" onClick={() => setRichMode(false)} className={'px-2.5 py-1 rounded-md transition-colors ' + (!richMode ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>Markdown</button>
              </div>
              {richMode ? (
                <Suspense fallback={<div className="min-h-[360px] grid place-items-center text-sm text-zinc-400 rounded-lg border border-zinc-300 dark:border-zinc-700">Loading editor…</div>}>
                  <RichTextEditor value={content} onChange={setContent} />
                </Suspense>
              ) : (
                <MarkdownEditor value={content} onChange={setContent} />
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <label className="text-xs font-medium text-zinc-500">Description &amp; tags</label>
            {!isBinary && (
              <button type="button" onClick={autoFill} disabled={filling} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 px-2.5 py-1 text-xs hover:bg-emerald-500/10 disabled:opacity-50">
                <Sparkles size={13} /> {filling ? 'Thinking…' : 'Auto-fill with AI'}
              </button>
            )}
          </div>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description (≤200 chars — AI fills this if you leave it blank)" maxLength={200} rows={2} className="w-full resize-none rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags (comma separated)" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          <div className="flex items-center gap-2">
            <select value={collectionId} onChange={(e) => (e.target.value === '__new__' ? newCollection() : setCollectionId(e.target.value))} className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500">
              <option value="">No collection</option>
              {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new__">＋ New collection…</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 dark:border-zinc-800 p-4">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
