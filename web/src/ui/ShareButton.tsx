import { useEffect, useRef, useState } from 'react';
import { Share2, Check, Link2 } from 'lucide-react';

/**
 * Share a link — the native sheet on a phone, the clipboard everywhere else. (BEA-1264)
 *
 * Deliberately has no Toast dependency: it confirms inline, so it works on the public paper, which
 * a stranger reaches with no session and no app shell around it.
 *
 * The caller passes the URL. That matters more than it looks: on the owner's own edition page the
 * link to share is the PUBLIC `/paper/<day>` one, never the private `/news/<day>` he is standing
 * on — sending someone the private URL gives them a login screen.
 */
export function ShareButton({
  url,
  title,
  text,
  label = 'Share',
  className = '',
}: {
  url: string;
  title: string;
  text?: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flash = (s: 'copied' | 'failed') => {
    setState(s);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  };

  async function share() {
    const absolute = url.startsWith('http') ? url : `${window.location.origin}${url}`;
    // The native sheet is the good path on a phone: WhatsApp, Messages, anything installed.
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: absolute });
        return;
      } catch (e: any) {
        // Cancelling the sheet is not a failure — it must not look like one.
        if (e?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(absolute);
      flash('copied');
    } catch {
      flash('failed');
    }
  }

  return (
    <button
      onClick={share}
      aria-label={`${label} — ${title}`}
      className={
        'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ' +
        (state === 'copied'
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : state === 'failed'
            ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
            : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700') +
        (className ? ` ${className}` : '')
      }
    >
      {state === 'copied' ? <Check size={13} /> : state === 'failed' ? <Link2 size={13} /> : <Share2 size={13} />}
      {state === 'copied' ? 'Link copied' : state === 'failed' ? 'Could not copy — select the address bar' : label}
    </button>
  );
}
