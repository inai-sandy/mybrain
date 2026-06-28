import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, CheckCircle2, Circle, AlertCircle, Info, FileText, RotateCw, Sparkles, Terminal, ChevronDown } from 'lucide-react';
import { StatusBadge } from './Agents';

/** Seconds → m:ss for the live elapsed timer. */
function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

type Step = { label: string; status?: string; detail?: string; kind?: string; at?: string };
type Waitpoint = { id: string; question: string; kind: string; options: any; status: string; defaultValue?: string | null };
type Run = {
  id: string;
  title?: string;
  status: string;
  input?: string;
  stepLog?: Step[];
  waitpoints?: Waitpoint[];
  learnings?: { text: string; status: string }[];
  outputDocId?: string | null;
  resultText?: string | null;
  grade?: Grade | null;
  error?: string | null;
  startedAt: string;
  endedAt?: string | null;
};
type Grade = { verdict: 'pass' | 'partial' | 'fail'; score: number; criteria?: { text: string; met: boolean }[]; notes?: string };

const GRADE_STYLES: Record<string, { card: string; txt: string }> = {
  pass: { card: 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10', txt: 'text-emerald-700 dark:text-emerald-300' },
  partial: { card: 'border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10', txt: 'text-amber-700 dark:text-amber-300' },
  fail: { card: 'border-rose-300 bg-rose-50 dark:border-rose-500/30 dark:bg-rose-500/10', txt: 'text-rose-700 dark:text-rose-300' },
};
function GradeCard({ grade }: { grade: Grade }) {
  const s = GRADE_STYLES[grade.verdict] || GRADE_STYLES.partial;
  const txt = s.txt;
  return (
    <div className={'rounded-2xl border p-4 ' + s.card}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className={'flex items-center gap-2 text-sm font-semibold ' + txt}>
          <CheckCircle2 className="h-4 w-4" /> Outcome: {grade.verdict}
        </div>
        <span className={'rounded-full bg-white/70 px-2 py-0.5 text-xs font-bold dark:bg-black/20 ' + txt}>{grade.score}/100</span>
      </div>
      {!!grade.criteria?.length && (
        <ul className="space-y-1">
          {grade.criteria.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-200">
              {c.met ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />}
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      )}
      {grade.notes && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{grade.notes}</p>}
    </div>
  );
}

function StepIcon({ status }: { status?: string }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  if (status === 'failed') return <AlertCircle className="h-4 w-4 text-red-500" />;
  if (status === 'info') return <Info className="h-4 w-4 text-zinc-400" />;
  return <Circle className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />;
}

function FreeTextAnswer({ onSubmit, disabled }: { onSubmit: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()); }} className="flex w-full gap-2">
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Type your answer…" className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm outline-none dark:border-amber-500/30 dark:bg-zinc-800" />
      <button type="submit" disabled={disabled || !v.trim()} className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">Send</button>
    </form>
  );
}

