import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightbulb, Plus, X, Sparkles, Check, Circle, Link2, Trash2 } from 'lucide-react';
import { DataTable, Column, Filter, SortOption } from '../ui/DataTable';
import { useToast } from '../ui/Toast';

type Idea = {
  id: string;
  title: string;
  snippet: string;
  researchPrompt: string;
  status: string;
  createdAt: string;
  linkedCount: number;
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (d.toDateString() === new Date().toDateString()) return 'today';
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function CaptureModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [dump, setDump] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit() {
    if (!dump.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dump }) });
      if (r.ok) {
        toast('success', 'Idea captured & organized');
        onCreated();
        onClose();
      } else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold flex items-center gap-2">
            <Lightbulb className="text-amber-500" size={18} /> New idea
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-3">Dump everything on your mind — the AI will organize it into a title + content and build a /deep-research prompt.</p>
        <textarea
          autoFocus
          value={dump}
          onChange={(e) => setDump(e.target.value)}
          rows={7}
          placeholder="e.g. what if we used local mmwave radar + an llm to detect falls at home… privacy, cost, edge processing…"
          className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
          }}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={submit} disabled={busy || !dump.trim()} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
            {busy ? 'Organizing…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Ideas() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  async function load() {
    // NOTE: no setLoading(true) on refresh — keep current content on screen so scroll position survives
    try {
      const r = await fetch('/api/ideas');
      if (r.ok) setIdeas((await r.json()).ideas || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function copyPrompt(it: Idea) {
    try {
      await navigator.clipboard.writeText(it.researchPrompt);
      toast('success', 'Prompt copied — paste into Claude Code / chat');
    } catch {
      toast('error', 'Could not copy');
    }
  }

  async function toggleDone(it: Idea) {
    const next = it.status === 'done' ? 'open' : 'done';
    const r = await fetch(`/api/ideas/${it.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
    if (r.ok) setIdeas((prev) => prev.map((x) => (x.id === it.id ? { ...x, status: next } : x)));
  }

  const cols: Column<Idea>[] = [
    { key: 'title', label: 'Title' },
    { key: 'snippet', label: 'Summary' },
  ];
  const filters: Filter[] = [
    { key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] },
  ];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Oldest', key: 'createdAt', dir: 1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  async function remove(it: Idea) {
    if (!window.confirm(`Delete "${it.title}"? This permanently removes the idea, its research docs, its workflow, and its memory (RAG + SuperMemory). This can't be undone.`)) return;
    const r = await fetch(`/api/ideas/${it.id}`, { method: 'DELETE' });
    if (r.ok) { setIdeas((prev) => prev.filter((x) => x.id !== it.id)); toast('success', 'Idea deleted'); }
    else toast('error', 'Could not delete');
  }

  function card(it: Idea) {
    return (
      <div className={'group h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-col transition-all hover:border-emerald-500/40 hover:shadow-md ' + (it.status === 'done' ? 'opacity-70' : '')}>
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg p-2 bg-amber-500/10 text-amber-500">
            <Lightbulb size={18} />
          </div>
          <button onClick={() => navigate(`/ideas/${it.id}`)} className="min-w-0 flex-1 text-left">
            <h3 className={'font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600 ' + (it.status === 'done' ? 'line-through text-zinc-400' : '')}>{it.title}</h3>
          </button>
          <div className="flex items-center gap-0.5 shrink-0">
            {it.linkedCount > 0 && (
              <button onClick={() => navigate(`/ideas/${it.id}`)} title={`${it.linkedCount} research doc${it.linkedCount === 1 ? '' : 's'}`} className="p-1.5 rounded-md text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Link2 size={16} />
              </button>
            )}
            <button onClick={() => copyPrompt(it)} title="Copy /deep-research prompt" className="p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-emerald-600">
              <Sparkles size={16} />
            </button>
            <button
              onClick={() => toggleDone(it)}
              title={it.status === 'done' ? 'Mark open' : 'Mark as done'}
              className={'p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (it.status === 'done' ? 'text-emerald-600' : 'text-zinc-400 hover:text-emerald-600')}
            >
              {it.status === 'done' ? <Check size={16} /> : <Circle size={16} />}
            </button>
            <button onClick={() => remove(it)} title="Delete idea" className="p-1.5 rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10">
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        <button onClick={() => navigate(`/ideas/${it.id}`)} className="text-left">
          <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400 line-clamp-2">{it.snippet}</p>
        </button>
        <div className="mt-auto pt-3 flex items-center justify-between text-xs text-zinc-400">
          <span>{shortDate(it.createdAt)}</span>
          {it.linkedCount > 0 && <span>{it.linkedCount} research doc{it.linkedCount === 1 ? '' : 's'}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2">
          <Lightbulb className="text-amber-500" /> Ideas
        </h1>
        <p className="text-zinc-500 text-sm">Dump a thought, get it organized, and spin up deep research.</p>
      </div>

      <DataTable<Idea>
        columns={cols}
        rows={ideas}
        loading={loading}
        filters={filters}
        sortOptions={sortOptions}
        renderCard={card}
        cardsOnly
        pageSize={12}
        emptyText="No ideas yet — tap “＋ New idea” to capture one."
      />

      {/* Floating capture button */}
      <button
        onClick={() => setCapturing(true)}
        title="New idea"
        className="fixed right-4 bottom-[calc(10rem+env(safe-area-inset-bottom))] md:bottom-24 md:right-6 z-30 inline-flex items-center gap-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 px-4 py-3"
      >
        <Plus size={20} />
        <span className="hidden sm:inline font-medium pr-1">New idea</span>
      </button>

      {capturing && <CaptureModal onClose={() => setCapturing(false)} onCreated={load} />}
    </div>
  );
}
