import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Loader2, Mail, RotateCcw, Search, X } from 'lucide-react';
import { Sheet } from './Sheet';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';

type Sender = { from: string; count: number; blocked: boolean };
type Breakdown = { total: number; blocked: string[]; senders: Sender[] };

/**
 * Who is filling your brain with email, and the power to stop them (BEA-1126).
 *
 * Until now the only control was one blind on/off switch for "Important Emails" — no counts, so
 * there was no way to know that email was 45% of the brain, or that a single no-reply sender was
 * bigger than any colleague. Gmail's "important" flag decided; the owner could not.
 */
export function EmailSendersSheet({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Breakdown | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Sender | null>(null);

  const load = useCallback(() => {
    setData(null);
    return fetch('/api/google/email-memory/senders')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setBlocked(s: Sender, on: boolean) {
    setBusy(s.from);
    try {
      const r = await fetch('/api/google/email-memory/senders/block', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: s.from, blocked: on }),
      });
      if (!r.ok) throw new Error();
      const d = await r.json().catch(() => ({ removed: 0 }));
      toast('success', on
        ? `Blocked ${s.from}${d.removed ? ` — ${d.removed} email${d.removed === 1 ? '' : 's'} removed from your brain` : ''}`
        : `Unblocked ${s.from} — new mail from them will be remembered again`);
      await load();
      onChanged?.();
    } catch {
      toast('error', 'Could not change that — try again');
    } finally {
      setBusy(null);
    }
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.senders || []).filter((s) => !needle || s.from.includes(needle));
  }, [data, q]);

  return (
    <>
      <Sheet onClose={onClose}>
        {(close) => (
          <div>
            <div className="mb-1 flex items-start justify-between gap-2">
              <div>
                <h3 className="flex items-center gap-2 font-bold"><Mail size={16} className="text-emerald-600" /> Who fills your brain with email</h3>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {data === null ? 'Loading…' : `${data.total} email${data.total === 1 ? '' : 's'} from ${data.senders.length} sender${data.senders.length === 1 ? '' : 's'}`}
                </p>
              </div>
              <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
            </div>

            <p className="mb-3 text-[11px] text-zinc-400">
              Blocking removes everything already stored from that sender and stops anything new. Machine addresses
              (no-reply, mailer-daemon) are refused automatically.
            </p>

            <div className="relative mb-3">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search senders…"
                className="w-full rounded-lg border border-zinc-300 bg-zinc-100 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </div>

            {data === null ? (
              <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-11 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />)}</div>
            ) : shown.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                {data.senders.length ? 'No sender matches that.' : 'No email in your brain yet.'}
              </div>
            ) : (
              <ul className="max-h-[55vh] space-y-1.5 overflow-y-auto pr-1">
                {shown.map((s) => (
                  <li key={s.from} className={'flex items-center gap-2 rounded-lg border p-2.5 ' + (s.blocked ? 'border-rose-500/30 bg-rose-500/5' : 'border-zinc-200 dark:border-zinc-800')}>
                    <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-zinc-500">{s.count}</span>
                    <span className={'min-w-0 flex-1 break-all text-sm ' + (s.blocked ? 'text-zinc-400 line-through' : '')}>{s.from}</span>
                    <button
                      onClick={() => (s.blocked ? setBlocked(s, false) : setConfirm(s))}
                      disabled={busy === s.from}
                      className={'inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium disabled:opacity-50 ' + (s.blocked
                        ? 'border border-zinc-300 text-zinc-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-300'
                        : 'border border-zinc-300 text-zinc-500 hover:border-rose-500 hover:text-rose-600 dark:border-zinc-700')}
                    >
                      {busy === s.from ? <Loader2 size={11} className="animate-spin" /> : s.blocked ? <RotateCcw size={11} /> : <Ban size={11} />}
                      {s.blocked ? 'Unblock' : 'Block'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={!!confirm}
        title={`Block ${confirm?.from}?`}
        message={`Their ${confirm?.count} email${confirm?.count === 1 ? '' : 's'} will be removed from your brain, and nothing new from them will be remembered. You can unblock later, but the removed mail does not come back.`}
        confirmLabel="Block and remove"
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const s = confirm!; setConfirm(null); setBlocked(s, true); }}
      />
    </>
  );
}
