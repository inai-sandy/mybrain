import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Newspaper, Telescope, ExternalLink, ChevronDown, ChevronRight, AlertTriangle, Loader2, ArrowLeft } from 'lucide-react';
import { ResearchModal } from '../ui/ResearchModal';
import { DataTable, Column } from '../ui/DataTable';
import { ShareButton } from '../ui/ShareButton';
import { RadarView } from './RadarView';

/**
 * AI News Twitter (renamed from AI News Daily in BEA-1318) — your own view of an edition (BEA-1260).
 *
 * Complete coverage, layered. Every one of the day's 31–79 stories is in the page from the first
 * render, so nothing can go missing and browser-find works on all of it. What changes is size:
 * the written sections carry the paragraphs, and each section's remaining stories sit behind
 * "N more". Complete and short only fight each other if everything is the same size.
 *
 * This is the private view. Research buttons live here and never on the public page (BEA-1261).
 */

type Story = { id: string; text: string; theme: string | null; category: string; sourceKind: string; links: string[]; flagged: boolean; headline?: string | null };
type Section = { category: string; line: string; prose: string; written: boolean; storyCount: number; stories: Story[] };
type Edition = {
  number: number;
  day: string;
  headline: string;
  sixty: string[];
  engineOk: boolean;
  notes: string[];
  storyCount: number;
  shown: number;
  complete: boolean;
  sections: Section[];
  flagged: Story[];
  bySource: Record<string, number>;
  source: { title: string; link: string; pubDate: string } | null;
};
type ArchiveRow = { number: number; day: string; headline: string; storyCount: number; engineOk: boolean; categories: { category: string; count: number }[] };

/** How many stories each section shows before "N more". */
const SHOWN_PER_SECTION = 3;

const SOURCE_LABEL: Record<string, string> = { twitter: 'X / Twitter', reddit: 'Reddit', discord: 'Discord', unknown: 'Elsewhere' };

function longDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * A story's headline: the one the engine wrote (BEA-1267), else its first sentence.
 *
 * The written one was already coming back from the API and this page was ignoring it — so the
 * public paper showed "DeepSeek launches V4-Flash public beta" while this one still showed thirty
 * words of narrative. Claiming a page improves "for free" and not checking is how that happens.
 */
function headlineOf(s: Story): string {
  if (s.headline) return s.headline;
  const first = s.text.split('\n')[0].trim();
  const stop = first.search(/[.!?](\s|$)/);
  const cut = stop > 30 ? first.slice(0, stop + 1) : first;
  return cut.length > 150 ? `${cut.slice(0, 150).trimEnd()}…` : cut;
}

