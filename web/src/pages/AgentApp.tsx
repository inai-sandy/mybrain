import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Play, Sparkles, FileText, CheckCircle2, RotateCcw, MessageSquare, Send, Save, Check, Settings as GearIcon, Workflow, Clock, ListChecks, History as HistoryIcon, ChevronRight } from 'lucide-react';
import { useGoBack } from '../ui/useGoBack';
import { useToast } from '../ui/Toast';
import { Markdown } from '../ui/markdown';
import { DictateButton } from '../ui/DictateButton';
import { GrowTextarea } from '../ui/GrowTextarea';
import { SchedulePicker, schedText } from '../ui/SchedulePicker';
import { StatusBadge, timeAgo } from './Agents';

type UiInput = { key: string; label: string; type: 'topic' | 'text' | 'url' | 'contact' | 'date' | 'choice'; placeholder?: string; options?: string[] };
type UiSpec = { headline: string; inputs: UiInput[]; view: 'report' | 'brief' | 'checklist' | 'plain'; runLabel: string };
type Mode = 'run' | 'chat' | 'settings';

/**
 * One home per agent (BEA-1090): three clearly-labelled modes — ▶ Run · 💬 Chat · ⚙ Settings.
 * Run is the agent's AI-designed mini-app (BEA-1082); Chat changes the agent in plain words with a
 * confirm-first diff (BEA-1065); Settings holds the task, outcome, skills, schedule and links out to
 * the deeper Flow · Tests · History views. No hidden workshop, no naked icons.
 */
