import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Logo } from '../ui/Logo';
import { mdComponents } from '../ui/markdown';

type Shared = { title: string; threadSubject: string | null; summary: string; createdAt: string };

/** Public, unauthenticated view of a shared Gmail request briefing. */
export function RequestViewer() {
  const { shareId } = useParams();
  const [doc, setDoc] = useState<Shared | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/google/gmail/requests/shared/${shareId}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setDoc)
      .catch(() => setError('This link is private or no longer shared.'));
  }, [shareId]);

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-12 flex items-center gap-2 font-bold">
          <Logo size={28} /> My Brain
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-5 py-8">
        {error && <p className="text-amber-500">{error}</p>}
        {doc && (
          <div className="space-y-5">
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1">Email briefing</div>
              <h1 className="text-2xl font-extrabold">{doc.title}</h1>
              {doc.threadSubject && <p className="mt-1 text-sm text-zinc-500">From the thread: “{doc.threadSubject}”</p>}
            </div>
            <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-5">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{doc.summary}</ReactMarkdown>
            </article>
          </div>
        )}
        {!doc && !error && <p className="text-zinc-400">Loading…</p>}
      </div>
    </div>
  );
}
