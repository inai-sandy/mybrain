import { useEffect, useState } from 'react';
import { Link2, Copy, Check, RefreshCw, EyeOff, Eye, Send, Loader2 } from 'lucide-react';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';

type Share = { slug: string; path: string; enabled: boolean };

/**
 * The contact's own page link: copy it, send it on WhatsApp, rotate it if it leaks, or turn the
 * page off. The link is name + a random tail so it reads out loud but can't be guessed. (BEA-1027)
 */
export function ContactShareLink({ contactId, contactName, chaseId }: { contactId: string; contactName: string; chaseId?: string | null }) {
  const [share, setShare] = useState<Share | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setShare(null);
    fetch(`/api/contacts/${contactId}/share`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setShare)
      .catch(() => setShare(null));
  }, [contactId]);

  if (!share) return null;
  const url = `${window.location.origin}${share.path}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('error', 'Could not copy — long-press the link to copy it');
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const r = await fetch(`/api/contacts/${contactId}/share/rotate`, { method: 'POST' });
      if (!r.ok) { toast('error', 'Could not make a new link'); return; }
      setShare(await r.json());
      toast('success', 'New link made — the old one no longer works');
    } finally { setBusy(false); setConfirmRotate(false); }
  }

  async function toggle() {
    setBusy(true);
    try {
      const r = await fetch(`/api/contacts/${contactId}/share/enabled`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !share!.enabled }),
      });
      if (!r.ok) { toast('error', 'Could not change that'); return; }
      setShare({ ...share!, enabled: !share!.enabled });
      toast('success', share!.enabled ? 'Their page is off' : 'Their page is on');
    } finally { setBusy(false); }
  }

  async function sendIt() {
    if (!chaseId) return;
    const body = `Hi ${contactName.split(/\s+/)[0]}, here's your list of what's pending with Sandeep — you can tick things off here: ${url}`;
    setBusy(true);
    try {
      const r = await fetch(`/api/reminders/${chaseId}/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
      });
      toast(r.ok ? 'success' : 'error', r.ok ? 'Link sent on WhatsApp' : 'Could not send — open the chat');
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <Link2 size={14} className="shrink-0 text-emerald-600" />
        <span className="text-sm font-medium">Their own page</span>
        {!share.enabled && <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-[10px] text-zinc-500">off</span>}
      </div>
      <p className="mt-1 break-all font-mono text-xs text-zinc-500">{url}</p>
      <p className="mt-1 text-[11px] text-zinc-400">They see only their own list and can tick things off. No login needed.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button onClick={copy} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700">
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
        {chaseId && (
          <button onClick={sendIt} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-zinc-700">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send on WhatsApp
          </button>
        )}
        <button onClick={toggle} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-zinc-700">
          {share.enabled ? <><EyeOff size={12} /> Turn off</> : <><Eye size={12} /> Turn on</>}
        </button>
        <button onClick={() => setConfirmRotate(true)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs hover:border-amber-500 hover:text-amber-600 disabled:opacity-50 dark:border-zinc-700">
          <RefreshCw size={12} /> New link
        </button>
      </div>

      {confirmRotate && (
        <ConfirmDialog
          title="Make a new link?"
          message="The current link stops working straight away. Anyone who saved it will need the new one."
          confirmLabel="Make a new link"
          onConfirm={rotate}
          onCancel={() => setConfirmRotate(false)}
        />
      )}
    </div>
  );
}
