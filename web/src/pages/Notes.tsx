import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Pin, Archive, ArchiveRestore, Trash2, X, ListChecks, ListTodo, Tag as TagIcon, StickyNote, Sparkles, Loader2, RotateCcw, Eye, LayoutGrid, List } from 'lucide-react';
import { DataTable, type Column } from '../ui/DataTable';
import { useToast } from '../ui/Toast';
import { DictateButton } from '../ui/DictateButton';
import { Sheet } from '../ui/Sheet';
import { GrowTextarea } from '../ui/GrowTextarea';

type Check = { text: string; done: boolean };
type Note = {
  id: string;
  title: string;
  content: string;
  checklist: Check[];
  color: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
};

// Color key → the dot/strip colour on a note.
const COLORS: Record<string, string> = {
  default: 'transparent', red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  teal: '#14b8a6', blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899', gray: '#9ca3af',
};
const COLOR_KEYS = Object.keys(COLORS);

/** One-line plain-text preview of a note's body (strips Markdown) — for the list rows/cards. */
function preview(n: { content: string; checklist: { text: string }[] }): string {
  const raw = (n.content || n.checklist.map((c) => c.text).join(' · ') || '').replace(/```[\s\S]*?```/g, ' ');
  return raw
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>#~]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortDate(s: string) {
  return new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function Chip({ t }: { t: string }) {
  return <span className="shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">#{t}</span>;
}

export function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const [color, setColor] = useState('');
  const [tag, setTag] = useState('');
  const [sortKey, setSortKey] = useState('updatedAt:-1');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [view, setView] = useState<'list' | 'cards'>(() => (localStorage.getItem('notesView') === 'cards' ? 'cards' : 'list'));
  const [editing, setEditing] = useState<'new' | null>(null); // "New note" composer (new notes only)
  const [formatting, setFormatting] = useState<string | null>(null); // note id being AI-formatted
  const [undo, setUndo] = useState<{ id: string; prev: string } | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  function changeView(v: 'list' | 'cards') { setView(v); localStorage.setItem('notesView', v); }

  async function load() {
    try {
      const r = await fetch(`/api/notes?archived=${archived ? 1 : 0}`);
      if (r.ok) setNotes((await r.json()).notes || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [archived]);

  const allTags = useMemo(() => [...new Set(notes.flatMap((n) => n.tags))].sort(), [notes]);
  const usedColors = useMemo(() => [...new Set(notes.map((n) => n.color))].filter((c) => c !== 'default'), [notes]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return notes.filter((n) => {
      if (color && n.color !== color) return false;
      if (tag && !n.tags.includes(tag)) return false;
      if (pinnedOnly && !n.pinned) return false;
      if (needle) {
        const hay = (n.title + ' ' + n.content + ' ' + n.checklist.map((c) => c.text).join(' ') + ' ' + n.tags.join(' ')).toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [notes, q, color, tag, pinnedOnly]);

  // Pinned always first, then the chosen sort — matches the Documents list controls.
  const sorted = useMemo(() => {
    const [key, dir] = sortKey.split(':');
    const d = Number(dir) as 1 | -1;
    return [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const av = key === 'title' ? (a.title || '').toLowerCase() : a.updatedAt;
      const bv = key === 'title' ? (b.title || '').toLowerCase() : b.updatedAt;
      return (av > bv ? 1 : av < bv ? -1 : 0) * d;
    });
  }, [filtered, sortKey]);

  async function patch(id: string, data: Partial<Note>) {
    const r = await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (r.ok) load();
  }
  async function remove(id: string) {
    const r = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (r.ok) { toast('success', 'Note deleted'); load(); }
  }
  async function aiFormat(n: Note) {
    if (formatting) return;
    setFormatting(n.id);
    try {
      const r = await fetch(`/api/notes/${n.id}/format`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d.message || 'Could not clean up'); return; }
      const prev = (d.previous ?? n.content) as string;
      const next = d.note?.content ?? n.content;
      setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, content: next } : x)));
      setUndo({ id: n.id, prev });
      toast('success', 'Cleaned up ✨');
    } catch { toast('error', 'Could not clean up'); }
    finally { setFormatting(null); }
  }
  async function undoFormat() {
    if (!undo) return;
    const { id, prev } = undo;
    setUndo(null);
    const r = await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: prev }) });
    if (r.ok) { setNotes((ns) => ns.map((x) => (x.id === id ? { ...x, content: prev } : x))); toast('success', 'Restored the original'); }
    else toast('error', 'Could not undo');
  }

  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';
  const cols: Column<Note>[] = [{ key: 'title', label: 'Title' }, { key: 'content', label: 'Content' }];

  // Card view (grid) — mirrors the Documents card. (BEA-966)
  function card(n: Note) {
    const line = preview(n);
    const isChecklist = !n.content && n.checklist.length > 0;
    return (
      <div className="group relative h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:shadow-md hover:border-amber-500/40 transition-all flex flex-col">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg p-2 text-amber-500 bg-amber-500/10">{isChecklist ? <ListTodo size={18} /> : <StickyNote size={18} />}</div>
          <button onClick={() => navigate(`/notes/${n.id}`)} className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-amber-600 flex items-center gap-1.5">
              {n.color !== 'default' && <span className="shrink-0 h-2 w-2 rounded-full" style={{ background: COLORS[n.color] }} />}
              {n.pinned && <Pin size={12} className="shrink-0 text-amber-500 fill-amber-500" />}
              <span className="truncate">{n.title || 'Untitled note'}</span>
            </h3>
            <p className="mt-1 text-xs text-zinc-400">{shortDate(n.updatedAt)}</p>
          </button>
        </div>
        {line && <p className="mt-2 text-xs text-zinc-500 line-clamp-2">{line}</p>}
        {n.tags?.length > 0 && (
          <div className="mt-3 flex flex-nowrap items-center gap-1.5 overflow-hidden">
            {n.tags.slice(0, 4).map((t) => <Chip key={t} t={t} />)}
            {n.tags.length > 4 && <Chip t={`+${n.tags.length - 4}`} />}
          </div>
        )}
        <div className="mt-auto pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center gap-0.5">
          <button onClick={() => patch(n.id, { pinned: !n.pinned } as any)} title={n.pinned ? 'Unpin' : 'Pin'} className={iconBtn + (n.pinned ? ' text-amber-500' : ' hover:text-amber-500')}><Pin size={16} className={n.pinned ? 'fill-amber-500' : ''} /></button>
          <div className="flex-1" />
          <button onClick={() => navigate(`/notes/${n.id}`)} title="Open" className={iconBtn + ' hover:text-amber-600'}><Eye size={16} /></button>
          <button onClick={() => aiFormat(n)} disabled={formatting === n.id} title="Clean up with AI" className={iconBtn + ' text-violet-500 hover:text-violet-600 disabled:opacity-50'}>{formatting === n.id ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}</button>
          <button onClick={() => patch(n.id, { archived: !n.archived } as any)} title={n.archived ? 'Unarchive' : 'Archive'} className={iconBtn + ' hover:text-emerald-600'}>{n.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>
          <button onClick={() => remove(n.id)} title="Delete" className={iconBtn + ' hover:text-red-500'}><Trash2 size={16} /></button>
        </div>
      </div>
    );
  }

  // List view (rows) — mirrors the Documents 3-line row, actions always visible. (BEA-966)
  function row(n: Note) {
    const line = preview(n);
    const isChecklist = !n.content && n.checklist.length > 0;
    return (
      <div className="group flex items-start gap-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2.5 hover:border-amber-500/40 hover:shadow-sm transition-all">
        <div className="shrink-0 mt-0.5 rounded-lg p-1.5 text-amber-500 bg-amber-500/10">{isChecklist ? <ListTodo size={16} /> : <StickyNote size={16} />}</div>
        <button onClick={() => navigate(`/notes/${n.id}`)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            {n.color !== 'default' && <span className="shrink-0 h-2 w-2 rounded-full" style={{ background: COLORS[n.color] }} />}
            {n.pinned && <Pin size={12} className="shrink-0 text-amber-500 fill-amber-500" />}
            <h3 className="font-semibold leading-tight truncate group-hover:text-amber-600">{n.title || 'Untitled note'}</h3>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="shrink-0">{shortDate(n.updatedAt)}</span>
            {line && <><span className="text-zinc-300 dark:text-zinc-700">·</span><span className="truncate">{line}</span></>}
          </p>
          <div className="mt-1 flex flex-nowrap items-center gap-1.5 h-[18px] overflow-hidden">
            {n.tags?.length ? (
              <>
                {n.tags.slice(0, 4).map((t) => <Chip key={t} t={t} />)}
                {n.tags.length > 4 && <Chip t={`+${n.tags.length - 4}`} />}
              </>
            ) : (
              <span className="text-[10px] text-zinc-300 dark:text-zinc-600">no tags</span>
            )}
          </div>
        </button>
        <div className="shrink-0 flex items-center gap-0.5">
          <button onClick={() => patch(n.id, { pinned: !n.pinned } as any)} title={n.pinned ? 'Unpin' : 'Pin'} className={iconBtn + (n.pinned ? ' text-amber-500' : ' hover:text-amber-500')}><Pin size={16} className={n.pinned ? 'fill-amber-500' : ''} /></button>
          <button onClick={() => navigate(`/notes/${n.id}`)} title="Open" className={iconBtn + ' hover:text-amber-600'}><Eye size={16} /></button>
          <button onClick={() => aiFormat(n)} disabled={formatting === n.id} title="Clean up with AI" className={iconBtn + ' text-violet-500 hover:text-violet-600 disabled:opacity-50'}>{formatting === n.id ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}</button>
          <button onClick={() => patch(n.id, { archived: !n.archived } as any)} title={n.archived ? 'Unarchive' : 'Archive'} className={iconBtn + ' hidden sm:inline-flex hover:text-emerald-600'}>{n.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>
          <button onClick={() => remove(n.id)} title="Delete" className={iconBtn + ' hover:text-red-500'}><Trash2 size={16} /></button>
        </div>
      </div>
    );
  }

  const inputCls = 'shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2 py-2 text-sm outline-none focus:border-amber-500';
  const viewToggle = (
    <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 p-0.5 shrink-0">
      <button onClick={() => changeView('cards')} title="Card view" aria-label="Card view" className={'p-1.5 rounded-md transition-colors ' + (view === 'cards' ? 'bg-amber-500 text-white' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200')}><LayoutGrid size={15} /></button>
      <button onClick={() => changeView('list')} title="List view" aria-label="List view" className={'p-1.5 rounded-md transition-colors ' + (view === 'list' ? 'bg-amber-500 text-white' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200')}><List size={15} /></button>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header — mirrors the Documents header (title left, actions top-right). */}
      <div className="flex items-center justify-between gap-3">
        <div className="hidden sm:block">
          <h1 className="text-xl font-bold flex items-center gap-2"><StickyNote size={20} className="text-amber-500" /> Notes</h1>
          <p className="text-sm text-zinc-500">Your notes as documents — tap one to open, read &amp; edit it full-page.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 ml-auto">
          <button onClick={() => setArchived((a) => !a)} title={archived ? 'Showing archived' : 'Show archived'} aria-pressed={archived} className={'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ' + (archived ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
            <Archive size={16} /> <span className="hidden sm:inline">{archived ? 'Archived' : 'Archive'}</span>
          </button>
          {!archived && (
            <button onClick={() => setEditing('new')} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-white px-3 py-2 text-sm font-medium"><Plus size={16} /> <span className="hidden sm:inline">New note</span></button>
          )}
        </div>
      </div>

      {/* Unified controls row: Search · Tags · Colour · Sort · Pinned · View — same shape as Documents. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 pl-9 pr-9 py-2 text-sm outline-none focus:border-amber-500" />
          {q && <button onClick={() => setQ('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"><X size={15} /></button>}
        </div>
        {allTags.length > 0 && (
          <select aria-label="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)} className={inputCls + ' max-w-[7rem]'}>
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {usedColors.length > 0 && (
          <select aria-label="Filter by colour" value={color} onChange={(e) => setColor(e.target.value)} className={inputCls + ' max-w-[7rem] capitalize'}>
            <option value="">All colours</option>
            {usedColors.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select aria-label="Sort" value={sortKey} onChange={(e) => setSortKey(e.target.value)} className={inputCls}>
          <option value="updatedAt:-1">Newest</option>
          <option value="updatedAt:1">Oldest</option>
          <option value="title:1">Title A–Z</option>
        </select>
        <button onClick={() => setPinnedOnly((s) => !s)} title={pinnedOnly ? 'Showing pinned only' : 'Show pinned only'} aria-pressed={pinnedOnly} className={'shrink-0 grid place-items-center rounded-lg border p-2 transition-colors ' + (pinnedOnly ? 'border-amber-400 bg-amber-400/10 text-amber-500' : 'border-zinc-200 dark:border-zinc-800 text-zinc-400 hover:text-amber-500')}>
          <Pin size={16} className={pinnedOnly ? 'fill-amber-500' : ''} />
        </button>
        {viewToggle}
      </div>

      <DataTable<Note>
        columns={cols}
        rows={sorted}
        loading={loading}
        filters={[]}
        sortOptions={[]}
        searchable={false}
        renderCard={view === 'list' ? row : card}
        cardsOnly
        gridClassName={view === 'list' ? 'space-y-2' : 'grid grid-cols-1 gap-3 sm:grid-cols-2'}
        pageSize={12}
        emptyText={archived ? 'No archived notes.' : q || color || tag || pinnedOnly ? 'No notes match.' : 'No notes yet — hit New note to add one.'}
      />

      {undo && (
        <div className="fixed bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          <Sparkles size={14} className="text-violet-400" /> Note cleaned up
          <button onClick={undoFormat} className="inline-flex items-center gap-1 font-semibold underline"><RotateCcw size={13} /> Undo</button>
        </div>
      )}

      {editing && (
        <NoteEditor note={null} allTags={allTags} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

function NoteEditor({ note, allTags, onClose, onSaved }: { note: Note | null; allTags: string[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(note?.title || '');
  const [content, setContent] = useState(note?.content || '');
  const [checklist, setChecklist] = useState<Check[]>(note?.checklist || []);
  const [color, setColor] = useState(note?.color || 'default');
  const [tags, setTags] = useState<string[]>(note?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const appendContent = (chunk: string) => setContent((c) => (c ? c + ' ' : '') + chunk);

  function addTag(raw: string) {
    const t = raw.toLowerCase().trim().replace(/^#/, '');
    if (t && !tags.includes(t)) setTags((ts) => [...ts, t].slice(0, 12));
    setTagInput('');
  }
  function setItem(i: number, text: string) { setChecklist((cl) => cl.map((c, idx) => (idx === i ? { ...c, text } : c))); }
  function toggleItem(i: number) { setChecklist((cl) => cl.map((c, idx) => (idx === i ? { ...c, done: !c.done } : c))); }
  function addItem() { setChecklist((cl) => [...cl, { text: '', done: false }]); }
  function removeItem(i: number) { setChecklist((cl) => cl.filter((_, idx) => idx !== i)); }

  async function save(close: () => void) {
    const cleanList = checklist.filter((c) => c.text.trim());
    if (!title.trim() && !content.trim() && cleanList.length === 0) { close(); return; }
    setBusy(true);
    try {
      const body = { title, content, checklist: cleanList, color, tags };
      const r = note
        ? await fetch(`/api/notes/${note.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) onSaved();
      else toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold flex items-center gap-2"><StickyNote size={16} className="text-amber-500" /> {note ? 'Edit note' : 'New note'}</h3>
            <button onClick={() => save(close)} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>

          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-medium outline-none focus:border-amber-500" />

          <div className="relative mt-2">
            <GrowTextarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Take a note…" rows={3} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 pr-11 text-sm outline-none focus:border-amber-500" />
            <DictateButton onText={appendContent} size={15} className="absolute right-2 top-2" />
          </div>

          {checklist.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {checklist.map((c, i) => (
                <li key={i} className="flex items-center gap-2">
                  <button onClick={() => toggleItem(i)} className={'shrink-0 h-5 w-5 rounded border flex items-center justify-center ' + (c.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-zinc-300 dark:border-zinc-600')}>{c.done && '✓'}</button>
                  <input value={c.text} onChange={(e) => setItem(i, e.target.value)} placeholder="List item" className={'flex-1 bg-transparent text-sm outline-none border-b border-transparent focus:border-zinc-300 ' + (c.done ? 'line-through text-zinc-400' : '')} />
                  <button onClick={() => removeItem(i)} className="shrink-0 p-1 text-zinc-400 hover:text-rose-600"><X size={14} /></button>
                </li>
              ))}
            </ul>
          )}
          <button onClick={addItem} className="mt-2 text-xs text-zinc-500 hover:text-amber-600 inline-flex items-center gap-1"><ListChecks size={14} /> Add checklist item</button>

          <div className="mt-4">
            <div className="text-xs text-zinc-400 mb-1.5">Color</div>
            <div className="flex flex-wrap gap-2">
              {COLOR_KEYS.map((k) => (
                <button key={k} onClick={() => setColor(k)} title={k} className={'h-7 w-7 rounded-full border-2 flex items-center justify-center ' + (color === k ? 'ring-2 ring-offset-1 ring-zinc-400 dark:ring-offset-zinc-900' : '')} style={{ borderColor: k === 'default' ? '#d4d4d8' : COLORS[k] }}>
                  {k !== 'default' && <span className="h-4 w-4 rounded-full" style={{ background: COLORS[k] }} />}
                  {k === 'default' && <span className="text-[9px] text-zinc-400">—</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <div className="text-xs text-zinc-400 mb-1.5 flex items-center gap-1"><TagIcon size={12} /> Tags</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-xs">
                  #{t}
                  <button onClick={() => setTags((ts) => ts.filter((x) => x !== t))}><X size={11} /></button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) { e.preventDefault(); addTag(tagInput); } }}
                onBlur={() => tagInput.trim() && addTag(tagInput)}
                placeholder="add tag…"
                list="note-tags"
                className="flex-1 min-w-[80px] bg-transparent text-sm outline-none"
              />
              <datalist id="note-tags">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={close} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
            <button onClick={() => save(close)} disabled={busy} className="rounded-lg bg-amber-500 hover:bg-amber-400 text-white px-4 py-1.5 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}
    </Sheet>
  );
}
