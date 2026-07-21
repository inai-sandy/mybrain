import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, Clock, Loader2, CircleAlert, CheckCircle2, Undo2 } from 'lucide-react';

type Item = {
  id: string;
  title: string;
  note?: string | null;
  givenAt: string;
  dueDate?: string | null;
  completedAt?: string | null;
  claimed?: { at: string; note: string } | null;
};
type Board = { off: boolean; name: string; open?: Item[]; done?: Item[] };

const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

/**
 * The page a contact opens from WhatsApp. No login, no account.
 *
 * Built phone-first and deliberately plain: most people will open this one-handed, outside, on a
 * bad connection. Big touch targets, short words, no chrome. It never says "Done" for something the
 * owner hasn't confirmed — it says it has been sent for his check, because that is the truth.
 * (BEA-1027)
 */
export function TaskShare() {
  const { slug = '' } = useParams();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    return fetch(`/api/t/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (r.status === 404) { setError('notfound'); return null; }
        if (!r.ok) { setError('down'); return null; }
        return r.json();
      })
      .then((d) => { if (d) setBoard(d); })
      .catch(() => setError('down'));
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  if (error === 'notfound') return <Shell><Message icon={<CircleAlert className="h-7 w-7 text-amber-500" />} title="This link isn't valid" body="Ask for a fresh link." /></Shell>;
  if (error === 'down') return <Shell><Message icon={<CircleAlert className="h-7 w-7 text-amber-500" />} title="Can't load this right now" body="Check your connection and try again." action={<button onClick={load} className="mt-4 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white">Try again</button>} /></Shell>;
  if (!board) return <Shell><div className="space-y-3 pt-6">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />)}</div></Shell>;
  if (board.off) return <Shell><Message icon={<CircleAlert className="h-7 w-7 text-zinc-400" />} title="This list has been turned off" body="Ask Sandeep for a fresh link." /></Shell>;

  const open = board.open || [];
  const done = board.done || [];

  return (
    <Shell>
      <header className="pb-4 pt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">For {board.name}</p>
        <h1 className="mt-1 text-2xl font-extrabold">What Sandeep is waiting on</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {open.length === 0 ? "Nothing outstanding — you're all clear." : `${open.length} thing${open.length === 1 ? '' : 's'} still open.`}
        </p>
      </header>

      {open.length > 0 && (
        <ul className="space-y-3">
          {open.map((t) => <OpenRow key={t.id} item={t} slug={slug} onChanged={load} />)}
        </ul>
      )}

      {open.length === 0 && (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-500" />
          <p className="font-medium">All clear</p>
          <p className="mt-1 text-sm text-zinc-500">Nothing is waiting on you right now.</p>
        </div>
      )}

      {done.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-zinc-500">Already finished ({done.length})</h2>
          <ul className="space-y-2">
            {done.map((t) => (
              <li key={t.id} className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-500 line-through">{t.title}</span>
                  {t.completedAt && <span className="text-[11px] text-zinc-400">{day(t.completedAt)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="py-10 text-center text-[11px] text-zinc-400">
        Sent by My Brain on behalf of Sandeep.
      </footer>
    </Shell>
  );
}

function OpenRow({ item, slug, onChanged }: { item: Item; slug: string; onChanged: () => void }) {
  const overdue = item.dueDate && new Date(item.dueDate) < new Date();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function send(done: boolean, withNote = '') {
    setBusy(true); setFailed(false);
    try {
      const r = await fetch(`/api/t/${encodeURIComponent(slug)}/tick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.id, note: withNote, done }),
      });
      if (!r.ok) { setFailed(true); return; }
      setAsking(false); setNote('');
      await onChanged();
    } catch { setFailed(true); } finally { setBusy(false); }
  }

  return (
    <li className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="font-medium leading-snug">{item.title}</p>
      {item.note && <p className="mt-1 text-sm text-zinc-500">{item.note}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-zinc-500">
          <Clock className="h-3 w-3" /> asked {day(item.givenAt)}
        </span>
        {item.dueDate && (
          <span className={'rounded-full px-2 py-0.5 ' + (overdue ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-zinc-500/10 text-zinc-500')}>
            {overdue ? 'was due' : 'by'} {day(item.dueDate)}
          </span>
        )}
      </div>
      {item.claimed ? (
        <div className="mt-3 rounded-xl bg-violet-500/10 px-3 py-2.5">
          <p className="text-xs text-violet-700 dark:text-violet-300">
            ✓ Sent to Sandeep for his check on {day(item.claimed.at)}.
          </p>
          {item.claimed.note && item.claimed.note !== 'Ticked it off on their page' && (
            <p className="mt-1 text-xs italic text-violet-600/80 dark:text-violet-400/80">“{item.claimed.note}”</p>
          )}
          <button onClick={() => send(false)} disabled={busy} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-violet-700 underline underline-offset-2 disabled:opacity-50 dark:text-violet-300">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} Undo
          </button>
        </div>
      ) : asking ? (
        <div className="mt-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            autoFocus
            placeholder="Anything to add? e.g. sent it to the CA yesterday (optional)"
            className="w-full resize-none rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <div className="mt-2 flex gap-2">
            <button onClick={() => send(true, note)} disabled={busy} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white disabled:opacity-50">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Send it
            </button>
            <button onClick={() => { setAsking(false); setNote(''); }} className="rounded-xl border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAsking(true)} className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-emerald-500/50 bg-emerald-500/5 px-4 py-3 text-sm font-medium text-emerald-700 active:bg-emerald-500/15 dark:text-emerald-400">
          <Check size={15} /> I've done this
        </button>
      )}
      {failed && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">That didn't go through — check your connection and try again.</p>}
    </li>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto w-full max-w-lg px-4">{children}</div>
    </div>
  );
}

function Message({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center text-center">
      {icon}
      <p className="mt-3 font-semibold">{title}</p>
      <p className="mt-1 text-sm text-zinc-500">{body}</p>
      {action}
    </div>
  );
}
