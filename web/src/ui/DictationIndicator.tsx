import { useDictationStatus } from './useDictation';
import { Mic, Loader2 } from 'lucide-react';

/** A single global banner showing whichever mic is active: the live transcript while listening, or a tidy-up spinner. */
export function DictationIndicator() {
  const { phase, interim } = useDictationStatus();
  if (phase === 'idle') return null;

  if (phase === 'transcribing') {
    return (
      <div className="fixed left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2.5 rounded-full bg-zinc-900 text-white px-4 py-2.5 shadow-xl bottom-[calc(6rem+env(safe-area-inset-bottom))] md:bottom-6">
        <Loader2 size={15} className="animate-spin text-emerald-300" />
        <span className="text-sm">{interim || 'Tidying up…'}</span>
      </div>
    );
  }

  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-[60] w-[92vw] max-w-md bottom-[calc(6rem+env(safe-area-inset-bottom))] md:bottom-6">
      <div className="rounded-2xl bg-zinc-900 text-white px-4 py-3 shadow-xl ring-1 ring-white/10">
        <div className="flex items-center gap-2.5 mb-1.5">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-rose-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500" />
          </span>
          <Mic size={14} className="shrink-0 text-rose-300" />
          <span className="text-xs font-medium text-rose-200">Listening — hold &amp; speak, release when done</span>
        </div>
        <div className="text-sm leading-relaxed max-h-24 overflow-y-auto">
          {interim ? interim : <span className="text-zinc-400">Start speaking…</span>}
        </div>
      </div>
    </div>
  );
}
