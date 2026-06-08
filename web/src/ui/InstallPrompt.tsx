import { useEffect, useState } from 'react';
import { Share, X, Download } from 'lucide-react';

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

    const onBIP = (e: any) => {
      e.preventDefault();
      setDeferred(e);
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', onBIP);
    if (isIosSafari) { setIos(true); setShow(true); }
    return () => window.removeEventListener('beforeinstallprompt', onBIP);
  }, []);

  function dismiss() {
    setShow(false);
    try { localStorage.setItem('pwa-install-dismissed', '1'); } catch { /* ignore */ }
  }
  async function install() {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    setDeferred(null);
    dismiss();
  }

  if (!show) return null;
  return (
    <div className="fixed top-[4.25rem] inset-x-3 md:inset-x-auto md:right-4 md:w-80 z-40 rounded-xl border border-emerald-500/40 bg-white dark:bg-zinc-900 shadow-lg p-3 flex items-center gap-3">
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
