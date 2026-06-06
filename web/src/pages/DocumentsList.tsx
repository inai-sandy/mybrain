import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Trash2, RefreshCw, MessageCircle, Upload, Link2, FileText, Brain, type LucideIcon } from 'lucide-react';
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
  supermemory: { icon: Brain, color: 'text-indigo-500 bg-indigo-500/10' }, // synced from SuperMemory
};

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
  const [syncing, setSyncing] = useState<string | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

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
      toast('success', 'Deleted everywhere');
      load();
    } else toast('error', 'Could not delete');
  }

  async function sync(it: Doc) {
    setSyncing(it.id);
    const r = await fetch(`/api/items/${it.id}/sync`, { method: 'POST' });
    setSyncing(null);
    if (r.ok) {
      toast('success', 'Synced — memory refreshed');
      load();
    } else toast('error', (await r.json().catch(() => ({}))).message || 'Sync failed');
  }

  const allTags = Array.from(new Set(items.flatMap((i) => i.tags || []))).sort();

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

  const iconBtn = 'p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';

  function card(r: Doc) {
    const meta = SOURCE[r.source] || SOURCE.upload;
    const Icon = meta.icon;
    return (
      <div className="h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5 hover:border-emerald-500/40 hover:shadow-md transition-all flex flex-col">
        <div className="flex items-center gap-2.5">
          <div className={'shrink-0 rounded-lg p-2 ' + meta.color}>
            <Icon size={16} />
          </div>
          <button onClick={() => navigate(`/doc/${r.id}`)} className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold truncate hover:text-emerald-600">{r.title}</h3>
          </button>
        </div>
        {r.tags?.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {r.tags.slice(0, 4).map((t) => <Chip key={t} t={t} />)}
          </div>
        )}
        <div className="mt-auto pt-3 flex flex-wrap items-center justify-between gap-y-2 gap-x-2">
          <StoreBadges supermemory={r.supermemory} rag={r.rag} chunked={r.chunked} />
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => navigate(`/chat/${r.id}`)} title="Chat with this document" className={iconBtn + ' hover:text-emerald-600'}>
              <MessageCircle size={16} />
            </button>
            <button onClick={() => navigate(`/doc/${r.id}`)} title="View" className={iconBtn + ' hover:text-emerald-600'}>
              <Eye size={16} />
            </button>
            <button onClick={() => sync(r)} title="Sync (refresh memory)" className={iconBtn + ' hover:text-blue-500'}>
              <RefreshCw size={16} className={syncing === r.id ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setDel(r)} title="Delete everywhere" className={iconBtn + ' hover:text-red-500'}>
              <Trash2 size={16} />
            </button>
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
        message={del ? `"${del.title}" will be permanently removed from the app and from both memory stores (SuperMemory + RAG).` : ''}
        confirmLabel="Delete everywhere"
        onCancel={() => setDel(null)}
        onConfirm={() => del && remove(del)}
      />
    </>
  );
}
