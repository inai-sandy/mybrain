import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sun, Plus, Target, Wrench, Compass } from 'lucide-react';
import { useToast } from './Toast';

type Today = {
  focus: string | null;
  suggestion: { id: string; title: string; reason: string | null } | null;
  lever: { goal: string; lever: string } | null;
};

/** Home "Today" card — your focus, the top action to do first, and your key lever. Replaces the old
 *  auto-connections card. Non-naggy: hidden when there's nothing yet. (BEA-518) */
export function TodayCard() {
  const [d, setD] = useState<Today | null>(null);
  const [added, setAdded] = useState(false);
  const toast = useToast();

  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      fetch('/api/daily/today')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          setD(data);
          // The Coach's pick is generated in the background after a close — keep checking for ~75s so it
          // appears without a manual refresh. (BEA-550)
          if (data && !data.suggestion && tries < 5) {
            tries++;
            setWaiting(true);
            timer = setTimeout(load, 15000);
          } else {
            setWaiting(false);
          }
        })
        .catch(() => setD(null));
    load();
    return () => clearTimeout(timer);
  }, []);

  if (!d || (!d.focus && !d.suggestion && !d.lever && !waiting)) return null;

  async function add() {
    if (!d?.suggestion) return;
    try {
      await fetch(`/api/daily/suggestions/${d.suggestion.id}/add`, { method: 'POST' });
      setAdded(true);
      toast('success', 'Added to your tasks ✓');
    } catch {
      toast('error', 'Could not add that');
    }
  }

  return (
    <section className="rounded-xl border border-violet-300/40 dark:border-violet-500/30 bg-gradient-to-br from-violet-500/5 to-transparent p-4 space-y-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400 flex items-center gap-1.5"><Sun size={13} /> Today</div>

      {d.focus && (
        <Link to="/lab?tab=mentor" className="flex items-start gap-2 text-sm hover:underline">
          <Compass size={15} className="text-emerald-500 shrink-0 mt-0.5" />
          <span><span className="text-zinc-400">Focus — </span>{d.focus}</span>
        </Link>
      )}

      {!d.suggestion && waiting && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Target size={15} className="text-violet-400 shrink-0 animate-pulse" />
          <span>Working out your suggestions for today…</span>
        </div>
      )}

      {d.suggestion && (
        <div className="flex items-start gap-2 text-sm">
          <Target size={15} className="text-violet-500 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <span className="text-zinc-400">Do first — </span>{d.suggestion.title}
            {d.suggestion.reason && <div className="text-[11px] text-zinc-400 mt-0.5">{d.suggestion.reason}</div>}
          </div>
          {!added ? (
            <button onClick={add} className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-xs font-medium hover:bg-emerald-500"><Plus size={13} /> Add</button>
          ) : (
            <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">Added ✓</span>
          )}
        </div>
      )}

      {d.lever && (
        <Link to="/lab?tab=situation" className="flex items-start gap-2 text-sm hover:underline">
          <Wrench size={15} className="text-emerald-500 shrink-0 mt-0.5" />
          <span><span className="text-zinc-400">Lever — </span><span className="text-emerald-700 dark:text-emerald-300 font-medium">{d.lever.lever}</span></span>
        </Link>
      )}
    </section>
  );
}
