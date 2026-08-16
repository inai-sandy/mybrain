import { createContext, ReactNode, useCallback, useContext, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

type Kind = 'success' | 'error' | 'info';
type Toast = { id: number; kind: Kind; msg: string };

const Ctx = createContext<{ toast: (kind: Kind, msg: string) => void }>({ toast: () => undefined });

/**
 * How long a toast stays up. A success is a glance, but an error now carries a real explanation
 * (e.g. why notifications wouldn't turn on) — at the old flat 3.5s a long one vanished before it
 * could be read, which is the same as saying nothing (BEA-1093). Errors get reading time, and any
 * toast can be tapped away early.
 */
export function toastMs(kind: Kind, msg: string): number {
  // 'info' carries an explanation too (e.g. "this PDF is a scan, so it isn't searchable"), so it
  // gets reading time like an error rather than a 3.5s glance. (BEA-1339)
  if (kind === 'success') return 3500;
  return Math.min(15000, Math.max(6000, msg.length * 55));
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((kind: Kind, msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), toastMs(kind, msg));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {/* Sits above the floating action button (bottom-24 + its height) on desktop and above the
          nav on mobile — a long error toast used to cover the FAB in the corner (BEA-1093). */}
      <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-36 right-4 left-4 md:left-auto flex flex-col items-end gap-2 z-[70] pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              role={t.kind === 'error' ? 'alert' : 'status'}
              onClick={() => dismiss(t.id)}
              title="Tap to dismiss"
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              className={'pointer-events-auto cursor-pointer px-4 py-2.5 rounded-xl text-sm text-white shadow-lg max-w-[90vw] md:max-w-md text-left ' + (t.kind === 'success' ? 'bg-emerald-600' : t.kind === 'info' ? 'bg-zinc-800 dark:bg-zinc-700' : 'bg-red-600')}
            >
              {t.msg}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx).toast;
