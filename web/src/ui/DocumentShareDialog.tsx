import { useEffect, useState } from 'react';
import { Copy, Check, Share2, X, Globe, Lock, Pencil } from 'lucide-react';
import { useToast } from './Toast';

/**
 * Share dialog for Documents — publishes the doc and offers a tiiny.host-style
 * public link: an editable pretty link name plus a short link. (BEA-584)
 * Kept separate from the generic ShareDialog (used by items/skills/meetings).
 */
export function DocumentShareDialog({
  id,
  title,
  slug: initialSlug,
  shortCode: initialShortCode,
  initialShared,
  onClose,
  onChanged,
}: {
  id: string;
  title: string;
  slug: string;
  shortCode?: string | null;
  initialShared: boolean;
  onClose: () => void;
  onChanged?: (shared: boolean) => void;
}) {
  const [shared, setShared] = useState(initialShared);
  const [slug, setSlug] = useState(initialSlug);
  const [shortCode, setShortCode] = useState<string | null>(initialShortCode || null);
  const [busy, setBusy] = useState(false);
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugDraft, setSlugDraft] = useState(initialSlug);
  const [savingSlug, setSavingSlug] = useState(false);
  const [copied, setCopied] = useState<'pretty' | 'short' | null>(null);
  const toast = useToast();

  const prettyUrl = `${location.origin}/d/${slug}`;
  const shortUrl = shortCode ? `${location.origin}/s/${shortCode}` : '';

  async function setSharedState(next: boolean) {
    setBusy(true);
    try {
      const r = await fetch(`/api/documents/${id}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared: next }),
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        setShared(next);
        if (d?.slug) setSlug(d.slug);
        if (d?.shortCode) setShortCode(d.shortCode);
        onChanged?.(next);
      } else toast('error', 'Could not update sharing');
    } catch {
      toast('error', 'Could not update sharing');
    } finally {
      setBusy(false);
    }
  }

  // Publish automatically when the dialog opens on an unshared doc.
  useEffect(() => {
    if (!initialShared) setSharedState(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSlug() {
    const next = slugDraft.trim();
    if (!next || next === slug) {
      setEditingSlug(false);
      return;
    }
    setSavingSlug(true);
    try {
      const r = await fetch(`/api/documents/${id}/slug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setSlug(d.slug || next);
        setSlugDraft(d.slug || next);
        setEditingSlug(false);
        onChanged?.(shared);
        toast('success', 'Link name updated');
      } else toast('error', d.message || 'Could not rename the link');
    } catch {
      toast('error', 'Could not rename the link');
    } finally {
      setSavingSlug(false);
    }
  }

  async function copy(text: string, which: 'pretty' | 'short') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast('error', 'Could not copy the link');
    }
  }

  async function nativeShare() {
    const nav = navigator as any;
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: title || 'My Brain', url: prettyUrl });
      } catch {
        /* cancelled */
      }
    } else copy(prettyUrl, 'pretty');
  }

  const linkRow = (value: string, which: 'pretty' | 'short') => (
    <div className="flex gap-2">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm" />
      <button onClick={() => copy(value, which)} className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm inline-flex items-center gap-1.5">
        {copied === which ? (<><Check size={15} /> Copied</>) : (<><Copy size={15} /> Copy</>)}
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold flex items-center gap-2">{shared ? <Globe size={18} className="text-emerald-600" /> : <Lock size={18} />} Share</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{title}</p>

        {shared ? (
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-zinc-500">Public link</p>
                {!editingSlug && (
                  <button onClick={() => { setSlugDraft(slug); setEditingSlug(true); }} className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-1"><Pencil size={12} /> Rename</button>
                )}
              </div>
              {editingSlug ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-zinc-400 shrink-0">/d/</span>
                  <input
                    autoFocus
                    value={slugDraft}
                    onChange={(e) => setSlugDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveSlug(); if (e.key === 'Escape') setEditingSlug(false); }}
                    placeholder="my-page"
                    className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
                  />
                  <button onClick={saveSlug} disabled={savingSlug} className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">{savingSlug ? '…' : 'Save'}</button>
                  <button onClick={() => setEditingSlug(false)} className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-sm">Cancel</button>
                </div>
              ) : (
                linkRow(prettyUrl, 'pretty')
              )}
            </div>

            {shortUrl && (
              <div>
                <p className="text-xs font-medium text-zinc-500 mb-1">Short link</p>
                {linkRow(shortUrl, 'short')}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <button onClick={nativeShare} className="text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 inline-flex items-center gap-1.5"><Share2 size={15} /> Share via…</button>
              <button onClick={() => setSharedState(false)} disabled={busy} className="text-sm text-red-500 hover:underline disabled:opacity-50 inline-flex items-center gap-1.5"><Lock size={14} /> Make private</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setSharedState(true)} disabled={busy} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-60">{busy ? 'Creating link…' : 'Create public link'}</button>
        )}
      </div>
    </div>
  );
}
