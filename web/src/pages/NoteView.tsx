import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Trash2, Pencil, Save, X, Pin, Archive, ArchiveRestore, Sparkles, Loader2, RotateCcw } from 'lucide-react';
import { Markdown } from '../ui/markdown';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

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
  createdAt: string;
  updatedAt: string;
};

const COLORS: Record<string, string> = {
  default: 'transparent', red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  teal: '#14b8a6', blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899', gray: '#9ca3af',
};

/** Full-page note reader — an exact sibling of DocumentView (BEA-966). Reads the note as
 *  formatted Markdown; Edit switches this SAME page into edit mode in place (no popup). */
export function NoteView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  function goBack() {
    if (location.key && location.key !== 'default') navigate(-1);
    else navigate('/notes');
  }

  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState('');
  const [inline, setInline] = useState(false); // in-place edit
  const [eTitle, setETitle] = useState('');
  const [eContent, setEContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [undo, setUndo] = useState<string | null>(null); // previous content, for one-tap undo

  function load() {
    fetch(`/api/notes/${id}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setNote)
      .catch(() => setError('Note not found.'));
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  function startInline() { if (!note) return; setETitle(note.title); setEContent(note.content || ''); setInline(true); }
  async function saveInline() {
    if (!note) return;
    setSaving(true);
    const r = await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: eTitle, content: eContent }) });
    setSaving(false);
    if (r.ok) { toast('success', 'Saved'); setInline(false); setNote(await r.json()); } else toast('error', 'Could not save');
  }

  async function patch(data: Partial<Note>) {
    const r = await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (r.ok) setNote(await r.json());
    else toast('error', 'Could not update');
  }
  async function toggleCheck(i: number) {
    if (!note) return;
    const checklist = note.checklist.map((c, idx) => (idx === i ? { ...c, done: !c.done } : c));
    setNote({ ...note, checklist }); // optimistic
    patch({ checklist } as any);
  }

  async function remove() {
    setDel(false);
    const r = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (r.ok) { toast('success', 'Deleted'); navigate('/notes'); } else toast('error', 'Could not delete');
  }

  async function aiFormat() {
    if (formatting || !note) return;
    setFormatting(true);
    try {
      const r = await fetch(`/api/notes/${id}/format`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d.message || 'Could not clean up'); return; }
      setUndo((d.previous ?? note.content) as string);
      if (d.note) setNote(d.note);
      toast('success', 'Cleaned up ✨');
    } catch { toast('error', 'Could not clean up'); }
    finally { setFormatting(false); }
  }
  async function undoFormat() {
    if (undo == null) return;
    const prev = undo;
    setUndo(null);
    const r = await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: prev }) });
    if (r.ok) { setNote(await r.json()); toast('success', 'Restored the original'); } else toast('error', 'Could not undo');
  }

  const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800';
  const strip = note ? COLORS[note.color] || 'transparent' : 'transparent';

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <button onClick={goBack} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft size={15} /> Back</button>

      {error && <p className="text-amber-500">{error}</p>}

      {note && (
        <>
          {note.color !== 'default' && <div style={{ height: 4, borderRadius: 4, background: strip }} />}

          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
              {inline ? (
                <input value={eTitle} onChange={(e) => setETitle(e.target.value)} placeholder="Title" className="w-full text-2xl font-extrabold bg-transparent border-b border-zinc-300 dark:border-zinc-700 focus:border-amber-500 outline-none pb-1" />
              ) : (
                <h1 className="text-2xl font-extrabold break-words">{note.title || 'Untitled note'}</h1>
              )}
              {!inline && (
                <p className="mt-1 text-xs text-zinc-400">Updated {new Date(note.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}{note.pinned && <> · <span className="text-amber-600">pinned</span></>}</p>
              )}
              {!inline && note.tags?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {note.tags.map((t) => <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">#{t}</span>)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {inline ? (
                <>
                  <button onClick={saveInline} disabled={saving} className={btn + ' bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-500 disabled:opacity-50'}>{saving ? '…' : <><Save size={15} /> Save</>}</button>
                  <button onClick={() => setInline(false)} className={btn}><X size={15} /> Cancel</button>
                </>
              ) : (
                <>
                  <button onClick={aiFormat} disabled={formatting} className={btn + ' text-violet-600 border-violet-300 dark:border-violet-500/40 hover:bg-violet-500/10 disabled:opacity-50'} title="Clean up & format with AI">{formatting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Clean up</button>
                  <button onClick={startInline} className={btn}><Pencil size={15} /> Edit</button>
                  <button onClick={() => patch({ pinned: !note.pinned } as any)} className={btn + (note.pinned ? ' text-amber-500 border-amber-300 dark:border-amber-500/40' : ' hover:text-amber-500')}><Pin size={15} fill={note.pinned ? 'currentColor' : 'none'} /> {note.pinned ? 'Pinned' : 'Pin'}</button>
                  <button onClick={() => patch({ archived: !note.archived } as any)} className={btn}>{note.archived ? <><ArchiveRestore size={15} /> Unarchive</> : <><Archive size={15} /> Archive</>}</button>
                  <button onClick={() => setDel(true)} className={btn + ' hover:text-red-500'}><Trash2 size={15} /> Delete</button>
                </>
              )}
            </div>
          </div>

          {inline ? (
            <textarea value={eContent} onChange={(e) => setEContent(e.target.value)} placeholder="Write your note…" className="w-full min-h-[65vh] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 p-4 text-sm leading-relaxed font-mono outline-none focus:border-amber-500 resize-y" />
          ) : (
            <div className="border-t border-zinc-200 dark:border-zinc-800 pt-5 space-y-4">
              {note.content ? (
                <Markdown className="text-[15px]">{note.content}</Markdown>
              ) : note.checklist.length === 0 ? (
                <p className="text-sm text-zinc-400 italic">This note is empty. Tap Edit to add something.</p>
              ) : null}

              {note.checklist.length > 0 && (
                <ul className="space-y-2">
                  {note.checklist.map((c, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm">
                      <button onClick={() => toggleCheck(i)} className={'mt-0.5 shrink-0 h-4 w-4 rounded border flex items-center justify-center ' + (c.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-zinc-300 dark:border-zinc-600')}>
                        {c.done && <span className="text-[10px] leading-none">✓</span>}
                      </button>
                      <span className={'min-w-0 break-words ' + (c.done ? 'line-through text-zinc-400' : 'text-zinc-700 dark:text-zinc-200')}>{c.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {undo != null && (
        <div className="fixed bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          <Sparkles size={14} className="text-violet-400" /> Note cleaned up
          <button onClick={undoFormat} className="inline-flex items-center gap-1 font-semibold underline"><RotateCcw size={13} /> Undo</button>
        </div>
      )}

      <ConfirmDialog open={del} title="Delete this note?" message={note ? `"${note.title || 'Untitled note'}" will be permanently removed.` : ''} confirmLabel="Delete" onCancel={() => setDel(false)} onConfirm={remove} />
    </div>
  );
}
