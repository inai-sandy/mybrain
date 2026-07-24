import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useGoBack } from '../ui/useGoBack';
import { ArrowLeft, Save, Plus, Trash2, Loader2, Play, CheckCircle2, Sparkles, Check, X, Workflow, Clock, FileText, AlertCircle, Circle, MessageSquare, Send } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { FlowProcess } from '../ui/FlowProcess';
import { SchedulePicker, schedText } from '../ui/SchedulePicker';
import { DictateButton } from '../ui/DictateButton';

const FlowEditor = lazy(() => import('./FlowEditor').then((m) => ({ default: m.FlowEditor })));

const VERDICT: Record<string, string> = {
  pass: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  fail: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
function Verdict({ v, s }: { v?: string; s?: number | null }) {
  if (!v) return <span className="shrink-0 text-xs text-zinc-400">not run</span>;
  return <span className={'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' + (VERDICT[v] || VERDICT.partial)}>{v}{s != null ? ` · ${s}` : ''}</span>;
}
function when(s?: string) { if (!s) return ''; try { return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function RunIcon({ s }: { s?: string }) {
  if (s === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (s === 'failed') return <AlertCircle className="h-4 w-4 text-rose-500" />;
  if (s === 'waiting') return <Clock className="h-4 w-4 text-amber-500" />;
  if (s === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  return <Circle className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />;
}

type Tab = 'Build' | 'Flow' | 'Evals' | 'Runs';

export function AgentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const goBack = useGoBack('/agent');
  const toast = useToast();
  const [a, setA] = useState<any>(null);
  const [task, setTask] = useState('');
  const [rubric, setRubric] = useState('');
  const [savingCfg, setSavingCfg] = useState(false);
  const [newInput, setNewInput] = useState('');
  const [runningEvals, setRunningEvals] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [flow, setFlow] = useState<any>(null);
  const [genFlow, setGenFlow] = useState(false);
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [process, setProcess] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('Build');
  const [runs, setRuns] = useState<any[] | null>(null);
  const [showCanvas, setShowCanvas] = useState(true);
  const [allSkills, setAllSkills] = useState<any[] | null>(null); // installed skills for the attach chips (BEA-1079)
  useEffect(() => { fetch('/api/skills').then((r) => r.json()).then((d) => setAllSkills(d.skills || [])).catch(() => setAllSkills([])); }, []);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dirtyRef = useRef(false); // true once you edit Task/Outcome — the eval poll must not overwrite it (BEA-817)

  // Mobile leads with the readable steps; the canvas is a tap away (editing on a phone is fiddly).
  useEffect(() => { if (typeof window !== 'undefined') setShowCanvas(window.innerWidth >= 640); }, []);

  function load() {
    fetch(`/api/flows?agentId=${id}`).then((r) => r.json()).then((d) => {
      const fl = (d.flows || [])[0] || null;
      setFlow(fl);
      if (fl) fetch(`/api/flows/${fl.id}/prompt`).then((r) => r.json()).then((p) => { setPrompt(p.prompt || ''); setProcess(p.process || null); }).catch(() => undefined);
    }).catch(() => undefined);
    return fetch(`/api/agent/agents/${id}`).then((r) => r.json()).then((d) => { setA(d); if (!dirtyRef.current) { setTask(d.prompt || ''); setRubric(d.rubric || ''); } return d; }).catch(() => { setA(null); return null; });
  }
  useEffect(() => { load(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; /* eslint-disable-next-line */ }, [id]);

  async function loadRuns() {
    const out: any[] = [];
    try { const ar = await fetch(`/api/agent/runs?agentId=${id}`).then((r) => r.json()); (Array.isArray(ar) ? ar : ar.runs || []).forEach((r: any) => out.push({ ...r, _kind: 'agent' })); } catch { /* */ }
    if (flow) { try { const fr = await fetch(`/api/flows/${flow.id}/runs`).then((r) => r.json()); (fr.runs || []).forEach((r: any) => out.push({ ...r, _kind: 'flow' })); } catch { /* */ } }
    out.sort((x, y) => new Date(y.startedAt || 0).getTime() - new Date(x.startedAt || 0).getTime());
    setRuns(out);
  }
  useEffect(() => { if (tab === 'Runs') loadRuns(); /* eslint-disable-next-line */ }, [tab, flow]);

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

  async function genFlowNow() {
    setGenFlow(true);
    try {
      let fl = flow;
      if (!fl) {
        const r = await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${a.name || 'Agent'} flow`, question: task || a.prompt || '', agentId: id }) });
        fl = await r.json().catch(() => ({}));
        if (!r.ok || !fl.id) throw new Error();
      }
      await fetch(`/api/flows/${fl.id}/plan`, { method: 'POST' }).catch(() => undefined);
      await load();
      setTab('Flow');
      toast('success', 'Flow generated — check the steps in How it runs');
    } catch { toast('error', 'Could not generate flow'); }
    setGenFlow(false);
  }
  async function runFlow() {
    if (!flow) { genFlowNow(); return; }
    setRunning(true);
    try { const r = await fetch(`/api/flows/${flow.id}/run`, { method: 'POST' }); const d = await r.json().catch(() => ({})); if (d.runId) nav(`/flows/runs/${d.runId}`); else throw new Error(); }
    catch { toast('error', 'Could not run'); } finally { setRunning(false); }
  }

  // ---- Change it by chatting (BEA-1065): message → proposed diff → apply on confirm ----
  const [chatMsg, setChatMsg] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLog, setChatLog] = useState<{ who: 'you' | 'ai'; text: string }[]>([]);
  const [proposal, setProposal] = useState<any>(null); // {patch, changes, note}

  async function sendChat() {
    const msg = chatMsg.trim();
    if (!msg || chatBusy) return;
    setChatBusy(true);
    setProposal(null);
    setChatLog((p) => [...p, { who: 'you', text: msg }]);
    setChatMsg('');
    try {
      const r = await fetch(`/api/agent/agents/${id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not do that');
      setChatLog((p) => [...p, { who: 'ai', text: d.note || 'Done.' }]);
      if (d.patch && Object.keys(d.patch).length) setProposal(d);
    } catch (e: any) {
      setChatLog((p) => [...p, { who: 'ai', text: e.message || 'Something went wrong — try again.' }]);
    }
    setChatBusy(false);
  }

  async function applyProposal() {
    if (!proposal || chatBusy) return;
    setChatBusy(true);
    try {
      const d = await patch(proposal.patch);
      if (!d) throw new Error();
      dirtyRef.current = false;
      setTask(d.prompt || '');
      setRubric(d.rubric || '');
      // agent is boss: when the words changed, re-draw the flow from them
      if (flow && proposal.patch.prompt) {
        await fetch(`/api/flows/${flow.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: d.prompt || '' }) }).catch(() => undefined);
        await fetch(`/api/flows/${flow.id}/plan`, { method: 'POST' }).catch(() => undefined);
        await load();
        toast('success', 'Changed — and the flow was re-drawn to match');
      } else {
        await load();
        toast('success', 'Changed');
      }
      setChatLog((p) => [...p, { who: 'ai', text: 'Applied ✓' }]);
      setProposal(null);
    } catch { toast('error', 'Could not apply the change'); }
    setChatBusy(false);
  }

  async function patch(body: any) {
    const r = await fetch(`/api/agent/agents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { const d = await r.json(); setA(d); return d; }
    toast('error', 'Could not save');
  }
  async function saveCfg() { setSavingCfg(true); await patch({ prompt: task, rubric }); dirtyRef.current = false; setSavingCfg(false); toast('success', 'Saved'); }
  async function addEval() { const input = newInput.trim(); if (!input) return; await patch({ evals: [...(a.evals || []), { id: 'ev_' + Math.random().toString(36).slice(2, 9), input }] }); setNewInput(''); }
  async function delEval(eid: string) { await patch({ evals: (a.evals || []).filter((e: any) => e.id !== eid) }); }
  async function suggestEvals() {
    setSuggesting(true);
    try { const r = await fetch(`/api/agent/agents/${id}/suggest-evals`, { method: 'POST' }); const d = await r.json().catch(() => ({})); await load(); toast('success', `Added ${d.added || 0} suggested case${(d.added || 0) === 1 ? '' : 's'}`); }
    catch { toast('error', 'Could not suggest cases'); }
    setSuggesting(false);
  }
  async function runEvals() {
    const endpoint = flow ? `/api/flows/agents/${id}/run-evals` : `/api/agent/agents/${id}/run-evals`;
    const r = await fetch(endpoint, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) { toast('error', d.message || 'Could not start'); return; }
    const n = d.started ?? (a?.evals?.length || 0);
    toast('success', `Running ${n} eval${n !== 1 ? 's' : ''}${flow ? ' through the flow' : ''} — verdicts will appear as they finish.`);
    setRunningEvals(true);
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks++;
      const d2 = await load();
      const evs = d2?.evals || [];
      const anyRunning = evs.some((e: any) => e.running);
      const allScored = evs.length > 0 && evs.every((e: any) => e.lastVerdict);
      if ((!anyRunning && allScored) || ticks > evs.length * 60 + 20) { if (pollRef.current) clearInterval(pollRef.current); setRunningEvals(false); }
    }, 5000);
  }

  if (!a) return <div><div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" /></div>;
  const evals = a.evals || [];
  const passed = evals.filter((e: any) => e.lastVerdict === 'pass').length;
  const scored = evals.filter((e: any) => e.lastVerdict).length;
  const inp = 'w-full resize-none rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';
  const passPill = scored > 0 ? (passed === evals.length ? VERDICT.pass : passed === 0 ? VERDICT.fail : VERDICT.partial) : '';

  return (
    <div>
      <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" /> Back</button>

      {/* Header: identity + status pills + Run */}
      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold">{a.icon ? a.icon + ' ' : ''}{a.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {flow ? <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"><Workflow className="h-3 w-3" />Flow</span> : <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">No flow yet</span>}
            {flow?.schedule && <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><Clock className="h-3 w-3" />Scheduled</span>}
            {scored > 0 && <span className={'rounded-full px-2 py-0.5 text-xs font-bold ' + passPill}>{passed}/{evals.length} pass</span>}
          </div>
        </div>
        <button onClick={runFlow} disabled={running} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run</button>
      </header>

      {/* Tabs */}
      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
        {(['Build', 'Flow', 'Evals', 'Runs'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={'shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors ' + (tab === t ? 'border-emerald-500 text-zinc-900 dark:text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>{t}</button>
        ))}
      </nav>

      <div className="mt-4">
        {/* ---- BUILD ---- */}
        {tab === 'Build' && (
          <div className="space-y-4">
            {/* Change it by chatting (BEA-1065) — the diff is shown and applied only on confirm */}
            <section className="space-y-3 rounded-2xl border border-violet-200 bg-white p-4 dark:border-violet-500/30 dark:bg-zinc-900">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4 text-violet-500" />Change it by chatting</h2>
              {chatLog.length === 0 && <p className="text-xs text-zinc-400">Say the change in your own words — “add a step that messages Mom”, “run it every morning at 7”, “stop asking me before saving”. You'll see what would change before it sticks.</p>}
              {chatLog.length > 0 && (
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {chatLog.map((m, i) => (
                    <div key={i} className={'flex ' + (m.who === 'you' ? 'justify-end' : 'justify-start')}>
                      <div className={'max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ' + (m.who === 'you' ? 'bg-violet-600 text-white' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200')}>{m.text}</div>
                    </div>
                  ))}
                </div>
              )}
              {proposal && (
                <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-500/30 dark:bg-violet-500/10">
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Here's what would change</p>
                  <ul className="mt-1.5 space-y-1">
                    {(proposal.changes || []).map((c: string, i: number) => (
                      <li key={i} className="flex items-start gap-1.5 text-sm text-zinc-700 dark:text-zinc-200"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />{c}</li>
                    ))}
                    {(proposal.changes || []).length === 0 && <li className="text-sm text-zinc-600 dark:text-zinc-300">A small update to this agent.</li>}
                  </ul>
                  {proposal.patch?.prompt && flow && <p className="mt-1.5 text-[11px] text-violet-600 dark:text-violet-300">The flow will be re-drawn to match.</p>}
                  <div className="mt-2 flex gap-2">
                    <button onClick={applyProposal} disabled={chatBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">{chatBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Apply change</button>
                    <button onClick={() => { setProposal(null); setChatLog((p) => [...p, { who: 'ai', text: 'Okay, left as it was.' }]); }} disabled={chatBusy} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Not this</button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <input value={chatMsg} onChange={(e) => setChatMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendChat()} placeholder="Tell it what to change…" className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 pr-10 text-sm outline-none focus:border-violet-400 dark:border-zinc-700" />
                  <DictateButton onText={(t) => setChatMsg((p) => (p ? p + ' ' : '') + t)} className="absolute right-1.5 top-1/2 -translate-y-1/2" />
                </div>
                <button onClick={sendChat} disabled={chatBusy || !chatMsg.trim()} title="Send" className="shrink-0 rounded-lg bg-violet-600 p-2 text-white hover:bg-violet-500 disabled:opacity-50">{chatBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
              </div>
            </section>

            <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <label className="block text-xs font-medium text-zinc-500">Task — what it does each run
                <div className="relative mt-1">
                  <textarea value={task} onChange={(e) => { dirtyRef.current = true; setTask(e.target.value); }} rows={3} className={inp + ' pr-11'} />
                  <DictateButton onText={(t) => { dirtyRef.current = true; setTask((p) => (p ? p + ' ' : '') + t); }} className="absolute right-2 top-2" />
                </div>
              </label>
              <label className="block text-xs font-medium text-zinc-500">Outcome — what does a good result look like? (each run is graded against this)
                <div className="relative mt-1">
                  <textarea value={rubric} onChange={(e) => { dirtyRef.current = true; setRubric(e.target.value); }} rows={3} placeholder="e.g. Has 3 bullets. Each is one short sentence. Mentions a source." className={inp + ' pr-11'} />
                  <DictateButton onText={(t) => { dirtyRef.current = true; setRubric((p) => (p ? p + ' ' : '') + t); }} className="absolute right-2 top-2" />
                </div>
              </label>
              <button onClick={saveCfg} disabled={savingCfg} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900">{savingCfg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save</button>
            </section>

            {/* Skills this agent uses on every run (BEA-1079) */}
            <section className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold">Skills it uses</h2>
              {allSkills === null ? (
                <div className="h-8 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
              ) : allSkills.length === 0 ? (
                <p className="text-xs text-zinc-500">No skills installed yet — add some on the <Link to="/skills" className="text-emerald-600 hover:underline">Skills</Link> page.</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {allSkills.map((sk: any) => {
                      const on = (a?.skills || []).includes(sk.id);
                      return (
                        <button key={sk.id} title={sk.description || sk.title}
                          onClick={async () => {
                            const next = on ? (a.skills || []).filter((x: string) => x !== sk.id) : [...(a.skills || []), sk.id];
                            await patch({ skills: next });
                            toast('success', on ? `Removed ${sk.title}` : `Attached ${sk.title}`);
                          }}
                          className={'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' + (on ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-zinc-200 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700')}>
                          {on ? '✓ ' : ''}{sk.title}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-zinc-400">Attached skills ride along on every run (up to 3 are used); a single attached skill also gives the run its files and scripts.</p>
                </>
              )}
            </section>

            {/* When it runs — editable on the agent itself, not just at create (BEA-1075) */}
            <section className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold">When it runs</h2>
              <SchedulePicker
                value={a?.schedule || null}
                onChange={async (s) => {
                  setA((p: any) => ({ ...p, schedule: s, scheduleText: schedText(s) }));
                  try {
                    const r = await fetch(`/api/agent/agents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: s, scheduleText: schedText(s) }) });
                    if (!r.ok) throw new Error();
                    toast('success', schedText(s) ? `Saved — ${schedText(s)}` : 'Saved — manual only');
                  } catch { toast('error', 'Could not save the schedule'); }
                }}
              />
            </section>

            <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><Workflow className="h-4 w-4 text-violet-500" />How it runs</h2>
                <button onClick={genFlowNow} disabled={genFlow} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">{genFlow ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{flow ? 'Regenerate flow' : 'Generate flow'}</button>
              </div>
              {flow && process ? <FlowProcess process={process} prompt={prompt} /> : <p className="text-xs text-zinc-500">No flow yet — Generate one to turn this agent's Task into a step-by-step process you can edit and run.</p>}
            </section>
          </div>
        )}

        {/* ---- FLOW (canvas on desktop, steps-first on mobile) ---- */}
        {tab === 'Flow' && (
          flow ? (
            <div>
              <div className="mb-2 flex items-center justify-end sm:hidden">
                <button onClick={() => setShowCanvas((v) => !v)} className="rounded-lg border border-zinc-300 px-2 py-1 text-xs hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700">{showCanvas ? 'Show steps' : 'Open canvas'}</button>
              </div>
              {showCanvas ? (
                <div className="h-[72vh] overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
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
          ) : (
            <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
              <Workflow className="mx-auto h-8 w-8 text-zinc-300 dark:text-zinc-600" />
              <p className="mt-2 text-sm text-zinc-500">No flow yet. Generate one from this agent's Task.</p>
              <button onClick={genFlowNow} disabled={genFlow} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">{genFlow ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Generate flow</button>
            </div>
          )
        )}

        {/* ---- EVALS ---- */}
        {tab === 'Evals' && (
          <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Eval cases <span className="text-xs font-normal text-zinc-400">· regression check</span></h2>
              {scored > 0 && <span className={'rounded-full px-2 py-0.5 text-xs font-bold ' + passPill}>{passed}/{evals.length} passed</span>}
            </div>
            {evals.length === 0 ? (
              <p className="text-sm text-zinc-500">No eval cases yet. Add example inputs this agent should handle well (or ✨ Suggest), then run them — each is graded against your Outcome so you catch regressions when you tweak the Task.</p>
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
              <input value={newInput} onChange={(e) => setNewInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addEval()} placeholder="Add a test input…" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
              <button onClick={addEval} title="Add this case" className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700"><Plus className="h-4 w-4" /></button>
              <button onClick={suggestEvals} disabled={suggesting} title="Suggest cases from the Task + Outcome" className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-300 px-3 text-sm hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-zinc-700">{suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}</button>
            </div>
            <button onClick={runEvals} disabled={runningEvals || !evals.length || !rubric} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">{runningEvals ? <><Loader2 className="h-4 w-4 animate-spin" />Running evals…</> : <><Play className="h-4 w-4" />Run evals</>}</button>
            {!rubric && <p className="text-xs text-amber-600">Set an Outcome on the Build tab so the evals can be graded.</p>}
          </section>
        )}

        {/* ---- RUNS ---- */}
        {tab === 'Runs' && (
          <div className="space-y-2">
            {runs && runs.length > 0 && (
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-zinc-400">{runs.length} run{runs.length === 1 ? '' : 's'}</span>
                <button onClick={() => { if (window.confirm('Clear all runs for this agent? Saved documents are kept.')) clearRuns(); }} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash2 className="h-3.5 w-3.5" />Clear all</button>
              </div>
            )}
            {runs === null ? <div className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" /> : runs.length === 0 ? (
              <p className="rounded-2xl border border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">No runs yet. Press Run.</p>
            ) : runs.map((r) => (
              <div key={r._kind + r.id} className="group flex items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                <Link to={`/${r._kind === 'flow' ? 'flows/runs' : 'agent/runs'}/${r.id}`} className="flex min-w-0 flex-1 items-center gap-2">
                  <RunIcon s={r.status} />
                  <span className="font-medium">{r.status === 'running' ? 'Running…' : r.status}</span>
                  <span className="truncate text-xs text-zinc-400">{r._kind} · {when(r.startedAt)}</span>
                  {r.documents?.length > 0 && <span className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400"><FileText className="h-3.5 w-3.5" />{r.documents.length}</span>}
                </Link>
                {r.status !== 'running' && r.status !== 'awaiting_input' && r.status !== 'waiting' && (
                  <button onClick={() => { if (window.confirm('Delete this run? Saved documents are kept.')) deleteRun(r); }} title="Delete run" className="shrink-0 rounded-lg p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 group-hover:text-zinc-400 dark:text-zinc-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
