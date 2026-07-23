import { useCallback, useEffect, useState } from 'react';
import { Brain, Plus, X, Loader2, Check, Sparkles } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DictateButton } from '../ui/DictateButton';
import { TaskFormModal, TaskCard, DoneModal, type Task } from './taskShared';

/**
 * Brain Eaters (BEA-1056) — the owner's own words: the things that "keep coming to my brain every
 * time and somehow get skipped… very important to finish for a peaceful sleep." A separate home,
 * dumped the way he always dumps, auto-spotted from tasks that keep rolling over, and finished
 * LOUDLY.
 */
export function BrainEatersTab({ onCountChange }: { onCountChange?: (open: number) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [candidates, setCandidates] = useState<{ id: string; title: string; carried: number }[]>([]);
  const [dumping, setDumping] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [doneFor, setDoneFor] = useState<Task | null>(null);
  const [confirm, setConfirm] = useState<Task | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null); // title just destroyed
  const toast = useToast();

  const load = useCallback(
    () =>
      fetch('/api/tasks/brain-eaters')
        .then((r) => (r.ok ? r.json() : { tasks: [], candidates: [], openCount: 0 }))
        .then((d) => {
          setTasks(d.tasks || []);
          setCandidates(d.candidates || []);
          onCountChange?.(d.openCount ?? 0);
        })
        .catch(() => setTasks([])),
    [onCountChange],
  );
  useEffect(() => { load(); }, [load]);

  async function toggle(t: Task) {
    if (t.status === 'open') { setDoneFor(t); return; } // the done sheet logs time, then we celebrate
    const r = await fetch(`/api/tasks/${t.id}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: false }) });
    if (r.ok) load();
  }

  async function unmark(t: Task) {
    await fetch('/api/tasks/brain-eaters/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [t.id], on: false }) }).catch(() => undefined);
    toast('success', 'Moved back to normal tasks');
    load();
  }

  async function remove(t: Task) {
    const r = await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' });
    toast(r.ok ? 'success' : 'error', r.ok ? 'Removed' : 'Could not remove');
    setConfirm(null);
    load();
  }

  async function adopt(id: string, yes: boolean) {
    if (yes) {
      await fetch('/api/tasks/brain-eaters/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], on: true }) }).catch(() => undefined);
      toast('success', 'Moved in — it will not escape again');
    }
    setCandidates((cs) => cs.filter((c) => c.id !== id));
    if (yes) load();
  }

  const open = (tasks || []).filter((t) => t.status !== 'done');
  const done = (tasks || []).filter((t) => t.status === 'done');

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-fuchsia-400/30 bg-gradient-to-br from-fuchsia-500/10 via-violet-500/5 to-transparent p-4">
        <h2 className="flex items-center gap-2 font-bold"><Brain size={18} className="text-fuchsia-500" /> Brain Eaters</h2>
        <p className="mt-0.5 text-xs text-zinc-500">The things that circle your head and keep getting skipped. Finish them for a peaceful sleep — each finish is celebrated in your night story.</p>
      </div>

      {/* Auto-spotted: work that keeps rolling over is exactly what eats the brain. Owner confirms. */}
      {candidates.length > 0 && (
        <section className="rounded-xl border border-amber-300/50 bg-amber-500/5 p-3 dark:border-amber-500/30">
          <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">These keep slipping — are they brain eaters?</p>
          <ul className="space-y-1.5">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{c.title}</p>
                  <p className="text-[11px] text-zinc-400">carried {c.carried} days</p>
                </div>
                <button onClick={() => adopt(c.id, true)} className="shrink-0 rounded-lg bg-fuchsia-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-fuchsia-500">Yes, move it</button>
                <button onClick={() => adopt(c.id, false)} className="shrink-0 rounded-lg border border-zinc-300 px-2 py-1 text-xs text-zinc-500 dark:border-zinc-700">No</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tasks === null ? (
        <div className="space-y-2.5">{[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : open.length === 0 && done.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <p className="text-sm font-medium">Nothing is eating your brain right now 🎉</p>
          <p className="mt-1 text-xs text-zinc-500">When something starts circling, dump it here and it can't escape.</p>
        </div>
      ) : (
        <>
          <div className="space-y-2.5">
            {open.map((t) => (
              <TaskCard key={t.id} t={t} onToggle={toggle} onEdit={setEditing} onDelete={setConfirm} extraAction={{ label: 'Back to normal', onClick: () => unmark(t) }} />
            ))}
          </div>
          {done.length > 0 && (
            <details className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-sm text-zinc-500">Destroyed ({done.length}) 🏆</summary>
              <ul className="mt-2 space-y-1.5">
                {done.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-sm text-zinc-400">
                    <Check size={14} className="shrink-0 text-emerald-500" /> <span className="line-through">{t.title}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <button onClick={() => setDumping(true)} className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-fuchsia-600 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-fuchsia-500 md:bottom-8 md:right-24">
        <Plus className="h-4 w-4" /> Dump brain eaters
      </button>

      {dumping && <EaterDumpModal onClose={() => setDumping(false)} onDone={load} />}
      {editing && <TaskFormModal task={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {doneFor && (
        <DoneModal
          task={doneFor}
          onClose={() => setDoneFor(null)}
          onSaved={() => {
            setCelebrate(doneFor.title); // the loud finish — it earned it
            setTimeout(() => setCelebrate(null), 3500);
            setDoneFor(null);
            load();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog title="Remove this brain eater?" message={`“${confirm.title}” will be deleted.`} confirmLabel="Remove" onConfirm={() => remove(confirm)} onCancel={() => setConfirm(null)} />
      )}

      {/* The celebration — finishing one of these deserves noise. */}
      {celebrate && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6" onClick={() => setCelebrate(null)}>
          <div className="animate-bounce rounded-2xl border border-fuchsia-400/50 bg-white p-6 text-center shadow-2xl dark:bg-zinc-900">
            <div className="text-5xl">🧠⚡</div>
            <p className="mt-2 text-lg font-extrabold">Brain eater destroyed!</p>
            <p className="mt-1 max-w-xs text-sm text-zinc-500">“{celebrate}” has been circling your head — not any more. Sleep well tonight. It goes in your story.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Dump the nagging things the way you always dump — speak or type, AI splits them. */
function EaterDumpModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const appendText = (chunk: string) => setText((t) => (t ? t + ' ' : '') + chunk);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/tasks/brain-eaters/dump', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('error', d.message || 'Could not process');
        return;
      }
      toast('success', `${d.created} brain eater${d.created === 1 ? '' : 's'} captured — they can't escape now`);
      onDone();
      onClose();
    } catch {
      toast('error', 'Could not process');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-bold"><Brain size={17} className="text-fuchsia-500" /> Dump the brain eaters</h3>
          <button onClick={onClose} disabled={busy} className="p-1 text-zinc-400 hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Speak or type everything that keeps circling — the AI splits it into separate items.</p>
        <div className="relative">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} autoFocus
            placeholder="The insurance renewal keeps nagging me… I still haven't called the CA about the filing… that broken door at the factory…"
            className="w-full resize-y rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 pr-12 text-sm outline-none focus:border-fuchsia-500 dark:border-zinc-700 dark:bg-zinc-950" />
          <DictateButton onText={appendText} className="absolute right-2 top-2" />
        </div>
        <button onClick={submit} disabled={!text.trim() || busy} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-fuchsia-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-fuchsia-500 disabled:opacity-50">
          {busy ? (<><Loader2 size={15} className="animate-spin" /> Splitting…</>) : (<><Sparkles size={15} /> Capture them</>)}
        </button>
      </div>
    </div>
  );
}
