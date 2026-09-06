import { useEffect, useRef } from 'react';
import { Mic, Square } from 'lucide-react';
import { useDictation } from './useDictation';

/**
 * Tap-to-talk mic (BEA-1626). One tap starts, a second tap stops.
 *
 * It used to be hold-to-talk: press and keep pressing, and lifting a finger ANYWHERE ended it. The
 * owner asked for the change because holding a button through a whole thought on a phone is
 * genuinely hard — and it matches the call already made on EMO Nano ("tap to talk, never hold").
 *
 * The thing hold-to-talk gave away for free was certainty: his own finger told him the mic was on.
 * Nothing does that now, so the button becomes an unmistakable red STOP while live, and the global
 * `DictationIndicator` shows the words arriving with its own Stop button beside them.
 *
 * Renders nothing when the device cannot record.
 */
export function DictateButton({ onText, size = 16, className = '' }: { onText: (text: string) => void; size?: number; className?: string }) {
  const { supported, active, start, stop } = useDictation(onText);

  // Always hold a CURRENT stop, so the unmount cleanup below can never call a stale closure.
  const endRef = useRef<() => void>(() => undefined);
  endRef.current = () => {
    if (active) stop();
  };

  // Safety: if the button unmounts mid-recording (a sheet closing, a route change), release the mic.
  useEffect(() => () => endRef.current(), []);

  if (!supported) return null;

  // pointerdown, not click: it fires on the first touch, so the mic opens the instant he taps.
  const toggle = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (active) stop();
    else start();
  };

  return (
    <button
      type="button"
      onPointerDown={toggle}
      onContextMenu={(e) => e.preventDefault()}
      title={active ? 'Tap to stop' : 'Tap to talk'}
      aria-label={active ? 'Stop dictation' : 'Start dictation'}
      aria-pressed={active}
      data-recording={active ? 'yes' : 'no'}
      className={
        'p-2 rounded-xl select-none touch-none transition ' +
        (active
          ? 'bg-rose-500 text-white scale-110 shadow-lg shadow-rose-500/30 ring-2 ring-rose-300/70 animate-pulse'
          : 'text-zinc-400 hover:text-emerald-600 active:scale-95') +
        (className ? ' ' + className : '')
      }
    >
      {active ? <Square size={Math.max(10, size - 3)} className="fill-current" /> : <Mic size={size} />}
    </button>
  );
}
