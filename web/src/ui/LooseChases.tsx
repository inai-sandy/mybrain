import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CheckSquare, ChevronDown, Link2, Loader2, XCircle } from 'lucide-react';
import { useToast } from './Toast';

type Item = {
  id: string;
  subject: string;
  message: string;
  notes: string | null;
  status: string;
  contact: { id: string; name: string } | null;
  existingTasks: { id: string; title: string; kind: string }[];
};

/**
 * Chases with no work behind them. (BEA-1292)
 *
 * These are the ones nobody can finish. The person replies "done" and it is recorded nowhere — the
 * chase agent's own code says so: *"a chase with no task behind it has nothing to claim."* And the
 * owner has nothing in his list to tick either, so the only way to stop one is by hand.
 *
 * Nine of his 24 live chases were in this state. They are listed rather than fixed automatically,
 * because the right answer differs per row and only he knows it: Karthik's two were duplicates of a
 * daily report he already had, Swathi's two were one hiring job written twice.
 */
export function LooseChases() {
  const toast = useToast();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [pick, setPick] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    fetch('/api/reminders/loose')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function fix(it: Item, mode: 'task' | 'daily' | 'existing' | 'stop') {
    if (mode === 'existing' && !pick[it.id]) { toast('error', 'Choose which work this is about'); return; }
    setBusy(it.id);
    try {
      const r = await fetch(`/api/reminders/${it.id}/link-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, taskId: mode === 'existing' ? pick[it.id] : undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d?.message || 'Could not do that'); return; }
      const who = it.contact?.name || 'them';
      toast(
        'success',
        d?.merged ? `Merged — ${who} is chased once about this now`
          : d?.stopped ? `Stopped chasing ${who} about this`
          : d?.kind === 'recurring' ? `Set up as a daily report for ${who}`
          : `Linked — you can now mark this done`,
      );
      setItems((xs) => (xs || []).filter((x) => x.id !== it.id));
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  if (!items || !items.length) return null;
  const people = new Set(items.map((i) => i.contact?.id).filter(Boolean)).size;

  const btn = 'inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50';

  return (
    <section className="rounded-xl border border-rose-300/50 bg-rose-500/5 p-3 dark:border-rose-500/30">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 text-left">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-rose-800 dark:text-rose-300">
            {items.length} {items.length === 1 ? 'chase has' : 'chases have'} nothing to finish
          </p>
          <p className="mt-0.5 text-xs text-rose-700/80 dark:text-rose-400/70">
            {people === 1 ? 'This person keeps' : `These ${people} people keep`} getting nudged, and saying "done" changes
            nothing — there is no task behind {items.length === 1 ? 'it' : 'them'} for you to tick.
          </p>
        </div>
        <ChevronDown size={16} className={'mt-0.5 shrink-0 text-rose-600 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>

      {open && (
        <ul className="mt-2.5 space-y-1.5">
          {items.map((i) => (
            <li key={i.id} className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-sm leading-snug">{i.subject}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
                {i.contact && (
                  <Link to={`/contacts?contact=${i.contact.id}`} className="text-emerald-600 hover:underline dark:text-emerald-400">
                    {i.contact.name}
                  </Link>
                )}
                {i.status === 'paused' && <span>paused</span>}
              </p>

              {/* Same work they already owe → merge, rather than a second task about one thing. */}
              {i.existingTasks.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <select
                    value={pick[i.id] || ''}
                    onChange={(e) => setPick((p) => ({ ...p, [i.id]: e.target.value }))}
                    className="min-w-0 max-w-full flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800"
                  >
                    <option value="">Same as work they already owe…</option>
                    {i.existingTasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.kind === 'recurring' ? '📅 ' : ''}{t.title}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => fix(i, 'existing')} disabled={busy === i.id} className={btn + ' bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'}>
                    {busy === i.id ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Link
                  </button>
                </div>
              )}

              <div className="mt-2 flex flex-wrap gap-1.5">
                <button onClick={() => fix(i, 'task')} disabled={busy === i.id} className={btn + ' bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400'}>
                  <CheckSquare size={12} /> One-off task
                </button>
                <button onClick={() => fix(i, 'daily')} disabled={busy === i.id} className={btn + ' bg-indigo-500/15 text-indigo-600 hover:bg-indigo-500/25 dark:text-indigo-400'}>
                  <CalendarClock size={12} /> Daily report
                </button>
                <button onClick={() => fix(i, 'stop')} disabled={busy === i.id} className={btn + ' bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'}>
                  <XCircle size={12} /> Stop chasing
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
