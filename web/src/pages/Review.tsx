import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Loader2, Quote, Search, CheckCheck, Hand, Send } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { Sheet } from '../ui/Sheet';
import { useUrlState } from '../ui/useUrlState';

type Claim = {
  id: string;
  taskId: string;
  chaseId: string | null;
  task?: { id: string; title: string; note?: string | null; openedAt: string };
  contact: { id: string; name: string } | null;
  source: string;
  quote: string;
  createdAt: string;
  openDays: number | null;
};

const ago = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
};

const SOURCE_LABEL: Record<string, string> = { whatsapp: 'on WhatsApp', page: 'on their page', owner: 'you said so' };

/**
 * Everything someone says they've finished, in one place. Nothing here is done until you say so —
 * that is the entire point of the screen. (BEA-1025)
 */
export function Review({ embedded = false, onCountChange }: { embedded?: boolean; onCountChange?: (n: number) => void } = {}) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useUrlState('q', '');
  const [rejecting, setRejecting] = useState<Claim | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const PAGE = 10;
  const toast = useToast();

  const load = useCallback(() => {
    return fetch('/api/tasks/claims')
      .then((r) => (r.ok ? r.json() : { claims: [] }))
      .then((d) => { setClaims(d.claims || []); onCountChange?.((d.claims || []).length); })
      .catch(() => setClaims([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const rows = claims || [];
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((c) => `${c.task?.title || ''} ${c.contact?.name || ''} ${c.quote}`.toLowerCase().includes(t));
  }, [claims, q]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const shown = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);

  async function decide(c: Claim, confirm: boolean, reason?: string) {
    setBusy(c.id);
    try {
      const r = await fetch(`/api/tasks/claims/${c.id}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm, reason }),
      });
      if (!r.ok) { toast('error', 'Could not save that'); return false; }
      const d = await r.json();
      if (!d.ok) { toast('error', d.message || 'Already decided'); await load(); return false; }
      toast('success', confirm ? 'Confirmed — chase stopped' : 'Sent back — chase resumes');
      setPicked((s) => { const n = new Set(s); n.delete(c.id); return n; });
      await load();
      return true;
    } catch { toast('error', 'Could not reach the server'); return false; } finally { setBusy(null); }
  }

  async function confirmPicked() {
    const ids = [...picked];
    if (!ids.length) return;
    setBusy('bulk');
    try {
      const r = await fetch('/api/tasks/claims/decide-many', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, confirm: true }),
      });
      const d = r.ok ? await r.json() : { decided: 0 };
      toast('success', `${d.decided} confirmed`);
      setPicked(new Set());
      await load();
    } catch { toast('error', 'Could not reach the server'); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          {/* As a Tasks tab the page header is the Tasks header — no second title. (BEA-1044) */}
          {!embedded && <h1 className="flex items-center gap-2 text-2xl font-extrabold"><Hand className="text-violet-500" /> To review</h1>}
          <p className="text-sm text-zinc-500">
            {claims === null ? 'Loading…' : claims.length === 0 ? 'Nothing waiting on you' : `${claims.length} thing${claims.length === 1 ? '' : 's'} someone says ${claims.length === 1 ? 'is' : 'are'} finished`}
          </p>
        </div>
        {!!picked.size && (
          <button onClick={confirmPicked} disabled={busy === 'bulk'} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy === 'bulk' ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />} Confirm {picked.size}
          </button>
        )}
      </div>

      {!!(claims && claims.length) && (
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by person, task or what they said…"
            className="w-full rounded-lg border border-zinc-300 bg-zinc-100 py-2 pl-8 pr-3 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
      )}

      {claims === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <Check className="mx-auto mb-2 h-7 w-7 text-emerald-500" />
          <p className="text-sm font-medium">{claims.length ? 'Nothing matches that' : "You're all clear"}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {claims.length ? 'Try a different search.' : 'When someone says a job is done, it lands here for your yes or no.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((c) => {
            const on = picked.has(c.id);
            return (
              <li key={c.id} className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-start gap-3">
                  <button
                    onClick={() => setPicked((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                    aria-label={on ? 'Deselect' : 'Select for bulk confirm'}
                    className={'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ' + (on ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-300 dark:border-zinc-600')}
                  >
                    {on && <Check size={11} className="text-white" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug">{c.task?.title || 'A task'}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      <span className="font-medium text-zinc-600 dark:text-zinc-300">{c.contact?.name || 'Someone'}</span> {SOURCE_LABEL[c.source] || ''} · {ago(c.createdAt)}
                      {c.openDays !== null && <> · open {c.openDays === 0 ? 'today' : `${c.openDays} day${c.openDays === 1 ? '' : 's'}`}</>}
                    </p>
                    <blockquote className="mt-2 flex gap-1.5 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                      <Quote size={12} className="mt-1 shrink-0 text-zinc-400" />
                      <span className="min-w-0 break-words">{c.quote}</span>
                    </blockquote>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => decide(c, true)}
                        disabled={busy === c.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {busy === c.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} It's done
                      </button>
                      <button
                        onClick={() => setRejecting(c)}
                        disabled={busy === c.id}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:border-rose-400 hover:text-rose-600 disabled:opacity-50 dark:border-zinc-700"
                      >
                        <X size={14} /> Not yet
                      </button>
                      <Link to="/tasks" className="inline-flex items-center rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Open task</Link>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} className="rounded-lg border border-zinc-300 px-3 py-1.5 disabled:opacity-40 dark:border-zinc-700">← Prev</button>
          <span>Page {safePage + 1} of {pages} · {filtered.length} total</span>
          <button disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)} className="rounded-lg border border-zinc-300 px-3 py-1.5 disabled:opacity-40 dark:border-zinc-700">Next →</button>
        </div>
      )}

      {rejecting && <RejectSheet claim={rejecting} onClose={() => setRejecting(null)} onDone={(reason, message) => decide(rejecting, false, reason).then((ok) => { if (ok && message && rejecting.chaseId) sendBack(rejecting.chaseId, message, toast); setRejecting(null); })} />}
    </div>
  );
}

function sendBack(chaseId: string, body: string, toast: (k: any, m: string) => void) {
  fetch(`/api/reminders/${chaseId}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) })
    .then((r) => { if (!r.ok) toast('error', 'Sent back, but the message did not go — open the chat'); })
    .catch(() => toast('error', 'Sent back, but the message did not go — open the chat'));
}

/** Rejecting is the moment to tell them why, in your words — so the message is yours to edit. */
function RejectSheet({ claim, onClose, onDone }: { claim: Claim; onClose: () => void; onDone: (reason: string, message: string) => void }) {
  const first = (claim.contact?.name || '').split(/\s+/)[0] || 'there';
  const [reason, setReason] = useState('');
  const [tell, setTell] = useState(!!claim.chaseId);
  const [message, setMessage] = useState(`Hi ${first}, thanks for the update — Sandeep says "${claim.task?.title || 'this'}" is still open on his side. Could you take another look?`);

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="font-bold">Not done yet</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          <p className="mb-3 text-xs text-zinc-500">This goes back to open and the chase starts again.</p>

          <label className="block text-sm text-zinc-600 dark:text-zinc-400">
            Why? <span className="text-zinc-400">(just for you)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. never arrived" className="mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950" />
          </label>

          {claim.chaseId ? (
            <>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={tell} onChange={(e) => setTell(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
                Tell {first} on WhatsApp
              </label>
              {tell && (
                <>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="mt-2 w-full resize-none rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950" />
                  <p className="mt-1 text-[11px] text-zinc-400">Edit it before it goes — it's sent in your name.</p>
                </>
              )}
            </>
          ) : (
            <p className="mt-3 text-xs text-zinc-400">There's no active chase on this one, so nothing will be sent.</p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={close} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Cancel</button>
            <button
              onClick={() => onDone(reason, tell && claim.chaseId ? message.trim() : '')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-1.5 text-sm text-white hover:bg-rose-500"
            >
              {tell && claim.chaseId ? <><Send size={14} /> Send back</> : 'Send back'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
