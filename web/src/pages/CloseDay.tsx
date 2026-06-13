import { useEffect, useState } from 'react';
import { Check, Circle, Moon, X, Lock, Mic } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { StoryModal } from './DailyStory';

type T = { id: string; title: string; status: string; pinned?: boolean; sphere?: string };
type DayInfo = {
  day: string;
  isToday: boolean;
  story: { text: string; mood?: string | null } | null;
  closed: boolean;
};

function prettyDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** The one unified "Close the day" flow: tick what you did (credited to THIS day), tell the story, seal it. */
export function CloseDaySheet({ day, onClose, onClosed }: { day: string; onClose: () => void; onClosed: () => void }) {
  const [tasks, setTasks] = useState<T[] | null>(null);
  const [info, setInfo] = useState<DayInfo | null>(null);
  const [telling, setTelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    const [tr, ar] = await Promise.all([fetch(`/api/tasks?day=${day}`), fetch(`/api/daily/activity?day=${day}`)]);
    if (tr.ok) setTasks((await tr.json()).tasks || []);
    if (ar.ok) {
      const a = await ar.json();
      setInfo({ day: a.day, isToday: a.isToday, story: a.story, closed: a.closed });
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [day]);

  async function toggle(t: T) {
    // one tap = done (credited to this day); tap again = reopen. Kept light so finishing a day is fast.
    const done = t.status !== 'done';
    const r = await fetch(`/api/tasks/${t.id}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) });
    if (r.ok) setTasks((list) => (list || []).map((x) => (x.id === t.id ? { ...x, status: done ? 'done' : 'open' } : x)));
  }

  async function seal(close: () => void) {
    setBusy(true);
    try {
      const r = await fetch('/api/daily/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) });
      if (r.ok) {
        const j = await r.json();
        toast('success', j.rolled ? `Day sealed ✓ · ${j.rolled} unfinished moved forward` : 'Day sealed ✓');
        onClosed();
        close();
      } else toast('error', 'Could not close the day');
    } finally {
      setBusy(false);
    }
  }

  const openCount = (tasks || []).filter((t) => t.status !== 'done').length;
  const doneCount = (tasks || []).filter((t) => t.status === 'done').length;

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <>
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-bold flex items-center gap-2"><Lock size={16} className="text-emerald-500" /> {info?.isToday ? 'Close today' : `Finish ${prettyDay(day)}`}</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          <p className="text-xs text-zinc-500 mb-4">Tick what you actually did — it credits this day — tell the story, then seal it. Anything still open moves forward when you close.</p>

          {/* The day's story */}
          <section className="rounded-xl border border-indigo-300/40 dark:border-indigo-500/30 bg-indigo-500/5 p-3.5 mb-4">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-2 font-semibold text-sm"><Moon size={14} className="text-indigo-400" /> Your story</h4>
              {info?.story && <button onClick={() => setTelling(true)} className="text-xs text-indigo-500 hover:underline">Edit</button>}
            </div>
            {info?.story ? (
              <p className="mt-1.5 text-xs text-zinc-500 line-clamp-2 whitespace-pre-wrap">{info.story.text}</p>
            ) : (
              <button onClick={() => setTelling(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 text-xs"><Mic size={13} /> Tell this day’s story</button>
            )}
          </section>

          {/* The day's tasks */}
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-semibold text-sm">What got done</h4>
            <span className="text-xs text-zinc-400">{doneCount} done · {openCount} open</span>
          </div>
          {tasks === null ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : tasks.length ? (
            <ul className="space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
              {tasks.map((t) => {
                const done = t.status === 'done';
                return (
                  <li key={t.id}>
                    <button onClick={() => toggle(t)} className="w-full flex items-start gap-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 text-left hover:border-emerald-500/40">
                      <span className={'mt-0.5 shrink-0 ' + (done ? 'text-emerald-600' : 'text-zinc-300 dark:text-zinc-600')}>{done ? <Check size={18} /> : <Circle size={18} />}</span>
                      <span className={'text-sm flex-1 ' + (done ? 'line-through text-zinc-400' : '')}>{t.title}{t.sphere === 'personal' && <span className="ml-1.5 text-[11px] text-violet-500">🏠</span>}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-zinc-400">No tasks recorded this day.</p>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button onClick={close} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Not yet</button>
            <button onClick={() => seal(close)} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm font-medium disabled:opacity-50">{busy ? 'Sealing…' : 'Close the day ✓'}</button>
          </div>

          {telling && (
            <StoryModal
              initial={info?.story || null}
              day={day}
              title={info?.isToday ? "Tonight's story" : `Story for ${prettyDay(day)}`}
              onClose={() => setTelling(false)}
              onSaved={() => load()}
            />
          )}
        </>
      )}
    </Sheet>
  );
}

/** Banner shown on Today when past days are still open — the gentle "finish yesterday" prompt. */
export function OpenDaysBanner({ onPick }: { onPick: (day: string) => void }) {
  const [days, setDays] = useState<{ day: string; openTasks: number; totalTasks: number; hasStory: boolean }[]>([]);
  useEffect(() => {
    fetch('/api/daily/open-days').then((r) => (r.ok ? r.json() : null)).then((j) => j && setDays(j.days || [])).catch(() => undefined);
  }, []);
  if (!days.length) return null;
  const d = days[0]; // most recent open day
  return (
    <button onClick={() => onPick(d.day)} className="w-full flex items-center gap-3 rounded-xl border border-amber-300/50 dark:border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10 p-3.5 text-left transition-colors">
      <span className="text-2xl shrink-0">📌</span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-sm">{prettyDay(d.day).replace(/^[A-Za-z]+, /, '')} is still open</div>
        <p className="text-xs text-zinc-500">{d.openTasks} to finish{days.length > 1 ? ` · +${days.length - 1} more day${days.length > 2 ? 's' : ''}` : ''} — close it so the story and mentor settle.</p>
      </div>
      <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300 px-3 py-1 text-xs font-medium">Finish →</span>
    </button>
  );
}
