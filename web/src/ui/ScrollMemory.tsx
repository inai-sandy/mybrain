import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * App-wide scroll restoration (BEA-1001) — the app had NONE, so Back always dumped you at the top.
 *
 * We remember the window scroll position per history entry (keyed on `location.key`) and, on a POP
 * (Back/forward, incl. the phone swipe and the browser button), restore it. A fresh PUSH/REPLACE starts
 * at the top.
 *
 * The tricky part: when you navigate away, the tall outgoing page unmounts and the browser CLAMPS the
 * scroll to 0, firing a scroll event. A naive scroll listener records that 0 and loses the real
 * position. So we capture the position two ways that both beat the clamp: a rAF-throttled scroll writer
 * that stores the *current* location's position live, and a layout-effect cleanup that snapshots the
 * outgoing position the instant the location changes (before the unmount clamp is observed).
 */
export function ScrollMemory() {
  const location = useLocation();
  const navType = useNavigationType();
  const positions = useRef<Map<string, number>>(new Map());
  const liveY = useRef(0); // the last real scroll position on the CURRENT page

  // Take over from the browser's own restoration so the two don't fight.
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      const prev = window.history.scrollRestoration;
      window.history.scrollRestoration = 'manual';
      return () => { window.history.scrollRestoration = prev; };
    }
  }, []);

  // Track the live scroll position of whatever page is currently shown.
  useEffect(() => {
    const onScroll = () => { liveY.current = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Snapshot the OUTGOING page's position the moment the location changes. A layout-effect cleanup runs
  // as part of the commit that swaps pages; `liveY` still holds the pre-navigation scroll, so we bank the
  // real number instead of the clamped 0 a scroll listener would see.
  useLayoutEffect(() => {
    const key = location.key;
    // Save ONLY on departure (cleanup). Do NOT seed on arrival — returning to a page would otherwise
    // re-seed its key with the current (clamped-to-0) scroll and wipe the position we banked. (BEA-1001)
    return () => { positions.current.set(key, liveY.current); };
  }, [location.key]);

  // Restore on Back/forward; go to top on a fresh navigation.
  useLayoutEffect(() => {
    if (navType === 'POP') {
      const target = positions.current.get(location.key) ?? 0;
      liveY.current = target;
      if (target <= 0) { window.scrollTo(0, 0); return; }
      // List pages paint asynchronously, so the page may be too short to reach `target` for a while.
      // Poll on a ~1.5s budget until we actually land there.
      let stop = false;
      const start = performance.now();
      const tick = () => {
        if (stop) return;
        const maxY = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(0, Math.min(target, Math.max(0, maxY)));
        if (Math.abs(window.scrollY - target) >= 4 && performance.now() - start < 1500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return () => { stop = true; };
    }
    liveY.current = 0;
    window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  return null;
}
