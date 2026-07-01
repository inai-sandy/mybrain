import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, AlertCircle, Loader2, FileText, ChevronRight } from 'lucide-react';

function when(s?: string) {
  if (!s) return '';
  try { return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/** History of a flow's runs + the documents each produced (Agent↔Flow merge ④). */
export function FlowRunsList() {
  const { id } = useParams();
  const nav = useNavigate();
  const [runs, setRuns] = useState<any[] | null>(null);

  useEffect(() => {
    fetch(`/api/flows/${id}/runs`).then((r) => r.json()).then((d) => setRuns(d.runs || [])).catch(() => setRuns([]));
  }, [id]);

  if (!runs) return <div className="mx-auto max-w-2xl"><div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" /></div>;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={() => nav(`/flows/${id}`)} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Editor</button>
      <h1 className="text-lg font-bold">Run history</h1>

      {runs.length === 0 ? (
        <p className="rounded-2xl border border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">No runs yet. Open the editor and press Run.</p>
      ) : (
        <ul className="space-y-3">
          {runs.map((r) => (
            <li key={r.id} className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <Link to={`/flows/runs/${r.id}`} className="flex items-center gap-2">
                {r.status === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : r.status === 'failed' ? <AlertCircle className="h-4 w-4 text-rose-500" /> : <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
                <span className="text-sm font-medium">{r.status === 'running' ? 'Running…' : r.status}</span>
                <span className="text-xs text-zinc-400">{when(r.startedAt)}</span>
                <ChevronRight className="ml-auto h-4 w-4 text-zinc-300" />
              </Link>
              {r.finalOutput && <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{r.finalOutput}</p>}
              {r.documents?.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  {r.documents.map((d: any) => (
                    <li key={d.id}><Link to={`/documents/${d.id}`} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50 hover:text-emerald-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-emerald-400"><FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" /><span className="truncate">{d.title}</span></Link></li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
