import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Telescope, X, Loader2, FileText } from 'lucide-react';
import { useToast } from './Toast';

/**
 * "Research this" — the same popup, wherever you press it. (BEA-1047 / BEA-1110, shared in BEA-1258)
 *
 * It started life welded inside Bookmarks. AI News Daily needs the identical thing on a news story,
 * and the owner asked for exactly that: "the same pop-up which opens when I click on the research
 * button on bookmarks has to open and follow the same steps."
 *
 * The steps, unchanged:
 *   1. You describe what you want researched, in your own words.
 *   2. A JOB is created inside Research Agent — created, NOT started. You press Run.
 *   3. The report is saved as a Document.
 *   4. Past research on this same thing shows here, so it is never lost.
 *
 * The caller supplies `endpointBase`; this component only knows `GET`/`POST {base}/research`.
 */

export type PastRun = {
  id: string;
  title: string | null;
  status: string;
  startedAt: string;
  outputDocId: string | null;
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === new Date().toDateString()) return 'today';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 1) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function ResearchModal({
  title,
  endpointBase,
  pastLabel = 'Past research on this',
  onClose,
}: {
  /** What is being researched — shown under the heading so you know what you pressed. */
  title: string;
  /** e.g. `/api/bookmarks/abc` or `/api/news/stories/abc`. `/research` is appended. */
  endpointBase: string;
  pastLabel?: string;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<PastRun[] | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    fetch(`${endpointBase}/research`)
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => alive && setPast(d.runs || []))
      .catch(() => alive && setPast([]));
    return () => {
      alive = false;
    };
  }, [endpointBase]);

  async function start() {
    if (!question.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${endpointBase}/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || (!d.jobId && !d.runId)) {
        toast('error', d.message || 'Could not create the research job');
        return;
      }
      if (d.jobId) {
        toast('success', 'Research job created in Research Agent — press Run when ready');
        navigate(d.url || `/agent/a/${d.jobId}`);
      } else {
        toast('success', 'Research started — watch it live');
        navigate(`/agent/runs/${d.runId}`);
      }
    } catch {
      toast('error', 'Could not start the research');
    } finally {
      setBusy(false);
    }
  }

  const statusDot = (s: string) =>
    s === 'done' ? 'bg-emerald-500' : s === 'failed' || s === 'cancelled' ? 'bg-rose-500' : 'bg-amber-400 animate-pulse';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-bold"><Telescope size={17} className="text-indigo-500" /> Research this</h3>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-50"><X size={18} /></button>
        </div>
        <p className="mb-3 line-clamp-2 text-xs text-zinc-500">{title}</p>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          autoFocus
          placeholder="What do you want to research? Describe it in your own words…"
          className="w-full resize-none rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button onClick={start} disabled={!question.trim() || busy} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? (<><Loader2 size={15} className="animate-spin" /> Creating the job…</>) : 'Create research job'}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-zinc-400">A real agent digs in — watch it live, the report is saved as a Document.</p>

        {past && past.length > 0 && (
          <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{pastLabel}</p>
            <ul className="max-h-40 space-y-1.5 overflow-y-auto">
              {past.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-xs">
                  <span className={'h-2 w-2 shrink-0 rounded-full ' + statusDot(r.status)} />
                  <button onClick={() => navigate(`/agent/runs/${r.id}`)} className="min-w-0 flex-1 truncate text-left hover:text-indigo-500">{r.title || 'Research run'}</button>
                  <span className="shrink-0 text-zinc-400">{shortDate(r.startedAt)}</span>
                  {r.outputDocId && (
                    <button onClick={() => navigate(`/documents/${r.outputDocId}`)} title="Open the report" className="shrink-0 rounded p-1 text-zinc-400 hover:text-indigo-500"><FileText size={13} /></button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
