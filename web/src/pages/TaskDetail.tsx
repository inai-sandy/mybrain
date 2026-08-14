import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Check, CheckCircle2, Clock, MessageSquare, Radio, UserRound, ArrowRightLeft, Loader2, Pencil, Pause, Play, Square, Trash2, RotateCcw, Undo2, X } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { HandOverSheet } from '../ui/HandOverSheet';
import { useToast } from '../ui/Toast';
import { Task, TaskFormModal, DoneModal } from './taskShared';

/**
 * One job, and everything that has happened to it. (BEA-1310)
 *
 * The owner: *"Tasks, contacts, reminders, delegated tasks, chats: all these have to have a proper
 * connection."* They were connected in the database and nowhere on screen — there was no page for a
 * job at all. To answer "what is going on with the Elleys PCBs?" he had to open Delegated for the
 * chase, Chats for the conversation, and the review list for the claim, and join them in his head.
 *
 * Everything here has been recorded for months. None of it is new; it had never been put in one
 * place. So this page invents nothing — if it is not in the record, it is not shown.
 *
 * It can also be ACTED on. (BEA-1315) The first version only showed things: you could see that the
 * chase was still running and that Deepthi said it was done three days ago, and you could do
 * nothing about either without leaving for another screen.
 *
 * Every action here posts to the SAME endpoint the other screens use — nothing on this page has its
 * own private door. That is deliberate: the whole complaint was that the pieces drift apart, and a
 * second way to finish a job is exactly how "done here" stops meaning "done there".
 */

type Detail = {
  id: string;
  title: string;
  note?: string | null;
  status: 'open' | 'done' | 'dropped';
  kind?: 'assignment' | 'recurring';
  droppedReason?: string | null;
  droppedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  owner?: { id: string; name: string } | null;
  party?: string | null;
  // Carried because the edit and done modals are the SAME ones the task board uses, and they read
  // these off the task they are handed. `ownerContactId` is the one that matters: the form posts
  // whatever it read back, so if the payload ever stopped carrying it, editing a title from here
  // would quietly unassign the job from the person doing it. Locked by a test. (BEA-1315)
  ownerContactId?: string | null;
  category?: string | null;
  tags?: string[];
  priority?: string;
  sphere?: string;
  pinned?: boolean;
  estimateMin?: number | null;
  reminderCount?: number;
  dueDate?: string | null;
  chases: { id: string; status: string; repeat: string; times: string[]; subject?: string | null; createdAt: string; pausedAuto?: boolean; contact?: { id: string; name: string } | null }[];
  claims: { id: string; quote: string; status: string; source: string; reason?: string | null; createdAt: string; decidedAt?: string | null; by?: string | null }[];
  handovers: { id: string; from?: string | null; to?: string | null; reason?: string | null; at: string }[];
  days: { day: string; status: string; quote?: string | null; summary?: string | null; by?: string | null }[];
  messages: { id: string; direction: string; body: string; createdAt: string; by?: string | null }[];
};

