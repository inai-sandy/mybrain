import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, CircleSlash, Clock, Coffee, Repeat, TriangleAlert, Pencil, Trash2 } from 'lucide-react';
import { DataTable } from '../ui/DataTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

type Item = {
  taskId: string;
  title: string;
  contact: { id: string; name: string } | null;
  status: 'received' | 'missed' | 'waiting' | 'off';
  quote: string | null;
  at: string | null;
  /** Which weekdays it is owed on, and how to say that. (BEA-1147) */
  schedule?: string[] | null;
  scheduleLabel?: string | null;
  /** For the table's Person column/filter — DataTable sorts on a plain key. */
  who?: string;
};
type Log = { day: string; weekday: string; restDay: boolean; items: Item[] };

const time = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

/**
 * Status still colours the card so the day stays scannable (BEA-1132) — but through the same
 * chip + leading-icon language every TaskCard uses, not a different card style. (BEA-1212)
 */
const LOOK: Record<Item['status'], { chip: string; label: string; icon: typeof Clock; mark: string }> = {
  received: { chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', label: "today's is in", icon: CalendarCheck, mark: 'text-emerald-600' },
  missed: { chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-400', label: 'missed today', icon: TriangleAlert, mark: 'text-rose-500' },
  waiting: { chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', label: 'waiting', icon: Clock, mark: 'text-amber-500' },
  off: { chip: 'bg-zinc-500/10 text-zinc-500', label: 'day off', icon: Coffee, mark: 'text-zinc-400 dark:text-zinc-600' },
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
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [schedFor, setSchedFor] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<Item | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    return fetch('/api/tasks/recurring/day-log')
      .then((r) => (r.ok ? r.json() : null))
      // `who` is flattened for the table's sort and filter — DataTable works on plain keys.
      .then((d: Log | null) => { const withWho = d ? { ...d, items: d.items.map((i) => ({ ...i, who: i.contact?.name || '' })) } : null; setLog(withWho); onCountChange?.(d?.items.length ?? 0); })
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

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  async function setDays(it: Item, days: string[]) {
    setBusy(it.taskId);
    try {
      const r = await fetch(`/api/tasks/recurring/${it.taskId}/schedule`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }),
      });
      if (!r.ok) throw new Error();
      await load();
    } catch {
      toast('error', 'Could not change the days');
    } finally { setBusy(null); }
  }

  async function rename(it: Item) {
    const title = draft.trim();
    if (!title || title === it.title) { setEditing(null); return; }
    setBusy(it.taskId);
    try {
      const r = await fetch(`/api/tasks/${it.taskId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      });
      if (!r.ok) throw new Error();
      toast('success', 'Renamed');
      setEditing(null);
      await load();
    } catch {
      toast('error', 'Could not rename that');
    } finally { setBusy(null); }
  }

  async function remove(it: Item) {
    setBusy(it.taskId);
    try {
      const r = await fetch(`/api/tasks/${it.taskId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      toast('success', `Deleted — nobody will be chased for "${it.title}" again`);
      await load();
    } catch {
      toast('error', 'Could not delete that');
    } finally { setBusy(null); setConfirmDel(null); }
  }

  // The same card language as every TaskCard (BEA-1212): status mark in the leading slot where
  // the tick lives on a task, actions as hover-revealed icons top-right, chips along the bottom.
  const card = (it: Item) => {
    const look = LOOK[it.status];
    const Icon = look.icon;
    return (
      <div className="group flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-3.5 transition-all hover:border-emerald-500/40 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className={'mt-0.5 shrink-0 ' + look.mark} title={look.label} role="img" aria-label={look.label}><Icon size={20} /></span>
        <div className="min-w-0 flex-1">
          {editing === it.taskId ? (
            <div className="space-y-2">
              <textarea autoFocus rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-zinc-100 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950" />
              <div className="flex gap-2">
                <button onClick={() => rename(it)} disabled={busy === it.taskId} className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs text-white hover:bg-emerald-500 disabled:opacity-50">Save</button>
                <button onClick={() => setEditing(null)} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs dark:border-zinc-700">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <h3 className="flex-1 font-medium leading-snug">{it.title}</h3>
              <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                <button onClick={() => { setEditing(it.taskId); setDraft(it.title); }} title="Edit" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"><Pencil size={14} /></button>
                <button onClick={() => makeOneOff(it)} disabled={busy === it.taskId} title="Not a daily report — back to Delegated" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><CircleSlash size={14} /></button>
                <button onClick={() => setConfirmDel(it)} title="Delete" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-rose-600 dark:hover:bg-zinc-800"><Trash2 size={14} /></button>
              </div>
            </div>
          )}
          <p className="mt-0.5 text-xs text-zinc-500">
            {it.contact?.name || 'Nobody assigned'}
            {it.at ? ` · ${time(it.at)}` : ''}
          </p>
          {it.quote && <p className="mt-1.5 break-words text-xs italic text-zinc-600 line-clamp-2 dark:text-zinc-400">“{it.quote}”</p>}

          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ' + look.chip}><Icon size={11} /> {look.label}</span>
            {/* Which days it is owed on — editable here rather than only on the person's page. (BEA-1157) */}
            <button onClick={() => setSchedFor(schedFor === it.taskId ? null : it.taskId)}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-zinc-500 hover:text-emerald-600 dark:bg-zinc-800">
              <Repeat size={11} /> {it.scheduleLabel || 'every working day'}
            </button>
          </div>
          {schedFor === it.taskId && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {DAYS.map((d) => {
                const on = (it.schedule || []).includes(d);
                return (
                  <button key={d} disabled={busy === it.taskId}
                    onClick={() => setDays(it, on ? (it.schedule || []).filter((x) => x !== d) : [...(it.schedule || []), d])}
                    className={'rounded-md border px-1.5 py-0.5 text-[11px] ' + (on ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>{d}</button>
                );
              })}
              <button onClick={() => setDays(it, [])} className="text-[11px] text-zinc-500 underline">every working day</button>
            </div>
          )}
        </div>
      </div>
    );
  };

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

      {/* Search, filters, sortable columns, count and paging — the house standard, through the
          shared table. This list had none of it. (BEA-1157) */}
      <DataTable<Item>
        rows={log.items}
        columns={[
          { key: 'title', label: 'Report', sortable: true, width: '46%', render: (r) => <span className="font-medium">{r.title}</span> },
          { key: 'who', label: 'Who', sortable: true, render: (r) => <span className="text-zinc-500">{r.contact?.name || '—'}</span> },
          { key: 'scheduleLabel', label: 'Days', sortable: true, render: (r) => <span className="text-zinc-500">{r.scheduleLabel || 'every working day'}</span> },
          { key: 'status', label: 'Today', sortable: true, render: (r) => <span className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ' + LOOK[r.status].chip}>{LOOK[r.status].label}</span> },
        ]}
        filters={[
          { key: 'status', label: 'Status', options: [{ value: 'received', label: "Today's is in" }, { value: 'waiting', label: 'Waiting' }, { value: 'missed', label: 'Missed' }] },
          { key: 'who', label: 'Person', options: [...new Set(log.items.map((i) => i.contact?.name).filter(Boolean))].map((n) => ({ value: String(n), label: String(n) })), match: (row, v) => row.contact?.name === v },
        ]}
        sortOptions={[
          { label: 'Longest waiting', key: 'status', dir: 1 },
          { label: 'Person A–Z', key: 'who', dir: 1 },
        ]}
        pageSize={12}
        renderCard={card}
        gridClassName="grid gap-2 sm:grid-cols-2"
        emptyText="Nothing matches that."
      />

      <ConfirmDialog
        open={!!confirmDel}
        title={`Delete "${confirmDel?.title || ''}"?`}
        message="This removes the standing report and its whole day-by-day history, and stops the chase. It cannot be undone. To keep the history but stop the daily rhythm, use “Not a daily report” instead."
        confirmLabel="Delete for good"
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && remove(confirmDel)}
      />
    </div>
  );
}
