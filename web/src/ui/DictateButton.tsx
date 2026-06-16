import { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';
import { useDictation } from './useDictation';

/**
 * Hold-to-talk mic button. Press & hold to dictate (audio streams live), release to insert the
 * cleaned text. Release is caught GLOBALLY (anywhere you lift your finger) — iPad/iOS don't always
 * deliver pointerup to the button itself, which would leave the mic stuck on. Renders nothing when
 * the device can't record.
 */
export function DictateButton({ onText, size = 16, className = '' }: { onText: (text: string) => void; size?: number; className?: string }) {
  const { supported, active, start, stop } = useDictation(onText);
  const holdingRef = useRef(false);
  const endRef = useRef<() => void>(() => undefined);

  // Always have a current "release" handler that detaches the global listeners + stops.
  endRef.current = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    for (const ev of RELEASE_EVENTS) window.removeEventListener(ev, endRef.current as any);
    stop();
  };

  // Safety: if the button unmounts mid-hold, release.
  useEffect(() => () => endRef.current(), []);

  if (!supported) return null;

  const begin = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (holdingRef.current) return;
    holdingRef.current = true;
    for (const ev of RELEASE_EVENTS) window.addEventListener(ev, endRef.current as any);
    start();
  };

  return (
    <button
      type="button"
      onPointerDown={begin}
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

const RELEASE_EVENTS = ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'mouseup', 'blur'] as const;