export function AgentRunView() {
  const { id } = useParams();
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reRun = async () => {
    if (!run?.input || rerunning) return;
    setRerunning(true);
    try {
      const r = await fetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: run.input, title: run.title || undefined }) });
      const d = await r.json();
      if (d?.id) nav('/agent/runs/' + d.id);
    } finally {
      setRerunning(false);
    }
  };

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

  const [submitting, setSubmitting] = useState(false);
  const [keepSel, setKeepSel] = useState<Record<number, boolean>>({});
  const [savingLearn, setSavingLearn] = useState(false);
  const steps = run?.stepLog || [];
  const timeline = steps.filter((s) => s.kind !== 'log'); // curated steps; raw log lines live in the Terminal
  const proposed = (run?.learnings || []).filter((l) => l.status === 'proposed');

  // Live elapsed clock — ticks each second while the run is active so it never looks frozen.
  const [tickNow, setTickNow] = useState(Date.now());
  useEffect(() => {
    const isActive = run && (run.status === 'running' || run.status === 'awaiting_input');
    if (!isActive) return;
    const t = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run?.status]);
  const elapsedSec = run ? Math.max(0, Math.round(((run.endedAt ? new Date(run.endedAt).getTime() : tickNow) - new Date(run.startedAt).getTime()) / 1000)) : 0;

  // Auto-scroll the terminal to the newest line.
  const termRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [steps.length]);

  async function saveLearnings() {
    setSavingLearn(true);
    try {
      const items = proposed.map((l, i) => ({ text: l.text, keep: keepSel[i] !== false }));
      await fetch(`/api/agent/runs/${id}/learnings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
      const r = await fetch(`/api/agent/runs/${id}`);
      if (r.ok) setRun(await r.json());
    } catch { /* ignore */ } finally { setSavingLearn(false); }
  }
  const active = !!run && (run.status === 'running' || run.status === 'awaiting_input');
  const pending = run?.status === 'awaiting_input' ? (run?.waitpoints || []).find((w) => w.status === 'pending') : undefined;

  async function answer(wpId: string, value: string) {
    setSubmitting(true);
    try {
      await fetch(`/api/agent/waitpoints/${wpId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: value, via: 'web' }) });
      const r = await fetch(`/api/agent/runs/${id}`);
      if (r.ok) setRun(await r.json());
    } catch { /* the poll will catch up */ } finally { setSubmitting(false); }
  }

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
            {timeline.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Getting started…</div>
            ) : (
              <ol className="space-y-2.5">
                {timeline.map((s, i) => (
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
                    Working… {mmss(elapsedSec)}
                  </li>
                )}
              </ol>
            )}
          </div>

          {/* Terminal — the raw engine activity, expandable (auto-open while running) */}
          {steps.length > 0 && (
            <details className="group overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" open={active}>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
                <Terminal className="h-4 w-4 text-zinc-500" />
                <span className="font-medium">Terminal</span>
                {active ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Working · {mmss(elapsedSec)}</span>
                ) : (
                  <span className="text-xs text-zinc-400">Finished in {mmss(elapsedSec)}</span>
                )}
                <ChevronDown className="ml-auto h-4 w-4 text-zinc-400 transition-transform group-open:rotate-180" />
              </summary>
              <div ref={termRef} className="max-h-72 overflow-auto border-t border-zinc-100 bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-300 dark:border-zinc-800">
                {steps.map((s, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="shrink-0 text-zinc-600">{s.at ? new Date(s.at).toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--'}</span>
                    <span className={'shrink-0 ' + (s.status === 'failed' ? 'text-red-400' : s.status === 'running' ? 'text-amber-300' : 'text-emerald-400')}>{s.status === 'failed' ? '✗' : s.status === 'running' ? '·' : '✓'}</span>
                    <span className="min-w-0 break-words">{s.label}{s.detail ? `  — ${s.detail}` : ''}</span>
                  </div>
                ))}
                {active && <div className="mt-0.5 animate-pulse text-zinc-500">▌</div>}
              </div>
            </details>
          )}

          {/* Pending question — answer here or on Telegram */}
          {pending && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
              <div className="mb-3 whitespace-pre-wrap text-sm font-medium text-amber-900 dark:text-amber-100">{pending.question}</div>
              <div className="flex flex-wrap gap-2">
                {pending.kind === 'approve_edit_reject' ? (
                  <>
                    <button disabled={submitting} onClick={() => answer(pending.id, 'approve')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Approve</button>
                    <button disabled={submitting} onClick={() => answer(pending.id, 'reject')} className="rounded-lg bg-zinc-200 px-3 py-1.5 text-sm font-medium hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-700 dark:hover:bg-zinc-600">Reject</button>
                  </>
                ) : Array.isArray(pending.options) && pending.options.length ? (
                  pending.options.map((o: any, i: number) => (
                    <button key={i} disabled={submitting} onClick={() => answer(pending.id, typeof o === 'string' ? o : o?.value ?? o?.label ?? String(o))} className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-amber-300 hover:bg-amber-100 disabled:opacity-50 dark:bg-zinc-800 dark:ring-amber-500/30 dark:hover:bg-zinc-700">
                      {typeof o === 'string' ? o : o?.label ?? o?.value ?? String(o)}
                    </button>
                  ))
                ) : (
                  <FreeTextAnswer disabled={submitting} onSubmit={(v) => answer(pending.id, v)} />
                )}
              </div>
              <p className="mt-2 text-xs text-amber-700/70 dark:text-amber-300/60">You can also answer this on Telegram.</p>
            </div>
          )}

          {/* Result */}
          {run.status === 'done' && run.grade && <GradeCard grade={run.grade} />}
          {run.status === 'done' && run.resultText && (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Answer</div>
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{run.resultText}</div>
            </div>
          )}
          {run.status === 'done' && run.outputDocId && (
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <FileText className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="flex-1 text-sm font-medium text-emerald-800 dark:text-emerald-200">Saved to Documents.</div>
              <button onClick={() => nav(`/documents/${run.outputDocId}`)} className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">Open</button>
            </div>
          )}
          {run.status === 'done' && !run.outputDocId && !run.resultText && (
            <div className="rounded-2xl border border-zinc-200 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">The agent finished.</div>
          )}
          {run.status === 'failed' && (
            <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
              {run.error || 'The run failed.'}
            </div>
          )}

          {(run.status === 'failed' || run.status === 'cancelled') && run.input && (
            <button onClick={reRun} disabled={rerunning} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
              {rerunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              {rerunning ? 'Starting…' : 'Re-run this task'}
            </button>
          )}

          {/* What I learned — keep / forget (BEA-624) */}
          {proposed.length > 0 && (
            <div className="rounded-2xl border border-indigo-300 bg-indigo-50 p-4 dark:border-indigo-500/30 dark:bg-indigo-500/10">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-indigo-900 dark:text-indigo-100"><Sparkles className="h-4 w-4" />What I learned — keep what's useful</div>
              <ul className="space-y-1.5">
                {proposed.map((l, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <input type="checkbox" checked={keepSel[i] !== false} onChange={(e) => setKeepSel((s) => ({ ...s, [i]: e.target.checked }))} className="mt-1 accent-indigo-600" />
                    <span className="text-sm text-zinc-800 dark:text-zinc-200">{l.text}</span>
                  </li>
                ))}
              </ul>
              <button onClick={saveLearnings} disabled={savingLearn} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                {savingLearn && <Loader2 className="h-4 w-4 animate-spin" />}Save to memory
              </button>
            </div>
          )}
          {proposed.length === 0 && (run.learnings || []).some((l) => l.status === 'kept') && (
            <p className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400"><Sparkles className="h-3.5 w-3.5" />Saved what you kept to memory.</p>
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
