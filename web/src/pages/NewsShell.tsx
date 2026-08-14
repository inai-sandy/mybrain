import { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * The shared frame of the News section (BEA-1321): the two feeds are SEPARATE pages —
 * AI News Daily at /news and AI Tweets Daily at /news/tweets, each with its own sidebar
 * entry — and this file holds what they share: the back-navigation shell and the
 * segmented toggle that jumps between the pages.
 */

export function NewsShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
      <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft size={14} /> Back
      </button>
      {children}
    </div>
  );
}

/** The mockup's segmented toggle — now a page switcher, not a tab. */
export function NewsToggle({ active, title }: { active: 'daily' | 'tweets'; title: string }) {
  const navigate = useNavigate();
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-base font-bold">{title}</h1>
      <div className="flex rounded-[10px] border border-zinc-200 bg-white p-[3px] text-[12.5px] dark:border-zinc-800 dark:bg-zinc-900">
        {(['daily', 'tweets'] as const).map((v) => (
          <button
            key={v}
            onClick={() => navigate(v === 'daily' ? '/news' : '/news/tweets')}
            className={
              'rounded-lg px-4 py-[5px] transition-colors ' +
              (active === v ? 'bg-indigo-500 font-semibold text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
            }
          >
            {v === 'daily' ? 'Daily' : 'Tweets'}
          </button>
        ))}
      </div>
    </div>
  );
}
