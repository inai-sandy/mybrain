/** Colored file-type badge — each kind gets its own color. (BEA-589) */
const KIND_STYLES: Record<string, string> = {
  pdf: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  html: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  md: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  markdown: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  image: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  site: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
};

export function KindBadge({ kind, className = '' }: { kind: string; className?: string }) {
  const style = KIND_STYLES[(kind || '').toLowerCase()] || 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400';
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style} ${className}`}>{kind || 'doc'}</span>;
}
