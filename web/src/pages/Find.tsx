import { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { DataTable, Column, SortOption } from '../ui/DataTable';

type SMDoc = { id: string; title: string; summary: string; tags: string[]; createdAt: string; status: string };

function Chip({ t }: { t: string }) {
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
      {t}
    </span>
  );
}

export function Find() {
  const [docs, setDocs] = useState<SMDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/memory/browse?limit=100')
      .then((r) => r.json())
      .then((d) => {
        setDocs(d.docs || []);
        setTotal(d.total || 0);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const cols: Column<SMDoc>[] = [
    { key: 'title', label: 'Title' },
    { key: 'summary', label: 'Summary' },
  ];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  function card(r: SMDoc) {
    return (
      <div className="h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-emerald-500/40 hover:shadow-md transition-all">
        <div className="flex items-start gap-2.5">
          <div className="shrink-0 rounded-lg p-2 bg-emerald-500/10 text-emerald-600">
            <Brain size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold leading-snug line-clamp-1">{r.title}</h3>
            {r.summary && <p className="text-sm text-zinc-500 mt-0.5 line-clamp-3">{r.summary}</p>}
            {r.tags?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {r.tags.slice(0, 5).map((t) => <Chip key={t} t={t} />)}
              </div>
            )}
            <div className="mt-2 text-xs text-zinc-400">{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold">Find</h1>
        <p className="text-zinc-500">Browse everything in your SuperMemory — {total} document{total === 1 ? '' : 's'} (including ones added outside this app).</p>
      </div>
      <DataTable<SMDoc>
        columns={cols}
        rows={docs}
        loading={loading}
        sortOptions={sortOptions}
        renderCard={card}
        cardsOnly
        pageSize={12}
        emptyText="Nothing in SuperMemory yet."
      />
    </div>
  );
}
