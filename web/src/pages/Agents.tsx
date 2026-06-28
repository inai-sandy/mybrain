import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Play, Loader2, FileText, CheckCircle2, AlertTriangle, Clock, XCircle, PauseCircle } from 'lucide-react';
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

export function Agents() {
  const nav = useNavigate();
  const toast = useToast();
  const [engine, setEngine] = useState<{ ok?: boolean; version?: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetch('/api/agent/engine').then((r) => r.json()).then(setEngine).catch(() => setEngine({ ok: false }));
    fetch('/api/agent/runs?limit=20').then((r) => r.json()).then(setRuns).catch(() => setRuns([]));
  }, []);

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
        <GrowTextarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do?  e.g. “Summarise the pros and cons of three CRM tools and write it up.”"
          className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400"
          minHeight={64}
          maxHeight={220}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700"
          />
          <button
            onClick={run}
            disabled={starting || !prompt.trim()}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run
          </button>
        </div>
        {engine && !engine.ok && <p className="text-xs text-amber-600">The agent engine isn’t reachable right now, so a run may not start.</p>}
      </div>

      {/* Recent runs */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-500">Recent runs</h2>
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
