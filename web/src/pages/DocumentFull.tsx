import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FullScreenHtml } from '../ui/FullScreenHtml';

/** Owner's chrome-free, full-screen live view of an HTML document. (BEA-582) */
export function DocumentFull() {
  const { id } = useParams();
  const [html, setHtml] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/documents/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d) => {
        setTitle(d.title || '');
        setHtml(d.contentText || '');
      })
      .catch(() => setError('Document not found.'));
  }, [id]);

  if (error) return <div className="min-h-screen grid place-items-center text-amber-500">{error}</div>;
  if (html === null) return <div className="min-h-screen grid place-items-center text-zinc-400">Loading…</div>;
  return <FullScreenHtml html={html} title={title} backTo={`/documents/${id}`} />;
}
