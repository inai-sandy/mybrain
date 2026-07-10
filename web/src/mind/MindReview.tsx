import { useEffect, useMemo, useState } from 'react';
import { Check, X, Pencil, Pin, Loader2, FlaskConical, HelpCircle, MessageSquarePlus } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { mindApi, KIND_GROUP, valenceClass, type Finding } from './client';
import { TrustLadder } from './TrustLadder';

/** The nightly "what I understood about you" review — your ✓/✗/almost taps teach the model. (BEA-449) */
export function MindReview({ onChange }: { onChange?: (remaining: number) => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ pending: Finding[]; fading: Finding[] } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [noting, setNoting] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  async function load() {
    try {
      setData(await mindApi.review());
    } catch {
      setData({ pending: [], fading: [] });
    }
  }
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (data && onChange) onChange(data.pending.length + data.fading.length);
  }, [data, onChange]);

  function drop(id: string) {
    setData((d) => (d ? { pending: d.pending.filter((f) => f.id !== id), fading: d.fading.filter((f) => f.id !== id) } : d));
  }
  async function act(id: string, fn: () => Promise<unknown>, msg: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
      drop(id);
      toast('success', msg);
    } catch {
      toast('error', 'Could not save that');
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }
  async function saveEdit(f: Finding) {
    if (!draft.trim()) return setEditing(null);
    setBusy((b) => ({ ...b, [f.id]: true }));
    try {
      await mindApi.amend(f.id, { statement: draft.trim() });
      drop(f.id);
      toast('success', 'Fixed — thanks for teaching me');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setEditing(null);
      setBusy((b) => ({ ...b, [f.id]: false }));
    }
  }
  async function saveNote(f: Finding) {
    if (!noteDraft.trim()) return setNoting(null);
    setBusy((b) => ({ ...b, [f.id]: true }));
    try {
      await mindApi.note(f.id, noteDraft.trim());
      drop(f.id); // a note is a soft "yes" — clear it from the review queue
      toast('success', 'Saved — thanks for telling me');
    } catch {
      toast('error', 'Could not save your note');
    } finally {
      setNoting(null);
      setNoteDraft('');
      setBusy((b) => ({ ...b, [f.id]: false }));
    }
  }

  const groups = useMemo(() => {
    const g: Record<string, Finding[]> = {};
    for (const f of data?.pending ?? []) {
      const key = KIND_GROUP[f.kind]?.label ?? 'Patterns';
      (g[key] ||= []).push(f);
    }
    return g;
  }, [data]);

  if (!data) return <div className="flex justify-center py-8 text-zinc-400"><Loader2 className="animate-spin" size={18} /></div>;
  const total = data.pending.length + data.fading.length;
  if (total === 0)
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
        <FlaskConical size={20} className="mx-auto mb-2 text-violet-500" />
        Nothing new to review — I'm still learning from your days. Tell tonight's story and I'll have more.
      </div>
    );

  // Inline render function, NOT a nested component — a nested component would be a new type each
  // render and remount the textarea, throwing the caret to the start on every keystroke. (BEA-931)
  const card = (f: Finding, fading?: boolean) => (
    <div key={f.id} className={'rounded-xl border p-3 ' + (fading ? 'border-amber-300/60 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/20' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900')}>
      {editing === f.id ? (
        <textarea autoFocus rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full text-sm rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:border-emerald-500 mb-2" />
      ) : (
        <p className="text-sm leading-snug">
          <span className={'font-medium ' + valenceClass(f.valence)}>{f.statement}</span>
        </p>
      )}
      {noting === f.id && (
        <textarea autoFocus rows={2} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Tell me in your own words — what's right, what's off, what I'm missing…" className="w-full text-sm rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:border-violet-500 mt-2" />
      )}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-zinc-400 tabular-nums flex items-center gap-1.5"><TrustLadder confidence={f.confidence} validated={f.validated} /> · {f.evidenceCount}×{f.cadence ? ` · ${f.cadence}` : ''}</span>
        <div className="flex-1" />
        {editing === f.id ? (
          <>
            <button onClick={() => saveEdit(f)} disabled={busy[f.id]} className="rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-xs hover:bg-emerald-500">Save</button>
            <button onClick={() => setEditing(null)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs">Cancel</button>
          </>
        ) : noting === f.id ? (
          <>
            <button onClick={() => saveNote(f)} disabled={busy[f.id] || !noteDraft.trim()} className="rounded-lg bg-violet-600 text-white px-2.5 py-1 text-xs hover:bg-violet-500 disabled:opacity-50">Save note</button>
            <button onClick={() => { setNoting(null); setNoteDraft(''); }} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs">Cancel</button>
          </>
        ) : (
          <>
            <button title="Yes, that's me" onClick={() => act(f.id, () => mindApi.confirm(f.id), 'Confirmed')} disabled={busy[f.id]} className="grid place-items-center h-7 w-7 rounded-lg bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25"><Check size={15} /></button>
            <button title="No, not me" onClick={() => act(f.id, () => mindApi.refute(f.id), "Got it — I won't think that")} disabled={busy[f.id]} className="grid place-items-center h-7 w-7 rounded-lg bg-rose-500/15 text-rose-600 hover:bg-rose-500/25"><X size={15} /></button>
            <button title="Add a note in your own words" onClick={() => { setNoting(f.id); setNoteDraft(''); }} disabled={busy[f.id]} className="grid place-items-center h-7 w-7 rounded-lg text-zinc-400 hover:text-violet-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><MessageSquarePlus size={14} /></button>
            <button title="Almost — fix it" onClick={() => { setEditing(f.id); setDraft(f.statement); }} disabled={busy[f.id]} className="grid place-items-center h-7 w-7 rounded-lg text-zinc-400 hover:text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil size={14} /></button>
            <button title={f.pinned ? 'Pinned' : 'Pin (never forget)'} onClick={() => mindApi.pin(f.id, !f.pinned).then(() => toast('success', f.pinned ? 'Unpinned' : 'Pinned'))} className={'grid place-items-center h-7 w-7 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (f.pinned ? 'text-amber-500' : 'text-zinc-400 hover:text-amber-500')}><Pin size={14} className={f.pinned ? 'fill-amber-400' : ''} /></button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 leading-relaxed">These are things I think I've noticed about you. Is each one really you? Tap ✓ if it's true (I'll trust it more), ✗ if it's wrong (I'll drop it), or ✎ to fix the wording.</p>
      {Object.entries(groups).map(([label, items]) => (
        <div key={label}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">{KIND_GROUP[Object.keys(KIND_GROUP).find((k) => KIND_GROUP[k].label === label) || '']?.emoji} {label}</div>
          <div className="space-y-2">{items.map((f) => card(f))}</div>
        </div>
      ))}
      {data.fading.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-500 mb-1.5 flex items-center gap-1"><HelpCircle size={12} /> Still you? (fading)</div>
          <div className="space-y-2">{data.fading.map((f) => card(f, true))}</div>
        </div>
      )}
    </div>
  );
}
