import { useEffect, useState } from 'react';
import { Copy, Check, Share2, X, Globe, Lock } from 'lucide-react';
import { useToast } from './Toast';

/**
 * Share dialog: publishes the item, shows the public link to copy, offers the native
 * share sheet, and lets the owner make it private again.
 */
export function ShareDialog({
  id,
  title,
  initialShared,
  onClose,
  onChanged,
  shareEndpoint,
  publicLink,
}: {
  id: string;
  title: string;
  initialShared: boolean;
  onClose: () => void;
  onChanged?: (shared: boolean) => void;
  shareEndpoint?: string;
  publicLink?: string;
}) {
  const [shared, setShared] = useState(initialShared);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const url = publicLink || `${location.origin}/view/${id}`;
  const endpoint = shareEndpoint || `/api/items/${id}/share`;

  async function setSharedState(next: boolean) {
    setBusy(true);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared: next }),
      });
      if (r.ok) {
        setShared(next);
        onChanged?.(next);
      } else toast('error', 'Could not update sharing');
    } catch {
      toast('error', 'Could not update sharing');
    } finally {
      setBusy(false);
    }
  }

  // Publish automatically when the dialog opens on an unshared item.
  useEffect(() => {
    if (!initialShared) setSharedState(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('error', 'Could not copy the link');
    }
  }

  async function nativeShare() {
    const nav = navigator as any;
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: title || 'My Brain', url });
      } catch {
        /* user cancelled */
      }
    } else {
      copy();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold flex items-center gap-2">
            {shared ? <Globe size={18} className="text-emerald-600" /> : <Lock size={18} />} Share
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{title}</p>

        {shared ? (
          <>
            <p className="text-xs text-zinc-500 mb-2">Anyone with this link can read it — no login needed.</p>
            <div className="flex gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm"
              />
              <button onClick={copy} className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm inline-flex items-center gap-1.5">
                {copied ? (
                  <>
                    <Check size={15} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={15} /> Copy
                  </>
                )}
              </button>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <button onClick={nativeShare} className="text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 inline-flex items-center gap-1.5">
                <Share2 size={15} /> Share via…
              </button>
              <button onClick={() => setSharedState(false)} disabled={busy} className="text-sm text-red-500 hover:underline disabled:opacity-50 inline-flex items-center gap-1.5">
                <Lock size={14} /> Make private
              </button>
            </div>
          </>
        ) : (
          <button onClick={() => setSharedState(true)} disabled={busy} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-60">
            {busy ? 'Creating link…' : 'Create public link'}
          </button>
        )}
      </div>
    </div>
  );
}
