import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Hand, Loader2 } from 'lucide-react';
import { useToast } from './Toast';

type Claim = {
  id: string;
  taskId: string;
  task?: { id: string; title: string };
  contact: { id: string; name: string } | null;
  quote: string;
  openDays: number | null;
};

/**
 * Someone says they finished something — your call. (BEA-1150)
 *
 * This used to be a whole screen, and the owner's verdict was: "In Tasks → Review Screen, I don't
 * know the use of it. It is not giving me anything to review." He was right — `/api/tasks/claims`
 * returns an empty list most days, so it was an empty inbox you had to remember to visit. And when
 * it wasn't empty it showed their words with no way to open the conversation, so he went to Chats
 * anyway.
 *
 * So it stops being a place. It appears where he already is, only when there is something, and it
 * links straight to the person rather than to a quote with no context.
 */
export function ClaimsStrip({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/tasks/claims')
      .then((r) => (r.ok ? r.json() : { claims: [] }))
      .then((d) => setClaims(d.claims || []))
      .catch(() => setClaims([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function decide(c: Claim, confirm: boolean) {
    setBusy(c.id);
    try {
      const r = await fetch(`/api/tasks/claims/${c.id}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }),
      });
      if (!r.ok) { toast('error', 'Could not save that'); return; }
      toast('success', confirm ? 'Confirmed — chase stopped' : 'Sent back — chase resumes');
      load();
      onChanged?.();
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  // Nothing to decide is the normal state, and an empty box is worse than no box.
  if (!claims || !claims.length) return null;

  return (
    <section className="rounded-xl border border-violet-300/50 bg-violet-500/5 p-3 dark:border-violet-500/30">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <Hand size={13} /> {claims.length === 1 ? 'Someone says they finished something' : `${claims.length} say they've finished something`} — your call
      </h3>
      <ul className="space-y-1.5">
        {claims.slice(0, 5).map((c) => (
          <li key={c.id} className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm leading-snug">{c.task?.title || 'A task'}</p>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              {c.contact ? (
                // Straight to the person, where the conversation is. Never a quote with nowhere to go.
                <Link to={`/contacts?contact=${c.contact.id}`} className="text-emerald-600 hover:underline dark:text-emerald-400">{c.contact.name}</Link>
              ) : 'Someone'}
              {c.openDays !== null && <> · open {c.openDays}d</>}
            </p>
            {c.quote && <p className="mt-1 border-l-2 border-zinc-200 pl-2 text-xs italic text-zinc-500 dark:border-zinc-700">“{c.quote.slice(0, 160)}”</p>}
            <div className="mt-2 flex items-center gap-1.5">
              <button onClick={() => decide(c, true)} disabled={busy === c.id} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400">
                {busy === c.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />} Yes, done
              </button>
              <button onClick={() => decide(c, false)} disabled={busy === c.id} className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-500/25 disabled:opacity-50 dark:text-rose-400">
                <X size={13} /> Not yet
              </button>
            </div>
          </li>
        ))}
      </ul>
      {claims.length > 5 && <p className="mt-1.5 text-[11px] text-zinc-400">…and {claims.length - 5} more</p>}
    </section>
  );
}
