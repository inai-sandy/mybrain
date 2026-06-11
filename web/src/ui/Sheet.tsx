import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useDragControls, useReducedMotion } from 'framer-motion';

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
  size = 'lg',
}: {
  onClose: () => void;
  children: (close: () => void) => ReactNode;
  canClose?: () => boolean;
  size?: 'sm' | 'lg';
}) {
  const [show, setShow] = useState(true);
  const reduce = useReducedMotion();
  const controls = useDragControls();
  const allow = () => (canClose ? canClose() : true);
  const requestClose = () => {
    if (allow()) setShow(false);
  };

  useEffect(() => {
    // iOS-safe scroll lock: plain overflow:hidden makes iOS Safari/PWA reset the page scroll to
    // the top, so closing a sheet dumped the user at the top of long lists. Pinning the body with
    // position:fixed at -scrollY keeps the page visually in place; restore the position on close.
    const y = window.scrollY;
    const b = document.body.style;
    const prev = { position: b.position, top: b.top, left: b.left, right: b.right, width: b.width, overflow: b.overflow };
    b.position = 'fixed';
    b.top = `-${y}px`;
    b.left = '0';
    b.right = '0';
    b.width = '100%';
    b.overflow = 'hidden';
    return () => {
      b.position = prev.position;
      b.top = prev.top;
      b.left = prev.left;
      b.right = prev.right;
      b.width = prev.width;
      b.overflow = prev.overflow;
      window.scrollTo(0, y);
    };
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
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <motion.div className="absolute inset-0 bg-black/50" onClick={requestClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.div
            {...panelMotion}
            drag="y"
            dragListener={false}
            dragControls={controls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_e, info) => {
              if (info.offset.y > 110 || info.velocity.y > 700) requestClose();
            }}
            className={'relative w-full rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl max-h-[90vh] overflow-y-auto ' + (size === 'sm' ? 'sm:max-w-sm' : 'sm:max-w-lg')}
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
