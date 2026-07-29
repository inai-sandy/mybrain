import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Trash2, Loader2, Play, CheckCircle2, Sparkles, Check, X, Workflow, Clock, FileText, AlertCircle, Circle } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { FlowProcess } from '../ui/FlowProcess';

const FlowEditor = lazy(() => import('./FlowEditor').then((m) => ({ default: m.FlowEditor })));

/**
 * The Flow · Evals · Runs panels of a job (BEA-1169). They used to live in a SECOND page you
 * reached by scrolling to the bottom of the job and following a link; now they are tabs on the one
 * job page. Lifted out whole so the page file stays readable.
 */

const VERDICT: Record<string, string> = {
  pass: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  fail: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
export function Verdict({ v, s }: { v?: string; s?: number | null }) {
  if (!v) return <span className="shrink-0 text-xs text-zinc-400">not run</span>;
  return <span className={'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' + (VERDICT[v] || VERDICT.partial)}>{v}{s != null ? ` · ${s}` : ''}</span>;
}
export function passPillFor(evals: any[]) {
  const passed = evals.filter((e: any) => e.lastVerdict === 'pass').length;
  const scored = evals.filter((e: any) => e.lastVerdict).length;
  const cls = scored > 0 ? (passed === evals.length ? VERDICT.pass : passed === 0 ? VERDICT.fail : VERDICT.partial) : '';
  return { passed, scored, cls };
}
function when(s?: string) { if (!s) return ''; try { return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function RunIcon({ s }: { s?: string }) {
  if (s === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (s === 'failed') return <AlertCircle className="h-4 w-4 text-rose-500" />;
  if (s === 'waiting') return <Clock className="h-4 w-4 text-amber-500" />;
  if (s === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  return <Circle className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />;
}

// ---- Flow ---------------------------------------------------------------------------------------

export function FlowPanel({ id, flow, onChanged, goChat }: { id: string; flow: any; onChanged: () => void; goChat: () => void }) {
  const toast = useToast();
  const [gen, setGen] = useState(false);
  const [showCanvas, setShowCanvas] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [process, setProcess] = useState<any>(null);

  // Mobile leads with the readable steps; the canvas is a tap away (editing on a phone is fiddly).
  useEffect(() => { if (typeof window !== 'undefined') setShowCanvas(window.innerWidth >= 640); }, []);
  useEffect(() => {
    if (!flow?.id) return;
    fetch(`/api/flows/${flow.id}/prompt`).then((r) => r.json()).then((p) => { setPrompt(p.prompt || ''); setProcess(p.process || null); }).catch(() => undefined);
  }, [flow?.id, flow?.updatedAt]);

  async function generate() {
    setGen(true);
    try {
      let fl = flow;
      if (!fl) {
        const r = await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Flow', question: '', agentId: id }) });
        fl = await r.json().catch(() => ({}));
        if (!r.ok || !fl.id) throw new Error();
      }
      await fetch(`/api/flows/${fl.id}/plan`, { method: 'POST' }).catch(() => undefined);
      onChanged();
      toast('success', 'Flow drawn — have a look at the steps');
    } catch { toast('error', 'Could not draw the flow'); }
    setGen(false);
  }

  if (!flow) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
        <Workflow className="mx-auto h-8 w-8 text-zinc-300 dark:text-zinc-600" />
        <p className="mt-2 text-sm text-zinc-500">No picture of the steps yet. Draw one from what this job is asked to do.</p>
        <button onClick={generate} disabled={gen} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {gen ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Draw the flow
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">
        ✦ This is the <b>picture</b> of what you told this job to do. Change it here — or just <button onClick={goChat} className="font-semibold underline decoration-violet-400 underline-offset-2 hover:text-violet-600 dark:hover:text-violet-100">💬 Chat</button> and it re-draws itself.
      </div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button onClick={generate} disabled={gen} className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10">
          {gen ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Re-draw
        </button>
        <button onClick={() => setShowCanvas((v) => !v)} className="rounded-lg border border-zinc-300 px-2 py-1 text-xs hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700 sm:hidden">{showCanvas ? 'Show steps' : 'Open canvas'}</button>
      </div>
      {showCanvas ? (
        <div className="h-[68vh] overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading editor…</div>}>
            <FlowEditor key={flow.updatedAt || flow.id} flowId={flow.id} embedded />
          </Suspense>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          {process ? <FlowProcess process={process} prompt={prompt} /> : <p className="text-sm text-zinc-500">No steps yet.</p>}
          <p className="mt-2 text-xs text-zinc-400">Tap “Open canvas” above to edit the flow visually (best on a larger screen).</p>
        </div>
      )}
    </div>
  );
}

// ---- Evals --------------------------------------------------------------------------------------

export function EvalsPanel({ id, a, flow, patch, reload }: { id: string; a: any; flow: any; patch: (b: any) => Promise<any>; reload: () => Promise<any> }) {
  const toast = useToast();
  const [newInput, setNewInput] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [runningEvals, setRunningEvals] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const evals: any[] = a.evals || [];
  const { passed, scored, cls } = passPillFor(evals);

  async function addEval() {
    const input = newInput.trim();
    if (!input) return;
    await patch({ evals: [...evals, { id: 'ev_' + Math.random().toString(36).slice(2, 9), input }] });
    setNewInput('');
  }
  async function delEval(eid: string) { await patch({ evals: evals.filter((e: any) => e.id !== eid) }); }
  async function suggestEvals() {
    setSuggesting(true);
    try {
      const r = await fetch(`/api/agent/agents/${id}/suggest-evals`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      await reload();
      toast('success', `Added ${d.added || 0} suggested check${(d.added || 0) === 1 ? '' : 's'}`);
    } catch { toast('error', 'Could not suggest checks'); }
    setSuggesting(false);
  }
  async function runEvals() {
    const endpoint = flow ? `/api/flows/agents/${id}/run-evals` : `/api/agent/agents/${id}/run-evals`;
    const r = await fetch(endpoint, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) { toast('error', d.message || 'Could not start'); return; }
    const n = d.started ?? evals.length;
    toast('success', `Running ${n} check${n !== 1 ? 's' : ''}${flow ? ' through the flow' : ''} — results appear as they finish.`);
    setRunningEvals(true);
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks++;
      const d2 = await reload();
      const evs = d2?.evals || [];
      const anyRunning = evs.some((e: any) => e.running);
      const allScored = evs.length > 0 && evs.every((e: any) => e.lastVerdict);
      if ((!anyRunning && allScored) || ticks > evs.length * 60 + 20) { if (pollRef.current) clearInterval(pollRef.current); setRunningEvals(false); }
    }, 5000);
  }

  return (
    <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Checks <span className="text-xs font-normal text-zinc-400">· what a good result must have</span></h2>
        {scored > 0 && <span className={'rounded-full px-2 py-0.5 text-xs font-bold ' + cls}>{passed}/{evals.length} passed</span>}
      </div>
      {evals.length === 0 ? (
        <p className="text-sm text-zinc-500">No checks yet. Add example inputs this job should handle well (or ✨ suggest some), then run them — each is graded against your Outcome, so you notice when a change makes things worse.</p>
      ) : (
        <ul className="space-y-1.5">
          {evals.map((e: any) => {
            const hasDetail = (e.lastCriteria && e.lastCriteria.length) || e.lastNotes;
            return (
              <li key={e.id} className="rounded-lg border border-zinc-100 dark:border-zinc-800">
                <div className="flex items-center gap-2 p-2">
                  <div className="min-w-0 flex-1 text-sm text-zinc-800 dark:text-zinc-200">{e.input}</div>
                  {e.running ? <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-blue-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />running…</span> : <Verdict v={e.lastVerdict} s={e.lastScore} />}
                  {e.lastRunId && <Link to={`/${e.lastRunKind === 'flow' ? 'flows/runs' : 'agent/runs'}/${e.lastRunId}`} className="shrink-0 text-xs text-zinc-400 hover:text-emerald-600">view</Link>}
                  <button onClick={() => delEval(e.id)} title="Remove" className="shrink-0 text-zinc-400 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                </div>
                {hasDetail && (
                  <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                    {e.lastNotes && <p className="mb-1 text-xs italic text-zinc-500">{e.lastNotes}</p>}
                    <ul className="space-y-0.5">
                      {(e.lastCriteria || []).map((c: any, i: number) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs">{c.met ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />}<span className="text-zinc-600 dark:text-zinc-300">{c.text}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-2">
        <input value={newInput} onChange={(e) => setNewInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addEval()} placeholder="Add a test input…" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 sm:text-sm" />
        <button onClick={addEval} title="Add this check" className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700"><Plus className="h-4 w-4" /></button>
        <button onClick={suggestEvals} disabled={suggesting} title="Suggest checks from the task + Outcome" className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-300 px-3 text-sm hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-zinc-700">{suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}</button>
      </div>
      <button onClick={runEvals} disabled={runningEvals || !evals.length || !a.rubric} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
        {runningEvals ? <><Loader2 className="h-4 w-4 animate-spin" />Running checks…</> : <><Play className="h-4 w-4" />Run the checks</>}
      </button>
      {!a.rubric && <p className="text-xs text-amber-600">Set an Outcome in Settings so the checks can be graded.</p>}
    </section>
  );
}

// ---- Runs ---------------------------------------------------------------------------------------

export function RunsPanel({ id, flow }: { id: string; flow: any }) {
  const toast = useToast();
  const nav = useNavigate();
  const [runs, setRuns] = useState<any[] | null>(null);

  async function loadRuns() {
    const out: any[] = [];
    try { const ar = await fetch(`/api/agent/runs?agentId=${id}`).then((r) => r.json()); (Array.isArray(ar) ? ar : ar.runs || []).forEach((r: any) => out.push({ ...r, _kind: 'agent' })); } catch { /* */ }
    if (flow) { try { const fr = await fetch(`/api/flows/${flow.id}/runs`).then((r) => r.json()); (fr.runs || []).forEach((r: any) => out.push({ ...r, _kind: 'flow' })); } catch { /* */ } }
    out.sort((x, y) => new Date(y.startedAt || 0).getTime() - new Date(x.startedAt || 0).getTime());
    setRuns(out);
  }
  useEffect(() => { loadRuns(); /* eslint-disable-next-line */ }, [id, flow?.id]);

  async function deleteRun(r: any) {
    const url = r._kind === 'flow' ? `/api/flows/runs/${r.id}` : `/api/agent/runs/${r.id}`;
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).message || 'Could not delete');
      setRuns((p) => (p || []).filter((x) => !(x._kind === r._kind && x.id === r.id)));
      toast('success', 'Run deleted');
    } catch (e: any) { toast('error', e.message || 'Could not delete'); }
  }
  async function clearRuns() {
    try {
      await fetch(`/api/agent/runs?agentId=${id}`, { method: 'DELETE' });
      if (flow) await fetch(`/api/flows/${flow.id}/runs`, { method: 'DELETE' });
      toast('success', 'Runs cleared');
      loadRuns();
    } catch { toast('error', 'Could not clear runs'); }
  }

  return (
    <div className="space-y-2">
      {runs && runs.length > 0 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-zinc-400">{runs.length} run{runs.length === 1 ? '' : 's'}</span>
          <button onClick={() => { if (window.confirm('Clear every run for this job? Saved documents are kept.')) clearRuns(); }} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash2 className="h-3.5 w-3.5" />Clear all</button>
        </div>
      )}
      {runs === null ? <div className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" /> : runs.length === 0 ? (
        <p className="rounded-2xl border border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">Nothing has run yet. Press Run on the Flow tab.</p>
      ) : runs.map((r) => (
        <div key={r._kind + r.id} className="group flex items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
          <button onClick={() => nav(`/${r._kind === 'flow' ? 'flows/runs' : 'agent/runs'}/${r.id}`)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <RunIcon s={r.status} />
            <span className="font-medium">{r.status === 'running' ? 'Running…' : r.status}</span>
            <span className="truncate text-xs text-zinc-400">{when(r.startedAt)}</span>
            {r.grade?.verdict && <Verdict v={r.grade.verdict} s={r.grade.score} />}
            {r.documents?.length > 0 && <span className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400"><FileText className="h-3.5 w-3.5" />{r.documents.length}</span>}
          </button>
          {r.status !== 'running' && r.status !== 'awaiting_input' && r.status !== 'waiting' && (
            <button onClick={() => { if (window.confirm('Delete this run? Saved documents are kept.')) deleteRun(r); }} title="Delete run" className="shrink-0 rounded-lg p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 group-hover:text-zinc-400 dark:text-zinc-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      ))}
    </div>
  );
}