export default function News() {
  const { day: dayParam } = useParams();
  const navigate = useNavigate();
  const [day, setDay] = useState<string | null>(dayParam || null);
  const [edition, setEdition] = useState<Edition | null>(null);
  const [archive, setArchive] = useState<ArchiveRow[] | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Which feed is open lives in the URL (BEA-1318): /news = Daily (the radar),
  // ?view=twitter = the written edition. Legacy ?view=radar links keep landing on Daily.
  // A DAY url (/news/2026-08-14) is inherently an edition link — every "Read it" link the
  // pipeline ever wrote points there bare — so it opens the edition unless explicitly told
  // otherwise (review finding, BEA-1318).
  const [searchParams, setSearchParams] = useSearchParams();
  const urlView = searchParams.get('view');
  const view: 'daily' | 'twitter' =
    urlView === 'twitter' ? 'twitter' : urlView === 'radar' ? 'daily' : dayParam ? 'twitter' : 'daily';
  // Inside the Twitter feed, the archive is a sub-view reached by its "Past editions" link.
  const [tab, setTab] = useState<'today' | 'archive'>('today');
  const selectView = (v: 'daily' | 'twitter') => {
    setTab('today');
    // Merge, never replace — a future ?param on /news must survive a toggle click.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v === 'twitter') next.set('view', 'twitter');
      else next.delete('view');
      return next;
    });
  };
  const [axis, setAxis] = useState<'category' | 'source'>('category');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [researching, setResearching] = useState<Story | null>(null);

  // Which dayParam the edition effect last completed for — so landing straight on the
  // Radar tab skips the fetch, and later tab switches load it exactly once.
  const editionLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (view === 'daily') return;
    if (editionLoadedFor.current === (dayParam || 'latest')) return;
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        let target = dayParam;
        if (!target) {
          const r = await fetch('/api/news/editions/latest');
          const d = await r.json().catch(() => ({}));
          target = d?.day || undefined;
        }
        if (!target) {
          editionLoadedFor.current = dayParam || 'latest';
          if (alive) { setEdition(null); setDay(null); setLoading(false); }
          return;
        }
        const r = await fetch(`/api/news/editions/${target}`);
        if (!r.ok) throw new Error('EDITION_FAILED');
        const d = await r.json();
        if (!alive) return;
        editionLoadedFor.current = dayParam || 'latest'; // errors do NOT mark — a retry stays possible
        setEdition(d);
        setDay(d.day);
        setOpen({}); // a new day starts collapsed, not carrying the last one's expansions
      } catch {
        // Same rule: our words, not the browser's.
        if (alive) setError('That edition could not be opened. It may not exist, or the server could not be reached.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [dayParam, view]);

  useEffect(() => {
    if (tab !== 'archive' || archive || archiveError) return;
    // A failed request must NOT be coerced to an empty list: "no past editions yet" and "we could
    // not reach the server" look identical to a reader, and only one of them is true.
    fetch('/api/news/editions')
      .then((r) => {
        if (!r.ok) throw new Error('The archive could not be loaded.');
        return r.json();
      })
      .then((d) => setArchive(Array.isArray(d) ? d : []))
      // Always our own words. A raw "offline" or "NetworkError" from the browser is not an
      // error message a person can act on.
      .catch(() => setArchiveError('The archive could not be loaded. Check your connection and try again.'));
  }, [tab, archive, archiveError]);

  // Rail index → scroll to that section's card. Sections only exist on the category
  // axis, so reading by source switches back first; the scroll then fires from an
  // effect AFTER the category cards have actually committed — a fixed delay could
  // fire before the anchor exists and silently do nothing.
  const pendingJump = useRef<string | null>(null);
  const jumpToSection = (category: string) => {
    if (axis !== 'category') {
      pendingJump.current = category;
      setAxis('category');
    } else {
      document.getElementById(`sec-${category}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  useEffect(() => {
    if (axis !== 'category' || !pendingJump.current) return;
    document.getElementById(`sec-${pendingJump.current}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pendingJump.current = null;
  }, [axis]);

  const bySource = useMemo(() => {
    if (!edition) return [];
    const groups = new Map<string, Story[]>();
    for (const sec of edition.sections) {
      for (const s of sec.stories) {
        if (!groups.has(s.sourceKind)) groups.set(s.sourceKind, []);
        groups.get(s.sourceKind)!.push(s);
      }
    }
    return [...groups.entries()].map(([kind, stories]) => ({ kind, stories }));
  }, [edition]);

  // Daily (the radar) does not depend on an edition existing — it renders before the
  // edition's own loading/error/empty returns so it is reachable on day zero too.
  if (view === 'daily') {
    return (
      <Shell>
        <ViewToggle view={view} onSelect={selectView} />
        <RadarView />
      </Shell>
    );
  }

  if (loading) return <Skeleton />;

  if (error) {
    return (
      <Shell>
        <ViewToggle view={view} onSelect={selectView} />
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>
      </Shell>
    );
  }

  if (!edition) {
    return (
      <Shell>
        <ViewToggle view={view} onSelect={selectView} />
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <Newspaper size={30} className="mx-auto mb-3 text-zinc-300 dark:text-zinc-600" />
          <p className="font-semibold">No edition yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
            AI News Twitter writes one every day at noon. The first one will appear here as soon as it runs.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <ViewToggle view={view} onSelect={selectView} />

      {tab === 'archive' && (
        <div className="mb-3">
          <button onClick={() => setTab('today')} className="text-xs font-semibold text-indigo-500 hover:text-indigo-400">‹ Back to the edition</button>
        </div>
      )}

      {tab === 'archive' ? (
        archiveError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
            <p>{archiveError}</p>
            <button onClick={() => setArchiveError(null)} className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500">
              Try again
            </button>
          </div>
        ) : (
          // Keep ?view=twitter — without it the day URL would land on the Daily feed and hide the edition.
          <ArchiveList rows={archive} onOpen={(d) => { navigate(`/news/${d}?view=twitter`); setTab('today'); }} />
        )
      ) : (
        <>
          {/* The hero card (BEA-1319) — replaces the old newspaper masthead. */}
          <header className="mb-4 rounded-2xl border border-indigo-200/80 bg-gradient-to-br from-indigo-50 via-white to-white p-5 dark:border-indigo-900/50 dark:from-indigo-950/40 dark:via-zinc-900 dark:to-zinc-900">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-indigo-500 dark:text-indigo-300">A I &nbsp; N E W S &nbsp; T W I T T E R</p>
            <h1 className="mt-2 max-w-3xl text-balance text-xl font-bold leading-snug sm:text-[22px]">{edition.headline}</h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
              <span>{longDate(edition.day)}</span>
              <span>Issue <b className="font-semibold text-zinc-700 dark:text-zinc-200">No. {edition.number}</b></span>
              <span>
                <b className="font-semibold text-zinc-700 dark:text-zinc-200">{edition.storyCount}</b> {edition.storyCount === 1 ? 'story' : 'stories'}
                {edition.complete ? ' · all shown' : ` · showing ${edition.shown}`}
              </span>
              <button onClick={() => setTab('archive')} className="ml-auto whitespace-nowrap text-xs font-semibold text-indigo-500 hover:text-indigo-400">
                Past editions ›
              </button>
            </div>
            {/*
              Shares the PUBLIC /paper link, not this private /news one. Sending someone the page
              you are standing on would hand them a login screen. On large screens the Share card
              lives in the right rail instead, so this row hides itself there.
            */}
            <div className="mt-3 flex items-center gap-2 lg:hidden">
              <ShareButton
                url={`/paper/${edition.day}`}
                title={`AI News Twitter — ${edition.headline}`}
                text={edition.sixty[0]}
                label="Share this edition"
              />
              <a
                href={`/paper/${edition.day}`}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-indigo-500"
              >
                see the public version
              </a>
            </div>
          </header>

          {/* Desktop reads in two columns (BEA-1319): the paper, and a slim rail beside it. */}
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_250px] lg:items-start lg:gap-5">
          <div className="min-w-0">

          {!edition.engineOk && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">Part of this edition was not written up.</p>
                <p className="mt-0.5">Every story is still here, with its links. {edition.notes.join(' ')}</p>
              </div>
            </div>
          )}

          {!edition.complete && (
            <div className="mb-4 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200">
              This edition recorded {edition.storyCount} stories but only {edition.shown} are on the page. Something is wrong — do not trust it as complete.
            </div>
          )}

          {/* The 60-second read */}
          {edition.sixty.length > 0 && (
            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
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

          {/* Axis switch + contents */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">Read by</span>
            {(['category', 'source'] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAxis(a)}
                className={
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors ' +
                  (axis === a
                    ? 'bg-indigo-600 text-white'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700')
                }
              >
                {a === 'category' ? 'Category' : 'Where it came from'}
              </button>
            ))}
          </div>

          {axis === 'category' ? (
            <div className="space-y-5">
              {edition.sections.map((sec) => (
                <SectionCard
                  key={sec.category}
                  section={sec}
                  expanded={!!open[sec.category]}
                  onToggle={() => setOpen({ ...open, [sec.category]: !open[sec.category] })}
                  onResearch={setResearching}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              {bySource.map(({ kind, stories }) => (
                <SectionCard
                  key={kind}
                  section={{ category: SOURCE_LABEL[kind] || kind, line: `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}`, prose: '', written: false, storyCount: stories.length, stories }}
                  expanded={!!open[`src:${kind}`]}
                  onToggle={() => setOpen({ ...open, [`src:${kind}`]: !open[`src:${kind}`] })}
                  onResearch={setResearching}
                />
              ))}
            </div>
          )}

          {/* Worth digging into */}
          <section className="mt-8 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/20 sm:p-5">
            <p className="mb-1 flex items-center gap-2 text-sm font-bold"><Telescope size={16} className="text-indigo-500" /> Worth digging into</p>
            {edition.flagged.length ? (
              <>
                <p className="mb-3 text-xs text-zinc-500">These say something matters but not enough about it. Tap one to research it properly.</p>
                <ul className="space-y-2">
                  {edition.flagged.map((s) => (
                    <li key={s.id}>
                      <button
                        onClick={() => setResearching(s)}
                        className="w-full rounded-xl border border-zinc-200 bg-white p-3 text-left text-sm transition-colors hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900"
                      >
                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-indigo-500">{s.category}</span>
                        {headlineOf(s)}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-xs text-zinc-500">Nothing today needs chasing. Every story still has its own research button.</p>
            )}
          </section>

          {edition.source && (
            <p className="mt-6 text-center text-xs text-zinc-400">
              Built from 500+ Twitter accounts and 12 subreddits ·{' '}
              <a href={edition.source.link} target="_blank" rel="noreferrer" className="underline hover:text-indigo-500">
                today's source issue
              </a>
            </p>
          )}

          </div>

          {/* The rail — index of the issue plus the share card, desktop only. */}
          <aside className="hidden lg:block">
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">In this issue</p>
              {edition.sections.map((sec) => (
                <button
                  key={sec.category}
                  onClick={() => jumpToSection(sec.category)}
                  className="flex w-full items-center justify-between border-b border-zinc-100 py-1.5 text-left text-[12.5px] last:border-b-0 dark:border-zinc-800"
                >
                  <span className="font-semibold text-zinc-700 hover:text-indigo-500 dark:text-zinc-200">{sec.category}</span>
                  <span className="text-zinc-400">{sec.storyCount}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">Share</p>
              <div className="flex flex-col items-start gap-2">
                <ShareButton
                  url={`/paper/${edition.day}`}
                  title={`AI News Twitter — ${edition.headline}`}
                  text={edition.sixty[0]}
                  label="Share this edition"
                />
                <a
                  href={`/paper/${edition.day}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-indigo-500"
                >
                  see the public version
                </a>
              </div>
            </div>
          </aside>
          </div>
        </>
      )}

      {researching && (
        <ResearchModal
          title={headlineOf(researching)}
          endpointBase={`/api/news/stories/${researching.id}`}
          pastLabel="Past research on this story"
          onClose={() => setResearching(null)}
        />
      )}
    </Shell>
  );
}

/** The mockup's segmented toggle: Daily = the radar feed, Twitter = the written edition. */
function ViewToggle({ view, onSelect }: { view: 'daily' | 'twitter'; onSelect: (v: 'daily' | 'twitter') => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-base font-bold">News</h1>
      <div className="flex rounded-[10px] border border-zinc-200 bg-white p-[3px] text-[12.5px] dark:border-zinc-800 dark:bg-zinc-900">
        {(['daily', 'twitter'] as const).map((v) => (
          <button
            key={v}
            onClick={() => onSelect(v)}
            className={
              'rounded-lg px-4 py-[5px] transition-colors ' +
              (view === v ? 'bg-indigo-500 font-semibold text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
            }
          >
            {v === 'daily' ? 'Daily' : 'Twitter'}
          </button>
        ))}
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
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

function SectionCard({
  section,
  expanded,
  onToggle,
  onResearch,
}: {
  section: Section;
  expanded: boolean;
  onToggle: () => void;
  onResearch: (s: Story) => void;
}) {
  const head = section.stories.slice(0, SHOWN_PER_SECTION);
  const rest = section.stories.slice(SHOWN_PER_SECTION);
  return (
    <section id={`sec-${section.category}`} className="scroll-mt-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">{section.category}</h2>
        <span className="shrink-0 text-xs text-zinc-400">{section.storyCount} {section.storyCount === 1 ? 'story' : 'stories'}</span>
      </div>
      {section.line && <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">{section.line}</p>}

      {section.prose ? (
        <div className="mb-4 space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          {section.prose.split(/\n{2,}/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : (
        <p className="mb-4 text-xs italic text-amber-700 dark:text-amber-300">Not written up — the stories are listed in full below.</p>
      )}

      <ul className="space-y-2">
        {head.map((s) => (
          <StoryRow key={s.id} story={s} onResearch={onResearch} />
        ))}
      </ul>

      {/*
        The long tail is ALWAYS rendered, never conditionally mounted. `{expanded && rest.map(…)}`
        looked equivalent and was not: those stories simply did not exist in the page until someone
        clicked, so find-in-page could not reach them and they were gone entirely if scripting broke
        after first paint. Complete coverage has to mean complete in the DOM, not complete in the
        data we happen to hold. Collapsing with a 0fr grid row keeps every story present and
        findable while still hiding it.
      */}
      {rest.length > 0 && (
        <div className={'grid transition-[grid-template-rows] duration-200 ' + (expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <ul className="min-h-0 space-y-2 overflow-hidden" aria-hidden={!expanded}>
            {rest.map((s) => (
              <li key={s.id}>
                <StoryRow story={s} onResearch={onResearch} bare />
              </li>
            ))}
          </ul>
        </div>
      )}

      {rest.length > 0 && (
        <button onClick={onToggle} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? 'Show fewer' : `${rest.length} more ${rest.length === 1 ? 'story' : 'stories'}`}
        </button>
      )}
    </section>
  );
}

function StoryRow({ story, onResearch, bare = false }: { story: Story; onResearch: (s: Story) => void; bare?: boolean }) {
  // `bare` renders a <div> instead of an <li>, for the collapsed tail where the <li> is supplied
  // by the caller. Nesting an <li> inside an <li> would be invalid markup.
  const Tag: any = bare ? 'div' : 'li';
  return (
    <Tag className="group flex items-start gap-2.5 border-t border-zinc-100 pt-2.5 dark:border-zinc-800">
      <span className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full bg-indigo-500" aria-hidden />
      <div className="min-w-0 flex-1">
      <p className="text-[13px] font-semibold leading-snug text-zinc-800 dark:text-zinc-200">{headlineOf(story)}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
        <span>{SOURCE_LABEL[story.sourceKind] || story.sourceKind}</span>
        {story.links.slice(0, 3).map((l, i) => (
          <a key={i} href={l} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-indigo-500">
            <ExternalLink size={11} /> link{story.links.length > 1 ? ` ${i + 1}` : ''}
          </a>
        ))}
        {story.flagged && <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">worth a dig</span>}
        <button
          onClick={() => onResearch(story)}
          title="Research this"
          className="ml-auto rounded-md p-1 text-zinc-400 transition-colors hover:bg-indigo-500/10 hover:text-indigo-500"
        >
          <Telescope size={13} />
        </button>
      </div>
      </div>
    </Tag>
  );
}

function ArchiveList({ rows, onOpen }: { rows: ArchiveRow[] | null; onOpen: (day: string) => void }) {
  const columns: Column<ArchiveRow>[] = [
    { key: 'number', label: 'No.', sortable: true, render: (r) => <span className="text-zinc-400">{r.number}</span> },
    { key: 'day', label: 'Day', sortable: true, render: (r) => <span className="whitespace-nowrap">{longDate(r.day)}</span> },
    { key: 'headline', label: 'Headline', render: (r) => <span className="font-medium">{r.headline}</span> },
    { key: 'storyCount', label: 'Stories', sortable: true, render: (r) => <span className="text-zinc-500">{r.storyCount}</span> },
  ];
  return (
    <DataTable<ArchiveRow>
      columns={columns}
      rows={rows || []}
      loading={rows === null}
      searchable
      pageSize={15}
      sortOptions={[
        { key: 'day', label: 'Newest first', dir: -1 as const },
        { key: 'storyCount', label: 'Most stories', dir: -1 as const },
      ]}
      filters={[{ key: 'engineOk', label: 'Written up', options: [{ value: 'true', label: 'Complete' }, { value: 'false', label: 'Partly written' }] }]}
      emptyText="No past editions yet — the first one arrives at noon."
      onRowClick={(r) => onOpen(r.day)}
      renderCard={(r) => (
        <button onClick={() => onOpen(r.day)} className="w-full rounded-xl border border-zinc-200 bg-white p-4 text-left transition-colors hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">No. {r.number} · {longDate(r.day)}</p>
          <p className="mt-1 text-sm font-semibold">{r.headline}</p>
          <p className="mt-1 text-xs text-zinc-500">{r.storyCount} stories{r.engineOk ? '' : ' · partly written'}</p>
        </button>
      )}
    />
  );
}

function Skeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl animate-pulse px-4 pt-8 sm:px-6">
      <div className="mx-auto mb-3 h-3 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mx-auto mb-6 h-6 w-3/4 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mb-6 h-32 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      <div className="space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
        ))}
      </div>
      <p className="mt-6 flex items-center justify-center gap-2 text-xs text-zinc-400"><Loader2 size={12} className="animate-spin" /> Loading the edition…</p>
    </div>
  );
}
