import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

/**
 * AI News Daily — the page strangers see (BEA-1261).
 *
 * Public, no login, and deliberately NOT the private page with things switched off. It renders a
 * separate, narrower payload that never contains story ids, the owner's shortlist, or anything
 * about runs — so nothing personal can leak through a prop somebody forgets to hide.
 *
 * The design is fixed and ours. Codex supplies words only (BEA-1257); this template turns them into
 * the same shape every single day. Familiarity is most of why anyone comes back to a daily paper.
 */

type PublicStory = { headline: string; source: string; links: string[] };
type PublicSection = { category: string; line: string; prose: string; storyCount: number; stories: PublicStory[] };
type PublicEdition = {
  number: number;
  day: string;
  headline: string;
  sixty: string[];
  storyCount: number;
  complete: boolean;
  sections: PublicSection[];
  builtOn: { name: string; link: string };
};

const SHOWN = 3;
const SOURCE_LABEL: Record<string, string> = { twitter: 'X', reddit: 'Reddit', discord: 'Discord', unknown: '' };

function longDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export default function PaperPublic() {
  const { day } = useParams();
  const [edition, setEdition] = useState<PublicEdition | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // A visitor here has never chosen a theme — they are a stranger following a link. The app
  // defaults to dark for its owner, which means someone on a light phone gets a black page as
  // their first impression of it. Follow THEIR setting instead, unless they have used the app
  // before and picked one.
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
    let alive = true;
    (async () => {
      try {
        const target = day || (await fetch('/api/news/public/editions').then((r) => r.json())).at?.(0)?.day;
        if (!target) {
          if (alive) setState('missing');
          return;
        }
        const r = await fetch(`/api/news/public/editions/${target}`);
        if (r.status === 404) {
          if (alive) setState('missing');
          return;
        }
        if (!r.ok) throw new Error('failed');
        const d = await r.json();
        if (!alive) return;
        setEdition(d);
        setState('ready');
        document.title = `${d.headline} — AI News Daily`;
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [day]);

  if (state === 'loading') {
    return (
      <Frame>
        <div className="animate-pulse space-y-4 pt-10">
          <div className="mx-auto h-3 w-40 rounded bg-stone-200 dark:bg-stone-800" />
          <div className="mx-auto h-7 w-3/4 rounded bg-stone-200 dark:bg-stone-800" />
          <div className="h-36 rounded-2xl bg-stone-100 dark:bg-stone-900" />
          <div className="h-52 rounded-2xl bg-stone-100 dark:bg-stone-900" />
        </div>
      </Frame>
    );
  }

  if (state !== 'ready' || !edition) {
    return (
      <Frame>
        <div className="pt-16 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-stone-400">A I &nbsp; N E W S &nbsp; D A I L Y</p>
          <h1 className="mt-4 text-xl font-bold">{state === 'missing' ? 'No paper for that day' : 'The paper could not be loaded'}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-stone-500">
            {state === 'missing'
              ? 'A new edition is written every day. Try the latest one.'
              : 'Something went wrong at our end. Please try again in a moment.'}
          </p>
          <a href="/paper" className="mt-5 inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900">
            Read the latest edition
          </a>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="border-y-2 border-stone-900 py-5 text-center dark:border-stone-100">
        <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-stone-500">A I &nbsp; N E W S &nbsp; D A I L Y</p>
        <p className="mt-1 text-[11px] text-stone-400">{longDate(edition.day)} &nbsp;·&nbsp; Issue No. {edition.number}</p>
        <h1 className="mx-auto mt-3 max-w-2xl text-balance font-serif text-2xl font-bold leading-snug sm:text-3xl">{edition.headline}</h1>
        <p className="mt-3 text-xs text-stone-400">
          {edition.storyCount} {edition.storyCount === 1 ? 'story' : 'stories'} · about a {Math.max(2, Math.round(edition.storyCount / 8))} minute read
        </p>
      </header>

      {!edition.complete && (
        <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-center text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          Part of today's edition was not written up. Every story is still listed below.
        </p>
      )}

      {edition.sixty.length > 0 && (
        <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-900">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-stone-400">The 60-second read</p>
          <ol className="space-y-2.5">
            {edition.sixty.map((l, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-relaxed">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[11px] font-bold text-white dark:bg-stone-100 dark:text-stone-900">{i + 1}</span>
                <span>{l}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="mt-8 space-y-6">
        {edition.sections.map((sec) => {
          const head = sec.stories.slice(0, SHOWN);
          const rest = sec.stories.slice(SHOWN);
          const expanded = !!open[sec.category];
          return (
            <section key={sec.category}>
              <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-stone-200 pb-2 dark:border-stone-800">
                <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wider">
                  <span className="h-1.5 w-1.5 rounded-full bg-stone-900 dark:bg-stone-100" />
                  {sec.category}
                </h2>
                <span className="shrink-0 text-xs text-stone-400">{sec.storyCount}</span>
              </div>
              {sec.line && <p className="mb-3 text-sm font-medium text-stone-600 dark:text-stone-300">{sec.line}</p>}
              {sec.prose && (
                <div className="mb-4 space-y-3 text-[15px] leading-relaxed text-stone-700 dark:text-stone-300">
                  {sec.prose.split(/\n{2,}/).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              )}

              <ul className="space-y-2">
                {head.map((s, i) => (
                  <li key={i}>
                    <StoryCard story={s} />
                  </li>
                ))}
              </ul>

              {/* Always rendered, only collapsed — every story stays in the page and findable. */}
              {rest.length > 0 && (
                <div className={'grid transition-[grid-template-rows] duration-200 ' + (expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                  <ul className="min-h-0 space-y-2 overflow-hidden" aria-hidden={!expanded}>
                    {rest.map((s, i) => (
                      <li key={i} className="pt-2">
                        <StoryCard story={s} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {rest.length > 0 && (
                <button
                  onClick={() => setOpen({ ...open, [sec.category]: !expanded })}
                  className="mt-3 text-xs font-medium text-stone-500 underline decoration-dotted underline-offset-4 hover:text-stone-900 dark:hover:text-stone-100"
                >
                  {expanded ? 'Show fewer' : `${rest.length} more in ${sec.category.toLowerCase()}`}
                </button>
              )}
            </section>
          );
        })}
      </div>

      <footer className="mt-12 border-t border-stone-200 pt-5 text-center dark:border-stone-800">
        <p className="text-xs text-stone-500">
          Built on{' '}
          <a href={edition.builtOn.link} target="_blank" rel="noreferrer" className="font-medium underline hover:text-stone-900 dark:hover:text-stone-100">
            {edition.builtOn.name}
          </a>
          , who read the subreddits, the X lists and the Discords. We sort it and write it up.
        </p>
        <p className="mt-2 text-[11px] text-stone-400">
          <a href="/paper" className="underline hover:text-stone-600">All editions</a>
        </p>
      </footer>
    </Frame>
  );
}

function StoryCard({ story }: { story: PublicStory }) {
  const label = SOURCE_LABEL[story.source] ?? story.source;
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-3.5 transition-colors hover:border-stone-400 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-600">
      <p className="text-sm leading-relaxed text-stone-800 dark:text-stone-200">{story.headline}</p>
      {(label || story.links.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-400">
          {label && <span>{label}</span>}
          {story.links.slice(0, 3).map((l, i) => (
            <a key={i} href={l} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-stone-700 dark:hover:text-stone-200">
              source{story.links.length > 1 ? ` ${i + 1}` : ''}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <div className="mx-auto w-full max-w-2xl px-4 pb-20 pt-6 sm:px-6 sm:pt-10">{children}</div>
    </div>
  );
}
