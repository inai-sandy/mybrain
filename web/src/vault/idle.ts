// Idle watcher for the vault auto-lock. Calls onIdle() after `ms` with no user activity.
// Any of the listed events resets the countdown. Returns a cleanup function.
export type IdleTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'visibilitychange'];

export function watchIdle(onIdle: () => void, ms: number, target: IdleTarget = window): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onIdle, ms);
  };
  for (const e of ACTIVITY_EVENTS) target.addEventListener(e, reset, { passive: true } as any);
  reset();
  return () => {
    if (timer) clearTimeout(timer);
    for (const e of ACTIVITY_EVENTS) target.removeEventListener(e, reset as any);
  };
}

export const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes
