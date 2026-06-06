import { useEffect, useState } from 'react';
import { Eye, Trash2, Upload, Link2, FileText, type LucideIcon } from 'lucide-react';
import { DataTable, Column, Filter, SortOption } from '../ui/DataTable';
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

const SOURCE: Record<string, { icon: LucideIcon; color: string }> = {
  upload: { icon: Upload, color: 'text-blue-500 bg-blue-500/10' },
  url: { icon: Link2, color: 'text-emerald-500 bg-emerald-500/10' },
  notion: { icon: FileText, color: 'text-purple-500 bg-purple-500/10' },
};

function openDoc(r: Doc) {
  if (r.source === 'notion' && r.sourceUrl) window.open(r.sourceUrl, '_blank', 'noopener');
  else window.open(`/view/${r.id}`, '_blank', 'noopener');
}

function Chip({ t }: { t: string }) {
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
      {t}
    </span>
  );
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

  // Columns drive search only (table is hidden in cardsOnly mode).
  const cols: Column<Doc>[] = [
    { key: 'title', label: 'Title' },
    { key: 'source', label: 'Source' },
    { key: 'summary', label: 'Summary' },
  ];

  const filters: Filter[] = [
    { key: 'source', label: 'Source', options: [{ value: 'upload', label: 'Upload' }, { value: 'url', label: 'Link' }, { value: 'notion', label: 'Notion' }] },
    { key: 'memoryStatus', label: 'Store', options: [{ value: 'synced', label: 'Synced' }, { value: 'pending', label: 'Pending' }] },
    ...(allTags.length
      ? [{ key: 'tags', label: 'Tag', options: allTags.map((t) => ({ value: t, label: t })), match: (row: Doc, val: string) => (row.tags || []).includes(val) } as Filter]
      : []),
  ];

  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Oldest', key: 'createdAt', dir: 1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  function card(r: Doc) {
    const meta = SOURCE[r.source] || SOURCE.upload;
    const Icon = meta.icon;
    return (
      <div className="group h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:shadow-lg hover:border-emerald-500/40 transition-all">
        <div className="flex items-start gap-3">
          <div className={'shrink-0 rounded-lg p-2 ' + meta.color}>
            <Icon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold leading-snug truncate">{r.title}</h3>
              <div className="flex items-center gap-1 shrink-0 opacity-70 sm:opacity-0 sm:group-hover:opacity-100 transition">
                <button onClick={() => openDoc(r)} title="View" className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-emerald-600">
                  <Eye size={15} />
                </button>
                <button onClick={() => setDel(r)} title="Delete" className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-red-500">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            {r.summary && <p className="text-sm text-zinc-500 mt-0.5 line-clamp-2">{r.summary}</p>}
            {r.tags?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {r.tags.slice(0, 5).map((t) => <Chip key={t} t={t} />)}
              </div>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-xs text-zinc-400 capitalize truncate">
                {r.source} · {new Date(r.createdAt).toLocaleDateString()}
              </span>
              <StoreBadges supermemory={r.supermemory} rag={r.rag} chunked={r.chunked} />
            </div>
          </div>
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
        sortOptions={sortOptions}
        renderCard={card}
        cardsOnly
        pageSize={12}
        emptyText="No documents yet — capture one with the buttons above."
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
