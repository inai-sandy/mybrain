import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Play, Loader2, FileText, CheckCircle2, AlertTriangle, Clock, XCircle, PauseCircle, Plus, Trash2, Power, History as HistoryIcon, CalendarClock } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { GrowTextarea } from '../ui/GrowTextarea';

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

function NewAgentForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [every, setEvery] = useState('manual');
  const [at, setAt] = useState('07:00');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || !task.trim()) { toast('error', 'Give it a name and a task'); return; }
    let schedule: any = null;
    let scheduleText: string | undefined;
    if (every === 'day') { schedule = { every: 'day', at }; scheduleText = `Every day at ${at}`; }
    else if (every === 'weekday') { schedule = { every: 'weekday', at }; scheduleText = `Every weekday at ${at}`; }
    else if (every === 'hour') { schedule = { every: 'hour', minute: Number(at.split(':')[1]) || 0 }; scheduleText = `Every hour at :${at.split(':')[1] || '00'}`; }
    setSaving(true);
    try {
      const r = await fetch('/api/agent/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), prompt: task.trim(), schedule, scheduleText }) });
      if (!r.ok) throw new Error('Could not save');
      onCreated();
    } catch (e: any) { toast('error', e?.message || 'Could not save'); } finally { setSaving(false); }
  }

  return (
    <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name (e.g. Morning Brief)" className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
      <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="What should it do each time it runs?" className="w-full resize-none rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
      <div className="flex flex-wrap items-center gap-2">
        <select value={every} onChange={(e) => setEvery(e.target.value)} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <option value="manual">Manual (run by hand)</option>
          <option value="day">Every day</option>
          <option value="weekday">Every weekday</option>
          <option value="hour">Every hour</option>
        </select>
        {every !== 'manual' && <input type="time" value={at} onChange={(e) => setAt(e.target.value)} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />}
        <div className="ml-auto flex gap-2">
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Save</button>
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
  const [agents, setAgents] = useState<any[] | null>(null);
  const [showNew, setShowNew] = useState(false);

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

  async function run() {
    const text = prompt.trim();
    if (!text) { toast('error', 'Type a task for the agent first'); return; }
    setStarting(true);
    try {
      const r = await fetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, title: title.trim() || undefined }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).message || 'Could not start');
      const row = await r.json();
      nav(`/agent/runs/${row.id}`);
    } catch (e: any) {
      toast('error', e?.message || 'Could not start the agent');
      setStarting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
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

      {/* Run box */}
      <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <label className="block text-xs font-medium text-zinc-500">Task</label>
        <div className="rounded-xl border border-zinc-300 bg-zinc-50 transition-colors focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950">
          <GrowTextarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?  e.g. “Research the best electric cars and write a short brief.”"
            className="w-full bg-transparent px-3 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
            minHeight={76}
            maxHeight={240}
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Name this run (optional)"
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700"
          />
          <button
            onClick={run}
            disabled={starting || !prompt.trim()}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run
          </button>
        </div>
        {engine && !engine.ok && <p className="text-xs text-amber-600">The agent engine isn’t reachable right now, so a run may not start.</p>}
      </div>

      {/* Saved agents */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-500">Saved agents</h2>
          <button onClick={() => setShowNew((v) => !v)} className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:text-emerald-500"><Plus className="h-4 w-4" />New agent</button>
        </div>
        {showNew && <NewAgentForm onCreated={() => { setShowNew(false); loadAgents(); }} onCancel={() => setShowNew(false)} />}
        {agents === null ? (
          <div className="h-12 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        ) : agents.length === 0 ? (
          !showNew && <div className="rounded-2xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">No saved agents yet. Create one to run it again or on a schedule.</div>
        ) : (
          <ul className="space-y-2">
            {agents.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.icon ? a.icon + ' ' : ''}{a.name}</div>
                  <div className="flex items-center gap-1 text-xs text-zinc-500">
                    {a.scheduleText ? <><CalendarClock className="h-3 w-3 shrink-0" /><span className="truncate">{a.scheduleText}</span></> : <span>Manual</span>}
                    {!a.enabled && <span className="ml-1 rounded bg-zinc-100 px-1 dark:bg-zinc-800">paused</span>}
                  </div>
                </div>
                <button onClick={() => runSaved(a.id)} title="Run now" className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"><Play className="h-4 w-4" /></button>
                <button onClick={() => toggleSaved(a)} title={a.enabled ? 'Pause schedule' : 'Resume schedule'} className={'rounded-lg p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (a.enabled ? 'text-zinc-500' : 'text-zinc-400')}><Power className="h-4 w-4" /></button>
                <button onClick={() => { if (window.confirm(`Delete "${a.name}"?`)) delSaved(a.id); }} title="Delete" className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent runs */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-500">Recent runs</h2>
          <button onClick={() => nav('/agent/history')} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><HistoryIcon className="h-4 w-4" />All runs</button>
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
              <li key={r.id}>
                <button
                  onClick={() => nav(`/agent/runs/${r.id}`)}
                  className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.title || 'Agent run'}</div>
                    <div className="text-xs text-zinc-500">{timeAgo(r.startedAt)}</div>
                  </div>
                  {r.outputDocId && <FileText className="h-4 w-4 shrink-0 text-zinc-400" />}
                  <StatusBadge status={r.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
