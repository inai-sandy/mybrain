import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash2, RotateCcw } from 'lucide-react';
import { DataTable, Column, Filter } from '../ui/DataTable';
import { StatusBadge, timeAgo } from './Agents';
import { useToast } from '../ui/Toast';

const GRADE_BADGE: Record<string, string> = {
  pass: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  fail: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
function GradeBadge({ grade }: { grade: { verdict: string; score: number } }) {
  return <span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + (GRADE_BADGE[grade.verdict] || GRADE_BADGE.partial)}>{grade.verdict} · {grade.score}</span>;
}

function fmtDuration(sec?: number | null): string {
  if (sec == null) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One honest history of EVERY run — agents and flows together (BEA-1069). */
export function AgentHistory() {
  const nav = useNavigate();
  const toast = useToast();
  const [runs, setRuns] = useState<any[] | null>(null);

  function load() {
    fetch('/api/agent/history?limit=500').then((r) => r.json()).then(setRuns).catch(() => setRuns([]));
  }
  useEffect(() => { load(); }, []);

  async function del(row: any) {
    try {
      const url = row.source === 'flow' ? `/api/flows/runs/${row.id}` : `/api/agent/runs/${row.id}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).message || 'Could not delete');
      setRuns((p) => (p || []).filter((x) => x.id !== row.id));
      toast('success', 'Run deleted');
    } catch (e: any) { toast('error', e.message || 'Could not delete'); }
  }

  const live = (s: string) => s === 'running' || s === 'awaiting_input' || s === 'waiting' || s === 'paused';

  // Replay a finished run on the same captured input (BEA-1070) — fix at noon, don't wait for tomorrow.
  const [replaying, setReplaying] = useState<string | null>(null);
  async function replay(row: any) {
    if (replaying) return;
    setReplaying(row.id);
    try {
      const url = row.source === 'flow' ? `/api/flows/runs/${row.id}/replay` : `/api/agent/runs/${row.id}/replay`;
      const d = await (await fetch(url, { method: 'POST' })).json();
      if (d?.ok === false) throw new Error(d.message || 'Could not replay');
      const newId = row.source === 'flow' ? d.runId : d.id;
      if (!newId) throw new Error('Could not replay');
      toast('success', 'Replaying on the same input…');
      nav(row.source === 'flow' ? `/flows/runs/${newId}` : `/agent/runs/${newId}`);
    } catch (e: any) { toast('error', e?.message || 'Could not replay'); setReplaying(null); }
  }

  const columns: Column<any>[] = [
    { key: 'name', label: 'Run', sortable: true, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'source', label: 'Kind', sortable: true, render: (r) => <span className={'rounded-full px-2 py-0.5 text-xs capitalize ' + (r.source === 'flow' ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300')}>{r.source}</span> },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'grade', label: 'Outcome', render: (r) => (r.grade ? <GradeBadge grade={r.grade} /> : <span className="text-xs text-zinc-400">—</span>) },
    { key: 'durationSec', label: 'Took', sortable: true, render: (r) => <span className="text-xs text-zinc-500">{fmtDuration(r.durationSec) || (live(r.status) ? '…' : '—')}</span> },
    { key: 'startedAt', label: 'When', sortable: true, render: (r) => <span className="text-zinc-500">{timeAgo(r.startedAt)}</span> },
    { key: 'outputDocId', label: 'Output', render: (r) => (r.outputDocId ? <span className="text-xs text-emerald-600 dark:text-emerald-400">document ↗</span> : <span className="text-xs text-zinc-400">—</span>) },
    { key: '_act', label: '', render: (r) => (live(r.status) ? null : (
      <span className="flex items-center gap-0.5">
        <button onClick={(e) => { e.stopPropagation(); replay(r); }} disabled={!!replaying} title="Replay on the same input" className="rounded-lg p-1.5 text-zinc-300 hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-40 dark:text-zinc-600 dark:hover:bg-emerald-500/10"><RotateCcw className="h-4 w-4" /></button>
        <button onClick={(e) => { e.stopPropagation(); if (window.confirm('Delete this run? Saved documents are kept.')) del(r); }} title="Delete run" className="rounded-lg p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
      </span>
    )) },
  ];

  const filters: Filter[] = [
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'done', label: 'Done' },
        { value: 'failed', label: 'Failed' },
        { value: 'running', label: 'Running' },
        { value: 'awaiting_input', label: 'Waiting on you' },
        { value: 'waiting', label: 'Waiting (flow)' },
        { value: 'paused', label: 'Paused' },
        { value: 'cancelled', label: 'Cancelled' },
      ],
    },
    {
      key: 'source',
      label: 'Kind',
      options: [
        { value: 'agent', label: 'Agents' },
        { value: 'flow', label: 'Flows' },
      ],
    },
  ];

  return (
    <div>
      <button onClick={() => nav('/agent')} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" />
        Agents
      </button>
      <h1 className="mb-4 text-xl font-bold">Every run</h1>
      <DataTable
        columns={columns}
        rows={runs || []}
        loading={runs === null}
        searchable
        filters={filters}
        pageSize={15}
        emptyText="No runs yet — start an agent from the Agents page."
        onRowClick={(r: any) => nav(r.source === 'flow' ? `/flows/runs/${r.id}` : `/agent/runs/${r.id}`)}
      />
    </div>
  );
}
