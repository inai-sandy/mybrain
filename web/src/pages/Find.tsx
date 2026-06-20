import { FormEvent, useEffect, useState } from 'react';
import { Brain, Search, Sparkles, ArrowRight, Bookmark, Trash2, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../ui/markdown';
import { DataTable, Column, SortOption } from '../ui/DataTable';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';

type SMDoc = { id: string; title: string; summary: string; tags: string[]; createdAt: string; status: string };
type Source = { n: number; sourceType: string; title: string; snippet: string; when?: string; link: string; source: string; score?: number };
type AskResult = { answer: string; sources: Source[]; matches: number };
type Saved = { id: string; question: string; answer: string; sources: Source[]; createdAt: string };

const TYPE_STYLE: Record<string, string> = {
  task: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  story: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  bookmark: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  idea: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  meeting: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30',
  skill: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
  email: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30',
  vault: 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400 border-emerald-600/30',
  document: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
};

function Chip({ t }: { t: string }) {
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
      {t}
    </span>
  );
}

function SourceCard({ s }: { s: Source }) {
  return (
    <Link
      to={s.link}
      className="block rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 hover:border-emerald-500/40 hover:shadow-md transition-all"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold tabular-nums text-zinc-400">[{s.n}]</span>
        <span className={'text-[10px] px-2 py-0.5 rounded-full border ' + (TYPE_STYLE[s.sourceType] || TYPE_STYLE.document)}>{s.sourceType}</span>
        {s.when && <span className="text-[10px] text-zinc-400">{new Date(s.when).toLocaleDateString()}</span>}
      </div>
      <h4 className="font-semibold text-sm mt-1.5 line-clamp-1">{s.title}</h4>
      <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{s.snippet}</p>
    </Link>
  );
}

