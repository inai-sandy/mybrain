import { useEffect, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { isBodyScrollLocked } from './scrollLock';

/**
 * Left-edge swipe-back gesture. Installed PWAs don't get the native swipe-back, so we provide one:
 * a one-finger drag that STARTS at the very left edge follows the finger (the page slides right under
 * it, iOS-style) and, if released past the threshold, goes back in history; otherwise it springs back.
 * (BEA-593, finger-following added BEA-1002.)
 *
 * `slideRef` is the element that visually slides. If it's absent, or the user prefers reduced motion,
 * we fall back to the original invisible threshold gesture (no transform).
 */
export function useEdgeSwipeBack(enabled = true, slideRef?: RefObject<HTMLElement>) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let startX = 0, startY = 0, startT = 0;
    let tracking = false;   // gesture began at the edge
    let sliding = false;    // we've decided this is a horizontal back-swipe and are moving the page
    let dx = 0;

    const el = () => slideRef?.current || null;
    const setTransform = (x: number, animate: boolean) => {
      const n = el();
      if (!n) return;
      n.style.transition = animate ? 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
      n.style.transform = x ? `translate3d(${x}px,0,0)` : '';
      n.style.willChange = x ? 'transform' : '';
    };
    const clearTransform = () => { const n = el(); if (n) { n.style.transition = ''; n.style.transform = ''; n.style.willChange = ''; } };

    const onStart = (e: TouchEvent) => {
      tracking = sliding = false;
      if (e.touches.length !== 1) return;
      // Don't slide the page from under an open modal/sheet, and don't hijack a horizontal scroller. (BEA-821)
      if (isBodyScrollLocked() || (e.target as Element | null)?.closest?.('.overflow-x-auto')) return;
      const t = e.touches[0];
      if (t.clientX > 24) return; // only from the very left edge
      tracking = true; startX = t.clientX; startY = t.clientY; startT = Date.now(); dx = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!sliding) {
        // Decide direction once: vertical → give up (let it scroll); clearly rightward → start sliding.
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { tracking = false; return; }
        if (dx > 12 && Math.abs(dx) > Math.abs(dy)) sliding = true;
      }
      if (sliding && !reduced) {
        e.preventDefault(); // we own this gesture now — stop the page scrolling under it
        setTransform(Math.max(0, dx * 0.9), false); // slight resistance
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const dt = Date.now() - startT;
      const width = window.innerWidth || 360;
      // Commit if dragged far enough OR flicked quickly; same horizontal/deliberate guards as before.
      const commit = dx > Math.min(120, width * 0.32) && Math.abs(dy) < 80 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 900;
      if (reduced || !el()) {
        if (commit) navigate(-1);
        return;
      }
      if (!sliding) { clearTransform(); return; }
      if (commit) {
        // Finish the slide off-screen, then navigate and snap the (now-previous) page back into place.
        setTransform(width, true);
        window.setTimeout(() => { navigate(-1); clearTransform(); }, 180);
      } else {
        setTransform(0, true); // spring back
        window.setTimeout(clearTransform, 240);
      }
      sliding = false;
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      clearTransform();
    };
  }, [enabled, navigate, slideRef]);
}
