import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightbulb, Sparkles, Check, Circle } from 'lucide-react';
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

export function Ideas() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [dump, setDump] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open');
  const toast = useToast();
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dump.trim()) return;
    setSubmitting(true);
    try {
      const r = await fetch('/api/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dump }) });
      if (r.ok) {
        setDump('');
        toast('success', 'Idea captured & organized');
        load();
      } else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setSubmitting(false);
    }
  }

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

  const shown = useMemo(() => ideas.filter((i) => (filter === 'all' ? true : i.status === filter)), [ideas, filter]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2">
          <Lightbulb className="text-amber-500" /> Ideas
        </h1>
        <p className="text-zinc-500 text-sm">Dump a thought, get it organized, and spin up deep research.</p>
      </div>

      <form onSubmit={submit} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <textarea
          value={dump}
          onChange={(e) => setDump(e.target.value)}
          rows={4}
          placeholder="Dump everything on your mind about this idea…"
          className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
        <div className="mt-3 flex justify-end">
          <button type="submit" disabled={submitting || !dump.trim()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm disabled:opacity-50">
            {submitting ? 'Organizing…' : 'Submit'}
          </button>
        </div>
      </form>

      <div className="flex items-center gap-2">
        {(['open', 'done', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={'text-sm rounded-lg px-3 py-1 capitalize ' + (filter === f ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 border border-zinc-200 dark:border-zinc-800')}
          >
            {f}
          </button>
        ))}
        <span className="text-xs text-zinc-400 ml-auto">
          {shown.length} idea{shown.length === 1 ? '' : 's'}
        </span>
      </div>

      {loading ? (
        <p className="text-zinc-400 py-8 text-center">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-zinc-400 py-10 text-center">{filter === 'done' ? 'No finished ideas yet.' : 'No ideas yet — dump one above.'}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((it) => (
            <div
              key={it.id}
              className={'group rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-col transition-all hover:border-emerald-500/40 hover:shadow-md ' + (it.status === 'done' ? 'opacity-70' : '')}
            >
              <div className="flex items-start gap-2">
                <button onClick={() => navigate(`/ideas/${it.id}`)} className="min-w-0 flex-1 text-left">
                  <h3 className={'font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600 ' + (it.status === 'done' ? 'line-through text-zinc-400' : '')}>{it.title}</h3>
                </button>
                <div className="flex items-center gap-0.5 shrink-0">
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
          ))}
        </div>
      )}
    </div>
  );
}
