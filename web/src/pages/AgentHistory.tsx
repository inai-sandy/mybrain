import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DataTable, Column, Filter } from '../ui/DataTable';
import { StatusBadge, timeAgo } from './Agents';

const GRADE_BADGE: Record<string, string> = {
  pass: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  fail: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
function GradeBadge({ grade }: { grade: { verdict: string; score: number } }) {
  return <span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + (GRADE_BADGE[grade.verdict] || GRADE_BADGE.partial)}>{grade.verdict} · {grade.score}</span>;
}

export function AgentHistory() {
  const nav = useNavigate();
  const [runs, setRuns] = useState<any[] | null>(null);

  useEffect(() => {
    fetch('/api/agent/runs?limit=500').then((r) => r.json()).then(setRuns).catch(() => setRuns([]));
  }, []);

  const columns: Column<any>[] = [
    { key: 'title', label: 'Agent', sortable: true, render: (r) => <span className="font-medium">{r.title || 'Agent run'}</span> },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'grade', label: 'Outcome', render: (r) => (r.grade ? <GradeBadge grade={r.grade} /> : <span className="text-xs text-zinc-400">—</span>) },
    { key: 'startedAt', label: 'When', sortable: true, render: (r) => <span className="text-zinc-500">{timeAgo(r.startedAt)}</span> },
    { key: 'outputDocId', label: 'Output', render: (r) => (r.outputDocId ? <span className="text-xs text-emerald-600 dark:text-emerald-400">document ↗</span> : <span className="text-xs text-zinc-400">—</span>) },
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
        { value: 'cancelled', label: 'Cancelled' },
      ],
    },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <button onClick={() => nav('/agent')} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" />
        Agents
      </button>
      <h1 className="mb-4 text-xl font-bold">Run history</h1>
      <DataTable
        columns={columns}
        rows={runs || []}
        loading={runs === null}
        searchable
        filters={filters}
        pageSize={15}
        emptyText="No runs yet — start an agent from the Agents page."
        onRowClick={(r: any) => nav(`/agent/runs/${r.id}`)}
      />
    </div>
  );
}
