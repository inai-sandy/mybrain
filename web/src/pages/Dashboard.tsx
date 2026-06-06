import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText, Brain, Database, RefreshCw, Upload, Link2, Sparkles,
  ArrowRight, type LucideIcon,
} from 'lucide-react';

type Doc = {
  id: string;
  source: string;
  createdAt: string;
  supermemory: boolean;
  rag: boolean;
  tags: string[];
};

function greeting(h: number): string {
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

function relativeDate(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24 && new Date(iso).toDateString() === new Date().toDateString()) return 'today';
  const days = Math.floor(hrs / 24);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Human label + accent for each capture source.
const SOURCE_META: Record<string, { label: string; bar: string }> = {
  supermemory: { label: 'Synced from SuperMemory', bar: 'bg-indigo-500' },
  upload: { label: 'Uploads', bar: 'bg-blue-500' },
  url: { label: 'Links', bar: 'bg-emerald-500' },
  notion: { label: 'Notion', bar: 'bg-purple-500' },
};
const SOURCE_ORDER = ['supermemory', 'upload', 'url', 'notion'];

export function Dashboard() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Doc[] | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/items')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
    fetch('/api/items/supermemory-sync-status')
      .then((r) => (r.ok ? r.json() : { lastSync: null }))
      .then((d) => setLastSync(d.lastSync || null))
      .catch(() => undefined);
  }, []);

  const stats = useMemo(() => {
    const list = items || [];
    const bySource: Record<string, number> = {};
    const tagCount: Record<string, number> = {};
    let inSM = 0;
    let inRag = 0;
    for (const it of list) {
      bySource[it.source] = (bySource[it.source] || 0) + 1;
      if (it.supermemory) inSM++;
      if (it.rag) inRag++;
      for (const t of it.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    }
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { total: list.length, bySource, inSM, inRag, topTags };
  }, [items]);

  const loading = items === null;
  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-64 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-xl bg-zinc-200 dark:bg-zinc-800" />)}
        </div>
        <div className="h-40 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
      </div>
    );
  }

  // Empty brain — friendly first-run state.
  if (stats.total === 0) {
    return (
      <div className="space-y-6">
        <Header dateLabel={dateLabel} hour={now.getHours()} total={0} />
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center">
          <Brain size={40} className="mx-auto text-emerald-500" />
          <h2 className="mt-3 text-lg font-bold">Your brain is empty</h2>
          <p className="mt-1 text-zinc-500">Capture your first note and it’s remembered forever.</p>
          <button
            onClick={() => navigate('/capture')}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-medium"
          >
            <Upload size={16} /> Capture something
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header dateLabel={dateLabel} hour={now.getHours()} total={stats.total} />

      {/* Real stats only — no fabricated zeros. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={FileText} label="Documents" value={String(stats.total)} hint="in your brain" />
        <Stat icon={Brain} label="In SuperMemory" value={String(stats.inSM)} hint="long-term memory" />
        <Stat icon={Database} label="In RAG" value={String(stats.inRag)} hint="searchable chunks" />
        <Stat icon={RefreshCw} label="Last synced" value={relativeDate(lastSync)} hint="from SuperMemory" />
      </div>

      {/* Quick capture */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400 mb-2">Add to your brain</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Action icon={Upload} label="Upload" onClick={() => navigate('/capture')} />
          <Action icon={Link2} label="Paste link" onClick={() => navigate('/capture')} />
          <Action icon={FileText} label="Notion" onClick={() => navigate('/capture')} />
          <Action icon={Brain} label="Sync SuperMemory" onClick={() => navigate('/settings')} />
        </div>
      </section>

      <div className="grid lg:grid-cols-2 gap-3">
        {/* By source */}
        <Panel title="By source">
          <div className="space-y-3">
            {SOURCE_ORDER.map((key) => {
              const meta = SOURCE_META[key];
              const count = stats.bySource[key] || 0;
              const pct = stats.total ? Math.round((count / stats.total) * 100) : 0;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-600 dark:text-zinc-300">{meta.label}</span>
                    <span className="tabular-nums text-zinc-500">{count}</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                    <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => navigate('/capture')}
            className="mt-4 inline-flex items-center gap-1 text-sm text-emerald-600 hover:text-emerald-500"
          >
            Browse all documents <ArrowRight size={14} />
          </button>
        </Panel>

        {/* Memory health */}
        <Panel title="Memory health">
          <ul className="space-y-3 text-sm">
            <HealthRow ok label={`${stats.inSM} of ${stats.total} safe in SuperMemory`} />
            <HealthRow ok={stats.inRag > 0} label={`${stats.inRag} also indexed in RAG (searchable)`} />
            <HealthRow ok={!!lastSync} label={`Last SuperMemory sync: ${relativeDate(lastSync)}`} />
          </ul>
          <button
            onClick={() => navigate('/settings')}
            className="mt-4 inline-flex items-center gap-1 text-sm text-emerald-600 hover:text-emerald-500"
          >
            Sync &amp; settings <ArrowRight size={14} />
          </button>
        </Panel>
      </div>

      {/* Topics */}
      <Panel title="Topics">
        {stats.topTags.length === 0 ? (
          <p className="text-sm text-zinc-500">No tags yet. Add tags when you capture to organise your brain.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {stats.topTags.map(([tag, count]) => (
              <button
                key={tag}
                onClick={() => navigate('/capture')}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-3 py-1 text-sm hover:border-emerald-500/50 hover:text-emerald-600"
              >
                <Sparkles size={12} className="text-amber-500" />
                {tag}
                <span className="tabular-nums text-xs text-zinc-400">{count}</span>
              </button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Header({ dateLabel, hour, total }: { dateLabel: string; hour: number; total: number }) {
  return (
    <div>
      <h1 className="text-2xl font-extrabold">
        {greeting(hour)}, Sandeep <span className="font-normal text-zinc-400">· {dateLabel}</span>
      </h1>
      <p className="text-zinc-500">
        Your second brain — {total === 0 ? 'nothing captured yet' : `${total} document${total === 1 ? '' : 's'} and counting`}.
      </p>
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-500">{label}</span>
        <Icon size={18} className="text-emerald-600" />
      </div>
      <div className="mt-2 text-2xl font-bold truncate">{value}</div>
      {hint && <div className="text-xs text-zinc-400 mt-1">{hint}</div>}
    </div>
  );
}

function Action({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3 text-sm font-medium hover:border-emerald-500/50 hover:shadow-sm transition-all"
    >
      <span className="rounded-lg bg-emerald-500/10 text-emerald-600 p-1.5">
        <Icon size={16} />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function HealthRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-400'}`} />
      <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
    </li>
  );
}
