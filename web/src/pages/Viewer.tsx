import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink } from 'lucide-react';
import { extractHeadings, stripLeadingUrl, mdComponents, OutlineLayout, MediaEmbed } from '../ui/markdown';

type Doc = { title: string; summary?: string | null; source: string; sourceUrl?: string | null; thumbnail?: string | null; content: string };

export function Viewer() {
  const { id } = useParams();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/share/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setDoc)
      .catch(() => setError('This link is private or no longer shared.'));
  }, [id]);

  const headings = useMemo(() => (doc?.content ? extractHeadings(doc.content) : []), [doc?.content]);
  const body = useMemo(() => (doc?.content ? stripLeadingUrl(doc.content) : ''), [doc?.content]);

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-5 h-12 flex items-center gap-2 font-bold">
          <span className="text-lg">🧠</span> My Brain
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-5 py-8">
        {error && <p className="text-amber-500">{error}</p>}

        {doc && (
          <OutlineLayout headings={headings}>
            <div className="space-y-5">
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1">{doc.source === 'raindrop' ? 'bookmark' : doc.source}</div>
                <h1 className="text-2xl font-extrabold">{doc.title}</h1>
                {doc.sourceUrl && (
                  <a
                    href={doc.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 break-all"
                  >
                    Open original <ExternalLink size={14} className="shrink-0" />
                  </a>
                )}
                {doc.summary && (
                  <p className="mt-4 text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">{doc.summary}</p>
                )}
              </div>

              <MediaEmbed sourceUrl={doc.sourceUrl} source={doc.source} thumbnail={doc.thumbnail} title={doc.title} />

              {body && (
                <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-5">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{body}</ReactMarkdown>
                </article>
              )}
            </div>
          </OutlineLayout>
        )}
        {!doc && !error && <p className="text-zinc-400">Loading…</p>}
      </div>
    </div>
  );
}
