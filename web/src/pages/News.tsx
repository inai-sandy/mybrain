import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Newspaper, Telescope, ExternalLink, ChevronDown, ChevronRight, AlertTriangle, Loader2, ArrowLeft } from 'lucide-react';
import { ResearchModal } from '../ui/ResearchModal';
import { DataTable, Column } from '../ui/DataTable';

/**
 * AI News Daily — your own view of an edition (BEA-1260).
 *
 * Complete coverage, layered. Every one of the day's 31–79 stories is in the page from the first
 * render, so nothing can go missing and browser-find works on all of it. What changes is size:
 * the written sections carry the paragraphs, and each section's remaining stories sit behind
 * "N more". Complete and short only fight each other if everything is the same size.
 *
 * This is the private view. Research buttons live here and never on the public page (BEA-1261).
 */

type Story = { id: string; text: string; theme: string | null; category: string; sourceKind: string; links: string[]; flagged: boolean };
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

/** A story's own headline: the first sentence, trimmed to something scannable. */
function headlineOf(s: Story): string {
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
  const [tab, setTab] = useState<'today' | 'archive'>('today');
  const [axis, setAxis] = useState<'category' | 'source'>('category');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [researching, setResearching] = useState<Story | null>(null);

  useEffect(() => {
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
          if (alive) { setEdition(null); setDay(null); setLoading(false); }
          return;
        }
        const r = await fetch(`/api/news/editions/${target}`);
        if (!r.ok) throw new Error('EDITION_FAILED');
        const d = await r.json();
        if (!alive) return;
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
  }, [dayParam]);

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

  if (loading) return <Skeleton />;

  if (error) {
    return (
      <Shell>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>
      </Shell>
    );
  }

  if (!edition) {
    return (
      <Shell>
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <Newspaper size={30} className="mx-auto mb-3 text-zinc-300 dark:text-zinc-600" />
          <p className="font-semibold">No edition yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
            AI News Daily writes one every day at noon. The first one will appear here as soon as it runs.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* Tabs */}
      <div className="mb-4 flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(['today', 'archive'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'relative px-3 py-2 text-sm font-medium transition-colors ' +
              (tab === t ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
            }
          >
            {t === 'today' ? 'The edition' : 'Past editions'}
            {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-indigo-500" />}
          </button>
        ))}
      </div>

      {tab === 'archive' ? (
        archiveError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
            <p>{archiveError}</p>
            <button onClick={() => setArchiveError(null)} className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500">
              Try again
            </button>
          </div>
        ) : (
          <ArchiveList rows={archive} onOpen={(d) => { navigate(`/news/${d}`); setTab('today'); }} />
        )
      ) : (
        <>
          {/* Masthead */}
          <header className="mb-5 border-y-2 border-zinc-900 py-4 text-center dark:border-zinc-100">
            <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-zinc-500">A I &nbsp; N E W S &nbsp; D A I L Y</p>
            <h1 className="mx-auto mt-2 max-w-2xl text-balance text-xl font-bold leading-snug sm:text-2xl">{edition.headline}</h1>
            <p className="mt-2 text-xs text-zinc-500">
              {longDate(edition.day)} · Issue No. {edition.number} · {edition.storyCount} {edition.storyCount === 1 ? 'story' : 'stories'}
              {edition.complete ? ' · all shown' : ` · showing ${edition.shown}`}
            </p>
          </header>

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
              Built on{' '}
              <a href={edition.source.link} target="_blank" rel="noreferrer" className="underline hover:text-indigo-500">
                Smol AI News
              </a>{' '}
              — they read the subreddits, the X lists and the Discords. We split, file and write it up.
            </p>
          )}
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
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-100">{section.category}</h2>
        <span className="shrink-0 text-xs text-zinc-400">{section.storyCount}</span>
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
              <li key={s.id} className="pt-2 first:pt-2">
                <StoryRow story={s} onResearch={onResearch} bare />
              </li>
            ))}
          </ul>
        </div>
      )}

      {rest.length > 0 && (
        <button onClick={onToggle} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? 'Show fewer' : `${rest.length} more in ${section.category}`}
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
    <Tag className="group rounded-xl border border-zinc-100 p-3 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700">
      <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{headlineOf(story)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
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
