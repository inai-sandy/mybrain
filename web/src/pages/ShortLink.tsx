import { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';

/** Resolves a short share code (/s/:code) to its public document page. (BEA-584) */
export function ShortLink() {
  const { code } = useParams();
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`/api/documents/public/code/${code}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setSlug(d.slug))
      .catch(() => setError(true));
  }, [code]);

  if (error) return <div className="min-h-screen grid place-items-center text-amber-500">This short link is not active.</div>;
  if (!slug) return <div className="min-h-screen grid place-items-center text-zinc-400">Opening…</div>;
  return <Navigate to={`/d/${slug}`} replace />;
}
