import { useEffect, useState } from 'react';
import { Share, X, Download } from 'lucide-react';

/** Chrome fires `beforeinstallprompt` ONCE per page load and never again on demand. Catching it in a
 *  component effect means the event is lost for good the moment that component unmounts — which now
 *  happens whenever you open Chat (BEA-1270). So the catch lives here, at module scope: it is armed
 *  the instant the bundle runs and outlives every mount. */
let captured: any = null;
const waiting = new Set<(e: any) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: any) => {
    e.preventDefault();
    captured = e;
    waiting.forEach((fn) => fn(e));
  });
}

/** A visible "install this app" banner — a real Install button on Android/Chrome,
 *  and the Share → Add to Home Screen hint on iOS Safari (which has no install API). */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<any>(null);
  const [show, setShow] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    try { if (localStorage.getItem('pwa-install-dismissed')) return; } catch { /* ignore */ }
    const standalone = (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) || (navigator as any).standalone === true;
    if (standalone) return; // already installed

    const ua = navigator.userAgent || '';
    const isIosSafari = /iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);

    // An event that fired before this mount is still good — that is the whole point of catching it above.
    if (captured) { setDeferred(captured); setShow(true); }

    const onBIP = (e: any) => { setDeferred(e); setShow(true); };
    waiting.add(onBIP);
    if (isIosSafari) { setIos(true); setShow(true); }
    return () => { waiting.delete(onBIP); };
  }, []);

  function dismiss() {
    setShow(false);
    try { localStorage.setItem('pwa-install-dismissed', '1'); } catch { /* ignore */ }
  }
  async function install() {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    captured = null; // spent — a remount must not offer it again
    setDeferred(null);
    dismiss();
  }

  if (!show) return null;
  return (
    // On phones this sits in the page flow, so it pushes the page down instead of floating on top
    // of it — as `fixed` it covered the Tasks tab row by 20px and made it untappable (BEA-1270).
    // On desktop there is room beside the content, so it stays the floating top-right card it was.
    <div className="mb-4 md:mb-0 md:fixed md:top-[calc(4.25rem+env(safe-area-inset-top))] md:right-4 md:w-80 md:z-40 rounded-xl border border-emerald-500/40 bg-white dark:bg-zinc-900 shadow-lg p-3 flex items-center gap-3">
      <img src="/icons/icon-192.png" alt="" className="h-9 w-9 rounded-lg shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">Install My Brain</div>
        {ios ? (
          <div className="text-xs text-zinc-500 flex items-center gap-1 flex-wrap">Tap <Share size={12} className="inline" /> Share, then “Add to Home Screen”.</div>
        ) : (
          <div className="text-xs text-zinc-500">Add it to your home screen — full-screen, like an app.</div>
        )}
      </div>
      {deferred && !ios && (
        <button onClick={install} className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm"><Download size={14} /> Install</button>
      )}
      <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={16} /></button>
    </div>
  );
}
