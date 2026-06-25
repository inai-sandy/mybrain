import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Plus, Eye, Download, Share2, Trash2, Pencil, X, Sparkles, Upload, Link2, Search } from 'lucide-react';
import { DataTable, Column, Filter, SortOption } from '../ui/DataTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ShareDialog } from '../ui/ShareDialog';
import { MarkdownEditor } from '../ui/MarkdownEditor';
import { useToast } from '../ui/Toast';

export type DocItem = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  kind: string;
  tags: string[];
  collectionId: string | null;
  shared: boolean;
  bytes: number | null;
  snippet?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Collection = { id: string; name: string; color: string | null; count: number };

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
  return <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">{t}</span>;
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
  const [activeCol, setActiveCol] = useState<string | 'all'>('all');
  const [managing, setManaging] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<DocItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDel, setBulkDel] = useState(false);
  const searching = q.trim().length >= 2;
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
  const filters: Filter[] = allTags.length
    ? [{ key: 'tags', label: 'Tag', options: allTags.map((t) => ({ value: t, label: t })), match: (row: DocItem, val: string) => (row.tags || []).includes(val) } as Filter]
    : [];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'updatedAt', dir: -1 },
    { label: 'Oldest', key: 'updatedAt', dir: 1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';

  function card(r: DocItem) {
    return (
      <div className={'group h-full rounded-xl border bg-white dark:bg-zinc-900 p-4 hover:shadow-md transition-all flex flex-col ' + (selected.has(r.id) ? 'border-emerald-500 ring-1 ring-emerald-500/40' : 'border-zinc-200 dark:border-zinc-800 hover:border-emerald-500/40')}>
        <div className="flex items-start gap-3">
          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} onClick={(e) => e.stopPropagation()} title="Select" className={'mt-2 h-4 w-4 accent-emerald-600 shrink-0 ' + (selected.size ? '' : 'opacity-0 group-hover:opacity-100 transition-opacity')} />
          <div className="shrink-0 rounded-lg p-2 text-emerald-500 bg-emerald-500/10"><FileText size={18} /></div>
          <button onClick={() => navigate(`/documents/${r.id}`)} className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600">{r.title}</h3>
            <p className="mt-0.5 text-xs text-zinc-400">{r.kind.toUpperCase()} · {shortDate(r.updatedAt)}{r.shared && <> · <span className="text-emerald-600">shared</span></>}</p>
          </button>
        </div>
        {r.description && <p className="mt-2 text-xs text-zinc-500 line-clamp-2">{r.description}</p>}
        {r.snippet && <p className="mt-1.5 text-xs text-zinc-400 italic line-clamp-2 border-l-2 border-emerald-500/40 pl-2">{r.snippet}</p>}
        {r.tags?.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><FileText size={20} className="text-emerald-600" /> Documents</h1>
          <p className="text-sm text-zinc-500">Your own files to write, share and re-use — kept out of memory unless you convert one to Capture.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input ref={fileInput} type="file" multiple accept=".md,.markdown,.txt,.html,.htm,.pdf,image/*" className="hidden" onChange={(e) => upload(e.target.files)} />
          <button onClick={() => setImporting(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Link2 size={16} /> Import URL</button>
          <button onClick={() => fileInput.current?.click()} disabled={uploading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"><Upload size={16} /> {uploading ? 'Uploading…' : 'Upload'}</button>
          <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm font-medium"><Plus size={16} /> New Document</button>
        </div>
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents — including inside their content…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 pl-9 pr-9 py-2 text-sm outline-none focus:border-emerald-500" />
        {q && <button onClick={() => setQ('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"><X size={15} /></button>}
      </div>

      <div className={'flex items-center gap-1.5 flex-wrap ' + (searching ? 'opacity-40 pointer-events-none' : '')}>
        {[{ id: 'all', name: 'All', count: items.length } as { id: string; name: string; count: number }, ...collections].map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveCol(c.id as string)}
            className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors ' + (activeCol === c.id ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-300 dark:hover:border-zinc-700')}
          >
            {c.name} <span className="text-zinc-400">{c.count}</span>
          </button>
        ))}
        <button onClick={() => setManaging(true)} className="text-xs text-zinc-400 hover:text-emerald-600 px-2 py-1">＋ Manage</button>
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
          <button onClick={() => setBulkDel(true)} className="inline-flex items-center gap-1 rounded-lg border border-rose-300 dark:border-rose-700 text-rose-600 px-2.5 py-1 text-xs hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 size={13} /> Delete</button>
          <button onClick={clearSel} className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 px-1">Clear</button>
        </div>
      )}

      <DataTable<DocItem>
        columns={cols}
        rows={searching ? results : activeCol === 'all' ? items : items.filter((i) => i.collectionId === activeCol)}
        loading={loading}
        filters={searching ? [] : filters}
        sortOptions={searching ? [] : sortOptions}
        searchable={false}
        renderCard={card}
        cardsOnly
        pageSize={12}
        emptyText={searching ? `No documents match "${q.trim()}".` : 'No documents yet — hit New Document to write your first one.'}
      />

      {(creating || editing) && (
        <DocEditor
          doc={editing}
          collections={collections}
          defaultCollectionId={activeCol !== 'all' ? activeCol : null}
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
      {sharing && <ShareDialog id={sharing.id} title={sharing.title} initialShared={sharing.shared} shareEndpoint={`/api/documents/${sharing.id}/share`} publicLink={`${location.origin}/d/${sharing.slug}`} onClose={() => setSharing(null)} onChanged={() => load()} />}
    </div>
  );
}

/** Create / rename / delete collections. (BEA-537) */
function ManageCollections({ collections, onClose, onChanged }: { collections: Collection[]; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<Collection[]>(collections);
  const [newName, setNewName] = useState('');
  const [del, setDel] = useState<Collection | null>(null);
  const toast = useToast();

  async function reload() {
    const r = await fetch('/api/documents/collections');
    if (r.ok) setList((await r.json()).collections || []);
    onChanged();
  }
  async function create() {
    if (!newName.trim()) return;
    const r = await fetch('/api/documents/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) });
    if (r.ok) {
      setNewName('');
      reload();
    } else toast('error', 'Could not create');
  }
  async function rename(c: Collection, name: string) {
    if (!name.trim() || name === c.name) return;
    await fetch(`/api/documents/collections/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
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
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="New collection name" className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          <button onClick={create} disabled={!newName.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 text-sm disabled:opacity-50">Add</button>
        </div>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {list.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No collections yet.</p>}
          {list.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <input defaultValue={c.name} onBlur={(e) => rename(c, e.target.value)} className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-emerald-500" />
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
            <MarkdownEditor value={content} onChange={setContent} />
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
