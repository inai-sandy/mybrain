import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Plus, X, Mic, Check, Circle, Star, Pencil, Trash2, Clock, Sparkles } from 'lucide-react';
import { DataTable, Column, Filter, SortOption } from '../ui/DataTable';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';

type Task = {
  id: string;
  title: string;
  note?: string | null;
  category?: string | null;
  tags: string[];
  priority: 'high' | 'medium' | 'low';
  pinned: boolean;
  estimateMin?: number | null;
  actualMin?: number | null;
  day?: string | null;
  status: 'open' | 'done';
  rolloverCount: number;
  createdAt: string;
  completedAt?: string | null;
};

type Today = {
  day: string;
  dumped: boolean;
  question: string | null;
  counts: { total: number; done: number; open: number };
  tasks: Task[];
};

const PRIO: Record<string, { label: string; cls: string; dot: string }> = {
  high: { label: 'High', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400', dot: 'bg-rose-500' },
  medium: { label: 'Med', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  low: { label: 'Low', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400', dot: 'bg-sky-500' },
};

function mins(n?: number | null): string {
  if (!n || n <= 0) return '';
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---- voice-to-text (browser Web Speech API; graceful if unsupported) ----
function useDictation(onText: (chunk: string) => void) {
  const recRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const SR = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  const supported = !!SR;

  function toggle() {
    if (!supported) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e: any) => {
      let chunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) chunk += e.results[i][0].transcript;
      }
      if (chunk.trim()) onText(chunk.trim() + ' ');
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }
  return { supported, listening, toggle };
}

function DumpModal({ onClose, onDone, initialQuestion }: { onClose: () => void; onDone: () => void; initialQuestion: string | null }) {
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold flex items-center gap-2">
            <Brain className="text-emerald-500" size={18} /> Dump your brain
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            <X size={18} />
          </button>
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
            <button
              onClick={toggle}
              title={listening ? 'Stop' : 'Speak'}
              className={'absolute right-2 top-2 p-2 rounded-full ' + (listening ? 'bg-rose-500 text-white animate-pulse' : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500 hover:text-emerald-600')}
            >
              <Mic size={16} />
            </button>
          )}
        </div>
        {supported && <p className="mt-1 text-[11px] text-zinc-400">{listening ? 'Listening… tap the mic to stop.' : 'Tap the mic to dictate.'}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={submit} disabled={busy || !text.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
            {busy ? 'Organizing…' : 'Make my tasks'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskFormModal({ task, onClose, onSaved }: { task: Task | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!task;
  const [title, setTitle] = useState(task?.title || '');
  const [category, setCategory] = useState(task?.category || '');
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [estimate, setEstimate] = useState(task?.estimateMin ? String(task.estimateMin) : '');
  const [tags, setTags] = useState((task?.tags || []).join(', '));
  const [note, setNote] = useState(task?.note || '');
  const [pinned, setPinned] = useState(!!task?.pinned);
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold">{editing ? 'Edit task' : 'Add task'}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
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
          <label className="text-sm text-zinc-600 dark:text-zinc-400 block">Tags
            <input value={tags} onChange={(e) => setTags(e.target.value)} className={inp} placeholder="comma, separated" />
          </label>
        </div>
        <label className="text-sm text-zinc-600 dark:text-zinc-400 block mt-3">Notes
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inp} placeholder="Any extra context…" />
        </label>
        <label className="flex items-center gap-2 mt-3 text-sm cursor-pointer">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
          <Star size={14} className="text-amber-500" /> Pin as a must-do today
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={save} disabled={busy || !title.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DoneModal({ task, onClose, onSaved }: { task: Task; onClose: () => void; onSaved: () => void }) {
  const [val, setVal] = useState(task.estimateMin ? String(task.estimateMin) : '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function finish(actualMin?: number) {
    setBusy(true);
    try {
      const r = await fetch(`/api/tasks/${task.id}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true, actualMin }) });
      if (r.ok) {
        toast('success', 'Nice — done ✓');
        onSaved();
        onClose();
      } else toast('error', 'Could not save');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-bold flex items-center gap-2"><Clock size={16} className="text-emerald-500" /> How long did it take?</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
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
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => finish(undefined)} disabled={busy} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Skip</button>
          <button onClick={() => finish(val ? Number(val) : undefined)} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">Done ✓</button>
        </div>
      </div>
    </div>
  );
}

export function Tasks() {
  const [data, setData] = useState<Today | null>(null);
  const [loading, setLoading] = useState(true);
  const [dumping, setDumping] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [doneFor, setDoneFor] = useState<Task | null>(null);
  const [delFor, setDelFor] = useState<Task | null>(null);
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const r = await fetch('/api/tasks/today');
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const tasks = data?.tasks || [];

  async function toggle(t: Task) {
    if (t.status === 'open') {
      setDoneFor(t);
      return;
    }
    const r = await fetch(`/api/tasks/${t.id}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: false }) });
    if (r.ok) load();
  }

  async function remove(t: Task) {
    const r = await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' });
    if (r.ok) {
      toast('success', 'Task deleted');
      load();
    } else toast('error', 'Could not delete');
    setDelFor(null);
  }

  const categories = useMemo(() => Array.from(new Set(tasks.map((t) => t.category).filter(Boolean))) as string[], [tasks]);

  const cols: Column<Task>[] = [
    { key: 'title', label: 'Task' },
    { key: 'category', label: 'Category' },
    { key: 'note', label: 'Notes' },
  ];
  const filters: Filter[] = [
    { key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] },
    { key: 'priority', label: 'Priority', options: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }] },
    ...(categories.length ? [{ key: 'category', label: 'Category', options: categories.map((c) => ({ value: c, label: c })) }] : []),
  ];
  const sortOptions: SortOption[] = [
    { label: 'Smart (pinned · priority)', key: 'createdAt', dir: 1 },
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Longest first', key: 'estimateMin', dir: -1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  function card(t: Task) {
    const p = PRIO[t.priority] || PRIO.medium;
    const done = t.status === 'done';
    return (
      <div className={'group rounded-xl border bg-white dark:bg-zinc-900 p-3.5 flex items-start gap-3 transition-all ' + (done ? 'opacity-60 border-zinc-200 dark:border-zinc-800' : 'border-zinc-200 dark:border-zinc-800 hover:border-emerald-500/40 hover:shadow-sm') + (t.pinned && !done ? ' ring-1 ring-amber-400/40' : '')}>
        <button onClick={() => toggle(t)} title={done ? 'Mark open' : 'Mark done'} className={'mt-0.5 shrink-0 ' + (done ? 'text-emerald-600' : 'text-zinc-300 dark:text-zinc-600 hover:text-emerald-600')}>
          {done ? <Check size={20} /> : <Circle size={20} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className={'font-medium leading-snug flex-1 ' + (done ? 'line-through text-zinc-400' : '')}>
              {t.pinned && <Star size={13} className="inline -mt-0.5 mr-1 text-amber-500 fill-amber-500" />}
              {t.title}
            </h3>
            <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => setEditing(t)} title="Edit" className="p-1 rounded text-zinc-400 hover:text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil size={14} /></button>
              <button onClick={() => setDelFor(t)} title="Delete" className="p-1 rounded text-zinc-400 hover:text-rose-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Trash2 size={14} /></button>
            </div>
          </div>
          {t.note && <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{t.note}</p>}
          <div className="flex items-center flex-wrap gap-1.5 mt-2 text-[11px]">
            <span className={'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ' + p.cls}><span className={'h-1.5 w-1.5 rounded-full ' + p.dot} />{p.label}</span>
            {t.category && <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-500">{t.category}</span>}
            {t.tags?.map((tag) => <span key={tag} className="text-zinc-400">#{tag}</span>)}
            {done && t.actualMin ? (
              <span className="ml-auto text-zinc-400">took {mins(t.actualMin)}{t.estimateMin ? ` · est ${mins(t.estimateMin)}` : ''}</span>
            ) : t.estimateMin ? (
              <span className="ml-auto inline-flex items-center gap-1 text-zinc-400"><Clock size={11} /> {mins(t.estimateMin)}</span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const c = data?.counts;
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><Brain className="text-emerald-500" /> Today</h1>
          <p className="text-zinc-500 text-sm">Dump your brain in the morning — get a clean, prioritized day.</p>
        </div>
        {c && c.total > 0 && (
          <div className="text-right shrink-0">
            <div className="text-2xl font-extrabold tabular-nums">{c.done}<span className="text-zinc-400 text-lg">/{c.total}</span></div>
            <div className="text-[11px] text-zinc-400">done today</div>
          </div>
        )}
      </div>

      {/* Brain-dump hero (shown until dumped) */}
      {!loading && !data?.dumped && (
        <button onClick={() => setDumping(true)} className="w-full rounded-2xl border border-dashed border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 p-6 text-center transition-colors">
          <Brain className="mx-auto text-emerald-500 mb-2" size={28} />
          <div className="font-semibold">🧠 Dump my brain</div>
          <p className="text-xs text-zinc-500 mt-1">{data?.question ? data.question : 'Type or speak everything on your mind — the AI builds your task list.'}</p>
        </button>
      )}

      {c && c.total > 0 && (
        <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((c.done / c.total) * 100)}%` }} />
        </div>
      )}

      <DataTable<Task>
        columns={cols}
        rows={tasks}
        loading={loading}
        filters={filters}
        sortOptions={sortOptions}
        renderCard={card}
        cardsOnly
        gridClassName="grid grid-cols-1 gap-2.5"
        pageSize={20}
        emptyText={data?.dumped ? 'All clear — no tasks today.' : 'No tasks yet — dump your brain to build today’s list.'}
      />

      {/* Floating actions */}
      <div className="fixed right-4 bottom-20 md:bottom-6 md:right-6 z-30 flex flex-col items-end gap-3">
        <button onClick={() => setAdding(true)} title="Add a task" className="inline-flex items-center justify-center rounded-full bg-zinc-800 dark:bg-zinc-700 hover:bg-zinc-700 text-white shadow-lg h-12 w-12">
          <Plus size={20} />
        </button>
        <button onClick={() => setDumping(true)} title="Dump my brain" className="inline-flex items-center gap-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 px-4 py-3">
          <Sparkles size={20} />
          <span className="hidden sm:inline font-medium pr-1">Dump my brain</span>
        </button>
      </div>

      {dumping && <DumpModal onClose={() => setDumping(false)} onDone={load} initialQuestion={data?.question || null} />}
      {adding && <TaskFormModal task={null} onClose={() => setAdding(false)} onSaved={load} />}
      {editing && <TaskFormModal task={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {doneFor && <DoneModal task={doneFor} onClose={() => setDoneFor(null)} onSaved={load} />}
      {delFor && <ConfirmDialog title="Delete task?" message={`“${delFor.title}” will be removed.`} confirmLabel="Delete" onConfirm={() => remove(delFor)} onCancel={() => setDelFor(null)} />}
    </div>
  );
}
