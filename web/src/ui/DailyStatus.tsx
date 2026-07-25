import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, ChevronLeft, ChevronRight, Clock, Coffee, Quote, TriangleAlert } from 'lucide-react';

type Item = {
  taskId: string;
  title: string;
  contact: { id: string; name: string } | null;
  status: 'received' | 'missed' | 'waiting' | 'off';
  quote: string | null;
  at: string | null;
};
type Log = { day: string; weekday: string; restDay: boolean; items: Item[] };

const time = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

const LOOK: Record<Item['status'], { chip: string; label: string; icon: typeof Clock }> = {
  received: { chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', label: 'in', icon: CalendarCheck },
  missed: { chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-400', label: 'missed', icon: TriangleAlert },
  waiting: { chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', label: 'waiting', icon: Clock },
  off: { chip: 'bg-zinc-500/10 text-zinc-500', label: 'day off', icon: Coffee },
};

/**
 * The standing daily reports for one day — who owed what, and whether it came in. (BEA-1120)
 *
 * Deliberately NOT a review queue: a daily report is never confirmed or rejected, so there is
 * nothing to decide here. What matters is the gap — a missed day — not the arrivals.
 */
export function DailyStatus({ day, onDayChange }: { day?: string; onDayChange?: (d: string) => void }) {
  const [log, setLog] = useState<Log | null>(null);
  const [viewing, setViewing] = useState<string>(day || '');

  const load = useCallback((d: string) => {
    setLog(null);
    return fetch(`/api/tasks/recurring/day-log${d ? `?day=${encodeURIComponent(d)}` : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d2) => { setLog(d2); if (d2?.day) setViewing(d2.day); })
      .catch(() => setLog(null));
  }, []);

  useEffect(() => { load(day || ''); }, [day, load]);

  const go = (by: number) => {
    const next = shiftDay(viewing, by);
    setViewing(next);
    onDayChange?.(next);
    load(next);
  };

  const received = log?.items.filter((i) => i.status === 'received').length ?? 0;
  const missed = log?.items.filter((i) => i.status === 'missed').length ?? 0;
  const isToday = viewing === new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {log ? `${log.weekday} ${log.day}` : 'Loading…'}
            {isToday && <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">today</span>}
          </p>
          <p className="text-xs text-zinc-500">
            {!log ? ' ' : log.restDay ? 'Day off — nothing owed' : log.items.length === 0 ? 'No daily reports set up' : `${received} in · ${missed} missed of ${log.items.length}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={() => go(-1)} aria-label="Previous day" className="rounded-lg border border-zinc-300 p-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"><ChevronLeft size={15} /></button>
          <button onClick={() => go(1)} disabled={isToday} aria-label="Next day" className="rounded-lg border border-zinc-300 p-1.5 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"><ChevronRight size={15} /></button>
        </div>
      </div>

      {log === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : log.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <CalendarCheck className="mx-auto mb-2 h-7 w-7 text-zinc-400" />
          <p className="text-sm font-medium">No daily reports yet</p>
          <p className="mt-1 text-xs text-zinc-500">Mark a task as a daily report and it will show up here each day.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {log.items.map((it) => {
            const look = LOOK[it.status];
            const Icon = look.icon;
            return (
              <li key={it.taskId} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{it.title}</p>
                    <p className="text-xs text-zinc-500">{it.contact?.name || 'Nobody assigned'}{it.at ? ` · ${time(it.at)}` : ''}</p>
                  </div>
                  <span className={'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ' + look.chip}>
                    <Icon size={11} /> {look.label}
                  </span>
                </div>
                {it.quote && (
                  <p className="mt-2 flex gap-1.5 text-xs italic text-zinc-600 dark:text-zinc-400">
                    <Quote size={12} className="mt-0.5 shrink-0 text-zinc-400" />
                    <span className="min-w-0 break-words">{it.quote}</span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
