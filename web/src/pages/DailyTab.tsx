import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, CircleSlash, Clock, Coffee, Repeat, TriangleAlert } from 'lucide-react';
import { useToast } from '../ui/Toast';

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

/** A colour down the left edge makes the day scannable without reading every chip. (BEA-1132) */
const EDGE: Record<Item['status'], string> = {
  received: '!border-l-emerald-500',
  missed: '!border-l-rose-500',
  waiting: '!border-l-amber-500',
  off: '!border-l-zinc-300 dark:!border-l-zinc-700',
};

const LOOK: Record<Item['status'], { chip: string; label: string; icon: typeof Clock }> = {
  received: { chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', label: "today's is in", icon: CalendarCheck },
  missed: { chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-400', label: 'missed today', icon: TriangleAlert },
  waiting: { chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', label: 'waiting', icon: Clock },
  off: { chip: 'bg-zinc-500/10 text-zinc-500', label: 'day off', icon: Coffee },
};

/**
 * Standing daily reports — the arrangements, not the day (BEA-1123).
 *
 * These never finish, so they don't belong in a list whose whole logic is finishing: in Delegated
 * they sat forever, aged meaninglessly and tripped the stalling detector. Here the question is
 * simply "who owes a standing report, and is today's in?". The day-by-day history lives in
 * Review → Daily status.
 */
export function DailyTab({ onCountChange }: { onCountChange?: (n: number) => void } = {}) {
  const [log, setLog] = useState<Log | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    return fetch('/api/tasks/recurring/day-log')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Log | null) => { setLog(d); onCountChange?.(d?.items.length ?? 0); })
      .catch(() => setLog(null));
  }, [onCountChange]);

  useEffect(() => { load(); }, [load]);

  /** Turn a standing report back into an ordinary one-off task. */
  async function makeOneOff(it: Item) {
    setBusy(it.taskId);
    try {
      const r = await fetch(`/api/tasks/${it.taskId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'assignment' }),
      });
      if (!r.ok) throw new Error();
      toast('success', `"${it.title}" is a one-off task again — it's back in Delegated`);
      await load();
    } catch {
      toast('error', 'Could not change that — try again');
    } finally {
      setBusy(null);
    }
  }

  const received = log?.items.filter((i) => i.status === 'received').length ?? 0;
  const waiting = log?.items.filter((i) => i.status === 'waiting').length ?? 0;
  const missed = log?.items.filter((i) => i.status === 'missed').length ?? 0;

  if (log === null) {
    return <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>;
  }

  if (!log.items.length) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
        <Repeat className="mx-auto mb-2 h-7 w-7 text-zinc-400" />
        <p className="text-sm font-medium">No standing reports yet</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">
          Something someone owes you <b>every day</b> — a production update, an OT report. Tick “They owe this every day”
          when you add or edit a delegated task and it will live here instead of Delegated.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* The day's shape at a glance, then the detail — a flat list made you count rows. (BEA-1132) */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        {log.restDay ? (
          <p className="text-sm text-zinc-500"><span className="font-semibold text-zinc-700 dark:text-zinc-200">{log.weekday} is a day off</span> — nothing is owed today.</p>
        ) : (
          <>
            <span className="text-sm"><b className="tabular-nums text-emerald-600">{received}</b> <span className="text-zinc-500">in</span></span>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <span className="text-sm"><b className="tabular-nums text-amber-600">{waiting}</b> <span className="text-zinc-500">waiting</span></span>
            {!!missed && (<><span className="text-zinc-300 dark:text-zinc-700">·</span><span className="text-sm"><b className="tabular-nums text-rose-600">{missed}</b> <span className="text-zinc-500">missed</span></span></>)}
            <span className="ml-auto text-xs text-zinc-400">owed again tomorrow</span>
          </>
        )}
      </div>

      <div className="flex justify-end">
        <Link to="/tasks?tab=review&rtab=daily" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-emerald-600">See the day-by-day record</Link>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {log.items.map((it) => {
          const look = LOOK[it.status];
          const Icon = look.icon;
          return (
            <li key={it.taskId} className={'rounded-xl border border-l-4 bg-white p-3 dark:bg-zinc-900 ' + EDGE[it.status] + ' border-zinc-200 dark:border-zinc-800'}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug">{it.title}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {it.contact?.name || 'Nobody assigned'}
                    {it.at ? ` · ${time(it.at)}` : ''}
                  </p>
                </div>
                <span className={'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ' + look.chip}>
                  <Icon size={11} /> {look.label}
                </span>
              </div>
              {it.quote && (
                <p className="mt-2 break-words text-xs italic text-zinc-600 dark:text-zinc-400">“{it.quote}”</p>
              )}
              <button
                onClick={() => makeOneOff(it)}
                disabled={busy === it.taskId}
                className="mt-2 inline-flex items-center gap-1 text-[11px] text-zinc-500 underline underline-offset-2 hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200"
              >
                <CircleSlash size={11} /> {busy === it.taskId ? 'Changing…' : 'Not a daily report'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
