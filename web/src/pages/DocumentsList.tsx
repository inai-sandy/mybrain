import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { DataTable, Column, Filter } from '../ui/DataTable';
import { StoreBadges } from '../ui/StoreBadges';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

export type Doc = {
  id: string;
  title: string;
  source: string;
  createdAt: string;
  supermemory: boolean;
  rag: boolean;
  chunked: boolean;
  memoryStatus: string;
  sourceUrl?: string | null;
  tags: string[];
  summary?: string | null;
};

function Chip({ t }: { t: string }) {
  return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{t}</span>;
}

/** Notion docs open the original Notion page; everything else opens the markdown viewer. */
function openDoc(r: Doc) {
  if (r.source === 'notion' && r.sourceUrl) window.open(r.sourceUrl, '_blank', 'noopener');
  else window.open(`/view/${r.id}`, '_blank', 'noopener');
}

export function DocumentsList({ onCount }: { onCount?: (n: number) => void }) {
  const [items, setItems] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [del, setDel] = useState<Doc | null>(null);
  const toast = useToast();

  async function load() {
    setLoading(true);
    const r = await fetch('/api/items');
    if (r.ok) {
      const d = await r.json();
      setItems(d.items || []);
      onCount?.((d.items || []).length);
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function remove(it: Doc) {
    const r = await fetch(`/api/items/${it.id}`, { method: 'DELETE' });
    setDel(null);
    if (r.ok) {
      toast('success', 'Deleted');
      load();
    } else toast('error', 'Could not delete');
  }

  const allTags = Array.from(new Set(items.flatMap((i) => i.tags || []))).sort();

  const cols: Column<Doc>[] = [
    { key: 'title', label: 'Title', sortable: true, render: (r) => (
      <div className="min-w-0">
        <div className="font-medium">{r.title}</div>
        {r.summary && <div className="text-xs text-zinc-500 truncate max-w-md">{r.summary}</div>}
        {r.tags?.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {r.tags.slice(0, 4).map((t) => <Chip key={t} t={t} />)}
          </div>
        )}
      </div>
    ) },
    { key: 'source', label: 'Source', sortable: true, render: (r) => <span className="capitalize">{r.source}</span> },
    { key: 'createdAt', label: 'Added', sortable: true, render: (r) => new Date(r.createdAt).toLocaleDateString() },
    { key: 'memoryStatus', label: 'Stored in', align: 'right', render: (r) => <StoreBadges supermemory={r.supermemory} rag={r.rag} chunked={r.chunked} /> },
    { key: 'id', label: '', align: 'right', render: (r) => (
      <div className="inline-flex items-center gap-3 justify-end">
        <button onClick={() => openDoc(r)} title="View" className="text-zinc-400 hover:text-emerald-600">
          <Eye size={16} />
        </button>
        <button onClick={() => setDel(r)} className="text-xs text-red-500 hover:underline">
          Delete
        </button>
      </div>
    ) },
  ];

  const filters: Filter[] = [
    { key: 'source', label: 'Source', options: [{ value: 'upload', label: 'Upload' }, { value: 'url', label: 'Link' }, { value: 'notion', label: 'Notion' }] },
    { key: 'memoryStatus', label: 'Store', options: [{ value: 'synced', label: 'Synced' }, { value: 'pending', label: 'Pending' }] },
    ...(allTags.length
      ? [{ key: 'tags', label: 'Tag', options: allTags.map((t) => ({ value: t, label: t })), match: (row: Doc, val: string) => (row.tags || []).includes(val) } as Filter]
      : []),
  ];

  function card(r: Doc) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium truncate">{r.title}</div>
            <div className="text-xs text-zinc-500 capitalize">
              {r.source} · {new Date(r.createdAt).toLocaleDateString()}
            </div>
          </div>
          <StoreBadges supermemory={r.supermemory} rag={r.rag} chunked={r.chunked} />
        </div>
        {r.summary && <p className="mt-2 text-xs text-zinc-500">{r.summary}</p>}
        {r.tags?.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {r.tags.slice(0, 5).map((t) => <Chip key={t} t={t} />)}
          </div>
        )}
        <div className="mt-2 flex items-center justify-end gap-3">
          <button onClick={() => openDoc(r)} className="inline-flex items-center gap-1 text-xs text-emerald-600">
            <Eye size={14} /> View
          </button>
          <button onClick={() => setDel(r)} className="text-xs text-red-500">
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <DataTable<Doc>
        columns={cols}
        rows={items}
        loading={loading}
        filters={filters}
        renderCard={card}
        emptyText="No documents yet — capture one above."
      />
      <ConfirmDialog
        open={!!del}
        title="Delete this document?"
        message={del?.title}
        onCancel={() => setDel(null)}
        onConfirm={() => del && remove(del)}
      />
    </>
  );
}
