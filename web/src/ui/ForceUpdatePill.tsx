import { useState } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { forceUpdate } from './forceUpdate';

/** Always-visible "Update app" pill — taps force a clean reload to the latest version (clears cache + SW). */
export function ForceUpdatePill() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={() => {
        setBusy(true);
        forceUpdate();
      }}
      disabled={busy}
      title="Force update to the latest version"
      aria-label="Force update the app"
      className="fixed left-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-6 z-40 inline-flex items-center gap-1.5 rounded-full bg-zinc-900/90 dark:bg-zinc-700 text-white px-3 py-2 text-xs font-medium shadow-lg ring-1 ring-white/10 active:scale-95"
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {busy ? 'Updating…' : 'Update app'}
    </button>
  );
}
