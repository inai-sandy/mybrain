import { useEffect, useState } from 'react';
import { Copy, Check, Share2, X, Globe, Lock, Pencil, KeyRound, Clock, Eye, Download, Bot } from 'lucide-react';
import { useToast } from './Toast';

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

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
  kind,
  initialShared,
  hasPassword: initialHasPassword,
  expiresAt: initialExpiresAt,
  allowDownload: initialAllowDownload,
  viewCount,
  onClose,
  onChanged,
}: {
  id: string;
  title: string;
  slug: string;
  shortCode?: string | null;
  kind?: string;
  initialShared: boolean;
  hasPassword?: boolean;
  expiresAt?: string | null;
  allowDownload?: boolean;
  viewCount?: number;
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
  const [copied, setCopied] = useState<'pretty' | 'short' | 'raw' | null>(null);
  const [hasPassword, setHasPassword] = useState(!!initialHasPassword);
  const [pwInput, setPwInput] = useState('');
  const [expiry, setExpiry] = useState(initialExpiresAt ? toLocalInput(initialExpiresAt) : '');
  const [allowDownload, setAllowDownload] = useState(!!initialAllowDownload);
  const [savingProt, setSavingProt] = useState(false);
  const [qr, setQr] = useState('');
  const toast = useToast();

  const prettyUrl = `${location.origin}/d/${slug}`;
  const shortUrl = shortCode ? `${location.origin}/s/${shortCode}` : '';
  // Direct plain-text link Claude/curl can read (no JS). Only text docs, and not when password-locked. (BEA-970)
  const isText = kind === 'md' || kind === 'html' || kind == null;
  const rawUrl = `${prettyUrl}.md`;
  const showRaw = isText && !hasPassword;

  // Generate the QR code client-side (qrcode is loaded on demand to stay out of the main bundle). (BEA-586)
  useEffect(() => {
    if (!shared) return;
    const link = shortUrl || prettyUrl;
    let alive = true;
    import('qrcode')
      .then((mod) => {
        const toDataURL = (mod as any).toDataURL || (mod as any).default?.toDataURL;
        return toDataURL(link, { width: 240, margin: 1 });
      })
      .then((u: string) => { if (alive) setQr(u); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [shared, shortUrl, prettyUrl]);

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

  async function protect(payload: { password?: string | null; expiresAt?: string | null; allowDownload?: boolean }, okMsg: string) {
    setSavingProt(true);
    try {
      const r = await fetch(`/api/documents/${id}/protect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        if ('hasPassword' in d) setHasPassword(!!d.hasPassword);
        if ('allowDownload' in d) setAllowDownload(!!d.allowDownload);
        if (payload.expiresAt !== undefined) setExpiry(d.expiresAt ? toLocalInput(d.expiresAt) : '');
        if (payload.password === null) setPwInput('');
        onChanged?.(shared);
        toast('success', okMsg);
      } else toast('error', 'Could not update protection');
    } catch {
      toast('error', 'Could not update protection');
    } finally {
      setSavingProt(false);
    }
  }

  async function copy(text: string, which: 'pretty' | 'short' | 'raw') {
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

  const linkRow = (value: string, which: 'pretty' | 'short' | 'raw') => (
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
            {/* Link-card preview — exactly what recipients see when they get the link (BEA-901) */}
            <div className="rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
              <img src={`/api/documents/public/${slug}/og.png`} alt="Link preview" className="w-full aspect-[1200/630] object-cover bg-zinc-100 dark:bg-zinc-800" loading="lazy" />
              <div className="px-3 py-2 bg-zinc-50 dark:bg-zinc-800/50">
                <p className="text-xs font-medium truncate">{title}</p>
                <p className="text-[11px] text-zinc-400">mybrain.1site.ai</p>
              </div>
            </div>

            <button onClick={nativeShare} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2.5 text-sm font-medium inline-flex items-center justify-center gap-2"><Share2 size={16} /> Share</button>

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

            {showRaw && (
              <div>
                <p className="text-xs font-medium text-zinc-500 mb-1 flex items-center gap-1.5"><Bot size={13} /> Direct link (Markdown — for AI / Claude)</p>
                {linkRow(rawUrl, 'raw')}
                <p className="mt-1 text-[11px] text-zinc-400">Plain-text version. Opens with no login or JavaScript, so Claude/ChatGPT and tools can read it.</p>
              </div>
            )}

            <div className="flex items-center gap-4 border-t border-zinc-100 dark:border-zinc-800 pt-3">
              {qr ? (
                <img src={qr} alt="QR code" className="h-24 w-24 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white p-1" />
              ) : (
                <div className="h-24 w-24 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 grid place-items-center text-[10px] text-zinc-400">QR…</div>
              )}
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-sm text-zinc-500"><Eye size={15} /> {viewCount ?? 0} {(viewCount ?? 0) === 1 ? 'view' : 'views'}</p>
                {qr && <a href={qr} download={`qr-${slug}.png`} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"><Download size={13} /> Save QR</a>}
              </div>
            </div>

            <div className="border-t border-zinc-100 dark:border-zinc-800 pt-3 space-y-3">
              <div>
                <p className="text-xs font-medium text-zinc-500 mb-1 flex items-center gap-1.5"><KeyRound size={13} /> Password</p>
                {hasPassword ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-sm text-emerald-600">Protected — readers must enter a password.</span>
                    <button onClick={() => protect({ password: null }, 'Password removed')} disabled={savingProt} className="text-xs text-red-500 hover:underline disabled:opacity-50">Remove</button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input type="password" value={pwInput} onChange={(e) => setPwInput(e.target.value)} placeholder="Set a password (optional)" className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                    <button onClick={() => pwInput.trim() && protect({ password: pwInput.trim() }, 'Password set')} disabled={savingProt || !pwInput.trim()} className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50">Set</button>
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-zinc-500 mb-1 flex items-center gap-1.5"><Clock size={13} /> Expires</p>
                <div className="flex gap-2">
                  <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                  <button onClick={() => protect({ expiresAt: expiry ? new Date(expiry).toISOString() : null }, expiry ? 'Expiry set' : 'Expiry cleared')} disabled={savingProt} className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50">Save</button>
                  {expiry && <button onClick={() => { setExpiry(''); protect({ expiresAt: null }, 'Expiry cleared'); }} disabled={savingProt} className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-2 text-sm disabled:opacity-50">Clear</button>}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-500 flex items-center gap-1.5"><Download size={13} /> Allow downloads</span>
                  <button
                    role="switch"
                    aria-checked={allowDownload}
                    onClick={() => protect({ allowDownload: !allowDownload }, allowDownload ? 'Downloads turned off' : 'Downloads turned on')}
                    disabled={savingProt}
                    className={'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ' + (allowDownload ? 'bg-emerald-600' : 'bg-zinc-300 dark:bg-zinc-700')}
                  >
                    <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ' + (allowDownload ? 'left-[18px]' : 'left-0.5')} />
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-zinc-400">When on, the shared page shows a download button.</p>
              </div>
            </div>

            <div className="flex items-center justify-end pt-1">
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
