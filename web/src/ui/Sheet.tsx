import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useDragControls, useReducedMotion } from 'framer-motion';
import { lockBodyScroll, unlockBodyScroll } from './scrollLock';

/**
 * Animated bottom-sheet (mobile) / centered dialog (desktop): slides up with a spring, fades the
 * backdrop, and supports drag-down-to-dismiss via the grab handle. All close paths animate out
 * before unmounting. `children` is a render-prop receiving an animated `close()` — use it for the
 * sheet's own X / Cancel / done buttons so they slide out too.
 */
export function Sheet({
  onClose,
  children,
  canClose,
  blockBackdropClose,
  size = 'lg',
}: {
  onClose: () => void;
  children: (close: () => void) => ReactNode;
  canClose?: () => boolean;
  // When this returns true, an accidental backdrop tap / drag-down is IGNORED (the user must use a button).
  // The explicit close passed to children still works — so Save/Cancel are never blocked. (BEA-512)
  blockBackdropClose?: () => boolean;
  size?: 'sm' | 'lg';
}) {
  const [show, setShow] = useState(true);
  const reduce = useReducedMotion();
  const controls = useDragControls();
  // Ignore close for a beat after opening so the very tap that opened the sheet can't fall through
  // onto the just-mounted backdrop and dismiss it instantly (mobile tap-through).
  const openedAt = useRef(Date.now());
  const allow = () => (canClose ? canClose() : true);
  const requestClose = () => {
    if (Date.now() - openedAt.current < 300) return;
    if (allow()) setShow(false);
  };
  // Backdrop tap / drag-down dismiss — skipped entirely when the modal asks to block accidental close. (BEA-512)
  const dismissByGesture = () => {
    if (blockBackdropClose?.()) return;
    requestClose();
  };

  useEffect(() => {
    // iOS-safe scroll lock via a SHARED reference count (see scrollLock.ts). Plain overflow:hidden
    // makes iOS Safari/PWA reset the page to the top; pinning the body with position:fixed keeps it
    // in place. The ref-counted lock is essential because sheets can briefly overlap (one animating
    // out while another mounts) — a per-instance lock would re-lock the page on close and freeze
    // scrolling. Only the first lock captures the page state; only the last unlock restores it.
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, []);

  const panelMotion = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
    : {
        initial: { y: '100%', opacity: 0.6 },
        animate: { y: 0, opacity: 1 },
        exit: { y: '100%', opacity: 0.6 },
        transition: { type: 'spring' as const, damping: 34, stiffness: 360 },
      };

  return (
    <AnimatePresence onExitComplete={onClose}>
      {show && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-end sm:items-center justify-center" style={{ height: 'var(--vvh, 100vh)' }}>
          <motion.div className="absolute inset-0 bg-black/50" onClick={dismissByGesture} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.div
            {...panelMotion}
            drag="y"
            dragListener={false}
            dragControls={controls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_e, info) => {
              if (info.offset.y > 110 || info.velocity.y > 700) dismissByGesture();
            }}
            className={'relative w-full rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl max-h-[calc(var(--vvh,100vh)-1.25rem)] overflow-y-auto ' + (size === 'sm' ? 'sm:max-w-sm' : 'sm:max-w-lg')}
          >
            {/* grab handle (mobile) — drag this to dismiss */}
            <div className="sm:hidden mx-auto -mt-1.5 mb-3 h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 cursor-grab touch-none" onPointerDown={(e) => controls.start(e)} />
            {children(requestClose)}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
