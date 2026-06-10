import { useState } from 'react';
import { Brain, X, Mic, Check, Circle, Star, Pencil, Trash2, Clock, Bell, RotateCcw, CalendarClock } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { useDictation, isDictating } from '../ui/useDictation';
import { Sheet } from '../ui/Sheet';
import { motion } from 'framer-motion';

export type Task = {
  id: string;
  title: string;
  note?: string | null;
  category?: string | null;
  tags: string[];
  priority: 'high' | 'medium' | 'low';
  pinned: boolean;
  estimateMin?: number | null;
  actualMin?: number | null;
  reminderCount?: number;
  reminders?: string[];
  day?: string | null;
  status: 'open' | 'done';
  progress?: number; // 0 | 30 | 60 | 100
  followUp?: boolean;
  rolloverCount: number;
  createdAt: string;
  completedAt?: string | null;
};

export type TodayData = {
  day: string;
  dumped: boolean;
  question: string | null;
  counts: { total: number; done: number; open: number };
  tasks: Task[];
};

export const PRIO: Record<string, { label: string; cls: string; dot: string }> = {
  high: { label: 'High', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400', dot: 'bg-rose-500' },
  medium: { label: 'Med', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  low: { label: 'Low', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400', dot: 'bg-sky-500' },
};

export function mins(n?: number | null): string {
  if (!n || n <= 0) return '';
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---- the task card (presentational; actions via callbacks) ----
export function TaskCard({ t, onToggle, onEdit, onDelete, onProgress }: { t: Task; onToggle: (t: Task) => void; onEdit: (t: Task) => void; onDelete: (t: Task) => void; onProgress?: (t: Task, pct: number) => void }) {
  const p = PRIO[t.priority] || PRIO.medium;
  const done = t.status === 'done';
  const prog = t.progress ?? 0;
  return (
    <div className={'group rounded-xl border bg-white dark:bg-zinc-900 p-3.5 flex items-start gap-3 transition-all ' + (done ? 'opacity-60 border-zinc-200 dark:border-zinc-800' : 'border-zinc-200 dark:border-zinc-800 hover:border-emerald-500/40 hover:shadow-sm') + (t.pinned && !done ? ' ring-1 ring-amber-400/40' : '')}>
      <button onClick={() => onToggle(t)} title={done ? 'Mark open' : 'Mark done'} className={'mt-0.5 shrink-0 ' + (done ? 'text-emerald-600' : 'text-zinc-300 dark:text-zinc-600 hover:text-emerald-600')}>
        {done ? (
          <motion.span initial={{ scale: 0, rotate: -25 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 16 }} className="inline-flex">
            <Check size={20} />
          </motion.span>
        ) : (
          <Circle size={20} />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <h3 className={'font-medium leading-snug flex-1 ' + (done ? 'line-through text-zinc-400' : '')}>
            {t.pinned && <Star size={13} className="inline -mt-0.5 mr-1 text-amber-500 fill-amber-500" />}
            {t.followUp && <RotateCcw size={12} className="inline -mt-0.5 mr-1 text-indigo-500" />}
            {t.title}
          </h3>
          <div className="flex items-center gap-0.5 shrink-0 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
            <button onClick={() => onEdit(t)} title="Edit" className="p-1 rounded text-zinc-400 hover:text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil size={14} /></button>
            <button onClick={() => onDelete(t)} title="Delete" className="p-1 rounded text-zinc-400 hover:text-rose-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Trash2 size={14} /></button>
          </div>
        </div>
        {t.note && <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{t.note}</p>}
        <div className="flex items-center flex-wrap gap-1.5 mt-2 text-[11px]">
          <span className={'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ' + p.cls}><span className={'h-1.5 w-1.5 rounded-full ' + p.dot} />{p.label}</span>
          {!done && t.rolloverCount > 0 && (
            <span title={`Carried forward ${t.rolloverCount} day${t.rolloverCount === 1 ? '' : 's'}`} className={'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ' + (t.rolloverCount >= 2 ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>
              <RotateCcw size={10} /> {t.rolloverCount >= 2 ? `carried ${t.rolloverCount}d` : 'carried'}
            </span>
          )}
          {t.category && <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-500">{t.category}</span>}
          {!!t.reminderCount && t.reminderCount > 0 && (
            <span title={(t.reminders || []).join(', ')} className="inline-flex items-center gap-0.5 text-zinc-400"><Bell size={10} /> {t.reminderCount}</span>
          )}
          {t.tags?.map((tag) => <span key={tag} className="text-zinc-400">#{tag}</span>)}
          {done && t.actualMin ? (
            <span className="ml-auto text-zinc-400">took {mins(t.actualMin)}{t.estimateMin ? ` · est ${mins(t.estimateMin)}` : ''}</span>
          ) : t.estimateMin ? (
            <span className="ml-auto inline-flex items-center gap-1 text-zinc-400"><Clock size={11} /> {mins(t.estimateMin)}</span>
          ) : null}
        </div>
        {!done && onProgress && (
          <div className="flex items-center gap-2 mt-2.5">
            <div className="flex-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${prog}%` }} />
            </div>
            {[30, 60].map((pct) => (
              <button
                key={pct}
                onClick={() => onProgress(t, prog === pct ? 0 : pct)}
                title={prog === pct ? 'Clear progress' : `Mark ${pct}% done`}
                className={'rounded-full px-2 py-0.5 text-[11px] font-medium border transition-colors ' + (prog === pct ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500 hover:text-emerald-600')}
              >
                {pct}%
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- brain-dump modal (type or speak) ----
export function DumpModal({ onClose, onDone, initialQuestion }: { onClose: () => void; onDone: () => void; initialQuestion: string | null }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState<string | null>(initialQuestion);
  const toast = useToast();
  const { supported, listening, toggle } = useDictation((chunk) => setText((t) => (t ? t + ' ' : '') + chunk));

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/tasks/dump', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('error', d.message || 'Could not process');
        return;
      }
      if (d.question && (!d.tasks || d.tasks.length === 0)) {
        setQuestion(d.question);
        toast('error', 'Need a bit more detail');
        return;
      }
      toast('success', `${d.tasks?.length || 0} task${d.tasks?.length === 1 ? '' : 's'} created`);
      onDone();
      onClose();
    } catch {
      toast('error', 'Could not process');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} canClose={() => !isDictating()}>
      {(close) => (
        <>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold flex items-center gap-2"><Brain className="text-emerald-500" size={18} /> Dump your brain</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          <p className="text-xs text-zinc-500 mb-3">Type or speak everything on your mind — the AI turns it into clean, prioritized tasks for today.</p>
          {question && (
            <div className="mb-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <span className="font-medium">One question: </span>{question}
            </div>
          )}
          <div className="relative">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder="e.g. need to finish the beakn proposal, call the accountant before noon, gym in the evening, read up on rag eval…"
              className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 pr-12 text-sm outline-none focus:border-emerald-500"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
              }}
            />
            {supported && (
              <button onClick={toggle} title={listening ? 'Stop' : 'Speak'} className={'absolute right-2 top-2 p-2 rounded-full ' + (listening ? 'bg-rose-500 text-white animate-pulse' : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500 hover:text-emerald-600')}>
                <Mic size={16} />
              </button>
            )}
          </div>
          {supported && <p className="mt-1 text-[11px] text-zinc-400">{listening ? 'Listening… just speak; it finishes when you pause.' : 'Tap the mic and speak — no need to stop.'}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={close} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
            <button onClick={submit} disabled={busy || !text.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
              {busy ? 'Organizing…' : 'Make my tasks'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ---- add / edit task ----
export function TaskFormModal({ task, onClose, onSaved }: { task: Task | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!task;
  const [title, setTitle] = useState(task?.title || '');
  const [category, setCategory] = useState(task?.category || '');
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [estimate, setEstimate] = useState(task?.estimateMin ? String(task.estimateMin) : '');
  const [tags, setTags] = useState((task?.tags || []).join(', '));
  const [note, setNote] = useState(task?.note || '');
  const [pinned, setPinned] = useState(!!task?.pinned);
  const [reminders, setReminders] = useState(task?.reminderCount ?? 0);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    const body = {
      title,
      category: category.trim() || undefined,
      priority,
      estimateMin: estimate ? Number(estimate) : undefined,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      note: note.trim() || undefined,
      pinned,
      reminderCount: reminders,
    };
    try {
      const r = editing
        ? await fetch(`/api/tasks/${task!.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) {
        toast('success', editing ? 'Task updated' : 'Task added');
        onSaved();
        onClose();
      } else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const inp = 'w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500';
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold">{editing ? 'Edit task' : 'Add task'}</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          <label className="text-sm text-zinc-600 dark:text-zinc-400 block">Title
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={inp} placeholder="What needs doing?" />
          </label>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="text-sm text-zinc-600 dark:text-zinc-400 block">Category
              <input value={category} onChange={(e) => setCategory(e.target.value)} className={inp} placeholder="Beakn, Admin…" />
            </label>
            <label className="text-sm text-zinc-600 dark:text-zinc-400 block">Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value as any)} className={inp}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="text-sm text-zinc-600 dark:text-zinc-400 block">Estimate (min)
              <input type="number" min={1} value={estimate} onChange={(e) => setEstimate(e.target.value)} className={inp} placeholder="30" />
            </label>
            <label className="text-sm text-zinc-600 dark:text-zinc-400 block">Reminders
              <select value={reminders} onChange={(e) => setReminders(Number(e.target.value))} className={inp}>
                <option value={0}>None</option>
                <option value={1}>1 reminder</option>
                <option value={2}>2 reminders</option>
                <option value={3}>3 reminders</option>
                <option value={4}>4 reminders</option>
              </select>
            </label>
          </div>
          <p className="text-[11px] text-zinc-400 mt-1">The AI picks smart times based on priority. Reminders are delivered via Telegram.</p>
          <label className="text-sm text-zinc-600 dark:text-zinc-400 block mt-3">Tags
            <input value={tags} onChange={(e) => setTags(e.target.value)} className={inp} placeholder="comma, separated" />
          </label>
          <label className="text-sm text-zinc-600 dark:text-zinc-400 block mt-3">Notes
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inp} placeholder="Any extra context…" />
          </label>
          <label className="flex items-center gap-2 mt-3 text-sm cursor-pointer">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
            <Star size={14} className="text-amber-500" /> Pin as a must-do today
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={close} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
            <button onClick={save} disabled={busy || !title.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ---- "how long did it take?" + optional follow-up, on completion ----
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function prettyDate(s: string): string {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function DoneModal({ task, onClose, onSaved }: { task: Task; onClose: () => void; onSaved: () => void }) {
  const [val, setVal] = useState(task.estimateMin ? String(task.estimateMin) : '');
  const [wantFollow, setWantFollow] = useState(false);
  const [fuDate, setFuDate] = useState(addDays(2));
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function finish(actualMin?: number) {
    setBusy(true);
    const followUpDate = wantFollow ? fuDate : undefined;
    try {
      const r = await fetch(`/api/tasks/${task.id}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true, actualMin, followUpDate }) });
      if (r.ok) {
        toast('success', followUpDate ? `Done ✓ · follow-up set for ${prettyDate(followUpDate)}` : 'Nice — done ✓');
        onSaved();
        onClose();
      } else toast('error', 'Could not save');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const quick = [
    { label: 'Tomorrow', date: addDays(1) },
    { label: 'In 2 days', date: addDays(2) },
    { label: 'In a week', date: addDays(7) },
  ];

  return (
    <Sheet onClose={onClose} size="sm">
      {(close) => (
        <>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold flex items-center gap-2"><Clock size={16} className="text-emerald-500" /> How long did it take?</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          <p className="text-xs text-zinc-500 mb-3 line-clamp-1">“{task.title}”{task.estimateMin ? ` · est. ${mins(task.estimateMin)}` : ''}</p>
          <div className="flex items-center gap-2">
            <input type="number" min={1} autoFocus value={val} onChange={(e) => setVal(e.target.value)} className="w-24 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
            <span className="text-sm text-zinc-500">minutes</span>
            <div className="flex gap-1 ml-auto">
              {[15, 30, 60].map((q) => (
                <button key={q} onClick={() => setVal(String(q))} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs hover:border-emerald-500">{q}m</button>
              ))}
            </div>
          </div>

          {/* Follow-up */}
          <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium flex items-center gap-1.5"><CalendarClock size={15} className="text-indigo-500" /> Need a follow-up?</span>
              <div className="flex gap-1">
                <button onClick={() => setWantFollow(false)} className={'rounded-lg px-3 py-1 text-sm border ' + (!wantFollow ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border-transparent' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500')}>No</button>
                <button onClick={() => setWantFollow(true)} className={'rounded-lg px-3 py-1 text-sm border ' + (wantFollow ? 'bg-indigo-600 text-white border-transparent' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500')}>Yes</button>
              </div>
            </div>
            {wantFollow && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {quick.map((q) => (
                    <button key={q.date} onClick={() => setFuDate(q.date)} className={'rounded-full px-3 py-1 text-xs border ' + (fuDate === q.date ? 'bg-indigo-600 text-white border-transparent' : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-indigo-500')}>{q.label}</button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400">or pick a date</span>
                  <input type="date" min={addDays(1)} value={fuDate} onChange={(e) => e.target.value && setFuDate(e.target.value)} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-sm outline-none focus:border-indigo-500" />
                </div>
                <p className="text-[11px] text-zinc-400">I'll add “Follow up: {task.title}” to {prettyDate(fuDate)} and nudge you on Telegram that morning.</p>
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => finish(undefined)} disabled={busy} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Skip time</button>
            <button onClick={() => finish(val ? Number(val) : undefined)} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">Done ✓</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ---- shared loader + actions hook ----
export function useToday() {
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  async function load() {
    // NOTE: no setLoading(true) on refresh — keep current content on screen so scroll position survives
    try {
      const r = await fetch('/api/tasks/today');
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }
  return { data, loading, load, setData };
}
