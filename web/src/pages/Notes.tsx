import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Pin, Archive, ArchiveRestore, Trash2, X, Mic, ListChecks, Tag as TagIcon, StickyNote, Sparkles, Loader2, RotateCcw } from 'lucide-react';
import { Markdown } from '../ui/markdown';
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

// Color key → the strip colour shown across the top of a note (border accent, not a fill).
const COLORS: Record<string, string> = {
  default: 'transparent',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  teal: '#14b8a6',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#9ca3af',
};
const COLOR_KEYS = Object.keys(COLORS);

export function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const [color, setColor] = useState('');
  const [tag, setTag] = useState('');
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [formatting, setFormatting] = useState<string | null>(null); // note id being AI-formatted
  const [undo, setUndo] = useState<{ id: string; prev: string } | null>(null); // one-tap undo after a clean-up
  const toast = useToast();

  async function load() {
    // NOTE: no setLoading(true) on refresh — keep current content on screen so scroll position survives
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
      if (needle) {
        const hay = (n.title + ' ' + n.content + ' ' + n.checklist.map((c) => c.text).join(' ') + ' ' + n.tags.join(' ')).toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [notes, q, color, tag]);

  async function patch(id: string, data: Partial<Note>) {
    const r = await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (r.ok) load();
  }
  async function remove(id: string) {
    const r = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (r.ok) { toast('success', 'Note deleted'); load(); }
  }
  async function toggleCheck(n: Note, i: number) {
    const checklist = n.checklist.map((c, idx) => (idx === i ? { ...c, done: !c.done } : c));
    setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, checklist } : x))); // optimistic
    patch(n.id, { checklist } as any);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><StickyNote className="text-amber-500" /> Notes</h1>
          <p className="text-zinc-500 text-sm">Your notes as documents — tap ✨ to clean up &amp; format any note.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setArchived((a) => !a)} title={archived ? 'Archived notes' : 'Show archived'} className={'text-xs inline-flex items-center gap-1 rounded-lg px-2.5 py-2 border ' + (archived ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
            <Archive size={14} />
          </button>
        </div>
      </div>

      {/* Take a note */}
      {!archived && (
        <button onClick={() => setEditing('new')} className="w-full flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 text-sm text-zinc-400 hover:border-amber-500/50">
          <Plus size={16} /> Take a note…
        </button>
      )}

      {/* Search + filters */}
      <div className="space-y-2">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-9 pr-3 py-2 text-sm outline-none focus:border-amber-500" />
        </div>
        {(usedColors.length > 0 || allTags.length > 0) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {usedColors.map((c) => (
              <button key={c} onClick={() => setColor(color === c ? '' : c)} title={c} className={'h-6 w-6 rounded-full border-2 ' + (color === c ? 'ring-2 ring-offset-1 ring-zinc-400 dark:ring-offset-zinc-950' : '')} style={{ borderColor: COLORS[c], background: 'transparent' }}>
                <span className="block h-full w-full rounded-full" style={{ background: COLORS[c], opacity: 0.18 }} />
              </button>
            ))}
            {allTags.map((t) => (
              <button key={t} onClick={() => setTag(tag === t ? '' : t)} className={'rounded-full px-2 py-0.5 text-xs border ' + (tag === t ? 'bg-amber-500/15 border-amber-500 text-amber-700 dark:text-amber-300' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500')}>#{t}</button>
            ))}
            {(color || tag) && <button onClick={() => { setColor(''); setTag(''); }} className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 underline">clear</button>}
          </div>
        )}
        <p className="text-[11px] text-zinc-400">{filtered.length} note{filtered.length === 1 ? '' : 's'}{q || color || tag ? ' (filtered)' : ''}</p>
      </div>

      {/* Masonry grid */}
      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-sm text-zinc-500">
          <StickyNote size={26} className="mx-auto mb-2 text-zinc-400" />
          {archived ? 'No archived notes.' : q || color || tag ? 'No notes match.' : 'No notes yet — tap “Take a note…” to add one.'}
        </div>
      ) : (
        <div className="space-y-3 max-w-3xl mx-auto">
          {filtered.map((n) => (
            <NoteCard key={n.id} n={n} formatting={formatting === n.id} onOpen={() => setEditing(n)} onAI={() => aiFormat(n)} onPin={() => patch(n.id, { pinned: !n.pinned } as any)} onArchive={() => patch(n.id, { archived: !n.archived } as any)} onDelete={() => remove(n.id)} onToggleCheck={(i) => toggleCheck(n, i)} />
          ))}
        </div>
      )}

      {undo && (
        <div className="fixed bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          <Sparkles size={14} className="text-violet-400" /> Note cleaned up
          <button onClick={undoFormat} className="inline-flex items-center gap-1 font-semibold underline"><RotateCcw size={13} /> Undo</button>
        </div>
      )}

      {editing && (
        <NoteEditor note={editing === 'new' ? null : editing} allTags={allTags} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

function NoteCard({ n, formatting, onOpen, onAI, onPin, onArchive, onDelete, onToggleCheck }: { n: Note; formatting: boolean; onOpen: () => void; onAI: () => void; onPin: () => void; onArchive: () => void; onDelete: () => void; onToggleCheck: (i: number) => void }) {
  const strip = COLORS[n.color] || 'transparent';
  return (
    <article className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden group shadow-sm">
      {n.color !== 'default' && <div style={{ height: 4, background: strip }} />}
      <div className="p-5">
        {/* Title + document actions */}
        <div className="flex items-start gap-2">
          <button onClick={onOpen} className="min-w-0 flex-1 text-left">
            {n.title ? <h2 className="text-lg font-bold leading-snug break-words">{n.title}</h2> : <span className="text-sm text-zinc-400">Untitled note</span>}
          </button>
          <div className="flex shrink-0 items-center gap-0.5 -mt-0.5">
            <button onClick={onAI} disabled={formatting} title="Clean up & format with AI" className="rounded-lg p-1.5 text-violet-500 hover:bg-violet-500/10 disabled:opacity-50">
              {formatting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            </button>
            <button onClick={onPin} title={n.pinned ? 'Unpin' : 'Pin'} className={'rounded-lg p-1.5 ' + (n.pinned ? 'text-amber-500' : 'text-zinc-300 dark:text-zinc-600 hover:text-amber-500')}><Pin size={16} className={n.pinned ? 'fill-amber-500' : ''} /></button>
            <button onClick={onArchive} title={n.archived ? 'Unarchive' : 'Archive'} className="rounded-lg p-1.5 text-zinc-400 hover:text-emerald-600">{n.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>
            <button onClick={onDelete} title="Delete" className="rounded-lg p-1.5 text-zinc-400 hover:text-rose-600"><Trash2 size={16} /></button>
          </div>
        </div>
        {/* Body — rendered as a document (Markdown) */}
        {n.content && (
          <div className="mt-2 cursor-pointer break-words" onClick={onOpen}>
            <Markdown className="text-sm">{n.content}</Markdown>
          </div>
        )}
        {n.checklist.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {n.checklist.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <button onClick={() => onToggleCheck(i)} className={'mt-0.5 shrink-0 h-4 w-4 rounded border flex items-center justify-center ' + (c.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-zinc-300 dark:border-zinc-600')}>
                  {c.done && <span className="text-[10px] leading-none">✓</span>}
                </button>
                <span className={'min-w-0 break-words ' + (c.done ? 'line-through text-zinc-400' : 'text-zinc-700 dark:text-zinc-200')}>{c.text}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
          <span>{new Date(n.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          {n.tags.map((t) => <span key={t}>#{t}</span>)}
        </div>
      </div>
    </article>
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

          {/* Checklist */}
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

          {/* Colors */}
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

          {/* Tags */}
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
