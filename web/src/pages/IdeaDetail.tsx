import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Copy, Check, Circle } from 'lucide-react';
import { useToast } from '../ui/Toast';

export function IdeaDetail() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  function load() {
    fetch(`/api/ideas/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setErr('Could not load this idea.'));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(d.researchPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('error', 'Could not copy');
    }
  }

  async function toggleDone() {
    const next = d.status === 'done' ? 'open' : 'done';
    const r = await fetch(`/api/ideas/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
    if (r.ok) setD({ ...d, status: next });
  }

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <Link to="/ideas" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to ideas
      </Link>

      {err && <p className="text-amber-500">{err}</p>}

      {d && (
        <>
          <div className="flex items-start justify-between gap-3">
            <h1 className={'text-2xl font-extrabold ' + (d.status === 'done' ? 'line-through text-zinc-400' : '')}>{d.title}</h1>
            <button
              onClick={toggleDone}
              className={'shrink-0 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ' + (d.status === 'done' ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 hover:text-emerald-600')}
            >
              {d.status === 'done' ? (
                <>
                  <Check size={15} /> Done
                </>
              ) : (
                <>
                  <Circle size={15} /> Mark as done
                </>
              )}
            </button>
          </div>

          {d.content && (
            <article className="prose prose-zinc dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
            </article>
          )}

          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-sm">Deep-research prompt</h2>
              <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs">
                {copied ? (
                  <>
                    <Check size={13} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={13} /> Copy
                  </>
                )}
              </button>
            </div>
            <p className="text-xs text-zinc-400 mb-2">Paste this into Claude Code or Claude chat to run your /deep-research skill.</p>
            <pre className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300 font-mono max-h-72 overflow-auto bg-white dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">{d.researchPrompt}</pre>
          </div>
        </>
      )}
      {!d && !err && <p className="text-zinc-400">Loading…</p>}
    </div>
  );
}
