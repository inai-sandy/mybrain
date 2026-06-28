import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DataTable, Column, Filter } from '../ui/DataTable';
import { StatusBadge, timeAgo } from './Agents';

export function AgentHistory() {
  const nav = useNavigate();
  const [runs, setRuns] = useState<any[] | null>(null);

  useEffect(() => {
    fetch('/api/agent/runs?limit=500').then((r) => r.json()).then(setRuns).catch(() => setRuns([]));
  }, []);

  const columns: Column<any>[] = [
    { key: 'title', label: 'Agent', sortable: true, render: (r) => <span className="font-medium">{r.title || 'Agent run'}</span> },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
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
