import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, Hand, Radio, Clock, MessageSquare, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { PersonTimeline } from './PersonTimeline';
import { TaskFormModal, type Task } from '../pages/taskShared';

type Report = {
  taskId: string; title: string; schedule: string[] | null; scheduleLabel: string;
  due: boolean; status: 'received' | 'waiting' | 'missed' | 'off'; quote: string | null;
  source: string | null; at: string | null;
};

type State = {
  open: number; done: number; awaitingYou: number; chasing: number;
  oldestOpenDays: number | null; lastHeardAt: string | null;
  /** Their standing reports for today, so the answer is on this page. (BEA-1149) */
  today?: { day: string; weekday: string; due: Report[]; notDue: Report[]; counts: { due: number; received: number } };
};
type Row = Task & { who: string; openDays: number; chaseStatus: string; chaseCount: number; chaseId: string | null };

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return 'today';
  return d === 1 ? 'yesterday' : `${d}d ago`;
};

/** Where this person stands, in one glance at the top of their page. (BEA-1037) */
export function ContactState({ contactId, reload }: { contactId: string; reload: number }) {
  const [s, setS] = useState<State | null>(null);

  useEffect(() => {
    setS(null);
    fetch(`/api/contacts/${contactId}/state`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setS)
      .catch(() => setS(null));
  }, [contactId, reload]);

  if (!s) return <div className="h-16 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />;
  if (!s.open && !s.done && !s.awaitingYou) return null;

  return (
    <div className="space-y-2">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Cell icon={<Circle size={13} />} n={s.open} label="still open" hint={s.oldestOpenDays !== null && s.oldestOpenDays >= 7 ? `oldest ${s.oldestOpenDays}d` : undefined} tone={s.oldestOpenDays !== null && s.oldestOpenDays >= 7 ? 'rose' : undefined} />
      {/* No longer a link out to Review — everything about this person is answered on this page.
          Bouncing between four screens to know where one person stands was the complaint. (BEA-1149) */}
      <Cell icon={<Hand size={13} />} n={s.awaitingYou} label="waiting on you" tone={s.awaitingYou ? 'violet' : undefined} />
      <Cell icon={<Radio size={13} />} n={s.chasing} label="being chased" />
      <div className="rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-1.5 text-zinc-500"><MessageSquare size={13} /><span className="text-[11px]">last heard</span></div>
        <p className="mt-0.5 text-sm font-semibold">{ago(s.lastHeardAt)}</p>
      </div>
    </div>
    <TodayReports today={s.today} onChanged={() => fetch(`/api/contacts/${contactId}/state`).then((r) => (r.ok ? r.json() : null)).then(setS).catch(() => undefined)} />
    {/* Both channels in one thread, so half the conversation is no longer invisible. (BEA-1159) */}
    <PersonTimeline contactId={contactId} reload={reload} />
    </div>
  );
}

/**
 * Their standing reports for today — due, arrived, or still waiting, with the words that settled it.
 * (BEA-1149)
 *
 * This lived on a different screen, so answering "did Jayanth's update come in?" meant leaving the
 * person you were looking at. It also shows WHERE the answer came from: a tick on their own page is
 * not the same as them telling you, and on 27 July that difference was the whole problem. (BEA-1152)
 */
