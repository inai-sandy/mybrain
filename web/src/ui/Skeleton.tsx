/** A soft shimmering placeholder block — use while content loads instead of bare "Loading…". */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={'relative overflow-hidden rounded-md bg-zinc-200/70 dark:bg-zinc-800/60 ' + className}>
      <div
        className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/50 dark:via-white/10 to-transparent"
        style={{ animation: 'mb-shimmer 1.3s infinite' }}
      />
    </div>
  );
}
