import { useEffect, useState } from 'react';
import { MessageSquareQuote, Sparkles, Trash2, Pencil, X, Loader2, Check, CheckCircle2 } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { DictateButton } from '../ui/DictateButton';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { MentionChips, useMentions } from '../ui/Mentions';

export type DraftTask = { title: string; note?: string; category?: string; priority?: 'high' | 'medium' | 'low'; estimateMin?: number };
export type Briefing = {
  id: string;
  rawText: string;
  summary?: string | null;
  createdAt: string;
  tasks: { id: string; title: string; status: string }[];
  taskCount: number;
  openCount: number;
};

const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Tell the story about someone once, and it becomes their work. Two steps on purpose: you see
 * exactly what will be created and can drop anything before a single task is saved. (BEA-1020)
 */
export function BriefModal({ contactId, contactName, onClose, onSaved }: { contactId: string; contactName: string; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [tasks, setTasks] = useState<DraftTask[] | null>(null);
  const [summary, setSummary] = useState('');
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const mentions = useMentions(text);

  async function readIt() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/contacts/${contactId}/briefings/draft`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (!r.ok) { toast('error', (await r.json().catch(() => ({}))).message || 'Could not read that'); return; }
      const d = await r.json();
      setTasks(d.tasks || []);
      setSummary(d.summary || '');
      setDropped(new Set());
    } catch { toast('error', 'Could not reach the server'); } finally { setBusy(false); }
  }

  async function save() {
    const keep = (tasks || []).filter((_, i) => !dropped.has(i));
    if (!keep.length) { toast('error', 'Keep at least one, or cancel'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/contacts/${contactId}/briefings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, summary, tasks: keep }),
      });
      if (!r.ok) { toast('error', (await r.json().catch(() => ({}))).message || 'Could not save'); return; }
      toast('success', `${keep.length} task${keep.length === 1 ? '' : 's'} added for ${contactName}`);
      onSaved();
      onClose();
    } catch { toast('error', 'Could not reach the server'); } finally { setBusy(false); }
  }

  const kept = (tasks || []).length - dropped.size;

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-bold"><MessageSquareQuote size={18} className="text-emerald-600" /> Brief me on {contactName}</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>

          {tasks === null ? (
            <>
              <p className="mb-3 text-xs text-zinc-500">Say the whole situation in your own words. I'll turn it into the things {contactName} owes you — you check them before anything is saved.</p>
              <div className="relative">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={7}
                  autoFocus
                  placeholder={`e.g. ${contactName} needs to finish the GST filing by Friday, and he still owes me the vendor list from last week. Loop in @someone if it involves them.`}
                  className="w-full resize-none rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 pr-11 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
                <div className="absolute right-2 top-2"><DictateButton onText={(t) => setText((v) => (v ? `${v} ${t}` : t))} /></div>
              </div>
              <MentionChips mentions={mentions} className="mt-2" />
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={close} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Cancel</button>
                <button onClick={readIt} disabled={busy || !text.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
                  {busy ? <><Loader2 size={14} className="animate-spin" /> Reading…</> : <><Sparkles size={14} /> Read it</>}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-3 text-xs text-zinc-500">
                Here's what I understood. Tap anything to drop it — <strong>nothing is saved yet</strong>.
              </p>
              {tasks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">I couldn't find anything actionable in that. Go back and add some detail.</div>
              ) : (
                <ul className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                  {tasks.map((t, i) => {
                    const off = dropped.has(i);
                    return (
                      <li key={i}>
                        <button
                          onClick={() => setDropped((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                          className={'flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition-colors ' + (off ? 'border-zinc-200 bg-zinc-50 opacity-50 dark:border-zinc-800 dark:bg-zinc-900/50' : 'border-emerald-500/40 bg-emerald-500/5')}
                        >
                          <span className={'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ' + (off ? 'border-zinc-300 dark:border-zinc-600' : 'border-emerald-500 bg-emerald-500')}>
                            {!off && <Check size={11} className="text-white" />}
                          </span>
                          <span className="min-w-0">
                            <span className={'block text-sm font-medium ' + (off ? 'text-zinc-400 line-through' : '')}>{t.title}</span>
                            {t.note && <span className="mt-0.5 block text-xs text-zinc-500">{t.note}</span>}
                            <span className="mt-1 flex flex-wrap gap-1 text-[10px]">
                              {t.priority && <span className="rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-zinc-500">{t.priority}</span>}
                              {t.category && <span className="rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-zinc-500">{t.category}</span>}
                              {t.estimateMin ? <span className="rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-zinc-500">{t.estimateMin}m</span> : null}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mt-4 flex items-center justify-between gap-2">
                <button onClick={() => setTasks(null)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">← Reword</button>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{kept} of {tasks.length} kept</span>
                  <button onClick={save} disabled={busy || !kept} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
                    {busy ? 'Saving…' : `Add ${kept} task${kept === 1 ? '' : 's'}`}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** Every situation you've told me about this person, newest first. (BEA-1020) */
export function BriefingsTab({ contactId, contactName, reload }: { contactId: string; contactName: string; reload: number }) {
  const [rows, setRows] = useState<Briefing[] | null>(null);
  const [editing, setEditing] = useState<Briefing | null>(null);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<Briefing | null>(null);
  const toast = useToast();

  const load = () =>
    fetch(`/api/contacts/${contactId}/briefings`)
      .then((r) => (r.ok ? r.json() : { briefings: [] }))
      .then((d) => setRows(d.briefings || []))
      .catch(() => setRows([]));

  useEffect(() => { setRows(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [contactId, reload]);

  async function saveEdit() {
    if (!editing || !draft.trim()) return;
    const r = await fetch(`/api/briefings/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawText: draft }) });
    if (r.ok) { toast('success', 'Briefing updated'); setEditing(null); load(); } else toast('error', 'Could not save');
  }

  async function remove(b: Briefing) {
    const r = await fetch(`/api/briefings/${b.id}`, { method: 'DELETE' });
    if (r.ok) { const d = await r.json().catch(() => ({ keptTasks: 0 })); toast('success', `Briefing deleted — ${d.keptTasks || 0} task${d.keptTasks === 1 ? '' : 's'} kept`); load(); }
    else toast('error', 'Could not delete');
    setConfirm(null);
  }

  if (rows === null) return <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>;

  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
        <MessageSquareQuote className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
        <p className="text-sm text-zinc-500">You haven't briefed me on {contactName} yet.</p>
        <p className="mt-1 text-xs text-zinc-400">Tell me the situation once and I'll turn it into their tasks.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-3">
        {rows.map((b) => (
          <li key={b.id} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{b.summary || 'Briefing'}</p>
                <p className="text-[11px] text-zinc-400">{fmt(b.createdAt)} · {b.taskCount} task{b.taskCount === 1 ? '' : 's'}{b.taskCount ? ` · ${b.openCount} still open` : ''}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => { setEditing(b); setDraft(b.rawText); }} aria-label="Edit briefing" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><Pencil size={14} /></button>
                <button onClick={() => setConfirm(b)} aria-label="Delete briefing" className="p-1 text-zinc-400 hover:text-rose-500"><Trash2 size={14} /></button>
              </div>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">{b.rawText}</p>
            {b.tasks.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                {b.tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-1.5 text-xs">
                    <CheckCircle2 className={'h-3 w-3 shrink-0 ' + (t.status === 'done' ? 'text-emerald-500' : 'text-zinc-300 dark:text-zinc-600')} />
                    <span className={t.status === 'done' ? 'text-zinc-400 line-through' : 'text-zinc-600 dark:text-zinc-300'}>{t.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <Sheet onClose={() => setEditing(null)}>
          {(close) => (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-bold">Edit briefing</h3>
                <button onClick={close} aria-label="Close" className="p-1 text-zinc-400"><X size={18} /></button>
              </div>
              <p className="mb-2 text-xs text-zinc-500">Fixing the wording won't create the tasks again.</p>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={7} className="w-full resize-none rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950" />
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={close} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Cancel</button>
                <button onClick={saveEdit} disabled={!draft.trim()} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">Save</button>
              </div>
            </div>
          )}
        </Sheet>
      )}

      {confirm && (
        <ConfirmDialog
          title="Delete this briefing?"
          message={`The ${confirm.taskCount} task${confirm.taskCount === 1 ? '' : 's'} it created will be kept — only the note goes.`}
          confirmLabel="Delete"
          onConfirm={() => remove(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
