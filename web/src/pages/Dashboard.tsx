import { Bookmark, CheckSquare, FileText, Brain, type LucideIcon } from 'lucide-react';
import { DataTable, Column } from '../ui/DataTable';

function Stat({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-500">{label}</span>
        <Icon size={18} className="text-emerald-600" />
      </div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {hint && <div className="text-xs text-zinc-400 mt-1">{hint}</div>}
    </div>
  );
}

type Capture = { title: string; source: string; added: string };

export function Dashboard() {
  const cols: Column<Capture>[] = [
    { key: 'title', label: 'Title', sortable: true },
    { key: 'source', label: 'Source', sortable: true },
    { key: 'added', label: 'Added', sortable: true },
  ];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Dashboard</h1>
        <p className="text-zinc-500">Your research, bookmarks, and tasks — all in one place.</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={FileText} label="Notes" value="0" hint="captured" />
        <Stat icon={CheckSquare} label="Open tasks" value="0" hint="to do" />
        <Stat icon={Bookmark} label="Bookmarks" value="0" hint="from Raindrop" />
        <Stat icon={Brain} label="Memory" value="2" hint="stores synced" />
      </div>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400 mb-2">Recent captures</h2>
        <DataTable<Capture>
          columns={cols}
          rows={[]}
          emptyText="No captures yet — add your first markdown from the Capture tab."
        />
      </div>
    </div>
  );
}
