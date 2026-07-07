import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from './markdown';

export type EmoSource = { n: number; sourceType?: string; title: string; snippet?: string; when?: string; link: string; source?: string };

const TYPE_STYLE: Record<string, string> = {
  task: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  story: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  bookmark: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  idea: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  meeting: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30',
  web: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30',
  document: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
};

function fmtDate(w?: string): string {
  if (!w) return '';
  const d = new Date(w);
  return isNaN(+d) ? String(w).slice(0, 10) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Answer with tappable superscript [n] chips that jump to a source accordion below (bold date + title → snippet on expand). */
export function AnswerWithSources({ answer, sources }: { answer: string; sources: EmoSource[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const valid = new Set(sources.map((s) => s.n));
  const md = (answer || '').replace(/\[(\d+)\]/g, (m, d) => (valid.has(Number(d)) ? `[${m}](#emo-src-${d})` : m));

  const jump = (n: number) => { setOpen(n); document.getElementById(`emo-src-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

  const comps = {
    ...mdComponents,
    a: ({ href, children }: any) => {
      if (typeof href === 'string' && href.startsWith('#emo-src-')) {
        const n = Number(href.replace('#emo-src-', ''));
        return (
          <button
            onClick={(e) => { e.preventDefault(); jump(n); }}
            className="align-super text-[0.68em] font-semibold text-emerald-600 dark:text-emerald-400 px-0.5 rounded hover:bg-emerald-500/10 no-underline"
          >
            {String(children).replace(/[[\]]/g, '')}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer" className="text-emerald-600 dark:text-emerald-400 underline">{children}</a>;
    },
  };

  return (
    <div className="space-y-4">
      <article className="prose prose-sm prose-zinc dark:prose-invert max-w-none prose-p:my-1.5 prose-strong:font-semibold prose-ul:my-1.5 prose-ul:pl-4 prose-li:my-0.5 prose-li:marker:text-emerald-500">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={comps}>{md}</ReactMarkdown>
      </article>

      {sources.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-zinc-400 mb-2">{sources.length} source{sources.length === 1 ? '' : 's'}</div>
          <div className="space-y-2">
            {sources.map((s) => {
              const isOpen = open === s.n;
              return (
                <div key={s.n} id={`emo-src-${s.n}`} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
                  <button onClick={() => setOpen(isOpen ? null : s.n)} className="w-full flex items-center gap-2 p-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                    <span className="text-[10px] font-semibold tabular-nums text-zinc-400">[{s.n}]</span>
                    {s.sourceType && <span className={'text-[10px] px-2 py-0.5 rounded-full border ' + (TYPE_STYLE[s.sourceType] || TYPE_STYLE.document)}>{s.sourceType}</span>}
                    {s.when && <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200 whitespace-nowrap">{fmtDate(s.when)}</span>}
                    <span className="font-medium text-sm truncate flex-1">{s.title}</span>
                    <ChevronDown className={'w-4 h-4 shrink-0 text-zinc-400 transition-transform ' + (isOpen ? 'rotate-180' : '')} />
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pt-0">
                      {s.snippet && <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2 leading-relaxed">{s.snippet}</p>}
                      <Link to={s.link} className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">Open ↗</Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
