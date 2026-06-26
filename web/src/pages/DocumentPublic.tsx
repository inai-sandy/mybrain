import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Logo } from '../ui/Logo';
import { mdComponents } from '../ui/markdown';
import { FullScreenHtml } from '../ui/FullScreenHtml';

type PublicDoc = { title: string; description: string | null; kind: string; contentText: string; updatedAt: string };

/** Public, no-login view of a shared document at /d/:slug. */
export function DocumentPublic() {
  const { slug } = useParams();
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/documents/public/${slug}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setDoc)
      .catch(() => setError('This document is private or no longer shared.'));
  }, [slug]);

  // An HTML doc gets the chrome-free, full-screen live page — exactly like a tiiny.host link. (BEA-582)
  if (doc && doc.kind === 'html') return <FullScreenHtml html={doc.contentText || ''} title={doc.title} />;

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 md:bg-white/80 md:dark:bg-zinc-950/80 md:backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-12 flex items-center gap-2 font-bold"><Logo size={28} /> My Brain</div>
      </header>
      <div className="max-w-3xl mx-auto px-5 py-8">
        {error && <p className="text-amber-500">{error}</p>}
        {doc && (
          <>
            <h1 className="text-2xl font-extrabold">{doc.title}</h1>
            {doc.kind === 'pdf' ? (
              <iframe title={doc.title} src={`/api/documents/public/${slug}/file`} className="mt-5 w-full min-h-[80vh] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white" />
            ) : doc.kind === 'image' ? (
              <img src={`/api/documents/public/${slug}/file`} alt={doc.title} className="mt-5 max-w-full rounded-xl border border-zinc-200 dark:border-zinc-800" />
            ) : (
              <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-5 mt-5">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{doc.contentText || ''}</ReactMarkdown>
              </article>
            )}
          </>
        )}
      </div>
    </div>
  );
}