export function AgentApp() {
  const { id } = useParams();
  const nav = useNavigate();
  const goBack = useGoBack('/agent');
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [a, setA] = useState<any>(null);
  const [spec, setSpec] = useState<UiSpec | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [liveRun, setLiveRun] = useState<any>(null);
  const [runs, setRuns] = useState<any[] | null>(null);
  const [redesigning, setRedesigning] = useState(false);
  const [flow, setFlow] = useState<any>(null);
  const [allSkills, setAllSkills] = useState<any[] | null>(null);
  const [histQ, setHistQ] = useState(''); // dated-history search + filter (BEA-1099)
  const [histFilter, setHistFilter] = useState<'all' | 'done' | 'failed'>('all');
  const [areas, setAreas] = useState<any[] | null>(null); // for move-to-agent
  const [moveTo, setMoveTo] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialMode = (params.get('mode') as Mode) || 'run';
  const [mode, setModeState] = useState<Mode>(['run', 'chat', 'settings'].includes(initialMode) ? initialMode : 'run');
  function setMode(m: Mode) { setModeState(m); const p = new URLSearchParams(params); if (m === 'run') p.delete('mode'); else p.set('mode', m); setParams(p, { replace: true }); }

  async function load() {
    const d = await fetch(`/api/agent/agents/${id}`).then((r) => r.json()).catch(() => null);
    if (!d?.id) { setA(null); return; }
    setA(d);
    if (Array.isArray(d.chatLog)) setChatLog(d.chatLog); // the persisted conversation (BEA-1097)
    if (!dirtyRef.current) { setTask(d.prompt || ''); setRubric(d.rubric || ''); }
    if (d.ui) setSpec(d.ui);
    else {
      const s = await fetch(`/api/agent/agents/${id}/ui/generate`, { method: 'POST' }).then((r) => r.json()).catch(() => null);
      if (s?.view) setSpec(s);
      else setSpec({ headline: `Run ${d.name}`, inputs: [], view: 'report', runLabel: 'Run →' });
    }
    loadRuns();
    return d;
  }
  async function loadRuns() {
    const rs = await fetch(`/api/agent/runs?agentId=${id}&limit=300`).then((r) => r.json()).catch(() => []);
    const list = Array.isArray(rs) ? rs : [];
    setRuns(list);
    const live = list.find((r: any) => r.status === 'running' || r.status === 'awaiting_input' || r.status === 'paused');
    setLiveRun(live || null);
    if (live && !pollRef.current) pollRef.current = setInterval(loadRuns, 4000);
    if (!live && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }
  function loadFlow() { fetch(`/api/flows?agentId=${id}`).then((r) => r.json()).then((d) => setFlow((d.flows || [])[0] || null)).catch(() => undefined); }
  useEffect(() => {
    load(); loadFlow();
    fetch('/api/skills').then((r) => r.json()).then((d) => setAllSkills(d.skills || [])).catch(() => setAllSkills([]));
    return () => { if (pollRef.current) clearInterval(pollRef.current); }; /* eslint-disable-next-line */
  }, [id]);

  async function run() {
    if (running) return;
    const missing = (spec?.inputs || []).filter((i) => i.type !== 'date' && !vals[i.key]?.trim());
    if (missing.length) { toast('error', `Fill in: ${missing.map((m) => m.label).join(', ')}`); return; }
    setRunning(true);
    try {
      const input = (spec?.inputs || []).map((i) => `${i.label}: ${vals[i.key] || ''}`).join('\n');
      const r = await fetch(`/api/agent/agents/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not start');
      toast('success', 'Started — watch it work below');
      loadRuns();
    } catch (e: any) { toast('error', e?.message || 'Could not start'); }
    setRunning(false);
  }

  async function redesign() {
    setRedesigning(true);
    try {
      const s = await fetch(`/api/agent/agents/${id}/ui/generate`, { method: 'POST' }).then((r) => r.json());
      if (s?.view) { setSpec(s); toast('success', 'Screen redesigned'); }
    } catch { toast('error', 'Could not redesign'); }
    setRedesigning(false);
  }

  // ---- shared patch + Settings editing ----
  const dirtyRef = useRef(false);
  const [task, setTask] = useState('');
  const [rubric, setRubric] = useState('');
  const [savingCfg, setSavingCfg] = useState(false);
  async function patch(body: any) {
    const r = await fetch(`/api/agent/agents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { const d = await r.json(); setA(d); return d; }
    toast('error', 'Could not save'); return null;
  }
  async function saveCfg() { setSavingCfg(true); await patch({ prompt: task, rubric }); dirtyRef.current = false; setSavingCfg(false); toast('success', 'Saved'); }

  // ---- Chat (BEA-1065): message → proposal → apply on confirm ----
  const [chatMsg, setChatMsg] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLog, setChatLog] = useState<{ who: 'you' | 'ai'; text: string }[]>([]);
  const [proposal, setProposal] = useState<any>(null);
  async function sendChat() {
    const msg = chatMsg.trim();
    if (!msg || chatBusy) return;
    setChatBusy(true); setProposal(null);
    setChatLog((p) => [...p, { who: 'you', text: msg }]); setChatMsg('');
    try {
      const r = await fetch(`/api/agent/agents/${id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not do that');
      setChatLog((p) => [...p, { who: 'ai', text: d.note || 'Done.' }]);
      if (d.patch && Object.keys(d.patch).length) setProposal(d);
    } catch (e: any) { setChatLog((p) => [...p, { who: 'ai', text: e.message || 'Something went wrong — try again.' }]); }
    setChatBusy(false);
  }
  async function applyProposal() {
    if (!proposal || chatBusy) return;
    setChatBusy(true);
    try {
      const d = await patch(proposal.patch);
      if (!d) throw new Error();
      dirtyRef.current = false; setTask(d.prompt || ''); setRubric(d.rubric || '');
      if (flow && proposal.patch.prompt) {
        await fetch(`/api/flows/${flow.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: d.prompt || '' }) }).catch(() => undefined);
        await fetch(`/api/flows/${flow.id}/plan`, { method: 'POST' }).catch(() => undefined);
        loadFlow();
        toast('success', 'Changed — and the flow was re-drawn to match');
      } else { toast('success', 'Changed'); }
      setSpec(null); load(); // the run screen may need to re-fit; reload spec
      setChatLog((p) => [...p, { who: 'ai', text: 'Applied ✓' }]);
      fetch(`/api/agent/agents/${id}/chat-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Applied ✓' }) }).catch(() => undefined);
      setProposal(null);
    } catch { toast('error', 'Could not apply the change'); }
    setChatBusy(false);
  }
  async function clearChatLog() {
    await fetch(`/api/agent/agents/${id}/chat-log`, { method: 'DELETE' }).catch(() => undefined);
    setChatLog([]); setProposal(null);
    toast('success', 'Chat cleared');
  }

  if (a === null) return <div className="p-6 text-sm text-zinc-500">This agent doesn't exist any more. <button onClick={() => nav('/agent')} className="text-emerald-600 hover:underline">Back to Agents</button></div>;
  if (!a || !spec) return <div className="space-y-3"><div className="h-16 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /><div className="h-40 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /></div>;

  const latest = (runs || []).find((r: any) => r.status === 'done' && r.resultText);
  const color = a.color || '#818cf8';
  const inp = 'w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900';
  const cfgInp = 'w-full resize-none rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';

  const MODES: { k: Mode; label: string; icon: any }[] = [
    { k: 'run', label: 'Run', icon: Play },
    { k: 'chat', label: 'Chat', icon: MessageSquare },
    { k: 'settings', label: 'Settings', icon: GearIcon },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Agents</button>

      <header className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl" style={{ background: color + '22' }}>{a.icon || '🤖'}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold">{a.name}</h1>
          <p className="truncate text-sm text-zinc-500">{a.description || a.scheduleText || 'Your agent'}</p>
        </div>
      </header>

      {/* labelled mode switch — no naked icons, nothing hidden */}
      <div className="flex gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
        {MODES.map((m) => {
          const on = mode === m.k;
          const Icon = m.icon;
          return (
            <button key={m.k} onClick={() => setMode(m.k)}
              className={'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ' + (on ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
              <Icon className="h-4 w-4" style={on && m.k === 'run' ? { color } : undefined} />{m.label}
            </button>
          );
        })}
      </div>

      {/* ===================== RUN ===================== */}
      {mode === 'run' && (<>
        <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" style={{ borderTop: `3px solid ${color}` }}>
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-base font-semibold">{spec.headline}</h2>
            <button onClick={redesign} disabled={redesigning} title="Redesign this screen" className="inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">{redesigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}<span className="hidden sm:inline">Redesign</span></button>
          </div>
          {spec.inputs.map((i) => (
            <div key={i.key}>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">{i.label}</label>
              {i.type === 'topic' ? (
                <div className="relative">
                  <GrowTextarea value={vals[i.key] || ''} onChange={(e) => setVals((p) => ({ ...p, [i.key]: e.target.value }))} placeholder={i.placeholder || 'Type it in your own words…'} className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 pr-11 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900" minHeight={64} maxHeight={200} />
                  <DictateButton onText={(t) => setVals((p) => ({ ...p, [i.key]: ((p[i.key] || '') + ' ' + t).trim() }))} className="absolute right-2 top-2" />
                </div>
              ) : i.type === 'choice' && i.options?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {i.options.map((o) => (
                    <button key={o} onClick={() => setVals((p) => ({ ...p, [i.key]: o }))} className={'rounded-full border px-3 py-1.5 text-sm transition-colors ' + (vals[i.key] === o ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300')}>{o}</button>
                  ))}
                </div>
              ) : (
                <input type={i.type === 'date' ? 'date' : i.type === 'url' ? 'url' : 'text'} value={vals[i.key] || ''} onChange={(e) => setVals((p) => ({ ...p, [i.key]: e.target.value }))} placeholder={i.placeholder || (i.type === 'contact' ? 'Who? e.g. Jayanth' : '')} className={inp} />
              )}
            </div>
          ))}
          {liveRun ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-500/25 dark:bg-blue-500/5">
              <button onClick={() => nav(`/agent/runs/${liveRun.id}`)} className="flex w-full items-center gap-2 text-left">
                <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" /></span>
                <span className="text-sm font-medium">{liveRun.status === 'running' ? 'Working…' : 'Waiting for your answer'}</span>
                <span className="ml-auto text-xs text-zinc-400">watch →</span>
              </button>
              {(liveRun.stepLog || []).filter((s: any) => s.kind !== 'log').slice(-2).map((s: any, i: number) => (
                <div key={i} className="mt-1 truncate pl-5 text-xs text-zinc-500">{s.label}</div>
              ))}
            </div>
          ) : (
            <button onClick={run} disabled={running} className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-5 py-3 text-sm font-semibold text-white transition-transform hover:brightness-110 active:scale-[.99] disabled:opacity-50" style={{ background: color }}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{spec.runLabel || 'Run →'}
            </button>
          )}
        </section>

        {latest && (
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />Latest result · {timeAgo(latest.endedAt || latest.startedAt)}
              {latest.grade?.verdict && <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">{latest.grade.verdict} · {latest.grade.score}</span>}
              {latest.outputDocId && <button onClick={() => nav(`/documents/${latest.outputDocId}`)} className="ml-auto inline-flex items-center gap-1 text-emerald-600 hover:underline"><FileText className="h-3.5 w-3.5" />document</button>}
            </div>
            {spec.view === 'brief' ? (
              <div>
                <div className="text-lg font-semibold leading-snug">{(latest.resultText || '').split('\n')[0]}</div>
                <Markdown className="mt-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{(latest.resultText || '').split('\n').slice(1).join('\n')}</Markdown>
              </div>
            ) : spec.view === 'checklist' ? (
              <ul className="space-y-1.5">
                {(latest.resultText || '').split('\n').map((l: string) => l.replace(/^[-*•\s]+/, '')).filter(Boolean).slice(0, 20).map((l: string, i: number) => (
                  <li key={i} className="flex items-start gap-2 text-sm"><span className="mt-0.5 text-emerald-500">✓</span><span className="text-zinc-700 dark:text-zinc-300">{l}</span></li>
                ))}
              </ul>
            ) : spec.view === 'plain' ? (
              <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{latest.resultText}</p>
            ) : (
              <Markdown className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{latest.resultText}</Markdown>
            )}
          </section>
        )}

        {/* Dated history (BEA-1099): every entry this job produced, newest first, honest about failures. */}
        {(runs || []).length > 0 && (() => {
          const all = runs || [];
          const filtered = all
            .filter((r: any) => histFilter === 'all' || (histFilter === 'done' ? r.status === 'done' : r.status === 'failed'))
            .filter((r: any) => !histQ || ((r.title || '') + ' ' + (r.resultText || '')).toLowerCase().includes(histQ.toLowerCase()));
          const fmtDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
          return (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">History · {filtered.length}</h3>
                {all.length > 3 && (
                  <div className="flex gap-1">
                    {(['all', 'done', 'failed'] as const).map((f) => (
                      <button key={f} onClick={() => setHistFilter(f)} className={'rounded-full border px-2 py-0.5 text-[11px] font-medium ' + (histFilter === f ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-zinc-200 text-zinc-400 dark:border-zinc-700')}>{f === 'all' ? 'All' : f === 'done' ? 'Done' : 'Failed'}</button>
                    ))}
                  </div>
                )}
              </div>
              {all.length > 5 && (
                <input value={histQ} onChange={(e) => setHistQ(e.target.value)} placeholder="Search this job's history…" className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
              )}
              {filtered.slice(0, 30).map((r: any) => (
                <div key={r.id} className="group flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                  <button onClick={() => nav(`/agent/runs/${r.id}`)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                    <span className="w-[4.6rem] shrink-0 text-[11px] font-bold uppercase tracking-wide" style={{ color }}>{fmtDay(r.endedAt || r.startedAt)}</span>
                    <span className="min-w-0 flex-1 truncate">{r.status === 'failed' ? <span className="text-rose-600 dark:text-rose-400">Failed{r.error ? ` — ${String(r.error).slice(0, 50)}` : ''}</span> : ((r.resultText || '').split('\n')[0] || r.title || a.name)}</span>
                  </button>
                  {(r.status === 'failed' || r.status === 'done') && (
                    <button onClick={() => fetch(`/api/agent/runs/${r.id}/replay`, { method: 'POST' }).then(() => { toast('success', r.status === 'failed' ? 'Retrying…' : 'Running it again…'); loadRuns(); })} title={r.status === 'failed' ? 'Retry' : 'Run again'} className={'shrink-0 rounded-lg p-1 ' + (r.status === 'failed' ? 'text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10' : 'text-zinc-300 hover:text-emerald-600 group-hover:text-zinc-400')}><RotateCcw className="h-3.5 w-3.5" /></button>
                  )}
                  <StatusBadge status={r.status} />
                </div>
              ))}
              {filtered.length === 0 && <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">Nothing matches.</p>}
            </section>
          );
        })()}
      </>)}

      {/* ===================== CHAT ===================== */}
      {mode === 'chat' && (
        <section className="space-y-3 rounded-2xl border border-violet-200 bg-white p-4 dark:border-violet-500/30 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4 text-violet-500" />Change it by chatting</h2>
            {chatLog.length > 0 && <button onClick={clearChatLog} className="text-xs text-zinc-400 hover:text-rose-500">Clear chat</button>}
          </div>
          {chatLog.length === 0 && <p className="text-xs text-zinc-400">Say the change in your own words — “add a step that messages Mom”, “run it every morning at 7”, “stop asking me before saving”. Or just ask it a question. You'll see what would change before it sticks.</p>}
          {chatLog.length > 0 && (
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
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
                <button onClick={() => { setProposal(null); setChatLog((p) => [...p, { who: 'ai', text: 'Okay, left as it was.' }]); fetch(`/api/agent/agents/${id}/chat-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Okay, left as it was.' }) }).catch(() => undefined); }} disabled={chatBusy} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Not this</button>
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
      )}

      {/* ===================== SETTINGS ===================== */}
      {mode === 'settings' && (
        <div className="space-y-3">
          <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <label className="block text-xs font-medium text-zinc-500">What it does — the task it runs each time
              <div className="relative mt-1">
                <textarea value={task} onChange={(e) => { dirtyRef.current = true; setTask(e.target.value); }} rows={3} className={cfgInp + ' pr-11'} />
                <DictateButton onText={(t) => { dirtyRef.current = true; setTask((p) => (p ? p + ' ' : '') + t); }} className="absolute right-2 top-2" />
              </div>
            </label>
            <label className="block text-xs font-medium text-zinc-500">A good result — what does a good run look like? (each run is graded against this)
              <div className="relative mt-1">
                <textarea value={rubric} onChange={(e) => { dirtyRef.current = true; setRubric(e.target.value); }} rows={3} placeholder="e.g. Has 3 bullets. Each is one short sentence. Mentions a source." className={cfgInp + ' pr-11'} />
                <DictateButton onText={(t) => { dirtyRef.current = true; setRubric((p) => (p ? p + ' ' : '') + t); }} className="absolute right-2 top-2" />
              </div>
            </label>
            <button onClick={saveCfg} disabled={savingCfg} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900">{savingCfg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save</button>
            <p className="text-[11px] text-zinc-400">Tip: you can also change all of this by talking to it — try the <button onClick={() => setMode('chat')} className="text-violet-600 hover:underline dark:text-violet-400">💬 Chat</button> tab.</p>
          </section>

          {/* Skills */}
          <section className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold">Skills it uses</h2>
            {allSkills === null ? (
              <div className="h-8 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
            ) : allSkills.length === 0 ? (
              <p className="text-xs text-zinc-500">No skills installed yet — add some on the <button onClick={() => nav('/skills')} className="text-emerald-600 hover:underline">Skills</button> page.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {allSkills.map((sk: any) => {
                    const on = (a?.skills || []).includes(sk.id);
                    return (
                      <button key={sk.id} title={sk.description || sk.title}
                        onClick={async () => { const next = on ? (a.skills || []).filter((x: string) => x !== sk.id) : [...(a.skills || []), sk.id]; await patch({ skills: next }); toast('success', on ? `Removed ${sk.title}` : `Attached ${sk.title}`); }}
                        className={'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' + (on ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-zinc-200 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700')}>
                        {on ? '✓ ' : ''}{sk.title}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-zinc-400">Attached skills ride along on every run (up to 3 are used).</p>
              </>
            )}
          </section>

          {/* Schedule */}
          <section className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold">When it runs</h2>
            <SchedulePicker value={a?.schedule || null} onChange={async (s) => { setA((p: any) => ({ ...p, schedule: s, scheduleText: schedText(s) })); const d = await patch({ schedule: s, scheduleText: schedText(s) }); if (d) toast('success', schedText(s) ? `Saved — ${schedText(s)}` : 'Saved — manual only'); }} />
          </section>

          {/* History retention + move (BEA-1099) */}
          <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div>
              <h2 className="text-sm font-semibold">Keep history for</h2>
              <select value={a.keepDays == null ? '' : String(a.keepDays)} onChange={async (e) => { const v = e.target.value; const d = await patch({ keepDays: v === '' ? null : Number(v) }); if (d) toast('success', v === '' ? 'History kept forever' : `Old entries clear after ${v} days`); }} className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">Forever (good for research)</option>
                <option value="30">30 days (good for daily news)</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </select>
              <p className="mt-1 text-[11px] text-zinc-400">Only finished entries are cleared. Saved documents are never touched.</p>
            </div>
            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold">Move to another agent</h2>
              {areas === null ? (
                <button onClick={() => fetch('/api/agent/areas').then((r) => r.json()).then((d) => setAreas(Array.isArray(d) ? d.filter((x: any) => x.id !== a.areaId) : []))} className="mt-1.5 text-xs text-emerald-600 hover:underline">Choose an agent…</button>
              ) : (
                <div className="mt-1.5 flex gap-2">
                  <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900">
                    <option value="">Pick where this job goes…</option>
                    {areas.map((ar: any) => <option key={ar.id} value={ar.id}>{ar.icon ? ar.icon + ' ' : ''}{ar.name}</option>)}
                  </select>
                  <button disabled={!moveTo} onClick={async () => {
                    const r = await fetch(`/api/agent/agents/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ areaId: moveTo }) });
                    if (r.ok) { toast('success', 'Moved'); setAreas(null); setMoveTo(''); load(); } else toast('error', 'Could not move');
                  }} className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900">Move</button>
                </div>
              )}
              <p className="mt-1 text-[11px] text-zinc-400">All its history and settings travel with it.</p>
            </div>
          </section>

          {/* Links out to the deeper views */}
          <section className="rounded-2xl border border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
            {[
              { icon: Workflow, label: 'Flow — the picture of its steps', right: flow ? `${(flow.graph?.nodes || []).length} blocks` : 'none yet', tab: 'Flow' },
              { icon: ListChecks, label: 'Tests', right: `${(a.evals || []).length}`, tab: 'Evals' },
              { icon: HistoryIcon, label: 'History', right: `${(runs || []).length} runs`, tab: 'Runs' },
            ].map((row) => (
              <button key={row.tab} onClick={() => nav(`/agent/agents/${id}?tab=${row.tab}`)} className="flex w-full items-center gap-3 border-t border-zinc-100 py-3 text-left text-sm first:border-t-0 dark:border-zinc-800">
                <row.icon className="h-4 w-4 text-zinc-400" />
                <span className="flex-1">{row.label}</span>
                <span className="text-xs text-zinc-400">{row.right}</span>
                <ChevronRight className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />
              </button>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
