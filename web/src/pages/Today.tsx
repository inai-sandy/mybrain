import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brain, ChevronRight, Star, Lock } from 'lucide-react';
import { Task, DumpModal, DumpReviewSheet, TaskFormModal, DoneModal, useToday } from './taskShared';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { StorySection } from './DailyStory';
import { CloseDaySheet, OpenDaysBanner, MissedDayPicker } from './CloseDay';
import { ClaimsStrip } from '../ui/ClaimsStrip';

/** Delegated open, for the facts strip. Used to be a lone pill of its own. (BEA-1138) */
function useDelegated() {
  const [s, setS] = useState<{ open: number; awaitingYou: number } | null>(null);
  useEffect(() => {
    fetch('/api/tasks/delegated').then((r) => (r.ok ? r.json() : null)).then((d) => setS(d?.summary || null)).catch(() => setS(null));
  }, []);
  return s;
}

/** One fact. Same language as the Home bands, so the app counts things one way. (BEA-1138) */
function Fact({ n, label, to, tone }: { n: string | number; label: string; to?: string; tone?: string }) {
  const inner = (
    <>
      <div className={'text-xl font-extrabold leading-none tabular-nums ' + (tone || '')}>{n}</div>
      <div className="mt-1 truncate text-[11px] text-zinc-400">{label}</div>
    </>
  );
  const cls = 'rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left dark:border-zinc-800 dark:bg-zinc-900';
  return to ? <Link to={to} className={cls + ' block transition-colors hover:border-emerald-500/50'}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

/** A task in two lines: what it is, then the facts about it. (BEA-1138) */
function TaskRow({ t, onToggle, onEdit }: { t: Task; onToggle: (t: Task) => void; onEdit: (t: Task) => void }) {
  const done = t.status === 'done';
  const added = t.day ? new Date(t.day + 'T12:00:00Z') : null;
  const addedLabel = added && !isNaN(added.getTime()) ? added.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
  const carried = t.rolloverCount || 0;
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <button onClick={() => onToggle(t)} aria-label={done ? 'Reopen' : 'Mark done'} className={'mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors ' + (done ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-300 hover:border-emerald-500 dark:border-zinc-600')} />
      <button onClick={() => onEdit(t)} className="min-w-0 flex-1 text-left">
        <span className={'block text-sm font-medium leading-snug ' + (done ? 'text-zinc-400 line-through' : '')}>
          {t.pinned && <Star size={12} className="mr-1 inline fill-amber-500 text-amber-500" />}
          {t.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
          {t.priority === 'high' && <span className="font-medium text-rose-500">High</span>}
          {carried > 0 && (
            <span className={carried >= 7 ? 'font-semibold text-rose-500' : carried >= 2 ? 'text-amber-500' : ''}>
              carried {carried}d{addedLabel ? ` · since ${addedLabel}` : ''}
            </span>
          )}
          {t.category && <span>{t.category}</span>}
          {!!t.progress && <span className="text-emerald-500">{t.progress}%</span>}
        </span>
      </button>
    </li>
  );
}

export function Today() {
  const { data, loading, load } = useToday();
  const [dumping, setDumping] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [doneFor, setDoneFor] = useState<Task | null>(null);
  const [delFor, setDelFor] = useState<Task | null>(null);
  const [review, setReview] = useState<Task[] | null>(null);
  const [closeDay, setCloseDay] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState(0); // re-fetch open-days after a close
  const [followUps, setFollowUps] = useState<string[]>([]); // last night's questions (BEA-1055)

  useEffect(() => {
    load();
    fetch('/api/daily/morning-questions').then((r) => (r.ok ? r.json() : null)).then((d) => d && setFollowUps(d.questions || [])).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tasks = data?.tasks || [];

  // "important" = your pinned must-dos; if none pinned, fall back to the top open tasks
  const important = useMemo(() => {
    const open = tasks.filter((t) => t.status === 'open');
    const pinned = open.filter((t) => t.pinned);
    return (pinned.length ? pinned : open).slice(0, 3);
  }, [tasks]);

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

  const c = data?.counts;
  const del = useDelegated();
  const dayLabel = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' });
  // Computed from today's own tasks, so the strip agrees with the list underneath it. (BEA-1138)
  const carried = tasks.filter((t) => t.status === 'open' && (t.rolloverCount || 0) > 0).length;
  const overdue = tasks.filter((t) => t.status === 'open' && t.dueDate && new Date(t.dueDate) < new Date(new Date().toDateString())).length;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold"><Brain className="text-emerald-500" /> Today</h1>
        <span className="shrink-0 text-sm text-zinc-400">{dayLabel}</span>
      </div>

      {/* Every number labelled, one shape — the page used to scatter 8/46, a delegated pill and an
          unlabelled progress bar across three places. (BEA-1138) */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        <Fact n={c ? `${c.done}/${c.total}` : '—'} label="Done today" tone="text-emerald-500" />
        <Fact n={c?.open ?? '—'} label="Open" />
        <Fact n={carried} label="Carried over" tone={carried ? 'text-amber-500' : ''} to="/tasks" />
        <Fact n={overdue} label="Overdue" tone={overdue ? 'text-rose-500' : ''} to="/tasks" />
        <Fact n={del?.open ?? '—'} label="With others" to="/tasks?tab=delegated" />
      </div>

      {/* Finish an earlier un-closed day (the morning-after catch-up) */}
      <OpenDaysBanner key={bannerKey} onPick={setCloseDay} />

      {/* "Someone says they finished something" used to be a whole screen he never visited because
          it was empty most days. It now appears here, only when there is something. (BEA-1150) */}
      <ClaimsStrip onChanged={load} />

      {/* Compact actions instead of a full-width dashed hero that was mostly empty space. (BEA-1138) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <button onClick={() => setDumping(true)} className={'inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ' + (data?.dumped ? 'border border-zinc-200 text-zinc-600 hover:border-emerald-500/50 dark:border-zinc-800 dark:text-zinc-300' : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
          <Brain size={15} /> {data?.dumped ? 'Dump again' : 'Dump my brain'}
        </button>
        {data?.dumped && (
          <button onClick={() => data?.day && setCloseDay(data.day)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 px-3 py-2.5 text-sm font-medium text-zinc-600 transition-colors hover:border-emerald-500/50 dark:border-zinc-800 dark:text-zinc-300">
            <Lock size={15} /> Close the day
          </button>
        )}
        <MissedDayPicker onPick={setCloseDay} />
      </div>

      {/* Last night's questions are long text — one row until you want them. (BEA-1138) */}
      {followUps.length > 0 && !data?.dumped && (
        <details className="group rounded-xl border border-zinc-200 dark:border-zinc-800">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm">
            <span className="font-medium">{followUps.length} question{followUps.length === 1 ? '' : 's'} from last night</span>
            <ChevronRight size={14} className="ml-auto text-zinc-400 transition-transform group-open:rotate-90" />
          </summary>
          <ul className="space-y-1.5 border-t border-zinc-100 px-3.5 py-3 dark:border-zinc-800">
            {followUps.map((q, i) => <li key={i} className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">• {q}</li>)}
          </ul>
        </details>
      )}

      {/* Your must-dos — the important tasks at a glance */}
      {important.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-1.5 font-semibold text-sm"><Star size={15} className="text-amber-500 fill-amber-500" /> Your must-dos</h2>
            <Link to="/tasks" className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline">View all tasks <ChevronRight size={13} /></Link>
          </div>
          <ul className="space-y-2">
            {important.map((t) => <TaskRow key={t.id} t={t} onToggle={toggle} onEdit={setEditing} />)}
          </ul>
        </section>
      )}

      {data?.dumped && important.length === 0 && (
        <Link to="/tasks" className="block rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-500 hover:border-emerald-500/40">
          No must-dos pinned today. <span className="text-emerald-600">See all tasks →</span>
        </Link>
      )}

      {/* Daytime notes + nightly story */}
      <StorySection />

      {closeDay && <CloseDaySheet day={closeDay} onClose={() => setCloseDay(null)} onClosed={() => { load(); setBannerKey((k) => k + 1); }} />}

      {dumping && <DumpModal onClose={() => setDumping(false)} onDone={load} onCreated={setReview} initialQuestion={data?.question || null} followUps={followUps} />}
      {review && <DumpReviewSheet tasks={review} onClose={() => setReview(null)} onChanged={load} />}
      {editing && <TaskFormModal task={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {doneFor && <DoneModal task={doneFor} onClose={() => setDoneFor(null)} onSaved={load} />}
      {delFor && <ConfirmDialog title="Delete task?" message={`“${delFor.title}” will be removed.`} confirmLabel="Delete" onConfirm={() => remove(delFor)} onCancel={() => setDelFor(null)} />}
    </div>
  );
}
