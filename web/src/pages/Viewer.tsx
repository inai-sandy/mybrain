import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Doc = { title: string; source: string; sourceUrl?: string | null; content: string };

export function Viewer() {
  const { id } = useParams();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/items/${id}/content`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setDoc)
      .catch(() => setError('Could not load this document.'));
  }, [id]);

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="max-w-3xl mx-auto px-5 py-8">
        {error && <p className="text-amber-500">{error}</p>}
        {doc && (
          <>
            <div className="mb-6 border-b border-zinc-200 dark:border-zinc-800 pb-4">
              <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1">{doc.source}</div>
              <h1 className="text-2xl font-extrabold">{doc.title}</h1>
            </div>
            <article className="prose prose-zinc dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
            </article>
          </>
        )}
        {!doc && !error && <p className="text-zinc-400">Loading…</p>}
      </div>
    </div>
  );
}
