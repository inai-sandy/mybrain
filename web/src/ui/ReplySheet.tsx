import { useState } from 'react';
import { Check, Loader2, MessageSquare, Send, X } from 'lucide-react';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

/**
 * The ONE reply / close sheet for a "needs you" item — used by Tasks → Needs you and by the
 * Dashboard's team rows, so the owner can answer from wherever he saw it. (BEA-1597)
 *
 * It talks only to the review endpoints the inbox already had: `/reply` (goes out on WhatsApp and
 * lands in their thread), `/decide` (yes/no on a done-claim) and `/close` (the only way an item
 * leaves the inbox). Body scroll is the shared ref-counted lock inside `Sheet` — never a lock of
 * its own (BEA-155).
 */
export type ReplyTarget = {
  id: string;
  text: string;
  /** The reason line — `readLabel()` on the server, the same string on every surface. */
  label?: string;
  contact: { id?: string; name: string } | null;
  canReply: boolean;
  /** Set when they claimed a task finished — then this is a yes/no, not just something to read. */
  claimId?: string | null;
  perTask?: boolean;
  task?: { id?: string; title: string } | null;
};

export type ReplyOutcome =
  | { kind: 'replied' }
  | { kind: 'closed'; pendingClaim: boolean }
  | { kind: 'decided'; confirm: boolean; stillOpen: boolean };

type ApiAnswer = { ok: boolean; message?: string; stillOpen?: boolean; pendingClaim?: boolean };

async function post(url: string, body?: unknown): Promise<ApiAnswer> {
  const r = await fetch(url, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: r.ok }));
}

/** The three review actions, in one place — the inbox card and the sheet both call these. */
export const reviewApi = {
  reply: (id: string, text: string) => post(`/api/reminders/review/${id}/reply`, { text }),
  // The exact claim the card showed — never let the server re-guess it. (BEA-1221)
  decide: (id: string, confirm: boolean, claimId?: string | null) => post(`/api/reminders/review/${id}/decide`, { confirm, claimId: claimId || undefined }),
  close: (id: string) => post(`/api/reminders/review/${id}/close`),
};

export function ReplySheet({ item, onClose, onDone }: { item: ReplyTarget; onClose: () => void; onDone?: (o: ReplyOutcome) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'close' | 'yes' | 'no' | null>(null);
  const name = item.contact?.name || 'them';

  async function send(close: () => void) {
    const text = draft.trim();
    if (!text) return;
    setBusy('send');
    try {
      const d = await reviewApi.reply(item.id, text);
      if (!d.ok) { toast('error', d.message || 'Could not send that'); return; }
      // Deliberately stays open: answering is not solving. He closes it when the problem is gone.
      toast('success', `Sent to ${name} — still open until you close it`);
      setDraft('');
      onDone?.({ kind: 'replied' });
      close();
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  /** Yes it's done, or no it isn't — "No" is what puts the chase back on. (BEA-1159) */
  async function decide(close: () => void, confirm: boolean) {
    setBusy(confirm ? 'yes' : 'no');
    try {
      const d = await reviewApi.decide(item.id, confirm, item.claimId);
      if (!d.ok) { toast('error', d.message || 'Could not save that'); return; }
      toast('success', (confirm ? 'Marked done — no more chasing for it' : `Sent back — ${name} will be chased again`)
        + (d.stillOpen ? '. Their message stays until you close it.' : ''));
      onDone?.({ kind: 'decided', confirm, stillOpen: !!d.stillOpen });
      close();
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  async function closeIt(close: () => void) {
    setBusy('close');
    try {
      const d = await reviewApi.close(item.id);
      if (!d.ok) { toast('error', 'Could not close that'); return; }
      toast('success', d.pendingClaim ? `Closed — ${name} still has a "says it's done" waiting for your Yes/No` : 'Closed');
      onDone?.({ kind: 'closed', pendingClaim: !!d.pendingClaim });
      close();
    } catch {
      toast('error', 'Could not close that');
    } finally {
      setBusy(null);
    }
  }

  const primary = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50';

  return (
    // A half-typed reply must not vanish on a stray backdrop tap — the buttons still close. (BEA-512)
    <Sheet onClose={onClose} blockBackdropClose={() => draft.trim().length > 0}>
      {(close) => (
        <div data-testid="reply-sheet">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-bold"><MessageSquare size={18} className="text-emerald-600" /> Reply to {name}</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          {item.label && (
            <p className="mb-3 text-xs text-zinc-500">
              Why it needs you: <span className="font-medium text-amber-600 dark:text-amber-500" data-testid="reply-sheet-reason">{item.label}</span>
            </p>
          )}
          {item.task && <p className="mb-1.5 text-[11px] text-zinc-500">on “{item.task.title}”</p>}

          {/* Their exact words. Never rewritten, never summarised. */}
          <p className="max-h-[30vh] overflow-y-auto whitespace-pre-wrap border-l-2 border-zinc-200 pl-2.5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">{item.text}</p>

          <textarea
            autoFocus
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!item.canReply}
            placeholder={item.canReply ? `Reply to ${name} — this goes to their WhatsApp` : 'No WhatsApp number for them'}
            className="mt-3 w-full rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-emerald-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
          />
          {!item.canReply && <p className="mt-1 text-xs text-zinc-400">No WhatsApp number for {name} — you can still close it.</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => send(close)} disabled={!!busy || !item.canReply || !draft.trim()} className={primary + ' bg-emerald-600 text-white hover:bg-emerald-500'}>
              {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send on WhatsApp
            </button>
            {item.claimId ? (
              <>
                <button onClick={() => decide(close, true)} disabled={!!busy} className={primary + ' bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400'}>
                  {busy === 'yes' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {item.perTask ? 'Yes, this one is done' : "Yes, it's done"}
                </button>
                <button onClick={() => decide(close, false)} disabled={!!busy} className={primary + ' bg-rose-500/15 text-rose-600 hover:bg-rose-500/25 dark:text-rose-400'}>
                  {busy === 'no' ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} {item.perTask ? 'Not this one — keep chasing' : 'No — keep chasing'}
                </button>
              </>
            ) : (
              <button onClick={() => closeIt(close)} disabled={!!busy} className={primary + ' bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400'}>
                {busy === 'close' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Sorted, close it
              </button>
            )}
            <button onClick={close} className="ml-auto rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-500 dark:border-zinc-700">Cancel</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
