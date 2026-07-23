import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brain, ChevronRight, Star, Lock } from 'lucide-react';
import { Task, TaskCard, DumpModal, DumpReviewSheet, TaskFormModal, DoneModal, useToday } from './taskShared';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { StorySection } from './DailyStory';
import { CloseDaySheet, OpenDaysBanner, MissedDayPicker } from './CloseDay';

/** One quiet line: what's out with other people, and what's waiting on you. (BEA-1029) */
function DelegatedLine() {
  const [s, setS] = useState<{ open: number; awaitingYou: number } | null>(null);
  useEffect(() => {
    fetch('/api/tasks/delegated')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setS(d?.summary || null))
      .catch(() => setS(null));
  }, []);
  if (!s || (!s.open && !s.awaitingYou)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      <span className="text-zinc-500">With other people:</span>
      <Link to="/tasks?tab=delegated" className="font-medium hover:text-emerald-600">{s.open} open</Link>
      {s.awaitingYou > 0 && (
        <Link to="/tasks?tab=review" className="font-medium text-violet-600 hover:underline dark:text-violet-400">{s.awaitingYou} waiting on you</Link>
      )}
    </div>
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
  async function progress(t: Task, pct: number) {
    const r = await fetch(`/api/tasks/${t.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: pct }) });
    if (r.ok) load();
  }
  async function remove(t: Task) {
    const r = await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' });
    if (r.ok) load();
    setDelFor(null);
  }

  const c = data?.counts;
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><Brain className="text-emerald-500" /> Today</h1>
          <p className="text-zinc-500 text-sm">Dump your brain, focus on what matters, reflect at night.</p>
        </div>
        {c && c.total > 0 && (
          <div className="text-right shrink-0">
            <div className="text-2xl font-extrabold tabular-nums">{c.done}<span className="text-zinc-400 text-lg">/{c.total}</span></div>
            <div className="text-[11px] text-zinc-400">done today</div>
          </div>
        )}
      </div>

      {/* Finish an earlier un-closed day (the morning-after catch-up) */}
      <OpenDaysBanner key={bannerKey} onPick={setCloseDay} />
      <DelegatedLine />

      {/* Brain-dump hero (until you've dumped) */}
      {!loading && !data?.dumped && (
        <button onClick={() => setDumping(true)} className="w-full rounded-2xl border border-dashed border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 p-6 text-center transition-colors">
          <Brain className="mx-auto text-emerald-500 mb-2" size={28} />
          <div className="font-semibold">🧠 Dump my brain</div>
          <p className="text-xs text-zinc-500 mt-1">{data?.question ? data.question : 'Type or speak everything on your mind — the AI builds your task list.'}</p>
          {followUps.length > 0 && (
            <div className="mx-auto mt-3 max-w-md rounded-lg border border-indigo-400/30 bg-indigo-500/5 px-3 py-2 text-left">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-500 dark:text-indigo-400">From last night's story</p>
              {followUps.map((q, i) => <p key={i} className="text-xs text-zinc-600 dark:text-zinc-300">• {q}</p>)}
            </div>
          )}
        </button>
      )}

      {c && c.total > 0 && (
        <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((c.done / c.total) * 100)}%` }} />
        </div>
      )}

      {/* Your must-dos — the important tasks at a glance */}
      {important.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-1.5 font-semibold text-sm"><Star size={15} className="text-amber-500 fill-amber-500" /> Your must-dos</h2>
            <Link to="/tasks" className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline">View all tasks <ChevronRight size={13} /></Link>
          </div>
          <div className="space-y-2.5">
            {important.map((t) => <TaskCard key={t.id} t={t} onToggle={toggle} onEdit={setEditing} onDelete={setDelFor} onProgress={progress} />)}
          </div>
        </section>
      )}

      {data?.dumped && important.length === 0 && (
        <Link to="/tasks" className="block rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-500 hover:border-emerald-500/40">
          No must-dos pinned today. <span className="text-emerald-600">See all tasks →</span>
        </Link>
      )}

      {/* Daytime notes + nightly story */}
      <StorySection />

      {/* Seal today when you're done — the one act that settles everything */}
      {data?.dumped && (
        <button onClick={() => data?.day && setCloseDay(data.day)} className="w-full flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 p-3 text-sm font-medium text-emerald-700 dark:text-emerald-300 transition-colors">
          <Lock size={15} /> Close the day — finish tasks, story &amp; settle the mentor
        </button>
      )}

      {/* The door back into any past day — sealed or not. (BEA-1052) */}
      <MissedDayPicker onPick={setCloseDay} />

      {closeDay && <CloseDaySheet day={closeDay} onClose={() => setCloseDay(null)} onClosed={() => { load(); setBannerKey((k) => k + 1); }} />}

      {dumping && <DumpModal onClose={() => setDumping(false)} onDone={load} onCreated={setReview} initialQuestion={data?.question || null} followUps={followUps} />}
      {review && <DumpReviewSheet tasks={review} onClose={() => setReview(null)} onChanged={load} />}
      {editing && <TaskFormModal task={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {doneFor && <DoneModal task={doneFor} onClose={() => setDoneFor(null)} onSaved={load} />}
      {delFor && <ConfirmDialog title="Delete task?" message={`“${delFor.title}” will be removed.`} confirmLabel="Delete" onConfirm={() => remove(delFor)} onCancel={() => setDelFor(null)} />}
    </div>
  );
}
