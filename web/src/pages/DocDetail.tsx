import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ExternalLink, Share2 } from 'lucide-react';
import { StoreBadges } from '../ui/StoreBadges';
import { ShareDialog } from '../ui/ShareDialog';
import { extractHeadings, stripLeadingUrl, mdComponents, OutlineLayout, MediaEmbed } from '../ui/markdown';

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

  return (
    <div className="space-y-5">
      <Link to={d?.source === 'raindrop' ? '/bookmarks' : '/capture'} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to {d?.source === 'raindrop' ? 'bookmarks' : 'documents'}
      </Link>

      {err && <p className="text-amber-500">{err}</p>}

      {d && (
        <OutlineLayout headings={headings}>
          <div className="space-y-5">
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

            <MediaEmbed sourceUrl={d.sourceUrl} source={d.source} thumbnail={d.thumbnail} title={d.title} />

            {body && (
              <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-5">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{body}</ReactMarkdown>
              </article>
            )}
          </div>
        </OutlineLayout>
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
