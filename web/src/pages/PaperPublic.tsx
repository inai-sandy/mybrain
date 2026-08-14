import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ShareButton } from '../ui/ShareButton';

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
};

const SHOWN = 3;
// The owner's own labels, so the two pages read identically (BEA-1269).
const SOURCE_LABEL: Record<string, string> = { twitter: 'X / Twitter', reddit: 'Reddit', discord: 'Discord', unknown: 'Elsewhere' };

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
  const [archive, setArchive] = useState<{ number: number; day: string; headline: string; storyCount: number }[]>([]);

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
        // One call gives both the day to land on and the archive underneath it.
        const index = await fetch('/api/news/public/editions').then((r) => (r.ok ? r.json() : [])).catch(() => []);
        if (alive && Array.isArray(index)) setArchive(index);
        const target = day || (Array.isArray(index) ? index[0]?.day : undefined);
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
        document.title = `${d.headline} — AI News Twitter`;
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [day]);

  // The editions either side of this one. The archive comes back newest-first, so the entry BEFORE
  // this one is the newer paper and the entry after it is the older one.
  const at = edition ? archive.findIndex((e) => e.day === edition.day) : -1;
  const newer = at > 0 ? archive[at - 1] : null;
  const older = at >= 0 && at < archive.length - 1 ? archive[at + 1] : null;

  if (state === 'loading') {
    return (
      <Frame>
        <div className="animate-pulse space-y-4 pt-10">
          <div className="mx-auto h-3 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mx-auto h-7 w-3/4 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-36 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-52 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
        </div>
      </Frame>
    );
  }

  if (state !== 'ready' || !edition) {
    return (
      <Frame>
        <div className="pt-16 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-zinc-400">A I &nbsp; N E W S &nbsp; T W I T T E R</p>
          <h1 className="mt-4 text-xl font-bold">{state === 'missing' ? 'No paper for that day' : 'The paper could not be loaded'}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-500">
            {state === 'missing'
              ? 'A new edition is written every day. Try the latest one.'
              : 'Something went wrong at our end. Please try again in a moment.'}
          </p>
          <a href="/paper" className="mt-5 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            Read the latest edition
          </a>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="border-y-2 border-zinc-900 py-5 text-center dark:border-zinc-100">
        <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-zinc-500">A I &nbsp; N E W S &nbsp; T W I T T E R</p>
        <p className="mt-1 text-[11px] text-zinc-400">{longDate(edition.day)} &nbsp;·&nbsp; Issue No. {edition.number}</p>
        <h1 className="mx-auto mt-3 max-w-2xl text-balance text-2xl font-bold leading-snug sm:text-3xl">{edition.headline}</h1>
        <p className="mt-3 text-xs text-zinc-400">
          {edition.storyCount} {edition.storyCount === 1 ? 'story' : 'stories'} · about a {Math.max(2, Math.round(edition.storyCount / 8))} minute read
        </p>
        <div className="mt-3 flex justify-center">
          <ShareButton url={`/paper/${edition.day}`} title={`AI News Twitter — ${edition.headline}`} text={edition.sixty[0]} />
        </div>
      </header>

      {/*
        Moving between editions belongs at the TOP, where a paper puts it. The archive at the foot
        of the page was 11 phone-screens down past 40 stories — the links were right and nobody was
        ever going to reach them, which for a reader is the same as their not existing.
      */}
      {(older || newer || archive.length > 1) && (
        <nav className="mt-4 flex items-center justify-between gap-2 text-xs">
          {newer ? (
            <a href={`/paper/${newer.day}`} className="inline-flex min-w-0 items-center gap-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
              <span aria-hidden>←</span> <span className="truncate">Newer</span>
            </a>
          ) : (
            <span className="text-zinc-300 dark:text-zinc-700" aria-hidden>←</span>
          )}

          <a href="#all-editions" className="shrink-0 rounded-full bg-zinc-200/70 px-3 py-1 font-medium text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
            All {archive.length} edition{archive.length === 1 ? '' : 's'}
          </a>

          {older ? (
            <a href={`/paper/${older.day}`} className="inline-flex min-w-0 items-center gap-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
              <span className="truncate">Older</span> <span aria-hidden>→</span>
            </a>
          ) : (
            <span className="text-zinc-300 dark:text-zinc-700" aria-hidden>→</span>
          )}
        </nav>
      )}

      {!edition.complete && (
        <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-center text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          Part of today's edition was not written up. Every story is still listed below.
        </p>
      )}

      {/* Same card, same indigo, same numbers as the owner's own view (BEA-1269). */}
      {edition.sixty.length > 0 && (
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">The 60-second read</p>
          <ol className="space-y-2">
            {edition.sixty.map((l, i) => (
              <li key={i} className="flex gap-3 text-sm leading-relaxed">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-[11px] font-bold text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">{i + 1}</span>
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
            <section key={sec.category} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-100">{sec.category}</h2>
                <span className="shrink-0 text-xs text-zinc-400">{sec.storyCount}</span>
              </div>
              {/*
                One block per category, exactly once — the same shape as the owner's own view.
                A "lead" that reprinted the first section's write-up above the section itself put
                its heading on the page three times, which is what made this read as repetition.
              */}
              {sec.line && <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">{sec.line}</p>}
              {sec.prose && (
                <div className="mb-4 space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {sec.prose.split(/\n{2,}/).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              )}

              <ul className="space-y-2">
                {head.map((s, i) => (
                  <li key={i}>
                    <StoryCard story={s} big={i === 0} />
                  </li>
                ))}
              </ul>

              {/* Always rendered, only collapsed — every story stays in the page and findable. */}
              {rest.length > 0 && (
                <div className={'grid transition-[grid-template-rows] duration-200 ' + (expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                  <ul className="min-h-0 space-y-2 overflow-hidden" aria-hidden={!expanded}>
                    {rest.map((s, i) => (
                      <li key={i} className="pt-2 first:pt-2">
                        <StoryCard story={s} brief />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {rest.length > 0 && (
                <button
                  onClick={() => setOpen({ ...open, [sec.category]: !expanded })}
                  className="mt-3 text-xs font-medium text-zinc-500 underline decoration-dotted underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
                >
                  {expanded ? 'Show fewer' : `${rest.length} more in ${sec.category.toLowerCase()}`}
                </button>
              )}
            </section>
          );
        })}
      </div>

      {/*
        The archive the footer link used to promise and never deliver — it pointed at /paper, which
        is this same latest edition, so "All editions" landed you on the page you were reading.
        Someone who likes today's paper should be able to read back.
      */}
      {archive.filter((e) => e.day !== edition.day).length > 0 && (
        <section id="all-editions" className="mt-12 scroll-mt-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          {/* "Earlier" was wrong: this lists every OTHER edition, which includes newer ones when
              you are reading an old link. */}
          <h2 className="mb-3 text-[13px] font-bold uppercase tracking-wider">All editions</h2>
          <ul className="space-y-2">
            {archive
              .filter((e) => e.day !== edition.day)
              .slice(0, 30)
              .map((e) => (
                <li key={e.day}>
                  <a
                    href={`/paper/${e.day}`}
                    className="block rounded-xl border border-zinc-200 bg-white p-3.5 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
                  >
                    <span className="block text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      No. {e.number} · {longDate(e.day)} · {e.storyCount} {e.storyCount === 1 ? 'story' : 'stories'}
                    </span>
                    <span className="mt-1 block text-sm font-medium">{e.headline}</span>
                  </a>
                </li>
              ))}
          </ul>
        </section>
      )}

      <footer className="mt-12 border-t border-zinc-200 pt-5 text-center dark:border-zinc-800">
        {/*
          Owner's wording, 2026-08-02. "500+" is accurate — the source checks 544 Twitter accounts.
          He asked for "20+ subreddits"; the real figure in the feed's own masthead is 12, so that
          is what this says. A number nobody can check is fine to round; one printed on a page you
          hand to people is not.
        */}
        <p className="text-xs text-zinc-500">Built from 500+ Twitter accounts and 12 subreddits.</p>
        <p className="mt-2 text-[11px] text-zinc-400">
          <a href="/paper" className="underline hover:text-zinc-600">Read the latest edition</a>
        </p>
      </footer>
    </Frame>
  );
}

/**
 * A story row — the same one the owner sees on his own page (BEA-1269).
 *
 * BEA-1267 gave these three sizes to break up the page. The owner then asked for the public paper
 * to use the design he already has, and his is one row at one size, so that is what this is.
 */
function StoryCard({ story, big = false, brief = false }: { story: PublicStory; big?: boolean; brief?: boolean }) {
  const label = SOURCE_LABEL[story.source] ?? story.source;
  const meta = (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
      {label && <span>{label}</span>}
      {story.links.slice(0, 3).map((l, i) => (
        <a key={i} href={l} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-200">
          link{story.links.length > 1 ? ` ${i + 1}` : ''}
        </a>
      ))}
    </div>
  );

  // One row, one size — the owner's own view (BEA-1269). `big` and `brief` stay in the signature so
  // the callers are unchanged, but they no longer alter the look: he asked for the same design, and
  // his has a single story row.
  void big;
  void brief;
  return (
    <div className="group rounded-xl border border-zinc-100 p-3 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700">
      <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{story.headline}</p>
      {meta}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto w-full max-w-2xl px-4 pb-20 pt-6 sm:px-6 sm:pt-10">{children}</div>
    </div>
  );
}
