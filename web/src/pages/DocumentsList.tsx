import { useEffect, useState } from 'react';
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
};

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

  const cols: Column<Doc>[] = [
    { key: 'title', label: 'Title', sortable: true },
    { key: 'source', label: 'Source', sortable: true, render: (r) => <span className="capitalize">{r.source}</span> },
    { key: 'createdAt', label: 'Added', sortable: true, render: (r) => new Date(r.createdAt).toLocaleDateString() },
    { key: 'memoryStatus', label: 'Stored in', align: 'right', render: (r) => <StoreBadges supermemory={r.supermemory} rag={r.rag} chunked={r.chunked} /> },
    { key: 'id', label: '', align: 'right', render: (r) => (
      <button onClick={() => setDel(r)} className="text-xs text-red-500 hover:underline">
        Delete
      </button>
    ) },
  ];

  const filters: Filter[] = [
    { key: 'source', label: 'Source', options: [{ value: 'upload', label: 'Upload' }, { value: 'url', label: 'Link' }, { value: 'notion', label: 'Notion' }] },
    { key: 'memoryStatus', label: 'Store', options: [{ value: 'synced', label: 'Synced' }, { value: 'pending', label: 'Pending' }] },
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
        <div className="mt-2 text-right">
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
