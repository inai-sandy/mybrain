import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Plus, Eye, Download, Share2, Trash2, Pencil, X, Sparkles } from 'lucide-react';
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
  shared: boolean;
  bytes: number | null;
  createdAt: string;
  updatedAt: string;
};

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
  const toast = useToast();
  const navigate = useNavigate();

  async function load() {
    const r = await fetch('/api/documents');
    if (r.ok) setItems((await r.json()).documents || []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

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
      <div className="group h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-emerald-500/40 hover:shadow-md transition-all flex flex-col">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg p-2 text-emerald-500 bg-emerald-500/10"><FileText size={18} /></div>
          <button onClick={() => navigate(`/documents/${r.id}`)} className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600">{r.title}</h3>
            <p className="mt-0.5 text-xs text-zinc-400">{r.kind.toUpperCase()} · {shortDate(r.updatedAt)}{r.shared && <> · <span className="text-emerald-600">shared</span></>}</p>
          </button>
        </div>
        {r.description && <p className="mt-2 text-xs text-zinc-500 line-clamp-2">{r.description}</p>}
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
        <button onClick={() => setCreating(true)} className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm font-medium"><Plus size={16} /> New Document</button>
      </div>

      <DataTable<DocItem>
        columns={cols}
        rows={items}
        loading={loading}
        filters={filters}
        sortOptions={sortOptions}
        renderCard={card}
        cardsOnly
        pageSize={12}
        emptyText="No documents yet — hit New Document to write your first one."
      />

      {(creating || editing) && (
        <DocEditor
          doc={editing}
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
      <ConfirmDialog open={!!del} title="Delete this document?" message={del ? `"${del.title}" will be permanently removed.` : ''} confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={() => del && remove(del)} />
      {sharing && <ShareDialog id={sharing.id} title={sharing.title} initialShared={sharing.shared} shareEndpoint={`/api/documents/${sharing.id}/share`} publicLink={`${location.origin}/d/${sharing.slug}`} onClose={() => setSharing(null)} onChanged={() => load()} />}
    </div>
  );
}

/** Simple create/edit modal (title + markdown + tags). The CodeMirror editor + AI summary arrive next issue. */
export function DocEditor({ doc, onClose, onSaved }: { doc: DocItem | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(doc?.title || '');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState(doc?.description || '');
  const [tags, setTags] = useState((doc?.tags || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [filling, setFilling] = useState(false);
  const [loaded, setLoaded] = useState(!doc);
  const toast = useToast();

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
    const body = { title: title.trim(), contentText: content, description: description.trim(), tags: tagList };
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
          ) : (
            <MarkdownEditor value={content} onChange={setContent} />
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <label className="text-xs font-medium text-zinc-500">Description &amp; tags</label>
            <button type="button" onClick={autoFill} disabled={filling} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 px-2.5 py-1 text-xs hover:bg-emerald-500/10 disabled:opacity-50">
              <Sparkles size={13} /> {filling ? 'Thinking…' : 'Auto-fill with AI'}
            </button>
          </div>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description (≤200 chars — AI fills this if you leave it blank)" maxLength={200} rows={2} className="w-full resize-none rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags (comma separated)" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 dark:border-zinc-800 p-4">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
