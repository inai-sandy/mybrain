import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ExternalLink, List, Share2 } from 'lucide-react';
import { StoreBadges } from '../ui/StoreBadges';
import { ShareDialog } from '../ui/ShareDialog';

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function youtubeId(url: string): string | null {
  const m = (url || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/i);
  return m ? m[1] : null;
}

function nodeText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node?.props?.children) return nodeText(node.props.children);
  return '';
}

type Heading = { level: number; text: string; id: string };

function extractHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (!m) continue;
    const text = m[2].replace(/[`*_]/g, '').trim();
    out.push({ level: m[1].length, text, id: slugify(text) || 'section' });
  }
  return out;
}

/** Drop a leading bare-URL line (bookmarks store the link on line 1) from the rendered body. */
function stripLeadingUrl(md: string): string {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^https?:\/\/\S+$/.test(lines[i].trim())) lines.splice(0, i + 1);
  return lines.join('\n').replace(/^\n+/, '');
}

const mdComponents = {
  h1: ({ children }: any) => <h1 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h1>,
  h2: ({ children }: any) => <h2 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h2>,
  h3: ({ children }: any) => <h3 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h3>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:underline break-words">{children}</a>
  ),
};

function Toc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState('');
  useEffect(() => {
    const els = headings.map((h) => document.getElementById(h.id)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [headings]);

  return (
    <nav>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">
        <List size={14} /> On this page
      </div>
      <ul className="border-l border-zinc-200 dark:border-zinc-800">
        {headings.map((h, i) => (
          <li key={h.id + i}>
            <button
              onClick={() => document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className={
                'block w-full text-left -ml-px border-l-2 py-1 text-sm transition-colors ' +
                (active === h.id
                  ? 'border-emerald-500 text-emerald-600 font-medium'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200')
              }
              style={{ paddingLeft: (h.level - 1) * 12 + 12 }}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocDetail() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    fetch(`/api/items/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setErr('Could not load this document.'));
  }, [id]);

  const headings = useMemo(() => (d?.content ? extractHeadings(d.content) : []), [d?.content]);
  const body = useMemo(() => (d?.content ? stripLeadingUrl(d.content) : ''), [d?.content]);
  const showToc = headings.length >= 2;

  return (
    <div className="space-y-5">
      <Link to={d?.source === 'raindrop' ? '/bookmarks' : '/capture'} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to {d?.source === 'raindrop' ? 'bookmarks' : 'documents'}
      </Link>

      {err && <p className="text-amber-500">{err}</p>}

      {d && (
        <div className="lg:flex lg:gap-8">
          {showToc && (
            <aside className="hidden lg:block lg:w-56 shrink-0 order-first">
              <div className="sticky top-20">
                <Toc headings={headings} />
              </div>
            </aside>
          )}

          <div className="min-w-0 flex-1 space-y-5">
            <div>
              <h1 className="text-2xl font-extrabold">{d.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-zinc-500">
                <span className="capitalize">{d.source === 'raindrop' ? 'bookmark' : d.source}</span>
                <span>·</span>
                <span>{new Date(d.createdAt).toLocaleString()}</span>
                <StoreBadges supermemory={d.supermemory} rag={d.rag} chunked={d.chunked} />
              </div>
              {d.tags?.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {d.tags.map((t: string) => (
                    <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {d.sourceUrl && (
                  <a
                    href={d.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 break-all"
                  >
                    Open original <ExternalLink size={14} className="shrink-0" />
                  </a>
                )}
                <button
                  onClick={() => setSharing(true)}
                  className={'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 ' + (d.shared ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700')}
                >
                  <Share2 size={14} /> {d.shared ? 'Shared' : 'Share'}
                </button>
              </div>
              {d.summary && (
                <p className="mt-4 text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
                  {d.summary}
                </p>
              )}
            </div>

            {(() => {
              const ytId = d.sourceUrl ? youtubeId(d.sourceUrl) : null;
              if (ytId)
                return (
                  <div className="aspect-video w-full rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
                    <iframe
                      className="w-full h-full"
                      src={`https://www.youtube.com/embed/${ytId}`}
                      title={d.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                );
              if (d.thumbnail && d.source === 'raindrop')
                return (
                  <a href={d.sourceUrl || '#'} target="_blank" rel="noreferrer" className="block rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
                    <img src={d.thumbnail} alt="" className="w-full max-h-80 object-cover" />
                  </a>
                );
              return null;
            })()}

            {showToc && (
              <details className="lg:hidden rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                <summary className="text-sm font-medium cursor-pointer text-zinc-600 dark:text-zinc-300">On this page</summary>
                <div className="mt-2">
                  <Toc headings={headings} />
                </div>
              </details>
            )}

            {body && (
              <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-5">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{body}</ReactMarkdown>
              </article>
            )}
          </div>
        </div>
      )}
      {!d && !err && <p className="text-zinc-400">Loading…</p>}

      {sharing && d && (
        <ShareDialog
          id={d.id}
          title={d.title}
          initialShared={!!d.shared}
          onClose={() => setSharing(false)}
          onChanged={(s) => setD((prev: any) => (prev ? { ...prev, shared: s } : prev))}
        />
      )}
    </div>
  );
}
