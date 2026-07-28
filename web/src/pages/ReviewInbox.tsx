import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Send, Loader2, MessageSquare, Link2, Radio, Search } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Item = {
  id: string;
  text: string;
  channel: 'whatsapp' | 'link';
  at: string;
  openDays: number;
  label: string;
  why: string | null;
  contact: { id: string; name: string; whatsappNumber: string | null } | null;
  task: { id: string; title: string; status: string } | null;
  chasePaused: boolean;
  canReply: boolean;
  /** Set when they claimed a task finished — then this is a yes/no, not just something to read. */
  claimId: string | null;
  /** One row per job, because they may only have done one of them. (BEA-1159) */
  perTask?: boolean;
};

/**
 * Review — where the team's problems come to the owner, and get closed. (BEA-1159)
 *
 * His loop, in his words: *"We send a WhatsApp reminder. If they need my help, it will land in the
 * review section. I will message them in the review section, and if the help is done, I will close
 * it."*
 *
 * Two things this must never do again. It must not wait for someone to ask — Radha wrote "we didn't
 * receive sense PCB" and the old signal ignored it because she never said the word help. And it must
 * not lose an item: the old flag was cleared by the next reply the agent could handle, so a "Kk sir"
 * erased the record that someone needed him. Here, only closing removes it.
 */
export function ReviewInbox({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const toast = useToast();
  const [items, setItems] = useState<Item[] | null>(null);
  const [q, setQ] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/reminders/review')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => { setItems(d.items || []); onCountChange?.((d.items || []).length); })
      .catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  async function send(it: Item) {
    const text = draft.trim();
    if (!text) return;
    setBusy(it.id);
    try {
      const r = await fetch(`/api/reminders/review/${it.id}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      const d = await r.json().catch(() => ({ ok: false }));
      if (!d.ok) { toast('error', d.message || 'Could not send that'); return; }
      // Deliberately stays open: answering is not solving. He closes it when the problem is gone.
      toast('success', `Sent to ${it.contact?.name || 'them'} — still open until you close it`);
      setDraft('');
      setReplyTo(null);
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Yes it's done, or no it isn't. (BEA-1159)
   *
   * Saying no is the important half: a pending claim keeps the chase quiet, so an undecided claim
   * left the task open forever with nobody being chased. "No" puts the chase straight back on.
   */
  async function decide(it: Item, confirm: boolean) {
    setBusy(it.id);
    try {
      const r = await fetch(`/api/reminders/review/${it.id}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }),
      });
      const d = await r.json().catch(() => ({ ok: false }));
      if (!d.ok) { toast('error', d.message || 'Could not save that'); return; }
      toast('success', confirm ? 'Marked done — no more chasing for it' : `Sent back — ${it.contact?.name || 'they'} will be chased again`);
      setItems((xs) => { const next = (xs || []).filter((x) => x.id !== it.id); onCountChange?.(next.length); return next; });
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  async function close(it: Item) {
    setBusy(it.id);
    try {
      await fetch(`/api/reminders/review/${it.id}/close`, { method: 'POST' });
      toast('success', 'Closed');
      setItems((xs) => { const next = (xs || []).filter((x) => x.id !== it.id); onCountChange?.(next.length); return next; });
    } catch {
      toast('error', 'Could not close that');
    } finally {
      setBusy(null);
    }
  }

  if (!items) return <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>;

  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => !needle || `${i.text} ${i.contact?.name || ''} ${i.task?.title || ''}`.toLowerCase().includes(needle));

  if (!items.length) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
        <Check className="mx-auto mb-2 h-8 w-8 text-emerald-500" />
        <p className="font-medium">Nothing needs you</p>
        <p className="mt-1 text-sm text-zinc-500">When someone says a thing is done, or tells you they're stuck, it lands here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.length > 4 && (
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search what they said, or a name…"
            className="w-full rounded-lg border border-zinc-200 bg-zinc-100 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
      )}

      {shown.length === 0 && <p className="py-6 text-center text-sm text-zinc-400">Nothing matches “{q}”.</p>}

      {shown.some((i) => i.perTask) && (
        <p className="text-[11px] text-zinc-400">
          One message can cover more than one job, and they may only have done one — so each is here on its own.
        </p>
      )}

      <ul className="space-y-2.5">
        {shown.map((it) => (
          <li key={it.id} className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
              {it.contact && (
                <Link to={`/contacts?contact=${it.contact.id}`} className="font-medium text-emerald-600 hover:underline dark:text-emerald-400">{it.contact.name}</Link>
              )}
              <span className="inline-flex items-center gap-1">
                {it.channel === 'link' ? <><Link2 size={11} /> on their link</> : <><MessageSquare size={11} /> on WhatsApp</>}
              </span>
              <span className="tabular-nums">{it.openDays === 0 ? 'today' : `${it.openDays}d ago`}</span>
              <span className={it.label.includes('problem') ? 'text-amber-600 dark:text-amber-500' : 'text-violet-600 dark:text-violet-400'}>{it.label}</span>
              {/* He replies and then nothing follows up — worth knowing before he answers. (BEA-1160) */}
              {it.chasePaused && <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400"><Radio size={11} /> their chase is off</span>}
            </div>

            {/* On a split row the TASK is the question, so it leads — their words are the evidence. */}
            {it.task && (
              <p className={it.perTask ? 'mt-1 text-sm font-medium' : 'mt-1.5 text-[11px] text-zinc-500'}>
                {it.perTask ? it.task.title : `on “${it.task.title}”`}
              </p>
            )}

            {/* Their exact words. Never rewritten, never summarised. */}
            <p className="mt-1 whitespace-pre-wrap border-l-2 border-zinc-200 pl-2.5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">{it.text}</p>

            {replyTo === it.id ? (
              <div className="mt-2.5 space-y-2">
                <textarea
                  autoFocus
                  rows={3}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`Reply to ${it.contact?.name || 'them'} — this goes to their WhatsApp`}
                  className="w-full rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => send(it)} disabled={busy === it.id || !draft.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                    {busy === it.id ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send on WhatsApp
                  </button>
                  <button onClick={() => { setReplyTo(null); setDraft(''); }} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-500 dark:border-zinc-700">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {/* They claimed a task finished — this is a decision, and "No" restarts the chase. */}
                {it.claimId ? (
                  <>
                    <button onClick={() => decide(it, true)} disabled={busy === it.id} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-600 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400">
                      {busy === it.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {it.perTask ? 'Yes, this one is done' : "Yes, it's done"}
                    </button>
                    <button onClick={() => decide(it, false)} disabled={busy === it.id} className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-500/25 disabled:opacity-50 dark:text-rose-400">
                      <X size={14} /> {it.perTask ? 'Not this one — keep chasing' : 'No — keep chasing'}
                    </button>
                  </>
                ) : (
                  <button onClick={() => close(it)} disabled={busy === it.id} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-600 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400">
                    {busy === it.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Sorted, close it
                  </button>
                )}
                <button
                  onClick={() => { setReplyTo(it.id); setDraft(''); }}
                  disabled={!it.canReply}
                  title={it.canReply ? undefined : 'No WhatsApp number for them'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                >
                  <Send size={14} /> Message them
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