const when = (s?: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

/** Everything that happened, in the order it happened. */
function storyOf(t: Detail) {
  const out: { at: string; icon: 'made' | 'moved' | 'said' | 'ended'; text: string; sub?: string | null }[] = [];
  out.push({ at: t.createdAt, icon: 'made', text: t.owner ? `Given to ${t.owner.name}` : 'Added to your own list' });
  for (const h of t.handovers) {
    out.push({ at: h.at, icon: 'moved', text: `Handed ${h.from ? `from ${h.from} ` : ''}to ${h.to || 'someone'}`, sub: h.reason });
  }
  for (const c of t.claims) {
    out.push({ at: c.createdAt, icon: 'said', text: `${c.by || 'They'} said it was done`, sub: `“${c.quote}”` });
    if (c.decidedAt) {
      const verdict =
        c.status === 'confirmed' ? 'You confirmed it' :
        c.status === 'rejected' ? `You said no${c.reason ? `: ${c.reason}` : ''}` :
        'No longer needed an answer — the work was dropped or handed on';
      out.push({ at: c.decidedAt, icon: 'ended', text: verdict });
    }
  }
  if (t.status === 'done' && t.completedAt) out.push({ at: t.completedAt, icon: 'ended', text: 'Finished' });
  if (t.status === 'dropped' && t.droppedAt) out.push({ at: t.droppedAt, icon: 'ended', text: 'Closed as not done', sub: t.droppedReason });
  return out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [t, setT] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [doneFor, setDoneFor] = useState(false);
  const [handOver, setHandOver] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropReason, setDropReason] = useState('');
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label: string; run: () => Promise<void> }>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`/api/tasks/${id}`);
      if (!r.ok) throw new Error();
      setT(await r.json());
    } catch {
      setMissing(true);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  /**
   * One way in and out for every action on this page: call it, say what happened, show the new
   * truth. Re-reading the whole job afterwards rather than patching state locally is on purpose —
   * finishing a job also settles its claim, stops its chase and closes the team update, and a
   * hand-patched screen would show one of those and not the others.
   */
  async function act(url: string, opts: RequestInit, ok: string, after?: (d: any) => void) {
    setBusy(true);
    try {
      const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d?.message || 'Could not do that'); return; }
      toast('success', ok);
      if (after) after(d); else await load();
    } catch {
      toast('error', 'Could not reach the server');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  if (missing) {
    return (
      <div className="py-16 text-center text-sm text-zinc-500">
        <p>That job is not there any more.</p>
        <button onClick={() => navigate(-1)} className="mt-3 text-emerald-600 hover:underline">Go back</button>
      </div>
    );
  }
  if (!t) {
    return <div className="flex justify-center py-16 text-zinc-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  const story = storyOf(t);
  const liveChase = t.chases.find((c) => c.status === 'active' || c.status === 'paused');
  const pending = t.claims.filter((c) => c.status === 'pending');
  const isReport = t.kind === 'recurring';
  const lastHandover = t.handovers.length ? t.handovers[t.handovers.length - 1] : null;
  const card = 'rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900';

  return (
    <div className="space-y-4 pb-10">
      <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className={card}>
        <div className="flex items-start gap-2">
          <h1 className={'flex-1 text-xl font-bold leading-snug ' + (t.status !== 'open' ? 'text-zinc-400 line-through' : '')}>{t.title}</h1>
          {t.status === 'done' && <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">finished</span>}
          {/* Never green, never a tick — this ended, it was not achieved. (BEA-1306) */}
          {t.status === 'dropped' && <span className="shrink-0 rounded-full bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-zinc-500">not done</span>}
        </div>
        {t.note && <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-500">{t.note}</p>}
        {t.status === 'dropped' && t.droppedReason && (
          <p className="mt-2 text-xs text-zinc-500"><Ban className="mr-1 inline h-3 w-3" />{t.droppedReason}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {t.owner ? (
            <button onClick={() => navigate(`/contacts?contact=${t.owner!.id}`)} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
              <UserRound className="h-3 w-3" /> {t.owner.name}
            </button>
          ) : (
            <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-500 dark:bg-zinc-800">yours</span>
          )}
          {t.kind === 'recurring' && <span className="rounded-full bg-indigo-500/10 px-2 py-1 text-indigo-600 dark:text-indigo-400">🔁 daily report</span>}
          {liveChase && (
            <span className={'inline-flex items-center gap-1 rounded-full px-2 py-1 ' + (liveChase.status === 'active' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
              {/* Two different silences, and they had the same caption. Only the app's own pause
                  means "they say it's done"; his own pause means he decided to stop asking. */}
              <Radio className="h-3 w-3" /> {liveChase.status === 'active' ? `chased at ${liveChase.times.join(', ')}` : liveChase.pausedAuto === false ? 'paused by you' : 'paused — they say it’s done'}
            </span>
          )}
          {!liveChase && t.status === 'open' && <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-500 dark:bg-zinc-800">not being chased</span>}
        </div>

        {/* What you can DO about it, on the same card as what it is. (BEA-1315) */}
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {t.status === 'open' ? (
            <>
              {/* A daily report is a standing arrangement, not a job that finishes — it is satisfied
                  day by day and the delegated and stalling lists both exclude it for that reason.
                  So it is never offered "Mark done"; it ends by being stopped. (BEA-1117/1123) */}
              {!isReport && <Act onClick={() => setDoneFor(true)} busy={busy} icon={<CheckCircle2 className="h-3.5 w-3.5" />} tone="go">Mark done</Act>}
              <Act onClick={() => setEditing(true)} busy={busy} icon={<Pencil className="h-3.5 w-3.5" />}>Edit</Act>
              <Act onClick={() => setHandOver(true)} busy={busy} icon={<ArrowRightLeft className="h-3.5 w-3.5" />}>Hand over</Act>
              <Act onClick={() => { setDropReason(''); setDropping(true); }} busy={busy} icon={<Ban className="h-3.5 w-3.5" />}>
                {isReport ? 'Stop this report' : 'Not doing it'}
              </Act>
            </>
          ) : (
            <Act
              // `PUT :id` does not accept a status at all — it would have looked like it worked and
              // changed nothing. `:id/done` with done:false is the real door: it clears the drop as
              // well, so a job can never be both dropped and open, and it restarts the chase.
              onClick={() => act(`/api/tasks/${t.id}/done`, { method: 'POST', body: JSON.stringify({ done: false }) }, // Not "chasing resumes": reopening only revives a chase that was stopped BECAUSE the work
              // finished, or auto-paused. A one-off chase with repeat:'none' stays dead, and this was
              // the first screen to state otherwise as fact. (review finding)
              'Open again')}
              busy={busy}
              icon={<RotateCcw className="h-3.5 w-3.5" />}
            >
              Open it again
            </Act>
          )}
          <Act
            onClick={() => setConfirm({
              title: 'Delete this job?',
              message: `“${t.title}” goes for good, along with its chase, what was said about it and its history. Closing it as not done keeps all of that instead.`,
              label: 'Delete',
              run: () => act(`/api/tasks/${t.id}`, { method: 'DELETE' }, 'Deleted', () => navigate(-1)),
            })}
            busy={busy}
            icon={<Trash2 className="h-3.5 w-3.5" />}
            tone="stop"
            label="Delete this job"
          >
            Delete
          </Act>
        </div>
      </div>

      {/* Somebody says it is finished and it is sitting on you. Answering here goes through the same
          door as the review inbox, so the chase reacts identically either way. (BEA-1315) */}
      {pending.map((c) => (
        <div key={c.id} className="rounded-2xl border border-amber-300/70 bg-amber-500/5 p-4 dark:border-amber-500/30">
          <h2 className="mb-1 text-sm font-bold">{c.by || 'They'} say it is done — is it?</h2>
          <p className="text-sm italic text-zinc-500">“{c.quote}”</p>
          <p className="mt-0.5 text-[11px] text-zinc-400">{when(c.createdAt)}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Act onClick={() => act(`/api/tasks/claims/${c.id}/decide`, { method: 'POST', body: JSON.stringify({ confirm: true }) }, 'Marked done — the chase stops')} busy={busy} icon={<Check className="h-3.5 w-3.5" />} tone="go">Yes, it is done</Act>
            <Act onClick={() => act(`/api/tasks/claims/${c.id}/decide`, { method: 'POST', body: JSON.stringify({ confirm: false }) }, 'Chasing again')} busy={busy} icon={<X className="h-3.5 w-3.5" />} tone="stop">No, not yet</Act>
          </div>
        </div>
      ))}

      {/* The chase itself — stop the messages without hunting for it on another screen. */}
      {t.chases.length > 0 && (
        <div className={card}>
          <h2 className="mb-3 text-sm font-bold">The chase</h2>
          <ul className="space-y-2.5">
            {t.chases.map((c) => (
              // Who and when on their own line. Sharing a row with three buttons squeezed the name
              // to "V." on a phone — the one thing on the row you actually need to read.
              <li key={c.id} className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ' + (c.status === 'active' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : c.status === 'paused' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-zinc-500/10 text-zinc-500')}>{c.status}</span>
                  <span className="min-w-0 text-xs text-zinc-500">
                    {c.contact?.name ? `${c.contact.name} · ` : ''}{c.times.length ? c.times.join(', ') : 'no set times'}
                  </span>
                </div>
                <span className="flex flex-wrap gap-1">
                  {c.status === 'active' && <Act onClick={() => act(`/api/reminders/${c.id}/pause`, { method: 'POST' }, 'Paused — they stop being messaged until you resume')} busy={busy} icon={<Pause className="h-3.5 w-3.5" />}>Pause</Act>}
                  {c.status === 'paused' && <Act onClick={() => act(`/api/reminders/${c.id}/resume`, { method: 'POST' }, 'Chasing again')} busy={busy} icon={<Play className="h-3.5 w-3.5" />}>Resume</Act>}
                  {(c.status === 'active' || c.status === 'paused') && (
                    <Act
                      onClick={() => setConfirm({ title: 'Stop this chase?', message: 'No more messages go out about this. The job stays open — you can start a new chase later.', label: 'Stop it', run: () => act(`/api/reminders/${c.id}/stop`, { method: 'POST' }, 'Stopped') })}
                      busy={busy}
                      icon={<Square className="h-3.5 w-3.5" />}
                    >
                      Stop
                    </Act>
                  )}
                  <Act
                    onClick={() => setConfirm({ title: 'Delete this chase?', message: 'The chase and its record go. The job itself stays exactly as it is.', label: 'Delete', run: () => act(`/api/reminders/${c.id}`, { method: 'DELETE' }, 'Chase deleted') })}
                    busy={busy}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    tone="stop"
                    label="Delete this chase"
                  >
                    Delete
                  </Act>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The story, in the order it happened. */}
      <div className={card}>
        <h2 className="mb-3 text-sm font-bold">What has happened</h2>
        <ol className="space-y-3">
          {story.map((s, i) => (
            <li key={i} className="flex gap-2.5">
              <span className={'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ' + (s.icon === 'ended' ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800' : s.icon === 'said' ? 'bg-amber-500/10 text-amber-600' : s.icon === 'moved' ? 'bg-indigo-500/10 text-indigo-600' : 'bg-emerald-500/10 text-emerald-600')}>
                {s.icon === 'ended' ? <Check className="h-3 w-3" /> : s.icon === 'said' ? <MessageSquare className="h-3 w-3" /> : s.icon === 'moved' ? <ArrowRightLeft className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug">{s.text}</p>
                {s.sub && <p className="mt-0.5 text-xs italic text-zinc-500">{s.sub}</p>}
                <p className="mt-0.5 text-[11px] text-zinc-400">{when(s.at)}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Undo the last handover — the mirror of handing it on, in the place you notice it. */}
      {lastHandover && t.status === 'open' && (
        <div className={card}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-sm text-zinc-500">
              Last handed {lastHandover.from ? `from ${lastHandover.from} ` : ''}to <span className="font-medium text-zinc-700 dark:text-zinc-200">{lastHandover.to || 'someone'}</span>.
            </p>
            <Act
              onClick={() => setConfirm({
                title: 'Give it back?',
                message: `It goes back to ${lastHandover.from || 'whoever had it before'}, and ${lastHandover.to || 'the current person'} stops being chased about it.`,
                label: 'Give it back',
                run: () => act(`/api/tasks/${t.id}/hand-back`, { method: 'POST' }, 'Handed back'),
              })}
              busy={busy}
              icon={<Undo2 className="h-3.5 w-3.5" />}
            >
              Undo the handover
            </Act>
          </div>
        </div>
      )}

      {/* A standing report's day-by-day ledger — which days came in, which were missed. */}
      {t.kind === 'recurring' && t.days.length > 0 && (
        <div className={card}>
          <h2 className="mb-3 text-sm font-bold">Day by day</h2>
          <ul className="space-y-1.5">
            {t.days.map((d) => (
              <li key={d.day} className="flex items-start gap-2 text-sm">
                <span className={'mt-0.5 shrink-0 text-xs ' + (d.status === 'received' ? 'text-emerald-600' : 'text-rose-600')}>{d.status === 'received' ? '✓' : '✕'}</span>
                <div className="min-w-0 flex-1">
                  <span className="tabular-nums text-xs text-zinc-500">{d.day}</span>
                  {d.by && <span className="ml-1.5 text-xs text-zinc-400">· {d.by}</span>}
                  {(d.summary || d.quote) && <p className="mt-0.5 truncate text-xs text-zinc-500">{d.summary || d.quote}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Said about THIS work — not everything that person has ever said. A section showing the
          wrong conversation is worse than one showing none, because it looks like an answer. */}
      {t.owner && t.messages.length === 0 && (
        <div className={card}>
          <h2 className="mb-1 text-sm font-bold">What was said</h2>
          <p className="text-sm text-zinc-500">
            Nothing about this one yet.{' '}
            <button onClick={() => navigate(`/contacts?contact=${t.owner!.id}`)} className="text-emerald-600 hover:underline">
              Open your whole chat with {t.owner.name}
            </button>
          </p>
        </div>
      )}
      {t.messages.length > 0 && (
        <div className={card}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">What was said about this</h2>
            {t.owner && (
              <button onClick={() => navigate(`/contacts?contact=${t.owner!.id}`)} className="text-xs text-emerald-600 hover:underline">Whole chat</button>
            )}
          </div>
          <ul className="space-y-2">
            {t.messages.slice(-8).map((m) => (
              <li key={m.id} className={'group flex items-center gap-1 ' + (m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ' + (m.direction === 'out' ? 'order-2 bg-emerald-500/15' : 'bg-zinc-100 dark:bg-zinc-800')}>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-400">
                    <Clock className="mr-0.5 inline h-2.5 w-2.5" />{when(m.createdAt)}{m.by ? ` · ${m.by}` : ''}
                  </p>
                </div>
                {/* Visible at rest on touch, where there is no hover to reveal it. Deleting the words
                    never touches the work behind them. (BEA-1309/1315) */}
                <button
                  onClick={() => setConfirm({
                    title: 'Delete this message?',
                    message: 'Only the message goes. The job, its chase and anything claimed about it stay exactly as they are.',
                    label: 'Delete',
                    run: () => act(`/api/reminders/messages/${m.id}`, { method: 'DELETE' }, 'Message deleted'),
                  })}
                  disabled={busy}
                  aria-label="Delete this message"
                  className="shrink-0 rounded p-1 text-zinc-300 opacity-60 hover:text-red-600 disabled:opacity-30 dark:text-zinc-600 sm:opacity-0 sm:group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing && <TaskFormModal task={t as unknown as Task} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />}
      {doneFor && <DoneModal task={t as unknown as Task} onClose={() => setDoneFor(false)} onSaved={() => { setDoneFor(false); void load(); }} />}
      {handOver && (
        <HandOverSheet
          task={{ id: t.id, title: t.title, who: t.owner?.name || null }}
          onClose={() => setHandOver(false)}
          onDone={() => { setHandOver(false); void load(); }}
        />
      )}

      {/* Closing it as not done asks WHY, because the reason is the whole value of the record —
          "Radha left the organisation" is what makes the ending readable a month later. */}
      {dropping && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900">
            <h3 className="mb-1 font-bold">{isReport ? 'Stop this daily report?' : 'Close it as not done?'}</h3>
            <p className="mb-3 text-sm text-zinc-500">
              {isReport
                ? 'They stop being asked for it every day. Every day already sent stays in the record.'
                : 'It leaves your board and stops being chased. It stays in your history and is never counted as finished.'}
            </p>
            <label htmlFor="drop-why" className="mb-1 block text-xs font-medium text-zinc-500">Why? <span className="font-normal text-zinc-400">(optional)</span></label>
            <input
              id="drop-why"
              value={dropReason}
              onChange={(e) => setDropReason(e.target.value)}
              placeholder="e.g. Radha left the organisation"
              className="mb-4 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setDropping(false)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Cancel</button>
              <button
                onClick={() => { setDropping(false); void act(`/api/tasks/${t.id}/drop`, { method: 'POST', body: JSON.stringify({ reason: dropReason.trim() || undefined }) }, 'Closed as not done — it stays in your history'); }}
                disabled={busy}
                className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm text-white hover:bg-zinc-600 disabled:opacity-50"
              >
                {isReport ? 'Stop it' : 'Close it'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          onConfirm={() => void confirm.run()}
          onCancel={() => setConfirm(null)}
          busy={busy}
        />
      )}
    </div>
  );
}

/** One small button, so every action on this page looks and behaves the same. */
function Act({ children, onClick, busy, icon, tone, label }: { children: React.ReactNode; onClick: () => void; busy?: boolean; icon?: React.ReactNode; tone?: 'go' | 'stop'; label?: string }) {
  const cls =
    tone === 'go'
      ? 'border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400'
      : tone === 'stop'
        // Quieter than the rest, but never so dim it reads as switched off — at 390 the greyed
        // Delete looked disabled next to its neighbours.
        ? 'border-zinc-200 text-zinc-500 hover:border-red-300 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-400'
        : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';
  return (
    <button
      onClick={onClick}
      disabled={busy}
      // Several buttons on this page read just "Delete". They are unambiguous on screen because
      // each sits in its own card, and identical to anyone using a screen reader — hence the label.
      aria-label={label}
      className={'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ' + cls}
    >
      {icon}
      {children}
    </button>
  );
}
