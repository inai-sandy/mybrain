import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Check, CheckCircle2, Clock, MessageSquare, Radio, UserRound, ArrowRightLeft, Loader2 } from 'lucide-react';

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
  chases: { id: string; status: string; repeat: string; times: string[]; subject?: string | null; createdAt: string; contact?: { id: string; name: string } | null }[];
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
  const [t, setT] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/tasks/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setT)
      .catch(() => setMissing(true));
  }, [id]);

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
              <Radio className="h-3 w-3" /> {liveChase.status === 'active' ? `chased at ${liveChase.times.join(', ')}` : 'paused — they say it’s done'}
            </span>
          )}
          {!liveChase && t.status === 'open' && <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-500 dark:bg-zinc-800">not being chased</span>}
        </div>
      </div>

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

      {/* The conversation about this work — with a way through to the full thread. */}
      {t.messages.length > 0 && (
        <div className={card}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">What was said</h2>
            {t.owner && (
              <button onClick={() => navigate(`/contacts?contact=${t.owner!.id}`)} className="text-xs text-emerald-600 hover:underline">Open the full chat</button>
            )}
          </div>
          <ul className="space-y-2">
            {t.messages.slice(-8).map((m) => (
              <li key={m.id} className={'flex ' + (m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ' + (m.direction === 'out' ? 'bg-emerald-500/15' : 'bg-zinc-100 dark:bg-zinc-800')}>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-400"><Clock className="mr-0.5 inline h-2.5 w-2.5" />{when(m.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
