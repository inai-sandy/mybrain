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
export function Accordion({ title, icon: Icon, badge, summary, defaultOpen, dense, children }: {
  title: ReactNode; icon?: LucideIcon; badge?: ReactNode; summary?: ReactNode;
  defaultOpen?: boolean; dense?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const pad = dense ? 'p-3' : 'p-5';
  const padBody = dense ? 'px-3 pb-3' : 'px-5 pb-5';
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={`flex w-full items-center justify-between gap-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${pad}`}>
        <span className={'flex min-w-0 items-center gap-2 font-semibold ' + (dense ? 'text-xs text-zinc-500' : '')}>
          {Icon && <Icon size={dense ? 14 : 18} className="shrink-0 text-emerald-600" />}
          <span className="truncate">{title}</span>
          {badge}
        </span>
        <ChevronDown size={dense ? 15 : 18} className={'shrink-0 text-zinc-400 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>
      {!open && summary && <div className={`${padBody} -mt-1`}>{summary}</div>}
      {open && <div className={padBody}>{children}</div>}
    </section>
  );
}
