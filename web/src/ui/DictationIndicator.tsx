import { useDictationStatus } from './useDictation';
import { Square, Mic } from 'lucide-react';

/** A single global banner shown whenever ANY mic is dictating. Gives the two things
 *  the user said were missing: live feedback ("is it hearing me?") + a clear Stop. */
export function DictationIndicator() {
  const { listening, interim, stop } = useDictationStatus();
  if (!listening) return null;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-full bg-zinc-900 text-white px-4 py-2.5 shadow-xl max-w-[92vw] bottom-[calc(6rem+env(safe-area-inset-bottom))] md:bottom-6">
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-rose-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500" />
      </span>
      <Mic size={15} className="shrink-0 text-rose-300" />
      <span className="text-sm truncate min-w-0">{interim ? interim : 'Listening… speak now'}</span>
      <button
        onClick={stop}
        className="ml-1 shrink-0 inline-flex items-center gap-1 rounded-full bg-rose-500 hover:bg-rose-400 px-3 py-1 text-xs font-semibold"
      >
        <Square size={11} className="fill-white" /> Stop
      </button>
    </div>
  );
}
