import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Collapsible card — header (icon + title + optional badge + chevron), body hidden until tapped.
 * Lifted out of Settings (BEA-531) so every page folds the same way. (BEA-1210)
 *
 * `summary` is the 1–2 line preview shown ONLY while collapsed — the page stays scannable and the
 * detail is one tap away. `dense` uses the compact padding the contact page cards already use.
 */
export function Accordion({ title, icon: Icon, badge, summary, defaultOpen, dense, tile, children }: {
  title: ReactNode; icon?: LucideIcon; badge?: ReactNode; summary?: ReactNode;
  defaultOpen?: boolean; dense?: boolean;
  /** Colour classes for an icon TILE (e.g. 'bg-violet-500/10 text-violet-500') — the approved
   *  contact/tasks design leads every accordion with one. Without it the icon renders plain. */
  tile?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const pad = dense ? 'p-3' : 'p-5';
  const padBody = dense ? 'px-3 pb-3' : 'px-5 pb-5';
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={`flex w-full items-center gap-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${pad}`}>
        {Icon && tile && <span className={'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ' + tile}><Icon size={16} /></span>}
        <span className="min-w-0 flex-1">
          <span className={'flex min-w-0 items-center gap-2 font-semibold ' + (dense ? 'text-sm' : '')}>
            {Icon && !tile && <Icon size={dense ? 14 : 18} className="shrink-0 text-emerald-600" />}
            <span className="truncate">{title}</span>
            {badge}
          </span>
          {!open && summary && <span className="mt-0.5 block">{summary}</span>}
        </span>
        <ChevronDown size={dense ? 15 : 18} className={'shrink-0 text-zinc-400 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>
      {open && <div className={padBody}>{children}</div>}
    </section>
  );
}
