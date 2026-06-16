import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';

/**
 * Registers the service worker and shows a bottom "Update" toast when a new version is waiting.
 * Tapping Update activates the new SW and reloads to it — no manual hard refresh. We also poll for
 * updates aggressively (every minute, on tab focus, on reconnect) so the toast appears promptly.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, r) {
      if (!r) return;
      const check = () => r.update().catch(() => undefined);
      setInterval(check, 60_000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('online', check);
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+5rem)] sm:pb-6 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-full bg-zinc-900 dark:bg-zinc-800 text-white shadow-xl ring-1 ring-white/10 pl-4 pr-1.5 py-1.5">
        <RefreshCw size={15} className="text-emerald-400 shrink-0" />
        <span className="text-sm">A new version is available</span>
        <button
          onClick={() => updateServiceWorker(true)}
          className="rounded-full bg-emerald-600 hover:bg-emerald-500 active:scale-95 transition px-3.5 py-1.5 text-sm font-semibold"
        >
          Update
        </button>
        <button onClick={() => setNeedRefresh(false)} aria-label="Dismiss" className="p-1.5 text-zinc-400 hover:text-white">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
