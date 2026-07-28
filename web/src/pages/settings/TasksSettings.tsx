import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useToast } from '../../ui/Toast';

type Field<T> = { value: T; says: string };
type Settings = {
  chaseTimes: Field<string[]>;
  claimGraceDays: Field<number>;
  restDays: Field<string[]>;
  digestHour: Field<number>;
  weekdays: string[];
};

/**
 * The rules that decide how the owner's team gets chased. (BEA-1161)
 *
 * Every one of these used to live somewhere he could not reach: rest days and the digest hour had
 * working API endpoints and no screen at all, and the chase times were hardcoded in three separate
 * files. He could not change his own rest days without someone calling the API for him — which is
 * why the app kept behaving as though it held opinions he never gave it.
 *
 * Each control shows what it currently MEANS, not just its value. "No reports are owed on Sunday"
 * tells him something; a ticked checkbox labelled "Sun" does not.
 */
export function TasksSettings() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/api/tasks/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then(setS)
      .catch(() => setS(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await fetch('/api/tasks/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!r.ok) { toast('error', 'Could not save that'); return; }
      setS(await r.json());
      toast('success', 'Saved');
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>;

  const timeInput = (i: number) => (
    <input
      key={i}
      type="time"
      value={s.chaseTimes.value[i] || ''}
      onChange={(e) => {
        const next = [...s.chaseTimes.value];
        if (e.target.value) next[i] = e.target.value; else next.splice(i, 1);
        save({ chaseTimes: next.filter(Boolean) });
      }}
      className="rounded-lg border border-zinc-300 bg-zinc-100 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
    />
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold">Tasks &amp; chasing</h2>
        <p className="text-sm text-zinc-500">How your team gets chased, and when a chase stops.</p>
      </div>

      <Card title="When a new chase nudges" says={s.chaseTimes.says}>
        <div className="flex flex-wrap items-center gap-2">
          {[0, 1, 2, 3].slice(0, Math.min(4, s.chaseTimes.value.length + 1)).map(timeInput)}
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-400">
          A time you say out loud in a briefing — “send it by 7PM” — always wins over this.
        </p>
      </Card>

      <Card title="If you don't review what they say they finished" says={s.claimGraceDays.says}>
        <div className="flex flex-wrap items-center gap-2">
          {[1, 2, 3, 7].map((n) => (
            <button
              key={n}
              disabled={busy}
              onClick={() => save({ claimGraceDays: n })}
              className={'rounded-lg border px-3 py-1.5 text-sm ' + (s.claimGraceDays.value === n ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300')}
            >
              {n} {n === 1 ? 'day' : 'days'}
            </button>
          ))}
          <button
            disabled={busy}
            onClick={() => save({ claimGraceDays: 0 })}
            className={'rounded-lg border px-3 py-1.5 text-sm ' + (!s.claimGraceDays.value ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300')}
          >
            Never stop
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-400">
          Only applies to work someone has reported finished. Nobody who simply stops replying is ever dropped.
        </p>
      </Card>

      <Card title="Days nobody owes you a report" says={s.restDays.says}>
        <div className="flex flex-wrap gap-1.5">
          {s.weekdays.map((d) => {
            const on = s.restDays.value.includes(d);
            return (
              <button
                key={d}
                disabled={busy}
                onClick={() => save({ restDays: on ? s.restDays.value.filter((x) => x !== d) : [...s.restDays.value, d] })}
                className={'rounded-lg border px-2.5 py-1.5 text-sm ' + (on ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300')}
              >
                {d}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-400">
          A report with its own days ignores this — if you set someone a Sunday report, you meant it.
        </p>
      </Card>

      <Card title="When the day closes" says={s.digestHour.says}>
        <select
          value={s.digestHour.value}
          disabled={busy}
          onChange={(e) => save({ digestHour: Number(e.target.value) })}
          className="rounded-lg border border-zinc-300 bg-zinc-100 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
          ))}
        </select>
        <p className="mt-1.5 text-[11px] text-zinc-400">
          After this, anything still outstanding is recorded as missed and you get one summary — never one message per miss.
        </p>
      </Card>
    </div>
  );
}

function Card({ title, says, children }: { title: string; says: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="text-sm font-semibold">{title}</h3>
      {/* What it means right now, in his words — not the raw value. */}
      <p className="mb-2.5 mt-0.5 text-xs text-emerald-700 dark:text-emerald-400">{says}</p>
      {children}
    </section>
  );
}
