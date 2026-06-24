import { trustRung } from './client';

/** A clear 4-rung trust ladder shown on each finding instead of a bare % bar. Turns green + full
 *  the moment you confirm it (validated='confirmed'), so tapping ✓ visibly lands. (BEA-514) */
export function TrustLadder({ confidence, validated, className = '' }: { confidence: number; validated?: string | null; className?: string }) {
  const { label, step } = trustRung(confidence, validated);
  const confirmed = step >= 4;
  return (
    <span className={'inline-flex items-center gap-1.5 align-middle ' + className} title={confirmed ? 'You confirmed this' : `${label} — tap ✓ to trust it more`}>
      <span className="flex gap-0.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={'h-1.5 w-3 rounded-full transition-colors ' + (i <= step ? (confirmed ? 'bg-emerald-500' : 'bg-violet-400') : 'bg-zinc-200 dark:bg-zinc-700')} />
        ))}
      </span>
      <span className={'text-[10px] font-medium ' + (confirmed ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400')}>{label}</span>
    </span>
  );
}
