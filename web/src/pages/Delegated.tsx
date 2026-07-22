import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Hand, Radio, Clock, Plus, Search, Timer } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { TaskFormModal, TaskCard, type Task } from './taskShared';

type Row = Task & {
  who: string;
  openDays: number;
  chaseStatus: 'active' | 'paused' | 'done' | 'stopped' | 'none';
  chaseRepeats: boolean;
  chaseCount: number;
  chaseId: string | null;
  stalling?: string[] | null;
};

/**
 * The Delegated tab of the Tasks page (BEA-1044) — everything handed to other people, in the SAME
 * card look as the owner's own board so the page reads as one thing. Lives as a tab, not a
 * separate sidebar page: 24 flat sidebar entries had become genuinely confusing.
 */
export function DelegatedTab({ onCountChange }: { onCountChange?: (open: number) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState({ open: 0, awaitingYou: 0, chasing: 0, stalling: 0 });
  const [editing, setEditing] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [q, setQ] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [person, setPerson] = useState('');
  const [status, setStatus] = useState<'open' | 'done' | ''>('open');
  const [needs, setNeeds] = useState('');
  const [shown, setShown] = useState(12);
  const toast = useToast();

  const load = useCallback(
    () =>
      fetch('/api/tasks/delegated')
        .then((r) => (r.ok ? r.json() : { rows: [], summary: { open: 0, awaitingYou: 0, chasing: 0, stalling: 0 } }))
        .then((d) => {
          setRows(d.rows || []);
          setSummary(d.summary || { open: 0, awaitingYou: 0, chasing: 0, stalling: 0 });
          onCountChange?.(d.summary?.open ?? 0);
        })
        .catch(() => setRows([])),
    [onCountChange],
  );
  useEffect(() => { load(); }, [load]);

  const people = useMemo(() => [...new Set((rows || []).map((r) => r.who))].sort(), [rows]);

  const filtered = useMemo(() => {
    let r = rows || [];
    if (status) r = r.filter((x) => x.status === status);
    if (person) r = r.filter((x) => x.who === person);
    if (needs === 'claim') r = r.filter((x) => !!x.claim);
    else if (needs === 'chasing') r = r.filter((x) => x.chaseStatus === 'active');
    else if (needs === 'stalling') r = r.filter((x) => !!x.stalling);
    else if (needs === 'quiet') r = r.filter((x) => x.chaseStatus !== 'active' && x.status !== 'done');
    const t = q.trim().toLowerCase();
    if (t) r = r.filter((x) => `${x.title} ${x.who} ${x.note || ''}`.toLowerCase().includes(t));
    return r;
  }, [rows, status, person, needs, q]);

  async function toggle(t: Task) {
    const res = await fetch(`/api/tasks/${t.id}/done`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: t.status !== 'done' }),
    });
    toast(res.ok ? 'success' : 'error', res.ok ? (t.status === 'done' ? 'Back to open — chase resumes' : 'Confirmed done — chase stopped') : 'Could not save');
    load();
  }

  async function remove(r: Row) {
    const res = await fetch(`/api/tasks/${r.id}`, { method: 'DELETE' });
    toast(res.ok ? 'success' : 'error', res.ok ? 'Removed — its chase went with it' : 'Could not remove');
    setConfirm(null);
    load();
  }

  const sel = 'rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300';

  return (
    <div className="space-y-3">
      {/* The four numbers that matter, in one glance. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat icon={<Clock size={14} />} n={summary.open} label="still open" />
        <Link to="/tasks?tab=review" className="contents"><Stat icon={<Hand size={14} />} n={summary.awaitingYou} label="waiting on you" tone={summary.awaitingYou ? 'violet' : undefined} /></Link>
        <Stat icon={<Radio size={14} />} n={summary.chasing} label="being chased" />
        <Stat icon={<Timer size={14} />} n={summary.stalling || 0} label="not moving" tone={summary.stalling ? 'amber' : undefined} />
      </div>

      {/* Filter row in the board's own style. */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={person} onChange={(e) => setPerson(e.target.value)} className={sel}>
          <option value="">Anyone</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as any)} className={sel}>
          <option value="open">Still open</option>
          <option value="done">Finished</option>
          <option value="">All</option>
        </select>
        <select value={needs} onChange={(e) => setNeeds(e.target.value)} className={sel}>
          <option value="">Everything</option>
          <option value="claim">Waiting on you</option>
          <option value="chasing">Being chased</option>
          <option value="stalling">Not moving</option>
          <option value="quiet">No chase running</option>
        </select>
        <button onClick={() => setShowSearch((v) => !v)} aria-label="Search" className={'rounded-lg border p-1.5 ' + (showSearch || q ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
          <Search size={14} />
        </button>
        <span className="ml-auto text-xs text-zinc-500">{filtered.length} shown</span>
      </div>
      {showSearch && (
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Search by task, person or note…" className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900" />
      )}

      {rows === null ? (
        <div className="space-y-2.5">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <p className="text-sm font-medium">{(rows || []).length ? 'Nothing matches those filters' : "You haven't given anyone anything yet"}</p>
          <p className="mt-1 text-xs text-zinc-500">{(rows || []).length ? 'Clear a filter or two.' : 'Brief a contact, or use the button below.'}</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.slice(0, shown).map((r) => (
            <TaskCard key={r.id} t={r} onToggle={toggle} onEdit={(t) => setEditing(t)} onDelete={(t) => setConfirm(t as Row)} />
          ))}
          {filtered.length > shown && (
            <button onClick={() => setShown((n) => n + 12)} className="w-full rounded-xl border border-dashed border-zinc-300 py-2 text-sm text-zinc-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700">
              Show {Math.min(12, filtered.length - shown)} more of {filtered.length}
            </button>
          )}
        </div>
      )}

      {/* Same floating-button pattern as the board — give, don't dump. */}
      <button onClick={() => setAdding(true)} className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-emerald-500 md:bottom-8">
        <Plus className="h-4 w-4" /> Give someone a task
      </button>

      {(editing || adding) && (
        <TaskFormModal task={editing} onClose={() => { setEditing(null); setAdding(false); }} onSaved={() => { setEditing(null); setAdding(false); load(); }} />
      )}
      {confirm && (
        <ConfirmDialog
          title="Remove this?"
          message={`"${confirm.title}" and its chase will be deleted. ${confirm.who} won't be asked about it again.`}
          confirmLabel="Remove"
          onConfirm={() => remove(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function Stat({ icon, n, label, tone }: { icon: React.ReactNode; n: number; label: string; tone?: 'violet' | 'amber' }) {
  const border = tone === 'violet' && n > 0 ? 'border-violet-400/50 bg-violet-500/5' : tone === 'amber' && n > 0 ? 'border-amber-400/50 bg-amber-500/5' : 'border-zinc-200 dark:border-zinc-800';
  return (
    <div className={'rounded-xl border p-3 ' + border}>
      <div className="flex items-center gap-1.5 text-zinc-500">{icon}<span className="text-[11px]">{label}</span></div>
      <p className="mt-0.5 text-xl font-bold">{n}</p>
    </div>
  );
}
