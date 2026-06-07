import { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Plus, Sparkles, Search, X } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Task, TaskCard, DumpModal, TaskFormModal, DoneModal, useToday } from './taskShared';

export function Tasks() {
  const { data, loading, load } = useToday();
  const [dumping, setDumping] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [doneFor, setDoneFor] = useState<Task | null>(null);
  const [delFor, setDelFor] = useState<Task | null>(null);

  const [showDone, setShowDone] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [q, setQ] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fCategory, setFCategory] = useState('');

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tasks = data?.tasks || [];
  const categories = useMemo(() => Array.from(new Set(tasks.map((t) => t.category).filter(Boolean))) as string[], [tasks]);

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
    if (r.ok) load();
    setDelFor(null);
  }

  // filter
  const filtered = useMemo(() => {
    let list = tasks;
    if (!showDone) list = list.filter((t) => t.status === 'open');
    if (q.trim()) {
      const s = q.toLowerCase();
      list = list.filter((t) => [t.title, t.category, ...(t.tags || [])].join(' ').toLowerCase().includes(s));
    }
    if (fPriority) list = list.filter((t) => t.priority === fPriority);
    if (fCategory) list = list.filter((t) => t.category === fCategory);
    return list;
  }, [tasks, showDone, q, fPriority, fCategory]);

  // group: must-dos → High → Medium → Low → Done
  const groups = useMemo(() => {
    const open = filtered.filter((t) => t.status === 'open');
    const g: { key: string; label: string; items: Task[] }[] = [
      { key: 'pin', label: '⭐️ Must-dos', items: open.filter((t) => t.pinned) },
      { key: 'high', label: 'High', items: open.filter((t) => !t.pinned && t.priority === 'high') },
      { key: 'medium', label: 'Medium', items: open.filter((t) => !t.pinned && t.priority === 'medium') },
      { key: 'low', label: 'Low', items: open.filter((t) => !t.pinned && t.priority === 'low') },
    ];
    if (showDone) g.push({ key: 'done', label: 'Done', items: filtered.filter((t) => t.status === 'done') });
    return g.filter((x) => x.items.length);
  }, [filtered, showDone]);

  const openCount = tasks.filter((t) => t.status === 'open').length;
  const hasFilters = !!(q || fPriority || fCategory);
  const chip = (active: boolean) =>
    'shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs border transition-colors ' +
    (active ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 font-medium' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-emerald-500/40');
  const PR = [
    { v: '', label: 'All' },
    { v: 'high', label: 'High' },
    { v: 'medium', label: 'Med' },
    { v: 'low', label: 'Low' },
  ];

  return (
    <div className="space-y-3">
      {/* Header: title + count + search/done toggles */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><CheckSquare className="text-emerald-500" /> Tasks</h1>
          <p className="text-zinc-500 text-sm">{openCount} to do{data && data.counts.done ? ` · ${data.counts.done} done today` : ''}</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowSearch((v) => !v)} aria-label="Search" className={'p-2 rounded-lg border ' + (showSearch || q ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
            <Search size={16} />
          </button>
          <button onClick={() => setShowDone((v) => !v)} className={'rounded-lg px-2.5 py-1.5 text-xs border ' + (showDone ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
            {showDone ? 'Hide done' : 'Show done'}
          </button>
        </div>
      </div>

      {/* Optional search box (behind the icon) */}
      {showSearch && (
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
        </div>
      )}

      {/* Always-visible filters: priority + category */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="text-[11px] text-zinc-400 shrink-0 mr-0.5">Priority</span>
          {PR.map((p) => (
            <button key={p.v} onClick={() => setFPriority(p.v)} className={chip(fPriority === p.v)}>{p.label}</button>
          ))}
        </div>
        {categories.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="text-[11px] text-zinc-400 shrink-0 mr-0.5">Category</span>
            <button onClick={() => setFCategory('')} className={chip(fCategory === '')}>All</button>
            {categories.map((c) => (
              <button key={c} onClick={() => setFCategory(c)} className={chip(fCategory === c)}>{c}</button>
            ))}
          </div>
        )}
        {hasFilters && (
          <button onClick={() => { setQ(''); setFPriority(''); setFCategory(''); setShowSearch(false); }} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-rose-600"><X size={12} /> clear filters</button>
        )}
      </div>

      {/* The list — clean, grouped, must-dos on top */}
      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : groups.length ? (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="flex items-center gap-2 mb-2">
                <span className={'text-xs font-semibold ' + (g.key === 'pin' ? 'text-amber-600' : g.key === 'done' ? 'text-zinc-400' : 'text-zinc-500')}>{g.label}</span>
                <span className="text-[11px] text-zinc-400">{g.items.length}</span>
                <span className="flex-1 h-px bg-zinc-100 dark:bg-zinc-800" />
              </div>
              <div className="space-y-2.5">
                {g.items.map((t) => <TaskCard key={t.id} t={t} onToggle={toggle} onEdit={setEditing} onDelete={setDelFor} />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-10 text-center text-sm text-zinc-400">
          {hasFilters ? 'No tasks match.' : data?.dumped ? 'All clear — nothing left to do. 🎉' : 'No tasks yet — tap 🧠 to dump your brain.'}
        </div>
      )}

      {/* Floating capture buttons */}
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