function AnswerBlock({ answer, sources }: { answer: string; sources: Source[] }) {
  return (
    <div className="space-y-4">
      <article className="prose prose-sm prose-zinc dark:prose-invert max-w-none prose-p:my-1.5 prose-strong:font-semibold prose-ul:my-1.5 prose-ul:pl-4 prose-li:my-0.5 prose-li:marker:text-emerald-500">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {answer}
        </ReactMarkdown>
      </article>
      {sources.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-zinc-400 mb-2">
            {sources.length} source{sources.length === 1 ? '' : 's'}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {sources.map((s) => (
              <SourceCard key={s.n} s={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function dateGroup(iso: string): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function SavedResources() {
  const toast = useToast();
  const [all, setAll] = useState<Saved[] | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [confirmDel, setConfirmDel] = useState<Saved | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/explore/saves');
      setAll(await r.json());
    } catch {
      setAll([]);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function del(s: Saved) {
    try {
      await fetch(`/api/explore/saves/${s.id}`, { method: 'DELETE' });
      setAll((a) => (a || []).filter((x) => x.id !== s.id));
      toast('success', 'Removed from saved');
    } catch {
      toast('error', 'Could not delete');
    }
  }

  const needle = query.trim().toLowerCase();
  const list = (all || []).filter((s) => !needle || `${s.question}\n${s.answer}`.toLowerCase().includes(needle));

  // group by date label, preserving newest-first order
  const groups: { label: string; items: Saved[] }[] = [];
  for (const s of list) {
    const label = dateGroup(s.createdAt);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(s);
    else groups.push({ label, items: [s] });
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your saved answers"
          className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-11 pr-4 py-3 outline-none focus:border-emerald-500 transition-colors"
        />
      </div>

      {all === null && <div className="text-sm text-zinc-400">Loading…</div>}
      {all !== null && list.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center text-sm text-zinc-500">
          {all.length === 0 ? 'Nothing saved yet. Ask your brain something, then tap Save on the answer.' : 'No saved answers match that search.'}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-400 mb-2 mt-1">{g.label}</div>
          <div className="space-y-2.5">
            {g.items.map((s) => {
              const isOpen = !!open[s.id];
              return (
                <div key={s.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
                  <div className="flex items-start gap-2 p-4">
                    <button onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))} className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <Sparkles size={14} className="text-emerald-500 shrink-0" />
                        <h3 className="font-semibold leading-snug line-clamp-1">{s.question}</h3>
                      </div>
                      {!isOpen && <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{s.answer.replace(/[#*`>_-]/g, '').trim()}</p>}
                      <div className="text-[11px] text-zinc-400 mt-1.5">
                        {new Date(s.createdAt).toLocaleString()} · {s.sources.length} source{s.sources.length === 1 ? '' : 's'}
                      </div>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setConfirmDel(s)} aria-label="Delete" className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-500/10 transition">
                        <Trash2 size={15} />
                      </button>
                      <button onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))} aria-label="Expand" className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
                        <ChevronDown size={16} className={'transition-transform ' + (isOpen ? 'rotate-180' : '')} />
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="border-t border-zinc-200 dark:border-zinc-800 p-4">
                      <AnswerBlock answer={s.answer} sources={s.sources} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <ConfirmDialog
        open={!!confirmDel}
        title="Delete saved answer?"
        message="This removes it from your saved list. It does not affect your brain or its index."
        confirmLabel="Delete"
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          const s = confirmDel!;
          setConfirmDel(null);
          del(s);
        }}
      />
    </div>
  );
}

export function Find() {
  const toast = useToast();
  const [tab, setTab] = useState<'ask' | 'saved'>('ask');
  const [q, setQ] = useState('');
  const [askedQ, setAskedQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // Secondary: browse everything already in the brain.
  const [docs, setDocs] = useState<SMDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/memory/browse?limit=100')
      .then((r) => r.json())
      .then((d) => {
        setDocs(d.docs || []);
        setTotal(d.total || 0);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function ask(e?: FormEvent) {
    e?.preventDefault();
    const question = q.trim();
    if (!question || asking) return;
    setAsking(true);
    setError('');
    setResult(null);
    setSaved(false);
    setAskedQ(question);
    try {
      const r = await fetch('/api/explore/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!r.ok) throw new Error('ask failed');
      setResult(await r.json());
    } catch {
      setError('Something went wrong asking your brain. Try again.');
    } finally {
      setAsking(false);
    }
  }

  async function saveAnswer() {
    if (!result || saved) return;
    try {
      const r = await fetch('/api/explore/saves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: askedQ, answer: result.answer, sources: result.sources }),
      });
      if (!r.ok) throw new Error();
      setSaved(true);
      toast('success', 'Saved — find it in the Saved tab');
    } catch {
      toast('error', 'Could not save');
    }
  }

  const cols: Column<SMDoc>[] = [
    { key: 'title', label: 'Title' },
    { key: 'summary', label: 'Summary' },
  ];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  function card(r: SMDoc) {
    return (
      <div className="h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-emerald-500/40 hover:shadow-md transition-all">
        <div className="flex items-start gap-2.5">
          <div className="shrink-0 rounded-lg p-2 bg-emerald-500/10 text-emerald-600">
            <Brain size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold leading-snug line-clamp-1">{r.title}</h3>
            {r.summary && <p className="text-sm text-zinc-500 mt-0.5 line-clamp-3">{r.summary}</p>}
            {r.tags?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {r.tags.slice(0, 5).map((t) => (
                  <Chip key={t} t={t} />
                ))}
              </div>
            )}
            <div className="mt-2 text-xs text-zinc-400">{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2">
          <Sparkles size={22} className="text-emerald-500" /> Explore
        </h1>
        <p className="text-zinc-500">Ask your brain anything — it answers from your tasks, stories, documents, bookmarks and research.</p>
      </div>

      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(['ask', 'saved'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ' +
              (tab === t ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')
            }
          >
            {t === 'saved' ? 'Saved' : 'Ask'}
          </button>
        ))}
      </div>

      {tab === 'saved' ? (
        <SavedResources />
      ) : (
        <>
          <form onSubmit={ask} className="relative">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="What did I decide about pricing?"
              className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-11 pr-28 py-3 outline-none focus:border-emerald-500 transition-colors"
            />
            <button
              type="submit"
              disabled={asking || !q.trim()}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-50 text-white px-3.5 py-2 text-sm font-semibold transition"
            >
              {asking ? 'Thinking…' : (
                <>
                  Ask <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          {asking && (
            <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 animate-pulse">
              <div className="h-3 w-24 rounded bg-zinc-200 dark:bg-zinc-800 mb-3" />
              <div className="h-3 w-full rounded bg-zinc-100 dark:bg-zinc-800/70 mb-2" />
              <div className="h-3 w-5/6 rounded bg-zinc-100 dark:bg-zinc-800/70" />
            </div>
          )}

          {error && <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-sm px-3 py-2">{error}</div>}

          {result && !asking && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.04] p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                  <Sparkles size={13} /> Answer
                </div>
                <button
                  onClick={saveAnswer}
                  disabled={saved}
                  className={'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ' + (saved ? 'bg-emerald-600 text-white' : 'border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 hover:text-emerald-600')}
                >
                  <Bookmark size={13} className={saved ? 'fill-current' : ''} /> {saved ? 'Saved' : 'Save'}
                </button>
              </div>
              {result.answer ? <AnswerBlock answer={result.answer} sources={result.sources} /> : <p className="text-sm text-zinc-500">No answer.</p>}
            </div>
          )}

          {!result && !asking && !error && (
            <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-5 text-sm text-zinc-500">
              Try: <span className="text-zinc-600 dark:text-zinc-300">“what tasks did I do this week?”</span> ·{' '}
              <span className="text-zinc-600 dark:text-zinc-300">“summarise my pricing research”</span> ·{' '}
              <span className="text-zinc-600 dark:text-zinc-300">“the day I argued pricing with Diksha”</span>
            </div>
          )}

          <div className="pt-2">
            <h2 className="text-sm font-bold text-zinc-500 mb-2">
              Everything in your brain — {total} item{total === 1 ? '' : 's'}
            </h2>
            <DataTable<SMDoc>
              columns={cols}
              rows={docs}
              loading={loading}
              sortOptions={sortOptions}
              renderCard={card}
              cardsOnly
              pageSize={12}
              emptyText="Nothing here yet."
            />
          </div>
        </>
      )}
    </div>
  );
}
