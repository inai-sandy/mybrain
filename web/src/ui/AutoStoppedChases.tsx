import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Radio, Loader2, Hand, ChevronDown } from 'lucide-react';
import { useToast } from './Toast';

type Item = {
  id: string;
  subject: string | null;
  contact: { id: string; name: string } | null;
  offDays: number;
  needsYou: boolean;
  taskDone: boolean;
  taskTitle: string | null;
};

/**
 * Chases the app switched off by itself, waiting for the owner to turn back on. (BEA-1160)
 *
 * `rollDay` used to pause any chase armed on an earlier day and delete its queued sends, so someone
 * who simply did not answer stopped being chased. On live data that was 23 chases the app switched
 * off against 1 the owner did. The rule is fixed going forward; these are the ones already off.
 *
 * They are listed rather than silently resumed. Some belong to work genuinely finished, and waking
 * 23 chases at once would put messages in front of real people without him choosing to.
 */
export function AutoStoppedChases() {
  const toast = useToast();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    fetch('/api/reminders/auto-stopped')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function resume(it: Item) {
    setBusy(it.id);
    try {
      const r = await fetch(`/api/reminders/${it.id}/resume-auto-stopped`, { method: 'POST' });
      if (!r.ok) { toast('error', 'Could not start that again'); return; }
      toast('success', `Chasing ${it.contact?.name || 'them'} again`);
      setItems((xs) => (xs || []).filter((x) => x.id !== it.id));
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  // Only offer the ones whose work is still open — a chase for a finished task needs no resuming.
  const live = (items || []).filter((i) => !i.taskDone);
  if (!items || !live.length) return null;
  const needing = live.filter((i) => i.needsYou).length;

  return (
    <section className="rounded-xl border border-amber-300/50 bg-amber-500/5 p-3 dark:border-amber-500/30">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 text-left">
        <Radio size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            {live.length} {live.length === 1 ? 'chase' : 'chases'} the app switched off by itself
          </p>
          <p className="mt-0.5 text-xs text-amber-700/80 dark:text-amber-400/70">
            These stopped at midnight because nobody replied — a bug, now fixed. The work is still open.
            {needing > 0 && ` ${needing} of them asked you for something.`}
          </p>
        </div>
        <ChevronDown size={16} className={'mt-0.5 shrink-0 text-amber-600 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>

      {open && (
        <ul className="mt-2.5 space-y-1.5">
          {live.map((i) => (
            <li key={i.id} className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug">{i.taskTitle || i.subject || 'A chase'}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
                  {i.contact && <Link to={`/contacts?contact=${i.contact.id}`} className="text-emerald-600 hover:underline dark:text-emerald-400">{i.contact.name}</Link>}
                  <span className="tabular-nums">off {i.offDays} {i.offDays === 1 ? 'day' : 'days'}</span>
                  {i.needsYou && <span className="inline-flex items-center gap-1 text-violet-600 dark:text-violet-400"><Hand size={11} /> asked you for something</span>}
                </p>
              </div>
              <button
                onClick={() => resume(i)}
                disabled={busy === i.id}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400"
              >
                {busy === i.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Chase again
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
