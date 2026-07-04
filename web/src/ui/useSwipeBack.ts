import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isBodyScrollLocked } from './scrollLock';

/**
 * Left-edge swipe-back gesture. Installed iOS PWAs don't get the native swipe-back,
 * so we provide one: a one-finger swipe that STARTS at the very left edge and moves
 * right far enough (and mostly horizontally) goes back in history. (BEA-593)
 */
export function useEdgeSwipeBack(enabled = true) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let tracking = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      // Don't navigate the page away from under an open modal/sheet (you'd lose typed input), and
      // don't hijack a swipe that starts inside a horizontal scroller (heatmaps etc.). (BEA-821)
      if (isBodyScrollLocked() || (e.target as Element | null)?.closest?.('.overflow-x-auto')) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      tracking = t.clientX <= 24; // only begin from the very left edge
      startX = t.clientX;
      startY = t.clientY;
      startT = Date.now();
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const dt = Date.now() - startT;
      // Rightward, far enough, mostly horizontal, and a deliberate (not too slow) flick.
      if (dx > 80 && Math.abs(dy) < 60 && Math.abs(dx) > Math.abs(dy) * 2 && dt < 800) {
        navigate(-1);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [enabled, navigate]);
}
