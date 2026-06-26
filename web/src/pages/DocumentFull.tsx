import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FullScreenHtml } from '../ui/FullScreenHtml';

/** Owner's chrome-free, full-screen live view of an HTML document. (BEA-582) */
export function DocumentFull() {
  const { id } = useParams();
  const [doc, setDoc] = useState<{ title: string; kind: string; contentText: string; siteEntry?: string | null } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/documents/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d) => setDoc({ title: d.title || '', kind: d.kind, contentText: d.contentText || '', siteEntry: d.siteEntry }))
      .catch(() => setError('Document not found.'));
  }, [id]);

  if (error) return <div className="min-h-screen grid place-items-center text-amber-500">{error}</div>;
  if (!doc) return <div className="min-h-screen grid place-items-center text-zinc-400">Loading…</div>;
  if (doc.kind === 'site') return <FullScreenHtml src={`/api/documents/${id}/site/${encodeURI(doc.siteEntry || 'index.html')}`} title={doc.title} backTo={`/documents/${id}`} />;
  return <FullScreenHtml html={doc.contentText} title={doc.title} backTo={`/documents/${id}`} />;
}
