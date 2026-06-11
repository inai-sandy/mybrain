import { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Plus, Sparkles, Search, X, CalendarDays, CheckCircle2, Star, StickyNote, ChevronDown } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Task, TaskCard, DumpModal, DumpReviewSheet, TaskFormModal, DoneModal, useToday, mins, sortTasksBy } from './taskShared';

export function Tasks() {
  const { data, loading, load } = useToday();
  const [dumping, setDumping] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [doneFor, setDoneFor] = useState<Task | null>(null);
  const [delFor, setDelFor] = useState<Task | null>(null);
  const [review, setReview] = useState<Task[] | null>(null);

  const [showDone, setShowDone] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [history, setHistory] = useState(false);
  const [q, setQ] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [sort, setSortRaw] = useState<string>(() => localStorage.getItem('tasks-sort') || 'newest');
  function setSort(v: string) {
    setSortRaw(v);
    localStorage.setItem('tasks-sort', v);
  }

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
  async function progress(t: Task, pct: number) {
    const r = await fetch(`/api/tasks/${t.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: pct }) });
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

  // group: priority view = must-dos → High → Medium → Low; date views = one flat list. Done at the bottom either way.
  const groups = useMemo(() => {
    const open = filtered.filter((t) => t.status === 'open');
    const g: { key: string; label: string; items: Task[] }[] =
      sort === 'priority'
        ? [
            { key: 'pin', label: '⭐️ Must-dos', items: open.filter((t) => t.pinned) },
            { key: 'high', label: 'High', items: open.filter((t) => !t.pinned && t.priority === 'high') },
            { key: 'medium', label: 'Medium', items: open.filter((t) => !t.pinned && t.priority === 'medium') },
            { key: 'low', label: 'Low', items: open.filter((t) => !t.pinned && t.priority === 'low') },
          ]
        : [{ key: 'open', label: sort === 'oldest' ? 'Oldest first' : 'Newest first', items: sortTasksBy(open, sort) }];
    if (showDone) {
      const done = filtered.filter((t) => t.status === 'done');
      g.push({ key: 'done', label: 'Done', items: sort === 'priority' ? done : sortTasksBy(done, sort) });
    }
    return g.filter((x) => x.items.length);
  }, [filtered, showDone, sort]);

  const openCount = tasks.filter((t) => t.status === 'open').length;
  const hasFilters = !!(q || fPriority || fCategory);
  const sel = 'rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm outline-none focus:border-emerald-500';

  return (
    <div className="space-y-3">
      {/* Header: title + count + search/done toggles */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><CheckSquare className="text-emerald-500" /> Tasks</h1>
          <p className="text-zinc-500 text-sm">{openCount} to do{data && data.counts.done ? ` · ${data.counts.done} done today` : ''}</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setHistory((v) => !v)} title="Finished-tasks calendar" aria-label="History calendar" className={'p-2 rounded-lg border ' + (history ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
            <CalendarDays size={16} />
          </button>
          {!history && (
            <>
              <button onClick={() => setShowSearch((v) => !v)} aria-label="Search" className={'p-2 rounded-lg border ' + (showSearch || q ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
                <Search size={16} />
              </button>
              <button onClick={() => setShowDone((v) => !v)} className={'rounded-lg px-2.5 py-1.5 text-xs border ' + (showDone ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
                {showDone ? 'Hide done' : 'Show done'}
              </button>
            </>
          )}
        </div>
      </div>

      {history && <TaskHistory />}

      {/* Optional search box (behind the icon) */}
      {!history && showSearch && (
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
        </div>
      )}

      {/* Always-visible dropdown filters: priority + category */}
      {!history && (
      <div className="flex items-center gap-2 flex-wrap">
        <select aria-label="Filter by priority" value={fPriority} onChange={(e) => setFPriority(e.target.value)} className={sel}>
          <option value="">All priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select aria-label="Filter by category" value={fCategory} onChange={(e) => setFCategory(e.target.value)} className={sel}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label="Sort tasks" value={sort} onChange={(e) => setSort(e.target.value)} className={sel}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="priority">By priority</option>
        </select>
        {hasFilters && (
          <button onClick={() => { setQ(''); setFPriority(''); setFCategory(''); setShowSearch(false); }} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-rose-600"><X size={12} /> clear</button>
        )}
      </div>
      )}

      {/* The list — clean, grouped, must-dos on top */}
      {!history && (loading ? (
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
                {g.items.map((t) => <TaskCard key={t.id} t={t} onToggle={toggle} onEdit={setEditing} onDelete={setDelFor} onProgress={progress} />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-10 text-center text-sm text-zinc-400">
          {hasFilters ? 'No tasks match.' : data?.dumped ? 'All clear — nothing left to do. 🎉' : 'No tasks yet — tap 🧠 to dump your brain.'}
        </div>
      ))}

      {/* Floating capture buttons */}
      <div className="fixed right-4 bottom-[calc(10rem+env(safe-area-inset-bottom))] md:bottom-24 md:right-6 z-30 flex flex-col items-end gap-3">
        <button onClick={() => setAdding(true)} title="Add a task" className="inline-flex items-center justify-center rounded-full bg-zinc-800 dark:bg-zinc-700 hover:bg-zinc-700 text-white shadow-lg h-12 w-12">
          <Plus size={20} />
        </button>
        <button onClick={() => setDumping(true)} title="Dump my brain" className="inline-flex items-center gap-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 px-4 py-3">
          <Sparkles size={20} />
          <span className="hidden sm:inline font-medium pr-1">Dump my brain</span>
        </button>
      </div>

      {dumping && <DumpModal onClose={() => setDumping(false)} onDone={load} onCreated={setReview} initialQuestion={data?.question || null} />}
      {review && <DumpReviewSheet tasks={review} onClose={() => setReview(null)} onChanged={load} />}
      {adding && <TaskFormModal task={null} onClose={() => setAdding(false)} onSaved={load} />}
      {editing && <TaskFormModal task={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {doneFor && <DoneModal task={doneFor} onClose={() => setDoneFor(null)} onSaved={load} />}
      {delFor && <ConfirmDialog title="Delete task?" message={`“${delFor.title}” will be removed.`} confirmLabel="Delete" onConfirm={() => remove(delFor)} onCancel={() => setDelFor(null)} />}
    </div>
  );
}

// ---- finished-tasks history calendar (Activity-style heatmap; tap a day → that day's finished tasks) ----
type Cal = { start: string; end: string; days: { day: string; done: number; total: number }[] };

function addDays(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function prettyDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function TaskHistory() {
  const [cal, setCal] = useState<Cal | null>(null);
  const [months, setMonths] = useState(3);
  const [sel, setSel] = useState<string | null>(null);
  const [dayTasks, setDayTasks] = useState<Task[] | null>(null);
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch(`/api/daily/calendar?months=${months}`)
      .then((r) => r.json())
      .then((c: Cal) => {
        setCal(c);
        setSel((s) => s || c.end);
      })
      .catch(() => undefined);
  }, [months]);

  useEffect(() => {
    if (!sel) return;
    setDayTasks(null);
    fetch(`/api/tasks?day=${sel}`)
      .then((r) => r.json())
      .then((d) => setDayTasks(d.tasks || []))
      .catch(() => setDayTasks([]));
  }, [sel]);

  if (!cal) return <p className="text-sm text-zinc-400">Loading…</p>;

  const map = new Map(cal.days.map((d) => [d.day, d]));
  const startD = new Date(cal.start + 'T12:00:00Z');
  startD.setUTCDate(startD.getUTCDate() - startD.getUTCDay()); // back to Sunday
  const cells: string[] = [];
  let cursor = startD.toISOString().slice(0, 10);
  while (cursor <= cal.end) {
    cells.push(cursor);
    cursor = addDays(cursor, 1);
  }
  const weeks: string[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  function tint(day: string): string {
    const e = map.get(day);
    if (!e || !e.done) return 'bg-zinc-100 dark:bg-zinc-800/50';
    if (e.done >= 5) return 'bg-emerald-600';
    if (e.done >= 3) return 'bg-emerald-500';
    if (e.done >= 1) return 'bg-emerald-400/70';
    return 'bg-zinc-100 dark:bg-zinc-800/50';
  }

  const finished = (dayTasks || []).filter((t) => t.status === 'done');
  const openCount = (dayTasks || []).filter((t) => t.status !== 'done').length;
  const minutes = finished.reduce((s, t) => s + (t.actualMin || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <select aria-label="Months" value={months} onChange={(e) => setMonths(Number(e.target.value))} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">
          <option value={3}>3 months</option>
          <option value={6}>6 months</option>
          <option value={12}>12 months</option>
        </select>
      </div>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 overflow-x-auto">
        <div className="flex gap-1">
          {weeks.map((w, wi) => (
            <div key={wi} className="flex flex-col gap-1">
              {w.map((day) => {
                const future = day > cal.end;
                const e = map.get(day);
                return (
                  <button
                    key={day}
                    disabled={future}
                    onClick={() => setSel(day)}
                    title={future ? '' : `${day} — ${e?.done || 0} finished${e?.total ? ` of ${e.total}` : ''}`}
                    className={'h-3.5 w-3.5 rounded-sm transition-transform hover:scale-125 ' + (future ? 'opacity-0' : tint(day)) + (sel === day ? ' ring-2 ring-emerald-500 ring-offset-1 dark:ring-offset-zinc-900' : '')}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-1.5 mt-3 text-[11px] text-zinc-400">
          <span>less</span>
          <span className="h-3 w-3 rounded-sm bg-zinc-100 dark:bg-zinc-800/50" />
          <span className="h-3 w-3 rounded-sm bg-emerald-400/70" />
          <span className="h-3 w-3 rounded-sm bg-emerald-500" />
          <span className="h-3 w-3 rounded-sm bg-emerald-600" />
          <span>more finished</span>
        </div>
      </section>

      {/* Selected day's finished tasks */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="font-semibold text-sm flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500" /> {sel ? prettyDay(sel) : '—'}</h2>
          <span className="text-xs text-zinc-500 shrink-0">{finished.length} finished{minutes ? ` · ${mins(minutes)}` : ''}{openCount ? ` · ${openCount} open` : ''}</span>
        </div>
        {dayTasks === null ? (
          <p className="text-sm text-zinc-400">Loading…</p>
        ) : finished.length ? (
          <ul className="space-y-2">
            {finished.map((t) => {
              const open = !!openNotes[t.id];
              return (
                <li key={t.id} className="rounded-lg border border-zinc-100 dark:border-zinc-800 p-2.5">
                  <div
                    className={'flex items-start gap-2.5 ' + (t.note ? 'cursor-pointer' : '')}
                    onClick={() => t.note && setOpenNotes((m) => ({ ...m, [t.id]: !m[t.id] }))}
                  >
                    <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium break-words">
                        {t.pinned && <Star size={12} className="inline -mt-0.5 mr-1 text-amber-500 fill-amber-500" />}
                        {t.title}
                      </div>
                      <div className="flex items-center flex-wrap gap-1.5 mt-1 text-[11px] text-zinc-400">
                        {t.category && <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-500">{t.category}</span>}
                        {t.actualMin ? <span>took {mins(t.actualMin)}</span> : null}
                        {t.completedAt && <span>at {new Date(t.completedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
                        {t.note && (
                          <span className={'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ' + (open ? 'bg-amber-500/15 text-amber-600' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>
                            <StickyNote size={10} /> notes <ChevronDown size={10} className={'transition-transform ' + (open ? 'rotate-180' : '')} />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {t.note && open && (
                    <p className="mt-2 ml-[26px] rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border-l-2 border-amber-400 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words">{t.note}</p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-zinc-400">Nothing finished on this day.</p>
        )}
      </section>
    </div>
  );
}
