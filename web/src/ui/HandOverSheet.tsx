import { useState } from 'react';
import { ArrowRightLeft, Loader2, X } from 'lucide-react';
import { Sheet } from './Sheet';
import { PersonPicker } from './PersonPicker';
import { useToast } from './Toast';

/**
 * Hand a piece of work to somebody else. (BEA-1308)
 *
 * A job belonged to whoever it started with, for ever. Nothing anywhere ever moved a chase to a
 * different person, so "reassigning" changed the name on screen while the OLD person kept getting
 * the WhatsApp messages. It is why Radha's open work had nowhere to go when she left.
 *
 * The wording matters here. Handing work over is not an accusation, and the new person has never
 * seen it before — so the screen says plainly what will happen to both sides.
 */
export function HandOverSheet({
  task,
  onClose,
  onDone,
}: {
  task: { id: string; title: string; who?: string | null };
  onClose: () => void;
  onDone: (res?: { to?: string; chaseNotStarted?: boolean }) => void;
}) {
  const toast = useToast();
  const [to, setTo] = useState<{ contactId: string | null; name: string }>({ contactId: null, name: '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!to.contactId) { toast('error', 'Pick who is taking it on'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/tasks/${task.id}/hand-over`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toContactId: to.contactId, reason: reason.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d?.message || 'Could not hand it over'); return; }
      toast(
        'success',
        d.unchanged
          ? 'They already have it'
          : `Handed to ${d.to}${d.chasing ? ' — they will be chased now' : ''}${d.hasNumber === false ? '. They have no WhatsApp number, so nothing can be sent to them.' : d.chaseNotStarted ? '. No chase was started — set one up if you want them nudged.' : ''}`,
      );
      onDone(d);
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} blockBackdropClose={() => !!to.contactId || reason.trim().length > 0}>
      {(close) => (
        <div className="space-y-4">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-bold"><ArrowRightLeft className="h-4 w-4 text-emerald-500" /> Hand this to someone else</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-800/40">
          <div className="font-medium leading-snug">{task.title}</div>
          {task.who && <div className="mt-0.5 text-xs text-zinc-500">with {task.who} right now</div>}
        </div>

        <div>
          <label htmlFor="handover-to" className="mb-1 block text-xs font-medium text-zinc-500">Who is taking it on?</label>
          <PersonPicker id="handover-to" contactId={to.contactId} name={to.name} onChange={setTo} placeholder="Start typing a name…" />
        </div>

        <div>
          <label htmlFor="handover-why" className="mb-1 block text-xs font-medium text-zinc-500">Why? <span className="font-normal text-zinc-400">(optional, kept in the history)</span></label>
          <input
            id="handover-why"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Radha left the organisation"
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>

        {/* Say what happens to BOTH people, before it happens. */}
        <p className="text-xs leading-relaxed text-zinc-500">
          {task.who || 'Whoever has it'} stops being chased about this straight away, and {to.name || 'the new person'} starts —
          with a message that reads as a handover, not as a chase about something they have never seen. Everything said so far
          stays in the history, and you can undo it.
        </p>

        <div className="flex justify-end gap-2">
          <button onClick={close} className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !to.contactId}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
            Hand it over
          </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
