import { Mic } from 'lucide-react';
import { useDictation } from './useDictation';

/**
 * Hold-to-talk mic button. Press & hold to dictate (audio streams live), release to insert the
 * cleaned text via onText. Uses pointer capture so sliding a finger off the button doesn't stop it.
 * Renders nothing when the device can't record.
 */
export function DictateButton({ onText, size = 16, className = '' }: { onText: (text: string) => void; size?: number; className?: string }) {
  const { supported, active, start, stop } = useDictation(onText);
  if (!supported) return null;

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    start();
  };
  const up = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    stop();
  };

  return (
    <button
      type="button"
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
      title="Hold to talk"
      aria-label="Hold to talk"
      className={
        'p-2 rounded-xl select-none touch-none transition ' +
        (active ? 'bg-rose-500 text-white scale-110 shadow-lg shadow-rose-500/30' : 'text-zinc-400 hover:text-emerald-600 active:scale-95') +
        (className ? ' ' + className : '')
      }
    >
      <Mic size={size} className={active ? 'animate-pulse' : ''} />
    </button>
  );
}
