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
  // The check ran, but we could not judge it (BEA-1247). Grey, because it is neither good news nor
  // bad news — it is missing news, and it must not look like a real verdict.
  ungraded: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};
export function Verdict({ v, s }: { v?: string; s?: number | null }) {
  if (!v) return <span className="shrink-0 text-xs text-zinc-400">not run</span>;
  if (v === 'ungraded') return <span className={'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' + VERDICT.ungraded}>couldn’t grade</span>;
  return <span className={'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' + (VERDICT[v] || VERDICT.partial)}>{v}{s != null ? ` · ${s}` : ''}</span>;
}
export function passPillFor(evals: any[]) {
  const passed = evals.filter((e: any) => e.lastVerdict === 'pass').length;
  // A check we could not grade is NOT scored — counting it would quietly change the pass rate.
  const scored = evals.filter((e: any) => e.lastVerdict && e.lastVerdict !== 'ungraded').length;
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

/**
 * A run's step log → what each node of the picture did last time (BEA-1366). A Social run's steps
 * carry `nodeId` (`social-flow.ts` ids); later steps for the same node override earlier ones, so a
 * "Shaping…" (running) line is replaced by "Shaped 12 rows" (done). Steps without a nodeId (log
 * lines, engine runs) mark nothing — the picture never guesses.
 */
export function nodeResultsFromRun(run: any): Record<string, { status?: string; note?: string }> {
  const out: Record<string, { status?: string; note?: string }> = {};
  const steps: any[] = Array.isArray(run?.stepLog) ? run.stepLog : [];
  for (const s of steps) {
    if (!s?.nodeId) continue;
    const st = s.status === 'failed' ? 'failed' : s.status === 'running' ? 'running' : s.status === 'info' ? 'skipped' : 'done';
    out[s.nodeId] = { status: st, note: String(s.label || '').slice(0, 160) };
  }
  // A run that ended while a node still says "running" did not finish that node.
  if (run && run.status !== 'running') for (const k of Object.keys(out)) if (out[k].status === 'running') out[k] = { ...out[k], status: run.status === 'failed' ? 'failed' : 'done' };
  return out;
}

export function FlowPanel({ id, flow, onChanged, goChat, lastRun }: { id: string; flow: any; onChanged: () => void; goChat: () => void; lastRun?: any }) {
  const toast = useToast();
  const [gen, setGen] = useState(false);
  const [showCanvas, setShowCanvas] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [process, setProcess] = useState<any>(null);
  const social = flow?.drawnBy === 'social';
  const drawing = flow?.drawStatus === 'drawing';
  const failed = flow?.drawStatus === 'failed';
  const hasNodes = (flow?.graph?.nodes || []).length > 0;
  const runResults = social && lastRun ? nodeResultsFromRun(lastRun) : undefined;

  // Mobile leads with the readable steps; the canvas is a tap away (editing on a phone is fiddly).
  useEffect(() => { if (typeof window !== 'undefined') setShowCanvas(window.innerWidth >= 640); }, []);
  useEffect(() => {
    if (!flow?.id) return;
    fetch(`/api/flows/${flow.id}/prompt`).then((r) => r.json()).then((p) => { setPrompt(p.prompt || ''); setProcess(p.process || null); }).catch(() => undefined);
  }, [flow?.id, flow?.updatedAt]);
  // A picture being drawn in the background (a normal agent's planner) — keep looking until it lands (BEA-1366).
  useEffect(() => {
    if (!drawing) return;
    let ticks = 0;
    const t = setInterval(() => { ticks++; onChanged(); if (ticks > 60) clearInterval(t); }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [drawing, flow?.id]);

  // One road for "Draw the flow" and "Re-draw" (BEA-1366): the server decides — a Social agent is
  // rebuilt from its settings, any other agent is (re)planned in the background and we poll.
  async function generate() {
    setGen(true);
    try {
      const r = await fetch(`/api/flows/agents/${id}/draw`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not draw the flow');
      onChanged();
      if (!d.flow) toast('error', 'Nothing to draw from yet — give this job a task first');
      else if (d.flow.drawnBy === 'social') toast('success', 'Drawn from this job’s settings');
      else toast('success', 'Drawing the steps — they appear in a moment');
    } catch (e: any) { toast('error', e?.message || 'Could not draw the flow'); }
    setGen(false);
  }

  if (!flow) {
    // Only a legacy job that was never saved since this shipped lands here — one press draws it the same way a save does.
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
      {social ? (
        <div className="mb-2 rounded-xl border border-pink-200 bg-pink-50/60 px-3 py-2 text-xs text-pink-800 dark:border-pink-500/30 dark:bg-pink-500/10 dark:text-pink-200">
          ✦ This picture is <b>drawn from this job’s settings</b> — the sources, the task, where the result goes, WhatsApp, Watch/Alert. Change them in <b>Settings</b> and the picture follows. Nothing here can drift from what actually runs.
        </div>
      ) : (
        <div className="mb-2 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">
          ✦ This is the <b>picture</b> of what you told this job to do. Change it here — or just <button onClick={goChat} className="font-semibold underline decoration-violet-400 underline-offset-2 hover:text-violet-600 dark:hover:text-violet-100">💬 Chat</button> and it re-draws itself.
        </div>
      )}
      {/* The state of the last (re-)draw (BEA-1366): drawing… / could not re-draw (the last picture is kept). */}
      {drawing && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />{hasNodes ? 'Re-drawing the steps to match the new task…' : 'Drawing the steps from what this job is asked to do…'}
        </div>
      )}
      {failed && !drawing && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">{flow.drawNote || 'Could not re-draw the flow — the last picture is kept.'}</span>
          <button onClick={generate} disabled={gen} className="rounded-md border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:hover:bg-amber-500/20">Try again</button>
        </div>
      )}
      <div className="mb-2 flex items-center justify-between gap-2">
        {social ? (
          <span className="text-xs text-zinc-500">
            {lastRun ? <>Last run {when(lastRun.startedAt)} · <span className={lastRun.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : lastRun.status === 'done' ? 'text-emerald-600 dark:text-emerald-400' : ''}>{lastRun.status}</span> — each step shows what it did</> : 'Not run yet — after a run, each step shows what it did'}
          </span>
        ) : (
          <button onClick={generate} disabled={gen || drawing} className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10">
            {gen || drawing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Re-draw
          </button>
        )}
        <button onClick={() => setShowCanvas((v) => !v)} className="rounded-lg border border-zinc-300 px-2 py-1 text-xs hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700 sm:hidden">{showCanvas ? 'Show steps' : 'Open canvas'}</button>
      </div>
      {!hasNodes && drawing ? (
        <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Drawing…</div>
      ) : showCanvas ? (
        <div className="h-[68vh] overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading editor…</div>}>
            <FlowEditor key={flow.updatedAt || flow.id} flowId={flow.id} embedded readOnly={social} runResults={runResults} />
          </Suspense>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          {process ? <FlowProcess process={process} prompt={prompt} /> : <p className="text-sm text-zinc-500">No steps yet.</p>}
          <p className="mt-2 text-xs text-zinc-400">{social ? 'Tap “Open canvas” above to see the picture.' : 'Tap “Open canvas” above to edit the flow visually (best on a larger screen).'}</p>
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
            {r.grade?.verdict
              ? <Verdict v={r.grade.verdict} s={r.grade.score} />
              : r.status === 'done' && <span className="shrink-0 text-xs text-zinc-400">not graded</span>}
            {/* What the run really spent on search (BEA-1196) — shown so a report's cost is a fact
                on the run, not an estimate anyone has to take on trust. */}
            {/* Tokens this run was BUDGETED (BEA-1245). This is the run's own budget accounting —
                a flat charge per engine step plus size-based charges for thinking steps — NOT a
                provider-measured count. Saying "measured" here would be lying with a confident
                number; the real per-call counts live in Settings → Usage. */}
            {r.spend?.tokens > 0 && (
              <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" title="Budget estimate for this run (flat charge per engine step + size-based charges). Real per-call counts: Settings → Usage.">
                ≈{r.spend.tokens >= 1000 ? `${Math.round(r.spend.tokens / 1000)}k` : r.spend.tokens} tokens
              </span>
            )}
            {r.spend?.searches > 0 && (
              <span
                className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                title={[
                  `${r.spend.searches} searches + ${r.spend.extracts} page reads across ${r.spend.sources} sources`,
                  r.spend.meaningSearches > 0 ? `${r.spend.meaningSearches} on Exa (not billed as Tavily credits)` : '',
                  r.spend.paidCalls > 0 ? `⚠️ ${r.spend.paidCalls} thinking step(s) used the paid model — your engine was unavailable` : 'the writing ran free on your own engine',
                ].filter(Boolean).join(' · ')}
              >
                {Math.max(0, (r.spend.searches || 0) - (r.spend.meaningSearches || 0)) * 2} credits
                {r.spend.paidCalls > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">+ paid</span>}
              </span>
            )}
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
