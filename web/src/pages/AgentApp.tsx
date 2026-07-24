import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Play, Settings as GearIcon, Sparkles, FileText, CheckCircle2, RotateCcw } from 'lucide-react';
import { useGoBack } from '../ui/useGoBack';
import { useToast } from '../ui/Toast';
import { Markdown } from '../ui/markdown';
import { DictateButton } from '../ui/DictateButton';
import { GrowTextarea } from '../ui/GrowTextarea';
import { StatusBadge, timeAgo } from './Agents';

type UiInput = { key: string; label: string; type: 'topic' | 'text' | 'url' | 'contact' | 'date' | 'choice'; placeholder?: string; options?: string[] };
type UiSpec = { headline: string; inputs: UiInput[]; view: 'report' | 'brief' | 'checklist' | 'plain'; runLabel: string };

/**
 * The agent's own mini-app (BEA-1082): an AI-designed screen from approved blocks — the right
 * inputs, the right result view, one Run button. The techy Build/Flow/Evals/Runs workspace lives
 * behind the ⚙ gear.
 */
export function AgentApp() {
  const { id } = useParams();
  const nav = useNavigate();
  const goBack = useGoBack('/agent');
  const toast = useToast();
  const [a, setA] = useState<any>(null);
  const [spec, setSpec] = useState<UiSpec | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [liveRun, setLiveRun] = useState<any>(null);
  const [runs, setRuns] = useState<any[] | null>(null);
  const [redesigning, setRedesigning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    const d = await fetch(`/api/agent/agents/${id}`).then((r) => r.json()).catch(() => null);
    if (!d?.id) { setA(null); return; }
    setA(d);
    if (d.ui) setSpec(d.ui);
    else {
      // first visit: the designer builds this agent's screen once, then it's stored
      const s = await fetch(`/api/agent/agents/${id}/ui/generate`, { method: 'POST' }).then((r) => r.json()).catch(() => null);
      if (s?.view) setSpec(s);
      else setSpec({ headline: `Run ${d.name}`, inputs: [], view: 'report', runLabel: 'Run →' });
    }
    loadRuns();
  }
  async function loadRuns() {
    const rs = await fetch(`/api/agent/runs?agentId=${id}`).then((r) => r.json()).catch(() => []);
    const list = Array.isArray(rs) ? rs : [];
    setRuns(list);
    const live = list.find((r: any) => r.status === 'running' || r.status === 'awaiting_input' || r.status === 'paused');
    setLiveRun(live || null);
    if (live && !pollRef.current) pollRef.current = setInterval(loadRuns, 4000);
    if (!live && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }
  useEffect(() => { load(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; /* eslint-disable-next-line */ }, [id]);

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

  if (a === null) return <div className="p-6 text-sm text-zinc-500">This agent doesn't exist any more. <button onClick={() => nav('/agent')} className="text-emerald-600 hover:underline">Back to Agents</button></div>;
  if (!a || !spec) return <div className="space-y-3"><div className="h-16 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /><div className="h-40 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /></div>;

  const latest = (runs || []).find((r: any) => r.status === 'done' && r.resultText);
  const color = a.color || '#818cf8';
  const inp = 'w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900';

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Agents</button>

      <header className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl" style={{ background: color + '22' }}>{a.icon || '🤖'}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold">{a.name}</h1>
          <p className="truncate text-sm text-zinc-500">{a.description || a.scheduleText || 'Your agent'}</p>
        </div>
        <button onClick={redesign} disabled={redesigning} title="Redesign this screen" className="rounded-xl border border-zinc-200 p-2 text-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:hover:text-zinc-200">{redesigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}</button>
        <button onClick={() => nav(`/agent/agents/${id}`)} title="Open the workshop (Build · Flow · Evals · Runs)" className="rounded-xl border border-zinc-200 p-2 text-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:hover:text-zinc-200"><GearIcon className="h-4 w-4" /></button>
      </header>

      {/* the input card — this agent's own controls */}
      <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" style={{ borderTop: `3px solid ${color}` }}>
        <h2 className="text-base font-semibold">{spec.headline}</h2>
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

      {/* the latest result, rendered the way this agent's output reads best */}
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

      {/* past runs, compact */}
      {(runs || []).length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Past runs</h3>
          {(runs || []).slice(0, 6).map((r: any) => (
            <button key={r.id} onClick={() => nav(`/agent/runs/${r.id}`)} className="flex w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="min-w-0 flex-1 truncate">{r.title || a.name}</span>
              {r.id === latest?.id ? null : r.status === 'done' && <button onClick={(e) => { e.stopPropagation(); fetch(`/api/agent/runs/${r.id}/replay`, { method: 'POST' }).then(() => loadRuns()); }} title="Replay" className="rounded p-1 text-zinc-300 hover:text-emerald-600"><RotateCcw className="h-3.5 w-3.5" /></button>}
              <span className="shrink-0 text-xs text-zinc-400">{timeAgo(r.startedAt)}</span>
              <StatusBadge status={r.status} />
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
