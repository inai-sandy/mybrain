import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { KeyRound, Clock } from 'lucide-react';
import { Logo } from '../ui/Logo';
import { mdComponents } from '../ui/markdown';
import { FullScreenHtml } from '../ui/FullScreenHtml';

type PublicDoc = { title: string; description: string | null; kind: string; contentText: string; siteEntry?: string | null; updatedAt: string };
type Gate = 'loading' | 'open' | 'locked' | 'expired' | 'error';

/** Public, no-login view of a shared document at /d/:slug. (locked/expiry: BEA-585) */
export function DocumentPublic() {
  const { slug } = useParams();
  const [gate, setGate] = useState<Gate>('loading');
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [title, setTitle] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [pwError, setPwError] = useState('');

  useEffect(() => {
    fetch(`/api/documents/public/${slug}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d) => {
        if (d?.expired) {
          setTitle(d.title || '');
          setGate('expired');
        } else if (d?.locked) {
          setTitle(d.title || '');
          setGate('locked');
        } else {
          setDoc(d);
          setGate('open');
        }
      })
      .catch(() => setGate('error'));
  }, [slug]);

  async function unlock() {
    setUnlocking(true);
    setPwError('');
    try {
      const r = await fetch(`/api/documents/public/${slug}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.ok) {
        setToken(d.token || null);
        setDoc({ title: d.title, description: d.description, kind: d.kind, contentText: d.contentText, updatedAt: d.updatedAt });
        setGate('open');
      } else if (d?.reason === 'gone') {
        setGate('expired');
      } else {
        setPwError('That password is not right.');
      }
    } catch {
      setPwError('Something went wrong — try again.');
    } finally {
      setUnlocking(false);
    }
  }

  // HTML + ZIP sites get the chrome-free, full-screen live page — exactly like a tiiny.host link. (BEA-582/587)
  if (gate === 'open' && doc && doc.kind === 'html') return <FullScreenHtml html={doc.contentText || ''} title={doc.title} />;
  if (gate === 'open' && doc && doc.kind === 'site') return <FullScreenHtml src={`/api/documents/public/${slug}/site/${encodeURI(doc.siteEntry || 'index.html')}`} title={doc.title} />;

  const fileSrc = `/api/documents/public/${slug}/file${token ? `?t=${encodeURIComponent(token)}` : ''}`;

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 md:bg-white/80 md:dark:bg-zinc-950/80 md:backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-12 flex items-center gap-2 font-bold"><Logo size={28} /> My Brain</div>
      </header>
      <div className="max-w-3xl mx-auto px-5 py-8">
        {gate === 'loading' && <p className="text-zinc-400">Loading…</p>}
        {gate === 'error' && <p className="text-amber-500">This document is private or no longer shared.</p>}

        {gate === 'expired' && (
          <div className="mt-10 text-center">
            <Clock size={32} className="mx-auto text-zinc-400" />
            <h1 className="mt-3 text-xl font-bold">{title || 'This link has expired'}</h1>
            <p className="mt-1 text-sm text-zinc-500">This share link has expired and is no longer available.</p>
          </div>
        )}

        {gate === 'locked' && (
          <div className="mx-auto mt-10 max-w-sm text-center">
            <KeyRound size={32} className="mx-auto text-emerald-600" />
            <h1 className="mt-3 text-xl font-bold">{title || 'Protected document'}</h1>
            <p className="mt-1 text-sm text-zinc-500">Enter the password to open it.</p>
            <div className="mt-4 flex gap-2">
              <input
                type="password"
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && pw && unlock()}
                placeholder="Password"
                className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              />
              <button onClick={unlock} disabled={unlocking || !pw} className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm disabled:opacity-50">{unlocking ? 'Opening…' : 'Open'}</button>
            </div>
            {pwError && <p className="mt-2 text-sm text-red-500">{pwError}</p>}
          </div>
        )}

        {gate === 'open' && doc && (
          <>
            <h1 className="text-2xl font-extrabold">{doc.title}</h1>
            {doc.kind === 'pdf' ? (
              <iframe title={doc.title} src={fileSrc} className="mt-5 w-full min-h-[80vh] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white" />
            ) : doc.kind === 'image' ? (
              <img src={fileSrc} alt={doc.title} className="mt-5 max-w-full rounded-xl border border-zinc-200 dark:border-zinc-800" />
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
