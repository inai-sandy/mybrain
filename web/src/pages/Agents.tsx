import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Play, Loader2, FileText, CheckCircle2, AlertTriangle, Clock, XCircle, PauseCircle, Plus, Trash2, Power, History as HistoryIcon, CalendarClock, Sparkles, Search, ShieldCheck, X } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { GrowTextarea } from '../ui/GrowTextarea';
import { DictateButton } from '../ui/DictateButton';
import { DepthDial, type Depth } from '../ui/DepthDial';
import { STARTERS, type Starter } from '../ui/agentStarters';

export type Run = { id: string; title?: string; status: string; startedAt: string; endedAt?: string | null; outputDocId?: string | null };

const STATUS: Record<string, { label: string; cls: string; icon: any; spin?: boolean }> = {
  running: { label: 'Running', cls: 'text-blue-600 bg-blue-50 dark:text-blue-300 dark:bg-blue-500/10', icon: Loader2, spin: true },
  awaiting_input: { label: 'Waiting on you', cls: 'text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10', icon: PauseCircle },
  scheduled: { label: 'Scheduled', cls: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800', icon: Clock },
  done: { label: 'Done', cls: 'text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/10', icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'text-red-600 bg-red-50 dark:text-red-300 dark:bg-red-500/10', icon: XCircle },
  cancelled: { label: 'Cancelled', cls: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800', icon: XCircle },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] || STATUS.scheduled;
  const Icon = s.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      <Icon className={'h-3 w-3 ' + (s.spin ? 'animate-spin' : '')} />
      {s.label}
    </span>
  );
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

function NewAgentForm({ initial, onCreated, onCancel }: { initial?: Starter | null; onCreated: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'describe' | 'form'>('describe');
  const [idea, setIdea] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [rubric, setRubric] = useState('');
  const [defaultDepth, setDefaultDepth] = useState<Depth>('standard');
  const [evals, setEvals] = useState<string[]>([]);
  const [newEval, setNewEval] = useState('');
  const [every, setEvery] = useState('manual');
  const [at, setAt] = useState('07:00');

  function pickStarter(s: Starter) {
    setName(s.name); setTask(s.task); setRubric(s.rubric); setDefaultDepth(s.depth);
    setEvery(s.every || 'manual'); if (s.at) setAt(s.at);
    setStep('form');
  }
  useEffect(() => { if (initial) pickStarter(initial); /* eslint-disable-next-line */ }, []);
  const [saving, setSaving] = useState(false);
  const inp = 'w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';

  async function draft() {
    if (!idea.trim()) { toast('error', 'Describe what you want it to do'); return; }
    setDrafting(true);
    try {
      const r = await fetch('/api/agent/agents/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not draft');
      setName(d.name || ''); setTask(d.prompt || ''); setRubric(d.rubric || ''); setEvals(Array.isArray(d.evals) ? d.evals : []);
      setStep('form');
    } catch (e: any) { toast('error', e?.message || 'Could not draft'); } finally { setDrafting(false); }
  }

  async function save() {
    if (!name.trim() || !task.trim()) { toast('error', 'Give it a name and a task'); return; }
    let schedule: any = null;
    let scheduleText: string | undefined;
    if (every === 'day') { schedule = { every: 'day', at }; scheduleText = `Every day at ${at}`; }
    else if (every === 'weekday') { schedule = { every: 'weekday', at }; scheduleText = `Every weekday at ${at}`; }
    else if (every === 'hour') { schedule = { every: 'hour', minute: Number(at.split(':')[1]) || 0 }; scheduleText = `Every hour at :${at.split(':')[1] || '00'}`; }
    setSaving(true);
    try {
      const evalCases = evals.map((x) => x.trim()).filter(Boolean).map((input) => ({ id: 'ev_' + Math.random().toString(36).slice(2, 9), input }));
      const r = await fetch('/api/agent/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), prompt: task.trim(), rubric: rubric.trim() || undefined, defaultDepth, evals: evalCases, schedule, scheduleText }) });
      if (!r.ok) throw new Error('Could not save');
      onCreated();
    } catch (e: any) { toast('error', e?.message || 'Could not save'); } finally { setSaving(false); }
  }

  if (step === 'describe') {
    return (
      <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Start from a template</div>
        <div className="grid grid-cols-2 gap-2">
          {STARTERS.map((s) => (
            <button key={s.key} onClick={() => pickStarter(s)} className="rounded-xl border border-zinc-200 p-2.5 text-left transition-colors hover:border-emerald-400 dark:border-zinc-800">
              <div className="flex items-center gap-1.5 text-sm font-medium"><span>{s.icon}</span>{s.name}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{s.blurb}</div>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1 text-sm font-medium"><Sparkles className="h-4 w-4 text-emerald-600" />…or describe your own</div>
        <div className="relative">
          <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="In a sentence or two, what should this agent do?  e.g. “Every morning, summarise my unread emails and flag anything urgent.”" className={inp + ' resize-none pr-11'} />
          <DictateButton onText={(t) => setIdea((p) => (p ? p + ' ' : '') + t)} className="absolute right-2 top-2" />
        </div>
        <p className="text-xs text-zinc-400">I'll draft the task, a clear Outcome to grade it against, and a couple of test cases — you review and tweak before saving.</p>
        <div className="flex items-center justify-between gap-2">
          <button onClick={() => setStep('form')} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Fill it in myself</button>
          <div className="flex gap-2">
            <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
            <button onClick={draft} disabled={drafting} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Draft it for me</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name (e.g. Morning Brief)" className={inp} />
      <label className="block text-xs text-zinc-500">Task
        <div className="relative mt-1">
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="What should it do each time it runs?" className={inp + ' resize-none pr-11'} />
          <DictateButton onText={(t) => setTask((p) => (p ? p + ' ' : '') + t)} className="absolute right-2 top-2" />
        </div>
      </label>
      <label className="block text-xs text-zinc-500">Outcome — what does a good result look like? (graded each run)
        <div className="relative mt-1">
          <textarea value={rubric} onChange={(e) => setRubric(e.target.value)} rows={3} placeholder="e.g. Has 3 bullets. Each is one short sentence. Flags anything urgent." className={inp + ' resize-none pr-11'} />
          <DictateButton onText={(t) => setRubric((p) => (p ? p + ' ' : '') + t)} className="absolute right-2 top-2" />
        </div>
      </label>
      <div>
        <div className="mb-1 text-xs text-zinc-500">How deep should each run go?</div>
        <DepthDial value={defaultDepth} onChange={setDefaultDepth} />
      </div>
      <div className="space-y-1.5">
        <div className="text-xs text-zinc-500">Eval cases — example inputs to test it (optional)</div>
        {evals.map((e, i) => (
          <div key={i} className="flex gap-2">
            <input value={e} onChange={(ev) => setEvals((p) => p.map((x, j) => (j === i ? ev.target.value : x)))} className={inp} />
            <button onClick={() => setEvals((p) => p.filter((_, j) => j !== i))} className="shrink-0 px-1 text-zinc-400 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <div className="flex gap-2">
          <input value={newEval} onChange={(e) => setNewEval(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newEval.trim()) { setEvals((p) => [...p, newEval.trim()]); setNewEval(''); } }} placeholder="Add a test input…" className={inp} />
          <button onClick={() => { if (newEval.trim()) { setEvals((p) => [...p, newEval.trim()]); setNewEval(''); } }} className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700"><Plus className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <select value={every} onChange={(e) => setEvery(e.target.value)} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <option value="manual">Manual (run by hand)</option>
          <option value="day">Every day</option>
          <option value="weekday">Every weekday</option>
          <option value="hour">Every hour</option>
        </select>
        {every !== 'manual' && <input type="time" value={at} onChange={(e) => setAt(e.target.value)} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />}
        <div className="ml-auto flex gap-2">
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Save agent</button>
        </div>
      </div>
    </div>
  );
}

export function Agents() {
  const nav = useNavigate();
  const toast = useToast();
  const [engine, setEngine] = useState<{ ok?: boolean; version?: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [saveResult, setSaveResult] = useState(true);
  const [depth, setDepth] = useState<Depth>('standard');
  const [agents, setAgents] = useState<any[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [starterPick, setStarterPick] = useState<Starter | null>(null);
  const [showAsk, setShowAsk] = useState(false);
  const [agentSort, setAgentSort] = useState<'recent' | 'name'>('recent');
  // Run popup: after planning a deep research, pick which sub-questions to run. (BEA-773)
  const [planFor, setPlanFor] = useState<{ flowId: string; subs: { id: string; branchIdx: number; sub: string; on: boolean }[] } | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 6;
  const [q, setQ] = useState('');

  const loadAgents = () => fetch('/api/agent/agents').then((r) => r.json()).then(setAgents).catch(() => setAgents([]));

  useEffect(() => {
    fetch('/api/agent/engine').then((r) => r.json()).then(setEngine).catch(() => setEngine({ ok: false }));
    fetch('/api/agent/runs?limit=20').then((r) => r.json()).then(setRuns).catch(() => setRuns([]));
    loadAgents();
  }, []);

  async function runSaved(id: string) {
    try {
      const r = await fetch(`/api/agent/agents/${id}/run`, { method: 'POST' });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).message || 'Could not start');
      const row = await r.json();
      nav(`/agent/runs/${row.id}`);
    } catch (e: any) { toast('error', e?.message || 'Could not run that agent'); }
  }
  async function toggleSaved(a: any) {
    await fetch(`/api/agent/agents/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !a.enabled }) });
    loadAgents();
  }
  async function delSaved(id: string) {
    await fetch(`/api/agent/agents/${id}`, { method: 'DELETE' });
    loadAgents();
  }

  async function delRun(id: string) {
    try {
      const res = await fetch(`/api/agent/runs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).message || 'Could not delete');
      setRuns((p) => (p || []).filter((x) => x.id !== id));
      toast('success', 'Run deleted');
    } catch (e: any) { toast('error', e.message || 'Could not delete'); }
  }

  async function clearRecent() {
    try {
      await fetch('/api/agent/runs', { method: 'DELETE' });
      setRuns([]);
      toast('success', 'Runs cleared');
    } catch { toast('error', 'Could not clear runs'); }
  }

  async function run() {
    const text = prompt.trim();
    if (!text) { toast('error', 'Type a task for the agent first'); return; }
    setStarting(true);
    try {
      if (depth === 'deep') {
        // Deep = a full flow: create one, plan it into sub-questions, then let the user pick which to run. (BEA-773)
        const fl = await (await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: title.trim() || text.slice(0, 60), question: text }) })).json();
        await fetch(`/api/flows/${fl.id}/plan`, { method: 'POST' }).catch(() => undefined);
        const flow = await (await fetch(`/api/flows/${fl.id}`)).json();
        const subs = ((flow.graph?.nodes || []) as any[])
          .filter((n) => n.data?.kind === 'subquestion')
          .map((n) => ({ id: n.id, branchIdx: Number(/^b(\d+)_/.exec(n.id)?.[1] ?? 0), sub: (n.data?.sub || '').toString(), on: true }));
        if (subs.length > 1) { setPlanFor({ flowId: fl.id, subs }); setStarting(false); return; } // show the picker
        const run = await (await fetch(`/api/flows/${fl.id}/run`, { method: 'POST' })).json();
        if (run?.runId) { nav(`/flows/runs/${run.runId}`); return; }
        throw new Error('Could not start the deep run');
      }
      const r = await fetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, title: title.trim() || undefined, save: depth === 'quick' ? false : saveResult, depth }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).message || 'Could not start');
      const row = await r.json();
      nav(`/agent/runs/${row.id}`);
    } catch (e: any) {
      toast('error', e?.message || 'Could not start the agent');
      setStarting(false);
    }
  }

  // Run the planned flow with only the ticked sub-questions (disable the rest for this run). (BEA-773)
  async function runSelected() {
    if (!planFor) return;
    const chosen = planFor.subs.filter((s) => s.on);
    if (!chosen.length) { toast('error', 'Pick at least one sub-question'); return; }
    setStarting(true);
    try {
      // Skip the unticked branches for THIS run only — sent to the run endpoint, never saved onto the
      // flow (a saved enabled:false used to cripple every later plain Run / schedule). (BEA-796)
      const skipBranches = planFor.subs.filter((s) => !s.on).map((s) => s.branchIdx);
      const run = await (await fetch(`/api/flows/${planFor.flowId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skipBranches }),
      })).json();
      setPlanFor(null);
      if (run?.runId) nav(`/flows/runs/${run.runId}`);
      else throw new Error('Could not start');
    } catch (e: any) { toast('error', e?.message || 'Could not start'); setStarting(false); }
  }

  return (
    <div className="space-y-6">
      {planFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !starting && setPlanFor(null)}>
          <div className="w-full max-w-md space-y-3 rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-emerald-600" />What should I research?</h2>
              <button onClick={() => setPlanFor(null)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
            </div>
            <p className="text-xs text-zinc-500">I split your ask into these questions. Untick any you don't want — or run them all.</p>
            <div className="space-y-1.5">
              {planFor.subs.map((s, i) => (
                <label key={s.id} className={'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition-colors ' + (s.on ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10' : 'border-zinc-200 dark:border-zinc-700')}>
                  <input type="checkbox" checked={s.on} onChange={(e) => setPlanFor((p) => p ? { ...p, subs: p.subs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) } : p)} className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600" />
                  <span className={s.on ? 'text-zinc-700 dark:text-zinc-100' : 'text-zinc-400'}>{s.sub}</span>
                </label>
              ))}
            </div>
            <button onClick={runSelected} disabled={starting || !planFor.subs.some((s) => s.on)} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{starting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Research {planFor.subs.filter((s) => s.on).length} question{planFor.subs.filter((s) => s.on).length === 1 ? '' : 's'}</button>
          </div>
        </div>
      )}
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-indigo-500 text-white">
          <Bot className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Agents</h1>
          <p className="truncate text-sm text-zinc-500">Give it a goal — it does the work and saves the result.</p>
        </div>
        <div className="ml-auto shrink-0">
          {engine === null ? null : engine.ok ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"><span className="h-2 w-2 rounded-full bg-emerald-500" />Engine online</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-600"><AlertTriangle className="h-3.5 w-3.5" />Engine offline</span>
          )}
        </div>
      </header>

      {/* Floating "Quick ask" — a one-off run without saving an agent (capture pattern, BEA-698) */}
      <button
        onClick={() => setShowAsk(true)}
        className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg transition-colors hover:bg-emerald-500"
      >
        <Sparkles className="h-4 w-4" />Quick ask
      </button>

      {showAsk && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !starting && setShowAsk(false)}>
          <div className="w-full max-w-lg space-y-3 rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-emerald-600" />Quick ask</h2>
              <button onClick={() => setShowAsk(false)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><XCircle className="h-5 w-5" /></button>
            </div>
            <div className="rounded-xl border border-zinc-300 bg-zinc-50 transition-colors focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950">
              <GrowTextarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do?  e.g. “Research the best electric cars and write a short brief.”" className="w-full bg-transparent px-3 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100" minHeight={76} maxHeight={240} autoFocus />
            </div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name this run (optional)" className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <DepthDial value={depth} onChange={setDepth} />
              {depth === 'standard' && (
                <label className="flex items-center gap-2 text-xs text-zinc-500">
                  <input type="checkbox" checked={saveResult} onChange={(e) => setSaveResult(e.target.checked)} className="accent-emerald-600" />
                  Save to Documents
                </label>
              )}
            </div>
            {engine && !engine.ok && <p className="text-xs text-amber-600">The agent engine isn’t reachable right now, so a run may not start.</p>}
            <button onClick={run} disabled={starting || !prompt.trim()} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run
            </button>
          </div>
        </div>
      )}

      {/* Saved agents */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-500">Saved agents</h2>
          <button onClick={() => setShowNew((v) => !v)} className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:text-emerald-500"><Plus className="h-4 w-4" />New agent</button>
        </div>
        {showNew && <NewAgentForm initial={starterPick} onCreated={() => { setShowNew(false); setStarterPick(null); loadAgents(); }} onCancel={() => { setShowNew(false); setStarterPick(null); }} />}
        {agents === null ? (
          <div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
        ) : agents.length === 0 ? (
          !showNew && (
            <div className="rounded-2xl border border-dashed border-zinc-300 p-5 dark:border-zinc-700">
              <p className="mb-3 text-center text-sm text-zinc-500">No saved agents yet — start from a template:</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => (
                  <button key={s.key} onClick={() => { setStarterPick(s); setShowNew(true); }} className="rounded-xl border border-zinc-200 bg-white p-3 text-left transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="flex items-center gap-1.5 text-sm font-medium"><span>{s.icon}</span>{s.name}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{s.blurb}</div>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (() => {
          const filtered = agents
            .filter((a) => !q || (a.name + ' ' + (a.prompt || '')).toLowerCase().includes(q.toLowerCase()))
            .slice()
            .sort((a, b) => (agentSort === 'name' ? a.name.localeCompare(b.name) : 0)); // 'recent' keeps API order (newest first)
          const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
          const cur = Math.min(page, pages);
          const list = filtered.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
          return (
            <div className="space-y-3">
              {agents.length > 3 && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="flex flex-1 items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 dark:border-zinc-700">
                    <Search className="h-4 w-4 shrink-0 text-zinc-400" />
                    <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search agents…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
                    <span className="shrink-0 text-xs text-zinc-400">{filtered.length}</span>
                  </div>
                  <select value={agentSort} onChange={(e) => setAgentSort(e.target.value as 'recent' | 'name')} className="rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-sm outline-none dark:border-zinc-700 dark:bg-zinc-900">
                    <option value="recent">Newest</option>
                    <option value="name">Name A–Z</option>
                  </select>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {list.map((a) => {
                  const evs = a.evals || [];
                  const scored = evs.filter((e: any) => e.lastVerdict).length;
                  const passed = evs.filter((e: any) => e.lastVerdict === 'pass').length;
                  const passCls = passed === evs.length ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : passed === 0 ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400';
                  return (
                    <div key={a.id} onClick={() => nav(`/agent/agents/${a.id}`)} className="group flex cursor-pointer flex-col rounded-2xl border border-zinc-200 bg-white p-4 transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="flex items-start gap-2">
                        <span className="text-2xl leading-none">{a.icon || '🤖'}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium group-hover:text-emerald-600">{a.name}</div>
                          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{a.prompt || 'No task set'}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs capitalize text-zinc-500 dark:bg-zinc-800">{a.defaultDepth || 'standard'}</span>
                        {scored > 0 && <span className={'rounded-full px-2 py-0.5 text-xs font-bold ' + passCls}>{passed}/{evs.length} pass</span>}
                        {a.scheduleText ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><CalendarClock className="h-3 w-3" />{a.scheduleText}</span> : <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">Manual</span>}
                        {!a.enabled && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">paused</span>}
                      </div>
                      <div className="mt-3 flex items-center gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                        <button onClick={(e) => { e.stopPropagation(); runSaved(a.id); }} title="Run now" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"><Play className="h-3.5 w-3.5" />Run</button>
                        <button onClick={(e) => { e.stopPropagation(); toggleSaved(a); }} title={a.enabled ? 'Pause schedule' : 'Resume schedule'} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Power className="h-3.5 w-3.5" /></button>
                        <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${a.name}"?`)) delSaved(a.id); }} title="Delete" className="ml-auto rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {pages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-1 text-sm">
                  <button disabled={cur <= 1} onClick={() => setPage(cur - 1)} className="rounded-lg px-2 py-1 text-zinc-500 hover:text-zinc-800 disabled:opacity-40 dark:hover:text-zinc-200">Prev</button>
                  <span className="text-xs text-zinc-400">Page {cur} of {pages}</span>
                  <button disabled={cur >= pages} onClick={() => setPage(cur + 1)} className="rounded-lg px-2 py-1 text-zinc-500 hover:text-zinc-800 disabled:opacity-40 dark:hover:text-zinc-200">Next</button>
                </div>
              )}
            </div>
          );
        })()}
      </section>

      {/* Recent runs */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-500">Recent runs</h2>
          <div className="flex items-center gap-1">
            {runs && runs.length > 0 && (
              <button onClick={() => { if (window.confirm('Clear all recent runs? Saved documents are kept.')) clearRecent(); }} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-red-600"><Trash2 className="h-4 w-4" />Clear all</button>
            )}
            <button onClick={() => nav('/agent/saved')} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ShieldCheck className="h-4 w-4" />Agent saves</button>
            <button onClick={() => nav('/agent/history')} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><HistoryIcon className="h-4 w-4" />All runs</button>
          </div>
        </div>
        {runs === null ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
        ) : runs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No runs yet. Give the agent a task above to get started.
          </div>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <li key={r.id} className="group flex items-center gap-1 rounded-xl border border-zinc-200 bg-white px-2 transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                <button
                  onClick={() => nav(`/agent/runs/${r.id}`)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.title || 'Agent run'}</div>
                    <div className="text-xs text-zinc-500">{timeAgo(r.startedAt)}</div>
                  </div>
                  {r.outputDocId && <FileText className="h-4 w-4 shrink-0 text-zinc-400" />}
                  <StatusBadge status={r.status} />
                </button>
                {r.status !== 'running' && r.status !== 'awaiting_input' && (
                  <button onClick={() => { if (window.confirm('Delete this run? Saved documents are kept.')) delRun(r.id); }} title="Delete run" className="shrink-0 rounded-lg p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 group-hover:text-zinc-400 dark:text-zinc-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
