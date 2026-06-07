import { useEffect, useState } from 'react';
import { Activity as ActivityIcon, ChevronLeft, ChevronRight, FileText, Bookmark, Lightbulb, Wand2, CheckCircle2, Brain, Moon, MessageSquare, Sparkles, RefreshCw } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Ev = { type: string; title: string; detail?: string; at: string };
type Stats = { tasksTotal: number; tasksDone: number; tasksOpen: number; minutesSpent: number; minutesEstimated: number };
type Summary = { day: string; text: string; stats: Stats | null } | null;
type Story = { text: string; mood?: string | null } | null;
type ActivityData = { day: string; isToday: boolean; stats: Stats; story: Story; summary: Summary; timeline: Ev[] };

const ICON: Record<string, any> = { capture: FileText, bookmark: Bookmark, idea: Lightbulb, skill: Wand2, task: CheckCircle2, dump: Brain, story: Moon, note: MessageSquare };
const TINT: Record<string, string> = {
  capture: 'text-sky-500 bg-sky-500/10', bookmark: 'text-emerald-500 bg-emerald-500/10', idea: 'text-amber-500 bg-amber-500/10',
  skill: 'text-violet-500 bg-violet-500/10', task: 'text-emerald-600 bg-emerald-600/10', dump: 'text-emerald-500 bg-emerald-500/10',
  story: 'text-indigo-400 bg-indigo-500/10', note: 'text-zinc-500 bg-zinc-500/10',
};

function addDays(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function prettyDay(day: string): string {
  const d = new Date(day + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function mins(n: number): string {
  if (!n) return '0m';
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function Activity() {
  const [day, setDay] = useState<string | null>(null);
  const [data, setData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [gen, setGen] = useState(false);
  const toast = useToast();

  async function load(d?: string) {
    setLoading(true);
    try {
      const r = await fetch('/api/daily/activity' + (d ? `?day=${d}` : ''));
      if (r.ok) {
        const j = await r.json();
        setData(j);
        setDay(j.day);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function generate(force = false) {
    if (!day) return;
    setGen(true);
    try {
      const r = await fetch('/api/daily/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, force }) });
      if (r.ok) {
        toast('success', force ? 'Summary rebuilt' : 'Summary generated');
        load(day);
      } else toast('error', 'Could not generate');
    } catch {
      toast('error', 'Could not generate');
    } finally {
      setGen(false);
    }
  }

  const st = data?.stats;
  const pct = st && st.tasksTotal ? Math.round((st.tasksDone / st.tasksTotal) * 100) : 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2"><ActivityIcon className="text-emerald-500" /> Activity</h1>
        <p className="text-zinc-500 text-sm">Your day, captured — what you did, finished, and felt.</p>
      </div>

      {/* Day navigator */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => day && load(addDays(day, -1))} className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-emerald-500"><ChevronLeft size={16} /></button>
        <div className="flex items-center gap-2 text-center">
          <div className="font-semibold">{day ? prettyDay(day) : '—'}{data?.isToday && <span className="ml-2 text-xs text-emerald-600">Today</span>}</div>
          <input type="date" value={day || ''} max={new Date().toISOString().slice(0, 10)} onChange={(e) => e.target.value && load(e.target.value)} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs" />
        </div>
        <button disabled={!!data?.isToday} onClick={() => day && load(addDays(day, 1))} className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-emerald-500 disabled:opacity-30"><ChevronRight size={16} /></button>
      </div>

      {/* Stats */}
      {st && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-center">
            <div className="text-xl font-extrabold tabular-nums">{st.tasksDone}<span className="text-zinc-400 text-sm">/{st.tasksTotal}</span></div>
            <div className="text-[11px] text-zinc-400">tasks done</div>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-center">
            <div className="text-xl font-extrabold tabular-nums">{mins(st.minutesSpent)}</div>
            <div className="text-[11px] text-zinc-400">time spent</div>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-center">
            <div className="text-xl font-extrabold tabular-nums">{pct}%</div>
            <div className="text-[11px] text-zinc-400">follow-through</div>
          </div>
        </div>
      )}

      {/* AI summary */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="flex items-center gap-2 font-semibold"><Sparkles size={16} className="text-emerald-500" /> Day summary</h2>
          {data?.summary && <button onClick={() => generate(true)} disabled={gen} className="text-xs text-zinc-400 hover:text-emerald-600 inline-flex items-center gap-1"><RefreshCw size={12} /> rebuild</button>}
        </div>
        {data?.summary ? (
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">{data.summary.text}</p>
        ) : (
          <div className="text-sm text-zinc-500">
            <p className="mb-3">{data?.isToday ? 'Auto-generates at 9:30 PM — or build it now.' : 'No summary was generated for this day.'}</p>
            <button onClick={() => generate(false)} disabled={gen} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
              {gen ? 'Generating…' : 'Generate summary'}
            </button>
          </div>
        )}
      </section>

      {/* Story */}
      {data?.story && (
        <section className="rounded-xl border border-indigo-300/40 dark:border-indigo-500/30 bg-indigo-500/5 p-4">
          <h2 className="flex items-center gap-2 font-semibold text-sm mb-1.5"><Moon size={15} className="text-indigo-400" /> Your story {data.story.mood && <span className="text-xs font-normal">· {data.story.mood}</span>}</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{data.story.text}</p>
        </section>
      )}

      {/* Timeline */}
      <section>
        <h2 className="font-semibold text-sm mb-2 text-zinc-500">Timeline</h2>
        {loading ? (
          <p className="text-sm text-zinc-400">Loading…</p>
        ) : data && data.timeline.length ? (
          <ul className="space-y-2">
            {data.timeline.map((e, i) => {
              const Icon = ICON[e.type] || Sparkles;
              return (
                <li key={i} className="flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <span className={'shrink-0 rounded-lg p-1.5 ' + (TINT[e.type] || 'text-zinc-500 bg-zinc-500/10')}><Icon size={15} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium leading-snug">{e.title}</div>
                    {e.detail && <div className="text-xs text-zinc-400">{e.detail}</div>}
                  </div>
                  <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">{timeOf(e.at)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-zinc-400 rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800 p-6 text-center">Nothing captured for this day yet.</p>
        )}
      </section>
    </div>
  );
}
