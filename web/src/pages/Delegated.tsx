import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Hand, Radio, Check, Clock, Trash2, Pencil, Plus } from 'lucide-react';
import { DataTable, type Column, type Filter } from '../ui/DataTable';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { TaskFormModal, type Task } from './taskShared';

type Row = Task & {
  who: string;
  openDays: number;
  chaseStatus: 'active' | 'paused' | 'done' | 'stopped' | 'none';
  chaseRepeats: boolean;
  chaseCount: number;
  chaseId: string | null;
};

const CHASE_LABEL: Record<string, string> = { active: 'chasing', paused: 'paused', done: 'stopped', stopped: 'stopped', none: 'no chase' };

/**
 * Everything handed to someone else. Deliberately NOT on the personal Tasks board — that stays
 * what the owner has to do; this is what he is waiting on. (BEA-1029)
 */
export function Delegated() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState({ open: 0, awaitingYou: 0, chasing: 0 });
  const [editing, setEditing] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const toast = useToast();

  const load = useCallback(
    () =>
      fetch('/api/tasks/delegated')
        .then((r) => (r.ok ? r.json() : { rows: [], summary: { open: 0, awaitingYou: 0, chasing: 0 } }))
        .then((d) => { setRows(d.rows || []); setSummary(d.summary || { open: 0, awaitingYou: 0, chasing: 0 }); })
        .catch(() => setRows([])),
    [],
  );
  useEffect(() => { load(); }, [load]);

  async function remove(r: Row) {
    const res = await fetch(`/api/tasks/${r.id}`, { method: 'DELETE' });
    toast(res.ok ? 'success' : 'error', res.ok ? 'Removed — its chase went with it' : 'Could not remove');
    setConfirm(null);
    load();
  }

  async function toggleDone(r: Row) {
    const res = await fetch(`/api/tasks/${r.id}/done`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: r.status !== 'done' }),
    });
    toast(res.ok ? 'success' : 'error', res.ok ? (r.status === 'done' ? 'Back to open — chase resumes' : 'Confirmed done — chase stopped') : 'Could not save');
    load();
  }

  const people = useMemo(() => [...new Set((rows || []).map((r) => r.who))].sort(), [rows]);

  const filters: Filter[] = [
    { key: 'status', label: 'Status', options: [{ value: 'open', label: 'Still open' }, { value: 'done', label: 'Finished' }], match: (r, v) => r.status === v },
    { key: 'who', label: 'Person', options: people.map((p) => ({ value: p, label: p })), match: (r, v) => r.who === v },
    {
      key: 'state',
      label: 'Needs',
      options: [
        { value: 'claim', label: 'Waiting on you' },
        { value: 'chasing', label: 'Being chased' },
        { value: 'quiet', label: 'No chase running' },
      ],
      match: (r, v) => (v === 'claim' ? !!r.claim : v === 'chasing' ? r.chaseStatus === 'active' : r.chaseStatus !== 'active' && r.status !== 'done'),
    },
  ];

  const columns: Column<Row>[] = [
    { key: 'title', label: 'What', width: '42%', sortable: true, render: (r) => (
      <div className="min-w-0">
        <span className={'block truncate ' + (r.status === 'done' ? 'text-zinc-400 line-through' : 'font-medium')}>{r.title}</span>
        {r.claim && <span className="text-[11px] text-violet-600 dark:text-violet-400">✋ says it's done — “{r.claim.quote.slice(0, 60)}”</span>}
      </div>
    ) },
    { key: 'who', label: 'Who', width: '16%', sortable: true },
    { key: 'openDays', label: 'Open', width: '12%', sortable: true, render: (r) => <span className={r.openDays >= 7 && r.status !== 'done' ? 'text-rose-600 dark:text-rose-400' : ''}>{r.status === 'done' ? '—' : r.openDays === 0 ? 'today' : `${r.openDays}d`}</span> },
    { key: 'chaseCount', label: 'Chased', width: '12%', sortable: true, render: (r) => <span className="text-zinc-500">{r.chaseCount || 0}×</span> },
    { key: 'chaseStatus', label: 'Chase', width: '18%', render: (r) => (
      <span className={'rounded-full px-2 py-0.5 text-[11px] ' + (r.chaseStatus === 'active' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-zinc-500/10 text-zinc-500')}>
        {CHASE_LABEL[r.chaseStatus] || r.chaseStatus}
      </span>
    ) },
  ];

  const card = (r: Row) => (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className={'font-medium leading-snug ' + (r.status === 'done' ? 'text-zinc-400 line-through' : '')}>{r.title}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{r.who} · {r.status === 'done' ? 'finished' : r.openDays === 0 ? 'given today' : `open ${r.openDays}d`} · chased {r.chaseCount || 0}×</p>
      {r.claim && <p className="mt-2 rounded-lg bg-violet-500/10 px-2.5 py-1.5 text-xs text-violet-700 dark:text-violet-300">✋ says it's done — “{r.claim.quote}”</p>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className={'rounded-full px-2 py-0.5 text-[11px] ' + (r.chaseStatus === 'active' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-zinc-500/10 text-zinc-500')}>{CHASE_LABEL[r.chaseStatus]}</span>
        <button onClick={() => toggleDone(r)} className="ml-auto rounded-lg border border-zinc-300 px-2 py-1 text-xs hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700">{r.status === 'done' ? 'Reopen' : 'Done'}</button>
        <button onClick={() => setEditing(r)} aria-label="Edit" className="rounded-lg border border-zinc-300 p-1.5 text-zinc-500 dark:border-zinc-700"><Pencil size={13} /></button>
        <button onClick={() => setConfirm(r)} aria-label="Delete" className="rounded-lg border border-zinc-300 p-1.5 text-zinc-500 hover:border-rose-400 hover:text-rose-600 dark:border-zinc-700"><Trash2 size={13} /></button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold"><Users className="text-amber-500" /> Delegated</h1>
          <p className="text-sm text-zinc-500">Everything you're waiting on other people for.</p>
        </div>
        <button onClick={() => setAdding(true)} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500">
          <Plus size={15} /> Give someone a task
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat icon={<Clock size={14} />} n={summary.open} label="still open" />
        <Link to="/review" className="contents"><Stat icon={<Hand size={14} />} n={summary.awaitingYou} label="waiting on you" tone={summary.awaitingYou ? 'violet' : undefined} /></Link>
        <Stat icon={<Radio size={14} />} n={summary.chasing} label="being chased" />
      </div>

      <DataTable<Row>
        columns={columns}
        rows={rows || []}
        loading={rows === null}
        filters={filters}
        pageSize={12}
        renderCard={card}
        onRowClick={(r) => setEditing(r)}
        tableLayoutFixed
        emptyText="You haven't given anyone anything yet. Brief a contact and their tasks show up here."
        sortOptions={[
          { label: 'Longest open', key: 'openDays', dir: -1 },
          { label: 'Newest', key: 'createdAt', dir: -1 },
          { label: 'Most chased', key: 'chaseCount', dir: -1 },
        ]}
      />

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

function Stat({ icon, n, label, tone }: { icon: React.ReactNode; n: number; label: string; tone?: 'violet' }) {
  return (
    <div className={'rounded-xl border p-3 ' + (tone === 'violet' && n > 0 ? 'border-violet-400/50 bg-violet-500/5' : 'border-zinc-200 dark:border-zinc-800')}>
      <div className="flex items-center gap-1.5 text-zinc-500">{icon}<span className="text-[11px]">{label}</span></div>
      <p className="mt-0.5 text-xl font-bold">{n}</p>
    </div>
  );
}
