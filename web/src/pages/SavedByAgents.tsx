import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGoBack } from '../ui/useGoBack';
import { ArrowLeft, Trash2, FileText, Brain } from 'lucide-react';
import { DataTable, Column } from '../ui/DataTable';
import { useToast } from '../ui/Toast';
import { timeAgo } from './Agents';

/** "Saved by agents" (BEA-700) — see and undo everything agents wrote to your brain / Documents. */
export function SavedByAgents() {
  const nav = useNavigate();
  const goBack = useGoBack('/agent');
  const toast = useToast();
  const [data, setData] = useState<{ documents: any[]; brainLearnings: any[] } | null>(null);

  function load() {
    fetch('/api/agent/saved').then((r) => r.json()).then(setData).catch(() => setData({ documents: [], brainLearnings: [] }));
  }
  useEffect(() => { load(); }, []);

  async function delDoc(id: string) {
    try {
      const r = await fetch(`/api/agent/saved/doc/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Could not delete');
      setData((d) => (d ? { ...d, documents: d.documents.filter((x) => x.id !== id) } : d));
      toast('success', 'Deleted');
    } catch (e: any) { toast('error', e.message || 'Could not delete'); }
  }
  async function clearLearnings() {
    try {
      await fetch('/api/agent/saved/clear-learnings', { method: 'POST' });
      setData((d) => (d ? { ...d, brainLearnings: [] } : d));
      toast('success', 'Cleared agent learnings from your brain');
    } catch { toast('error', 'Could not clear'); }
  }

  const columns: Column<any>[] = [
    { key: 'title', label: 'Document', sortable: true, render: (r) => (<div><div className="font-medium">{r.title}</div>{r.snippet && <div className="line-clamp-1 text-xs text-zinc-500">{r.snippet}</div>}</div>) },
    { key: 'when', label: 'When', sortable: true, render: (r) => <span className="text-zinc-500">{timeAgo(r.when)}</span> },
    { key: '_del', label: '', render: (r) => <button onClick={(e) => { e.stopPropagation(); if (window.confirm('Delete this document? This removes it from your library.')) delDoc(r.id); }} title="Delete" className="rounded-lg p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button> },
  ];

  return (
    <div>
      <button onClick={goBack} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Back</button>
      <h1 className="mb-1 text-xl font-bold">Saved by agents</h1>
      <p className="mb-4 text-sm text-zinc-500">Everything your agents wrote — review and undo anything you don't want kept.</p>

      {data && data.brainLearnings.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/50 px-4 py-3 dark:border-indigo-500/30 dark:bg-indigo-500/10">
          <div className="flex items-center gap-2 text-sm"><Brain className="h-4 w-4 text-indigo-500" />{data.brainLearnings.length} learning{data.brainLearnings.length === 1 ? '' : 's'} kept in your brain (RAG + SuperMemory)</div>
          <button onClick={() => { if (window.confirm('Clear all agent learnings from your brain?')) clearLearnings(); }} className="text-sm font-medium text-red-600 hover:text-red-500">Clear all</button>
        </div>
      )}

      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-500"><FileText className="h-4 w-4" />Documents agents saved</div>
      <DataTable columns={columns} rows={data?.documents || []} loading={data === null} searchable pageSize={15} emptyText="No documents saved by agents yet." />
    </div>
  );
}
