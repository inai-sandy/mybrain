import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Hand, Loader2 } from 'lucide-react';
import { useToast } from './Toast';

type Claim = {
  id: string;
  taskId: string;
  task?: { id: string; title: string } | null;
  contact: { id: string; name: string } | null;
  quote: string;
  openDays: number | null;
  label?: string;
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
    // The same inbox the Review tab shows, so the number on Today and the number there agree.
    // It used to read /api/tasks/claims, which only knew about completion claims — never a
    // problem someone raised. (BEA-1159)
    fetch('/api/reminders/review')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setClaims((d.items || []).map((i: any) => ({ id: i.id, taskId: i.task?.id || '', task: i.task, contact: i.contact, quote: i.text, openDays: i.openDays, label: i.label }))))
      .catch(() => setClaims([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function decide(c: Claim, confirm: boolean) {
    setBusy(c.id);
    try {
      const r = await fetch(`/api/reminders/review/${c.id}/close`, { method: 'POST' });
      if (!r.ok) { toast('error', 'Could not save that'); return; }
      toast('success', 'Closed');
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
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
          <Hand size={13} /> {claims.length === 1 ? 'One thing needs you' : `${claims.length} things need you`}
        </h3>
        <Link to="/tasks?tab=review" className="text-[11px] font-medium text-violet-600 hover:underline dark:text-violet-400">Open review →</Link>
      </div>
      <ul className="space-y-1.5">
        {claims.slice(0, 5).map((c) => (
          <li key={c.id} className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm leading-snug">{c.task?.title || 'Something they said'}</p>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              {c.contact ? (
                // Straight to the person, where the conversation is. Never a quote with nowhere to go.
                <Link to={`/contacts?contact=${c.contact.id}`} className="text-emerald-600 hover:underline dark:text-emerald-400">{c.contact.name}</Link>
              ) : 'Someone'}
              {c.openDays !== null && <> · open {c.openDays}d</>}
            </p>
            {c.label && <p className="mt-0.5 text-[11px] text-zinc-400">{c.label}</p>}
            {c.quote && <p className="mt-1 whitespace-pre-wrap border-l-2 border-zinc-200 pl-2 text-xs text-zinc-500 dark:border-zinc-700">{c.quote.slice(0, 160)}</p>}
            <div className="mt-2">
              <button onClick={() => decide(c, true)} disabled={busy === c.id} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400">
                {busy === c.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />} Sorted, close it
              </button>
            </div>
          </li>
        ))}
      </ul>
      {claims.length > 5 && <p className="mt-1.5 text-[11px] text-zinc-400">…and {claims.length - 5} more</p>}
    </section>
  );
}
