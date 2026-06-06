import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { StoreBadges } from '../ui/StoreBadges';

export function DocDetail() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`/api/items/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setErr('Could not load this document.'));
  }, [id]);

  return (
    <div className="space-y-5">
      <Link to="/capture" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to documents
      </Link>

      {err && <p className="text-amber-500">{err}</p>}

      {d && (
        <>
          <div>
            <h1 className="text-2xl font-extrabold">{d.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-zinc-500">
              <span className="capitalize">{d.source}</span>
              <span>·</span>
              <span>{new Date(d.createdAt).toLocaleString()}</span>
              <StoreBadges supermemory={d.supermemory} rag={d.rag} chunked={d.chunked} />
              {d.source === 'notion' && d.sourceUrl && (
                <a href={d.sourceUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-emerald-600 hover:underline">
                  Open in Notion <ExternalLink size={13} />
                </a>
              )}
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
            {d.summary && (
              <p className="mt-4 text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
                {d.summary}
              </p>
            )}
          </div>

          {d.content && (
            <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
            </article>
          )}
        </>
      )}
      {!d && !err && <p className="text-zinc-400">Loading…</p>}
    </div>
  );
}