export function TodayReports({ today, onChanged }: { today: State['today']; onChanged?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  if (!today || (!today.due.length && !today.notDue.length)) return null;

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  async function setDays(taskId: string, days: string[]) {
    setBusy(taskId);
    try {
      await fetch(`/api/tasks/recurring/${taskId}/schedule`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }),
      });
      onChanged?.();
    } finally { setBusy(null); setEditing(null); }
  }

  const row = (r: Report) => (
    <li key={r.taskId} className={'rounded-lg border px-3 py-2.5 ' + (r.status === 'received' ? 'border-emerald-400/50 bg-emerald-500/5' : r.status === 'missed' ? 'border-rose-400/50 bg-rose-500/5' : r.due ? 'border-zinc-200 dark:border-zinc-800' : 'border-zinc-200/60 opacity-60 dark:border-zinc-800/60')}>
      <div className="flex items-start gap-2">
        <span className={'mt-0.5 shrink-0 text-xs ' + (r.status === 'received' ? 'text-emerald-600' : r.status === 'missed' ? 'text-rose-600' : 'text-zinc-400')}>
          {r.status === 'received' ? '✓' : r.status === 'missed' ? '✕' : r.due ? '•' : '—'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">{r.title}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
            <button onClick={() => setEditing(editing === r.taskId ? null : r.taskId)} className="underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-200">{r.scheduleLabel}</button>
            {r.due ? <span>{r.status === 'received' ? 'came in' : r.status === 'missed' ? 'missed' : 'still waiting'}</span> : <span>not due today</span>}
            {r.source && <span className={r.source === 'page' ? 'text-amber-600 dark:text-amber-500' : 'text-emerald-600 dark:text-emerald-400'}>{r.source === 'page' ? 'ticked on their page' : 'said on WhatsApp'}</span>}
          </div>
          {r.quote && <p className="mt-1 border-l-2 border-zinc-200 pl-2 text-xs italic text-zinc-500 dark:border-zinc-700">“{r.quote.slice(0, 180)}”</p>}
          {editing === r.taskId && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {DAYS.map((d) => {
                const on = r.schedule ? r.schedule.includes(d) : false;
                return (
                  <button key={d} disabled={busy === r.taskId}
                    onClick={() => setDays(r.taskId, on ? (r.schedule || []).filter((x) => x !== d) : [...(r.schedule || []), d])}
                    className={'rounded-md border px-2 py-0.5 text-[11px] ' + (on ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>{d}</button>
                );
              })}
              <button disabled={busy === r.taskId} onClick={() => setDays(r.taskId, [])} className="rounded-md px-2 py-0.5 text-[11px] text-zinc-500 underline">every working day</button>
            </div>
          )}
        </div>
      </div>
    </li>
  );

  return (
    <section className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <h3 className="mb-2 text-xs font-semibold text-zinc-500">
        Today’s reports {today.counts.due > 0 && <span className="font-normal text-zinc-400">· {today.counts.received} of {today.counts.due} in</span>}
      </h3>
      {today.due.length ? <ul className="space-y-1.5">{today.due.map(row)}</ul> : <p className="text-sm text-zinc-400">Nothing due from them today.</p>}
      {today.notDue.length > 0 && (
        <>
          <p className="mt-2.5 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Not due today</p>
          <ul className="space-y-1.5">{today.notDue.map(row)}</ul>
        </>
      )}
    </section>
  );
}

function Cell({ icon, n, label, hint, tone }: { icon: React.ReactNode; n: number; label: string; hint?: string; tone?: 'violet' | 'rose' }) {
  const border = tone === 'violet' && n > 0 ? 'border-violet-400/50 bg-violet-500/5' : tone === 'rose' && n > 0 ? 'border-rose-400/40 bg-rose-500/5' : 'border-zinc-200 dark:border-zinc-800';
  return (
    <div className={`rounded-xl border p-2.5 ${border}`}>
      <div className="flex items-center gap-1.5 text-zinc-500">{icon}<span className="text-[11px]">{label}</span></div>
      <p className="mt-0.5 text-lg font-bold leading-none">{n}</p>
      {hint && <p className="mt-0.5 text-[10px] text-rose-600 dark:text-rose-400">{hint}</p>}
    </div>
  );
}

/**
 * Their work, right on their page and fully actionable — add, close, reopen, edit, remove without
 * going anywhere else. Anything found only by name-matching (not a real link) is shown separately
 * and honestly labelled, rather than mixed in as if it were theirs. (BEA-1037)
 */
type MentionRow = { id: string; title: string; status: string };

export function ContactTasks({ contactId, contactName, reload, legacy }: { contactId: string; contactName: string; reload: number; legacy: MentionRow[] | null }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [shown, setShown] = useState(8);
  const [chasing, setChasing] = useState<string | null>(null); // row id with a chase call in flight
  const toast = useToast();

  /** Start (or stop) the daily chase on one task — the CRUD that was missing. (BEA-1039) */
  async function toggleChase(r: Row) {
    setChasing(r.id);
    try {
      if (r.chaseStatus === 'active' && r.chaseId) {
        const res = await fetch(`/api/reminders/${r.chaseId}/stop`, { method: 'POST' });
        toast(res.ok ? 'success' : 'error', res.ok ? 'Chase stopped' : 'Could not stop it');
      } else {
        const res = await fetch('/api/reminders', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId, taskId: r.id, subject: r.title, message: `Following up on: ${r.title}`, times: ['09:00', '17:30'], repeat: 'daily' }),
        });
        toast(res.ok ? 'success' : 'error', res.ok ? 'Chasing daily at 9:00 and 17:30 — edit times in Reminders' : 'Could not start the chase');
      }
      await load();
    } finally { setChasing(null); }
  }

  const load = useCallback(
    () =>
      fetch(`/api/tasks/delegated?contactId=${encodeURIComponent(contactId)}`)
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .then((d) => setRows(d.rows || []))
        .catch(() => setRows([])),
    [contactId],
  );
  useEffect(() => { setRows(null); load(); }, [load, reload]);

  async function toggle(r: Row) {
    const res = await fetch(`/api/tasks/${r.id}/done`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: r.status !== 'done' }),
    });
    toast(res.ok ? 'success' : 'error', res.ok ? (r.status === 'done' ? 'Back to open' : 'Confirmed done — chase stopped') : 'Could not save');
    load();
  }

  async function remove(r: Row) {
    const res = await fetch(`/api/tasks/${r.id}`, { method: 'DELETE' });
    toast(res.ok ? 'success' : 'error', res.ok ? 'Removed' : 'Could not remove');
    setConfirm(null);
    load();
  }

  const linkedIds = new Set((rows || []).map((r) => r.id));
  const mentionedOnly = (legacy || []).filter((t) => !linkedIds.has(t.id));

  return (
    <div className="space-y-3">
      <button onClick={() => setAdding(true)} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/5 px-3 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400 sm:w-auto">
        <Plus size={15} /> Give {contactName.split(/\s+/)[0]} something
      </button>

      {rows === null ? (
        <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-500">Nothing is with {contactName} yet.</p>
          <p className="mt-1 text-xs text-zinc-400">Brief them, or add something above.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.slice(0, shown).map((r) => (
            <li key={r.id} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-start gap-2.5">
                <button onClick={() => toggle(r)} aria-label={r.status === 'done' ? 'Reopen' : 'Mark done'} className="mt-0.5 shrink-0">
                  <CheckCircle2 className={'h-4 w-4 ' + (r.status === 'done' ? 'text-emerald-500' : 'text-zinc-300 hover:text-emerald-500 dark:text-zinc-600')} />
                </button>
                <div className="min-w-0 flex-1">
                  <p className={'text-sm ' + (r.status === 'done' ? 'text-zinc-400 line-through' : 'font-medium')}>{r.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
                    <span className="inline-flex items-center gap-1"><Clock size={10} />{r.status === 'done' ? 'finished' : r.openDays === 0 ? 'today' : `open ${r.openDays}d`}</span>
                    {r.chaseCount > 0 && <span>chased {r.chaseCount}×</span>}
                    {r.chaseStatus === 'active' && <span className="text-emerald-600 dark:text-emerald-400">chasing</span>}
                    {r.status !== 'done' && (
                      <button onClick={() => toggleChase(r)} disabled={chasing === r.id} className="inline-flex items-center gap-1 rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-zinc-700">
                        {chasing === r.id ? <Loader2 size={9} className="animate-spin" /> : null}
                        {r.chaseStatus === 'active' ? 'Stop chase' : 'Chase daily'}
                      </button>
                    )}
                  </p>
                  {r.claim && <p className="mt-1.5 rounded-lg bg-violet-500/10 px-2 py-1 text-[11px] text-violet-700 dark:text-violet-300">✋ says it's done — “{r.claim.quote}”</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => setEditing(r)} aria-label="Edit" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><Pencil size={13} /></button>
                  <button onClick={() => setConfirm(r)} aria-label="Remove" className="p-1 text-zinc-400 hover:text-rose-500"><Trash2 size={13} /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows !== null && rows.length > shown && (
        <button onClick={() => setShown((n) => n + 8)} className="w-full rounded-xl border border-dashed border-zinc-300 py-2 text-sm text-zinc-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700">
          Show {Math.min(8, rows.length - shown)} more of {rows.length}
        </button>
      )}

      {mentionedOnly.length > 0 && (
        <section>
          <h3 className="mb-1.5 mt-4 text-xs font-semibold text-zinc-500">Also mentions {contactName} ({mentionedOnly.length})</h3>
          <p className="mb-2 text-[11px] text-zinc-400">Found by their name in the text — not owned by them.</p>
          <ul className="space-y-1.5">
            {mentionedOnly.map((t) => (
              <li key={t.id} className="flex items-start gap-2 rounded-xl border border-zinc-200 bg-white/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-900/60">
                <CheckCircle2 className={'mt-0.5 h-3.5 w-3.5 shrink-0 ' + (t.status === 'done' ? 'text-emerald-500' : 'text-zinc-300 dark:text-zinc-600')} />
                <span className={'text-xs ' + (t.status === 'done' ? 'text-zinc-400 line-through' : 'text-zinc-600 dark:text-zinc-300')}>{t.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(editing || adding) && (
        <TaskFormModal
          task={editing || ({ ownerContactId: contactId, party: contactName } as any)}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSaved={() => { setEditing(null); setAdding(false); load(); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title="Remove this?"
          message={`"${confirm.title}" and its chase will be deleted. ${contactName} won't be asked about it again.`}
          confirmLabel="Remove"
          onConfirm={() => remove(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
