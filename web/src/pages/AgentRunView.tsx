import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, CheckCircle2, Circle, AlertCircle, Info, FileText, RotateCw } from 'lucide-react';
import { StatusBadge } from './Agents';

type Step = { label: string; status?: string; detail?: string; kind?: string; at?: string };
type Run = {
  id: string;
  title?: string;
  status: string;
  input?: string;
  stepLog?: Step[];
  outputDocId?: string | null;
  error?: string | null;
  startedAt: string;
  endedAt?: string | null;
};

function StepIcon({ status }: { status?: string }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  if (status === 'failed') return <AlertCircle className="h-4 w-4 text-red-500" />;
  if (status === 'info') return <Info className="h-4 w-4 text-zinc-400" />;
  return <Circle className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />;
}

export function AgentRunView() {
  const { id } = useParams();
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/agent/runs/${id}`);
        if (r.status === 404) { if (alive) { setNotFound(true); setLoading(false); } return; }
        const d: Run = await r.json();
        if (!alive) return;
        setRun(d);
        setLoading(false);
        if (d.status === 'running' || d.status === 'awaiting_input') timer.current = setTimeout(tick, 1500);
      } catch {
        if (alive) timer.current = setTimeout(tick, 3000);
      }
    };
    tick();
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [id]);

  const steps = run?.stepLog || [];
  const active = !!run && (run.status === 'running' || run.status === 'awaiting_input');

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <button onClick={() => nav(-1)} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      {loading ? (
        <div className="space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : notFound || !run ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">That run wasn’t found.</div>
      ) : (
        <div className="space-y-5">
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-bold">{run.title || 'Agent run'}</h1>
              {run.input && <p className="mt-0.5 line-clamp-2 text-sm text-zinc-500">{run.input}</p>}
            </div>
            <StatusBadge status={run.status} />
          </header>

          {/* Activity / plan */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            {steps.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Getting started…</div>
            ) : (
              <ol className="space-y-2.5">
                {steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-0.5 shrink-0"><StepIcon status={s.status} /></span>
                    <div className="min-w-0">
                      <div className="text-sm text-zinc-800 dark:text-zinc-200">{s.label}</div>
                      {s.detail && <div className="truncate text-xs text-zinc-500">{s.detail}</div>}
                    </div>
                  </li>
                ))}
                {active && (
                  <li className="flex items-center gap-2.5 text-sm text-zinc-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Working…
                  </li>
                )}
              </ol>
            )}
          </div>

          {/* Result */}
          {run.status === 'done' && run.outputDocId && (
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <FileText className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="flex-1 text-sm font-medium text-emerald-800 dark:text-emerald-200">Saved to Documents.</div>
              <button onClick={() => nav(`/documents/${run.outputDocId}`)} className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">Open</button>
            </div>
          )}
          {run.status === 'done' && !run.outputDocId && (
            <div className="rounded-2xl border border-zinc-200 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">The agent finished.</div>
          )}
          {run.status === 'failed' && (
            <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
              {run.error || 'The run failed.'}
            </div>
          )}

          {(run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') && (
            <button onClick={() => nav('/agent')} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
              <RotateCw className="h-4 w-4" />
              Run another
            </button>
          )}
        </div>
      )}
    </div>
  );
}
