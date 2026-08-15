import { useEffect } from 'react';
import { ShareButton } from '../ui/ShareButton';
import { RadarView } from './RadarView';

/**
 * AI News Daily — the page strangers see (BEA-1325).
 *
 * Public, no login, at /radar — the same approved v4.1 timeline the owner reads on /news,
 * wrapped in the /paper-style public masthead. The view itself runs in `publicMode`: it reads
 * the no-login API routes and never shows the Sync button or internal error text, so nothing
 * an owner-only control could reveal is on the page at all.
 */

function todayLine(): string {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export default function RadarPublic() {
  // A visitor here has never chosen a theme — follow THEIR system setting, exactly as the
  // public paper does (BEA-1261), unless they have used the app before and picked one.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('mybrain-theme');
    } catch {
      saved = null;
    }
    if (saved) return;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', !!media?.matches);
    apply();
    media?.addEventListener?.('change', apply);
    return () => media?.removeEventListener?.('change', apply);
  }, []);

  useEffect(() => {
    document.title = 'AI News Daily — My Brain';
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto w-full max-w-[720px] px-4 pb-20 pt-6 sm:px-6 sm:pt-10">
        <header className="mb-6 border-y-2 border-zinc-900 py-5 text-center dark:border-zinc-100">
          <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-zinc-500">A I &nbsp; N E W S &nbsp; D A I L Y</p>
          <p className="mt-1 text-[11px] text-zinc-400">{todayLine()}</p>
          <h1 className="mx-auto mt-3 max-w-2xl text-balance text-2xl font-bold leading-snug sm:text-3xl">
            AI news from around the world, hour by hour
          </h1>
          <p className="mt-2 text-xs text-zinc-400">Refreshed every hour · everything in English</p>
          <div className="mt-3 flex justify-center">
            <ShareButton url="/radar" title="AI News Daily — My Brain" text="AI news from around the world, refreshed every hour." />
          </div>
        </header>

        <RadarView publicMode />

        <footer className="mt-12 border-t border-zinc-200 pt-5 text-center dark:border-zinc-800">
          <p className="text-xs text-zinc-500">Collected, deduplicated and translated automatically, around the clock.</p>
          <p className="mt-2 text-[11px] text-zinc-400">
            Also from My Brain:{' '}
            <a href="/paper" className="underline hover:text-zinc-600 dark:hover:text-zinc-300">AI Tweets Daily</a>
          </p>
        </footer>
      </div>
    </div>
  );
}
