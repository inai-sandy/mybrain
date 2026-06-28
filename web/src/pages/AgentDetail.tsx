import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Save, Plus, Trash2, Loader2, Play, CheckCircle2, History } from 'lucide-react';
import { useToast } from '../ui/Toast';

const VERDICT: Record<string, string> = {
  pass: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  fail: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
function Verdict({ v, s }: { v?: string; s?: number | null }) {
  if (!v) return <span className="shrink-0 text-xs text-zinc-400">not run</span>;
  return <span className={'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' + (VERDICT[v] || VERDICT.partial)}>{v}{s != null ? ` · ${s}` : ''}</span>;
}

export function AgentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [a, setA] = useState<any>(null);
  const [task, setTask] = useState('');
  const [rubric, setRubric] = useState('');
  const [savingCfg, setSavingCfg] = useState(false);
  const [newInput, setNewInput] = useState('');
  const [runningEvals, setRunningEvals] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function load() {
    return fetch(`/api/agent/agents/${id}`).then((r) => r.json()).then((d) => { setA(d); setTask(d.prompt || ''); setRubric(d.rubric || ''); return d; }).catch(() => { setA(null); return null; });
  }
  useEffect(() => { load(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; /* eslint-disable-next-line */ }, [id]);

  async function patch(body: any) {
    const r = await fetch(`/api/agent/agents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { const d = await r.json(); setA(d); return d; }
    toast('error', 'Could not save');
  }
  async function saveCfg() { setSavingCfg(true); await patch({ prompt: task, rubric }); setSavingCfg(false); toast('success', 'Saved'); }
  async function addEval() {
    const input = newInput.trim(); if (!input) return;
    await patch({ evals: [...(a.evals || []), { id: 'ev_' + Math.random().toString(36).slice(2, 9), input }] });
    setNewInput('');
  }
  async function delEval(eid: string) { await patch({ evals: (a.evals || []).filter((e: any) => e.id !== eid) }); }
  async function runEvals() {
    const r = await fetch(`/api/agent/agents/${id}/run-evals`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast('error', d.message || 'Could not start'); return; }
    toast('success', `Running ${d.started} eval${d.started !== 1 ? 's' : ''} — verdicts will appear as they finish.`);
    setRunningEvals(true);
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks++;
      const d2 = await load();
      const evs = d2?.evals || [];
      const done = evs.filter((e: any) => e.lastRunAt && Date.now() - Date.parse(e.lastRunAt) < 6 * 60000).length;
      if ((evs.length && done >= evs.length) || ticks > evs.length * 30 + 12) { if (pollRef.current) clearInterval(pollRef.current); setRunningEvals(false); }
    }, 5000);
  }

  if (!a) return <div className="mx-auto max-w-2xl px-4 py-6"><div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" /></div>;
  const evals = a.evals || [];
  const passed = evals.filter((e: any) => e.lastVerdict === 'pass').length;
  const scored = evals.filter((e: any) => e.lastVerdict).length;
  const inp = 'w-full resize-none rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';

  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-6">
      <button onClick={() => nav('/agent')} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" /> Agents</button>
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold">{a.icon ? a.icon + ' ' : ''}{a.name}</h1>
        <Link to="/agent/history" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><History className="h-4 w-4" />Runs</Link>
      </header>

      <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="block text-xs font-medium text-zinc-500">Task — what it does each run<textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} className={inp + ' mt-1'} /></label>
        <label className="block text-xs font-medium text-zinc-500">Outcome — what does a good result look like? (each run is graded against this)<textarea value={rubric} onChange={(e) => setRubric(e.target.value)} rows={3} placeholder="e.g. Has 3 bullets. Each is one short sentence. Mentions a source." className={inp + ' mt-1'} /></label>
        <button onClick={saveCfg} disabled={savingCfg} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900">{savingCfg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save</button>
      </section>

      <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Eval cases <span className="text-xs font-normal text-zinc-400">· regression check</span></h2>
          {scored > 0 && <span className={'rounded-full px-2 py-0.5 text-xs font-bold ' + (passed === evals.length ? VERDICT.pass : passed === 0 ? VERDICT.fail : VERDICT.partial)}>{passed}/{evals.length} passed</span>}
        </div>
        {evals.length === 0 ? (
          <p className="text-sm text-zinc-500">No eval cases yet. Add a few example inputs this agent should handle well, then run them — each is graded against your Outcome so you can catch regressions when you tweak the task.</p>
        ) : (
          <ul className="space-y-1.5">
            {evals.map((e: any) => (
              <li key={e.id} className="flex items-center gap-2 rounded-lg border border-zinc-100 p-2 dark:border-zinc-800">
                <div className="min-w-0 flex-1 text-sm text-zinc-800 dark:text-zinc-200">{e.input}</div>
                <Verdict v={e.lastVerdict} s={e.lastScore} />
                {e.lastRunId && <Link to={`/agent/runs/${e.lastRunId}`} className="shrink-0 text-xs text-zinc-400 hover:text-emerald-600">view</Link>}
                <button onClick={() => delEval(e.id)} title="Remove" className="shrink-0 text-zinc-400 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input value={newInput} onChange={(e) => setNewInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addEval()} placeholder="Add a test input…" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
          <button onClick={addEval} className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700"><Plus className="h-4 w-4" /></button>
        </div>
        <button onClick={runEvals} disabled={runningEvals || !evals.length || !rubric} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">{runningEvals ? <><Loader2 className="h-4 w-4 animate-spin" />Running evals…</> : <><Play className="h-4 w-4" />Run evals</>}</button>
        {!rubric && <p className="text-xs text-amber-600">Set an Outcome above so the evals can be graded.</p>}
      </section>
    </div>
  );
}
