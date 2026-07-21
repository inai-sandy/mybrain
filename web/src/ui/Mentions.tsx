import { useEffect, useRef, useState } from 'react';
import { AtSign, AlertTriangle, HelpCircle } from 'lucide-react';

export type Mention =
  | { raw: string; status: 'matched'; contactId: string; contactName: string }
  | { raw: string; status: 'ambiguous'; options: { id: string; name: string }[] }
  | { raw: string; status: 'unknown' };

/**
 * Resolve the `@names` in some text as it's typed. Debounced, latest-wins, and it only asks the
 * server when the text actually contains an "@" — so the common case costs nothing. (BEA-1019)
 */
export function useMentions(text: string, delay = 350): Mention[] {
  const [mentions, setMentions] = useState<Mention[]>([]);
  const req = useRef(0);

  useEffect(() => {
    if (!text || !text.includes('@')) { setMentions([]); return; }
    const id = ++req.current;
    const t = setTimeout(() => {
      fetch('/api/tasks/mentions/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
        .then((r) => (r.ok ? r.json() : { mentions: [] }))
        .then((d) => { if (id === req.current) setMentions(d.mentions || []); })
        .catch(() => { if (id === req.current) setMentions([]); });
    }, delay);
    return () => clearTimeout(t);
  }, [text, delay]);

  return mentions;
}

/**
 * What the @names came out as. Green means a real link will be made; amber means two people share
 * that name so nothing is linked until you say which; grey means nobody by that name. Never a
 * silent guess. (BEA-1019)
 */
export function MentionChips({ mentions, className = '' }: { mentions: Mention[]; className?: string }) {
  if (!mentions.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {mentions.map((m, i) => {
        if (m.status === 'matched') {
          return (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 text-[11px] font-medium">
              <AtSign className="w-3 h-3" aria-hidden />
              {m.contactName}
            </span>
          );
        }
        if (m.status === 'ambiguous') {
          return (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-0.5 text-[11px] font-medium" title={`${m.options.length} people are called ${m.raw} — nothing linked`}>
              <AlertTriangle className="w-3 h-3" aria-hidden />
              {m.raw} — which one?
            </span>
          );
        }
        return (
          <span key={i} className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 px-2 py-0.5 text-[11px]" title="Not in your contacts — nothing linked">
            <HelpCircle className="w-3 h-3" aria-hidden />
            {m.raw} — not a contact
          </span>
        );
      })}
    </div>
  );
}
