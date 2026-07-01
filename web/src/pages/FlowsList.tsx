import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Workflow, Plus, Trash2, Loader2 } from 'lucide-react';
import { useToast } from '../ui/Toast';

export function FlowsList() {
  const nav = useNavigate();
  const toast = useToast();
  const [flows, setFlows] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => fetch('/api/flows').then((r) => r.json()).then((d) => setFlows(d.flows || [])).catch(() => setFlows([]));
  useEffect(() => { load(); }, []);

  async function create() {
    setCreating(true);
    try {
      const r = await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Untitled flow' }) });
      const f = await r.json();
      nav(`/flows/${f.id}`);
    } catch { toast('error', 'Could not create'); setCreating(false); }
  }
  async function del(id: string) {
    if (!window.confirm('Delete this flow?')) return;
    await fetch(`/api/flows/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-500 text-white"><Workflow className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold">Flows</h1>
          <p className="truncate text-sm text-zinc-500">Chain your skills and tools on a canvas — split a question, run the branches, merge the result.</p>
        </div>
        <button onClick={create} disabled={creating} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}New flow</button>
      </header>

      {flows === null ? (
        <div className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
      ) : flows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">No flows yet. Create one to build a visual chain of skills and tools.</div>
      ) : (
        <ul className="space-y-2">
          {flows.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
              <button onClick={() => nav(`/flows/${f.id}`)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium hover:text-emerald-600">{f.name}</div>
                <div className="truncate text-xs text-zinc-500">{f.question || `${f.graph?.nodes?.length || 0} blocks`}</div>
              </button>
              <button onClick={() => del(f.id)} title="Delete" className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
