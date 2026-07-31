import { useCallback, useEffect, useState } from 'react';
import { Link2, MessageSquare, Check, Hand, ChevronDown, Loader2 } from 'lucide-react';
import { useToast } from './Toast';
import { Accordion } from './Accordion';

type Update = {
  id: string;
  text: string;
  channel: 'whatsapp' | 'link';
  at: string;
  reads: string[];
  label: string;
  needsYou: boolean;
  closedAt: string | null;
  task: { id: string; title: string } | null;
};

/**
 * Everything one person has said, in the order they said it. (BEA-1159)
 *
 * Their WhatsApp replies lived in one place, what they wrote on their own link lived welded to a
 * claim quote, and a report arriving lived on a different screen again. So the owner read one
 * channel and inferred the rest — and Swathi's three messages from a single morning were invisible
 * on her own page while her sixty WhatsApp messages sat right there.
 *
 * One thread, each entry saying how it arrived, and anything still needing him answerable here.
 */
export function PersonTimeline({ contactId, reload }: { contactId: string; reload?: number }) {
  const toast = useToast();
  const [items, setItems] = useState<Update[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/reminders/review/contact/${contactId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]));
  }, [contactId]);
  useEffect(() => { load(); }, [load, reload]);

  async function close(u: Update) {
    setBusy(u.id);
    try {
      await fetch(`/api/reminders/review/${u.id}/close`, { method: 'POST' });
      toast('success', 'Closed');
      load();
    } catch {
      toast('error', 'Could not close that');
    } finally {
      setBusy(null);
    }
  }

  if (!items || !items.length) return null;
  const openCount = items.filter((u) => u.needsYou && !u.closedAt).length;
  // Newest last reads like a conversation; the tail is what matters, so show it by default.
  const shown = open ? items : items.slice(-6);
  const last = items[items.length - 1];

  // An accordion like every other section on the page (BEA-1215): collapsed it shows the LAST
  // thing they said — usually the exact answer being looked for — instead of eating the screen.
  return (
    <Accordion
      dense
      icon={MessageSquare}
      tile="bg-emerald-500/10 text-emerald-500"
      title={<>Everything they've said <span className="font-normal text-zinc-400">· {items.length}</span></>}
      badge={openCount > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-violet-600 dark:text-violet-400">
          <Hand size={11} /> {openCount} needs you
        </span>
      ) : null}
      summary={<span className="line-clamp-2 text-xs font-normal text-zinc-400">“{last.text}” · {new Date(last.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
    >
      <ul className="space-y-1.5">
        {shown.map((u) => (
          <li key={u.id} className={'rounded-lg border px-3 py-2 ' + (u.needsYou && !u.closedAt ? 'border-violet-400/50 bg-violet-500/5' : 'border-zinc-200 dark:border-zinc-800')}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1">
                {u.channel === 'link' ? <><Link2 size={10} /> their link</> : <><MessageSquare size={10} /> WhatsApp</>}
              </span>
              <span>{new Date(u.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
              {u.needsYou && !u.closedAt && <span className="text-violet-600 dark:text-violet-400">{u.label}</span>}
              {u.closedAt && <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Check size={10} /> you closed this</span>}
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-sm leading-snug">{u.text}</p>
            {u.task && <p className="mt-0.5 text-[11px] text-zinc-400">on “{u.task.title}”</p>}
            {u.needsYou && !u.closedAt && (
              <button
                onClick={() => close(u)}
                disabled={busy === u.id}
                className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-600 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400"
              >
                {busy === u.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Sorted, close it
              </button>
            )}
          </li>
        ))}
      </ul>

      {items.length > 6 && (
        <button onClick={() => setOpen((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          <ChevronDown size={12} className={'transition-transform ' + (open ? 'rotate-180' : '')} />
          {open ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </Accordion>
  );
}
