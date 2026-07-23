import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Activity as ActivityIcon, ChevronLeft, ChevronRight, FileText, Bookmark, Lightbulb, Wand2, CheckCircle2, Brain, Moon, MessageSquare, Sparkles, RefreshCw, Flame, BarChart3, CalendarDays, ListTree, Fingerprint, Check, X, Plus, ListChecks, Mic, BookOpen, Lock, Clock, TrendingUp, TrendingDown, Footprints, HeartPulse, Users } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { Markdown } from '../ui/markdown';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Sheet } from '../ui/Sheet';
import { StoryModal } from './DailyStory';
import { CloseDaySheet } from './CloseDay';

type Ev = { type: string; title: string; detail?: string; at: string };
type Stats = { tasksTotal: number; tasksDone: number; tasksOpen: number; minutesSpent: number; minutesEstimated: number; workedMinutes?: number | null };
type Summary = { day: string; text: string; stats: Stats | null } | null;
type Story = { text: string; mood?: string | null } | null;
type DayStoryT = { text: string; personalText?: string | null; mood?: string | null; moodScore?: number | null; proMoodScore?: number | null; personalMoodScore?: number | null } | null;
type Emotions = { lifted: string[]; drained: string[]; energy: number | null; worry: number | null; feeling: string | null };
type DayData = { day: string; isToday: boolean; stats: Stats; emotions?: Emotions | null; story: Story; summary: Summary; dayStory: DayStoryT; timeline: Ev[]; closed?: boolean; provisional?: boolean; needsClosing?: boolean; openTaskCount?: number };

type Dash = {
  days: number;
  totals: { tasksTotal: number; tasksDone: number; followThrough: number };
  minutesSpent: number;
  minutesWorked?: number;
  worked?: { today: number; week: number; prevWeek: number; window: number; weekAvg: number };
  categoryTime: { category: string; minutes: number }[];
  estimateVsActual: { estimated: number; actual: number; count: number };
  streak: number;
  perDay: { day: string; done: number; total: number; worked?: number }[];
};
type Cal = { start: string; end: string; days: { day: string; done: number; total: number; dumped: boolean; story: boolean; suggested?: number }[] };
// Insights that are about YOU, not just tasks. (BEA-1060)
type Insights = {
  days: number;
  moodTrend: { day: string; mood: number | null; energy: number | null; worry: number | null }[];
  delegation: { teamOpen: number; teamDone: number; teamFollowThrough: number | null; promisesTotal: number; promisesKept: number; promisesOpen: number; promiseKeepRate: number | null; slipping: { title: string; party: string | null; slips: number; due: string | null; overdue: boolean }[] };
  neglect: { brainEaterCount: number; oldestBrainEaterDays: number; aging: { title: string; days: number }[]; oldestOpen: { title: string; days: number; carried: number }[] };
};

const ICON: Record<string, any> = { capture: FileText, bookmark: Bookmark, idea: Lightbulb, skill: Wand2, task: CheckCircle2, dump: Brain, story: Moon, note: MessageSquare, life: Footprints };
const TINT: Record<string, string> = {
  capture: 'text-sky-500 bg-sky-500/10', bookmark: 'text-emerald-500 bg-emerald-500/10', idea: 'text-amber-500 bg-amber-500/10',
  skill: 'text-violet-500 bg-violet-500/10', task: 'text-emerald-600 bg-emerald-600/10', dump: 'text-emerald-500 bg-emerald-500/10',
  story: 'text-indigo-400 bg-indigo-500/10', note: 'text-zinc-500 bg-zinc-500/10', life: 'text-pink-500 bg-pink-500/10',
};

function addDays(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function prettyDay(day: string): string {
  const d = new Date(day + 'T12:00:00Z');
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

// ---------- Day view ----------
function DayView({ day, onDay }: { day: string | null; onDay: (d: string) => void }) {
  const [data, setData] = useState<DayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [gen, setGen] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const toast = useToast();

  const reqId = useRef(0);
  async function load(d?: string) {
    // NOTE: no setLoading(true) on refresh — keep current content on screen so scroll position survives
    const my = ++reqId.current; // latest-wins: rapid Prev/Next must not let a slow earlier response win (BEA-816)
    try {
      const r = await fetch('/api/daily/activity' + (d ? `?day=${d}` : ''));
      if (r.ok) {
        const j = await r.json();
        if (my !== reqId.current) return; // a newer navigation superseded this one
        setData(j);
        if (j.day !== day) onDay(j.day);
      }
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }
  useEffect(() => {
    load(day || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  async function generate(force = false) {
    if (!day) return;
    setGen(true);
    try {
      const r = await fetch('/api/daily/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, force }) });
      if (r.ok) {
        toast('success', force ? 'Summary rebuilt' : 'Summary generated');
        load(day);
      } else toast('error', 'Could not generate');
    } finally {
      setGen(false);
    }
  }

  const [genStory, setGenStory] = useState(false);
  const [telling, setTelling] = useState(false);
  async function buildStory(force = false) {
    if (!day) return;
    setGenStory(true);
    try {
      const r = await fetch('/api/daily/day-story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, force }) });
      if (r.ok) {
        toast('success', force ? 'Story of the Day rebuilt' : 'Story of the Day created');
        load(day);
      } else toast('error', 'Could not create the story');
    } finally {
      setGenStory(false);
    }
  }

  const st = data?.stats;
  const pct = st && st.tasksTotal ? Math.round((st.tasksDone / st.tasksTotal) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => day && onDay(addDays(day, -1))} className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-emerald-500"><ChevronLeft size={16} /></button>
        <div className="flex items-center gap-2 text-center">
          <div className="font-semibold">{day ? prettyDay(day) : '—'}{data?.isToday && <span className="ml-2 text-xs text-emerald-600">Today</span>}</div>
          <input type="date" value={day || ''} max={new Date().toISOString().slice(0, 10)} onChange={(e) => e.target.value && onDay(e.target.value)} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs" />
        </div>
        <button disabled={!!data?.isToday} onClick={() => day && onDay(addDays(day, 1))} className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-emerald-500 disabled:opacity-30"><ChevronRight size={16} /></button>
      </div>

      {/* A past day that isn't sealed yet — finish & close it right here */}
      {data?.needsClosing && day && (
        <button onClick={() => setClosing(day)} className="w-full flex items-center justify-center gap-2 rounded-xl border border-amber-300/50 dark:border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300">
          <Lock size={15} /> This day is still open — finish &amp; close it
        </button>
      )}
      {closing && <CloseDaySheet day={closing} onClose={() => setClosing(null)} onClosed={() => load(day || undefined)} />}

      {st && (
        <div className="grid grid-cols-3 gap-3">
          <Stat big={`${st.tasksDone}/${st.tasksTotal}`} label="tasks done" />
          <Stat big={st.workedMinutes != null ? mins(st.workedMinutes) : mins(st.minutesSpent)} label={st.workedMinutes != null ? 'worked' : 'time spent'} />
          <Stat big={`${pct}%`} label="follow-through" />
        </div>
      )}

      {/* How the day FELT — mined from his own words. (BEA-1054) */}
      {data?.emotions && (data.emotions.feeling || data.emotions.lifted?.length || data.emotions.drained?.length) && (
        <section className="rounded-xl border border-pink-300/40 dark:border-pink-500/25 bg-gradient-to-br from-pink-500/10 to-transparent p-4">
          <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold"><HeartPulse size={15} className="text-pink-500" /> How the day felt</h2>
          {data.emotions.feeling && <p className="text-sm text-zinc-700 dark:text-zinc-200">{data.emotions.feeling}</p>}
          {(data.emotions.energy != null || data.emotions.worry != null) && (
            <div className="mt-2.5 space-y-1.5">
              {data.emotions.energy != null && (
                <div className="flex items-center gap-2 text-[11px] text-zinc-500"><span className="w-12">energy</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"><div className="h-full bg-emerald-500" style={{ width: `${data.emotions.energy}%` }} /></div>
                  <span className="w-7 text-right tabular-nums">{data.emotions.energy}</span></div>
              )}
              {data.emotions.worry != null && (
                <div className="flex items-center gap-2 text-[11px] text-zinc-500"><span className="w-12">worry</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"><div className="h-full bg-amber-500" style={{ width: `${data.emotions.worry}%` }} /></div>
                  <span className="w-7 text-right tabular-nums">{data.emotions.worry}</span></div>
              )}
            </div>
          )}
          {(data.emotions.lifted?.length > 0 || data.emotions.drained?.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {data.emotions.lifted?.map((x, i) => <span key={'l'+i} className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">▲ {x}</span>)}
              {data.emotions.drained?.map((x, i) => <span key={'d'+i} className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-600 dark:text-rose-400">▼ {x}</span>)}
            </div>
          )}
        </section>
      )}

      {/* Story of the Day — the woven nightly narrative (story + tasks + activity) */}
      <section className="rounded-xl border border-indigo-300/50 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 to-transparent p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="flex items-center gap-2 font-semibold"><Moon size={16} className="text-indigo-400" /> Story of the Day
            {typeof data?.dayStory?.moodScore === 'number' && (
              <span className="text-xs font-normal text-zinc-500 inline-flex items-center gap-1">· mood {data.dayStory.moodScore}/100{data.dayStory.mood ? ` · ${data.dayStory.mood}` : ''}</span>
            )}
          </h2>
          {data?.dayStory && <button onClick={() => buildStory(true)} disabled={genStory} className="text-xs text-zinc-400 hover:text-indigo-500 inline-flex items-center gap-1"><RefreshCw size={12} /> rebuild</button>}
        </div>
        {/* provisional vs final — the score only settles when the day is closed */}
        {data?.dayStory && (
          data.closed ? (
            <p className="mb-2 inline-flex items-center gap-1 text-[11px] rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5">🔒 Final — this day is sealed</p>
          ) : (
            <p className="mb-2 text-[11px] rounded-lg bg-amber-500/10 border border-amber-300/30 dark:border-amber-500/20 text-amber-700 dark:text-amber-300 px-2.5 py-1.5">⏳ Provisional — the score finalizes when you close this day{data.openTaskCount ? ` (${data.openTaskCount} task${data.openTaskCount === 1 ? '' : 's'} still open)` : ''}.</p>
          )
        )}
        {data?.dayStory ? (
          data.dayStory.personalText ? (
            <StoryTabs ds={data.dayStory} />
          ) : (
            <Markdown className="text-sm text-zinc-700 dark:text-zinc-200 leading-relaxed">{data.dayStory.text}</Markdown>
          )
        ) : (
          <div className="text-sm text-zinc-500">
            <p className="mb-3">{data?.isToday ? 'Your Story of the Day writes itself at 11:58 PM — weaving your story, tasks and activity into one. Or create it now.' : 'No Story of the Day was written for this day.'}</p>
            <button onClick={() => buildStory(false)} disabled={genStory} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">{genStory ? 'Writing…' : 'Create Story of the Day'}</button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="flex items-center gap-2 font-semibold"><Sparkles size={16} className="text-emerald-500" /> Day summary <span className="text-xs font-normal text-zinc-400">· 9:30 PM</span></h2>
          {data?.summary && <button onClick={() => generate(true)} disabled={gen} className="text-xs text-zinc-400 hover:text-emerald-600 inline-flex items-center gap-1"><RefreshCw size={12} /> rebuild</button>}
        </div>
        {data?.summary ? (
          <Markdown className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">{data.summary.text}</Markdown>
        ) : (
          <div className="text-sm text-zinc-500">
            <p className="mb-3">{data?.isToday ? 'Auto-generates at 9:30 PM — or build it now.' : 'No summary was generated for this day.'}</p>
            <button onClick={() => generate(false)} disabled={gen} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">{gen ? 'Generating…' : 'Generate summary'}</button>
          </div>
        )}
      </section>

      {/* Your story — always available, for today or any past day; saving rewrites that day's Story of the Day */}
      <section className="rounded-xl border border-indigo-300/40 dark:border-indigo-500/30 bg-indigo-500/5 p-4">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="flex items-center gap-2 font-semibold text-sm"><Moon size={15} className="text-indigo-400" /> Your story {data?.story?.mood && <span className="text-xs font-normal">· {data.story.mood}</span>}</h2>
          {data?.story && <button onClick={() => setTelling(true)} className="text-xs text-indigo-500 hover:underline">Edit</button>}
        </div>
        {data?.story ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{data.story.text}</p>
        ) : (
          <div className="text-sm text-zinc-500">
            <p className="mb-3">{data?.isToday ? 'Tell the story of your day — type or speak it. This is how the app comes to understand you.' : 'You didn’t tell this day’s story — you still can. The Story of the Day will rewrite itself around your words.'}</p>
            <button onClick={() => setTelling(true)} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 text-sm inline-flex items-center gap-1.5"><Mic size={14} /> Tell this day’s story</button>
          </div>
        )}
      </section>
      {telling && day && (
        <StoryModal
          initial={data?.story || null}
          day={day}
          title={data?.isToday ? "Tonight's story" : `Story for ${prettyDay(day)}`}
          onClose={() => setTelling(false)}
          onSaved={() => {
            load(day);
            // the Story of the Day rewrite runs in the background — refresh again once it has had time to finish
            setTimeout(() => load(day), 12000);
          }}
        />
      )}

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

function Stat({ big, label }: { big: string; label: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-center">
      <div className="text-xl font-extrabold tabular-nums">{big}</div>
      <div className="text-[11px] text-zinc-400">{label}</div>
    </div>
  );
}

// ---------- Insights view ----------
/** A tiny SVG line for a 0–100 series across days — used for mood/energy/worry. (BEA-1060) */
function TrendLine({ points, color, w = 300, h = 48 }: { points: (number | null)[]; color: string; w?: number; h?: number }) {
  const vals = points.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  if (vals.length < 2) return null;
  const n = points.length - 1 || 1;
  const x = (i: number) => (i / n) * (w - 4) + 2;
  const y = (v: number) => h - 4 - (v / 100) * (h - 8);
  const dPath = vals.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }} preserveAspectRatio="none">
      <path d={dPath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {vals.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r="2" fill={color} />)}
    </svg>
  );
}

/** The written "what's really going on" card. (BEA-1060) */
function WrittenInsight() {
  const [w, setW] = useState<{ text: string | null; generatedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch('/api/daily/insights/written').then((r) => (r.ok ? r.json() : null)).then(setW).catch(() => undefined); }, []);
  async function regen() {
    setBusy(true);
    try { const r = await fetch('/api/daily/insights/written/regenerate', { method: 'POST' }); if (r.ok) setW(await r.json()); } finally { setBusy(false); }
  }
  if (!w || !w.text) return null;
  return (
    <section className="rounded-2xl border border-violet-400/30 bg-gradient-to-br from-violet-500/10 via-emerald-500/5 to-transparent p-5">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-sm"><Sparkles size={15} className="text-violet-500" /> What's really going on</h2>
        <button onClick={regen} disabled={busy} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-violet-500 disabled:opacity-50"><RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> refresh</button>
      </div>
      <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">{w.text}</p>
    </section>
  );
}

function InsightsView() {
  const [d, setD] = useState<Dash | null>(null);
  const [ins, setIns] = useState<Insights | null>(null);
  const [range, setRange] = useState(30);
  useEffect(() => {
    fetch(`/api/daily/dashboard?days=${range}`).then((r) => r.json()).then(setD).catch(() => undefined);
    fetch(`/api/daily/insights?days=${range}`).then((r) => (r.ok ? r.json() : null)).then(setIns).catch(() => undefined);
  }, [range]);
  if (!d) return <p className="text-sm text-zinc-400">Loading…</p>;

  const maxCat = Math.max(1, ...d.categoryTime.map((c) => c.minutes));
  const eva = d.estimateVsActual;
  const ratio = eva.estimated ? Math.round((eva.actual / eva.estimated) * 100) : 0;
  const maxDone = Math.max(1, ...d.perDay.map((p) => p.done));

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* The honest read, first — the pattern you might not see. (BEA-1060) */}
      <WrittenInsight />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-amber-300/40 bg-amber-500/5 p-3 text-center">
          <div className="text-xl font-extrabold tabular-nums flex items-center justify-center gap-1"><Flame size={16} className="text-amber-500" />{d.streak}</div>
          <div className="text-[11px] text-zinc-400">dump streak</div>
        </div>
        <Stat big={`${d.totals.tasksDone}/${d.totals.tasksTotal}`} label="tasks done" />
        <Stat big={`${d.totals.followThrough}%`} label="follow-through" />
        <Stat big={d.minutesWorked ? mins(d.minutesWorked) : mins(d.minutesSpent)} label={d.minutesWorked ? 'worked' : 'time spent'} />
      </div>

      {/* working hours — the real timesheet (from your stated hours) */}
      {d.worked && (() => {
        const w = d.worked;
        const delta = w.week - w.prevWeek;
        const maxW = Math.max(1, ...d.perDay.map((p) => p.worked || 0));
        return (
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-sm flex items-center gap-1.5"><Clock size={15} className="text-emerald-500" /> Working hours</h2>
              {w.prevWeek > 0 && (
                <span className={'inline-flex items-center gap-1 text-xs ' + (delta >= 0 ? 'text-emerald-600' : 'text-rose-500')}>
                  {delta >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />} {delta >= 0 ? '+' : ''}{mins(Math.abs(delta))} vs last week
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat big={mins(w.today)} label="today" />
              <Stat big={mins(w.week)} label={`this week${w.weekAvg ? ` · ${mins(w.weekAvg)}/day` : ''}`} />
              <Stat big={mins(w.window)} label={`last ${d.days}d`} />
            </div>
            {maxW > 1 && (
              <div className="mt-4 flex items-end gap-1 h-16">
                {d.perDay.map((p) => (
                  <div key={p.day} className="flex-1 flex flex-col items-center justify-end gap-1" title={`${prettyDay(p.day)} · ${mins(p.worked || 0)}`}>
                    <div className="w-full rounded-t bg-emerald-500/80" style={{ height: `${Math.round(((p.worked || 0) / maxW) * 100)}%` }} />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })()}

      {/* mood & energy over time — how you actually FELT, not just task counts. (BEA-1060) */}
      {ins && ins.moodTrend.filter((m) => m.mood != null || m.energy != null || m.worry != null).length >= 2 && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 font-semibold text-sm"><HeartPulse size={15} className="text-pink-500" /> Mood & energy over time</h2>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-indigo-500" /> mood</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> energy</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> worry</span>
            </div>
          </div>
          <div className="relative">
            <TrendLine points={ins.moodTrend.map((m) => m.mood)} color="#6366f1" />
            <div className="-mt-12"><TrendLine points={ins.moodTrend.map((m) => m.energy)} color="#10b981" /></div>
            <div className="-mt-12"><TrendLine points={ins.moodTrend.map((m) => m.worry)} color="#f59e0b" /></div>
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-zinc-400">
            <span>{ins.moodTrend[0]?.day.slice(5)}</span>
            <span>{ins.moodTrend[ins.moodTrend.length - 1]?.day.slice(5)}</span>
          </div>
        </section>
      )}

      {/* delegation & promise health — are people delivering, are you keeping your word? (BEA-1060) */}
      {ins && (ins.delegation.teamOpen + ins.delegation.teamDone > 0 || ins.delegation.promisesTotal > 0) && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <h2 className="mb-3 flex items-center gap-1.5 font-semibold text-sm"><Users size={15} className="text-amber-500" /> Delegation & promises</h2>
          <div className="grid grid-cols-2 gap-3">
            <Stat big={ins.delegation.teamFollowThrough != null ? `${ins.delegation.teamFollowThrough}%` : '—'} label={`team follow-through · ${ins.delegation.teamOpen} open`} />
            <Stat big={ins.delegation.promiseKeepRate != null ? `${ins.delegation.promiseKeepRate}%` : '—'} label={`your promises kept · ${ins.delegation.promisesKept}/${ins.delegation.promisesTotal}`} />
          </div>
          {ins.delegation.slipping.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium text-rose-600 dark:text-rose-400">Slipping promises</p>
              <ul className="space-y-1.5">
                {ins.delegation.slipping.map((s, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{s.title}{s.party ? <span className="text-zinc-400"> · {s.party}</span> : null}</span>
                    <span className="shrink-0 text-[11px] text-rose-500">{s.overdue ? 'overdue' : ''}{s.slips ? ` · re-promised ${s.slips}×` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* brain-eaters & neglect — the peaceful-sleep scoreboard. (BEA-1060) */}
      {ins && (ins.neglect.brainEaterCount > 0 || ins.neglect.oldestOpen.length > 0) && (
        <section className="rounded-xl border border-fuchsia-300/30 dark:border-fuchsia-500/25 bg-fuchsia-500/[0.04] p-5">
          <h2 className="mb-3 flex items-center gap-1.5 font-semibold text-sm"><Brain size={15} className="text-fuchsia-500" /> What's circling your head</h2>
          <div className="grid grid-cols-2 gap-3">
            <Stat big={`${ins.neglect.brainEaterCount}`} label="brain eaters open" />
            <Stat big={ins.neglect.oldestBrainEaterDays ? `${ins.neglect.oldestBrainEaterDays}d` : '—'} label="oldest one, circling" />
          </div>
          {ins.neglect.aging.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {ins.neglect.aging.map((a, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">🧠 {a.title}</span>
                  <span className="shrink-0 text-[11px] text-zinc-400">{a.days}d</span>
                </li>
              ))}
            </ul>
          )}
          {ins.neglect.brainEaterCount === 0 && ins.neglect.oldestOpen.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs text-zinc-500">Oldest still open (candidates for a brain eater):</p>
              <ul className="space-y-1.5">
                {ins.neglect.oldestOpen.map((t, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{t.title}</span>
                    <span className="shrink-0 text-[11px] text-zinc-400">{t.days}d{t.carried ? ` · carried ${t.carried}×` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* time by category */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="font-semibold text-sm mb-3">Where your time went</h2>
        {d.categoryTime.length ? (
          <div className="space-y-2.5">
            {d.categoryTime.map((c) => (
              <div key={c.category}>
                <div className="flex justify-between text-xs mb-1"><span className="text-zinc-600 dark:text-zinc-300">{c.category}</span><span className="text-zinc-400 tabular-nums">{mins(c.minutes)}</span></div>
                <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${Math.round((c.minutes / maxCat) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">Finish some tasks with a logged time to see this.</p>
        )}
      </section>

      {/* estimate vs actual */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="font-semibold text-sm mb-2">Estimate vs reality</h2>
        {eva.count ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-300">
            <p>You estimated <b>{mins(eva.estimated)}</b> and actually spent <b>{mins(eva.actual)}</b> across {eva.count} task{eva.count === 1 ? '' : 's'}.</p>
            <p className="mt-1 text-zinc-500">{ratio > 115 ? `You tend to under-estimate — things take ~${ratio}% of your guess.` : ratio < 85 ? `You tend to over-estimate — things take ~${ratio}% of your guess.` : 'Your estimates are pretty accurate. 👌'}</p>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">Log actual times on finished tasks to compare.</p>
        )}
      </section>

      {/* per-day bars */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="font-semibold text-sm mb-3">Tasks finished per day</h2>
        <div className="flex items-end gap-0.5 h-24">
          {d.perDay.map((p) => (
            <div key={p.day} title={`${p.day}: ${p.done}/${p.total}`} className="flex-1 bg-emerald-500/80 hover:bg-emerald-500 rounded-t" style={{ height: `${Math.max(3, Math.round((p.done / maxDone) * 100))}%` }} />
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------- Calendar view ----------
function CalendarView({ onPick }: { onPick: (day: string) => void }) {
  const [cal, setCal] = useState<Cal | null>(null);
  const [months, setMonths] = useState(3);
  const [fillDay, setFillDay] = useState<string | null>(null); // gap day being filled via the wizard (BEA-1062)
  const load = () => fetch(`/api/daily/calendar?months=${months}`).then((r) => r.json()).then(setCal).catch(() => undefined);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [months]);
  if (!cal) return <p className="text-sm text-zinc-400">Loading…</p>;

  const todayStr = new Date().toLocaleDateString('en-CA');
  const map = new Map(cal.days.map((d) => [d.day, d]));
  const startD = new Date(cal.start + 'T12:00:00Z');
  startD.setUTCDate(startD.getUTCDate() - startD.getUTCDay()); // back to Sunday
  const cells: { day: string }[] = [];
  let cursor = startD.toISOString().slice(0, 10);
  while (cursor <= cal.end) { cells.push({ day: cursor }); cursor = addDays(cursor, 1); }
  const weeks: { day: string }[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // Work heat (green). A day with no work but a story stays faint — the dot carries the story. (BEA-1062)
  function tint(day: string): string {
    const e = map.get(day);
    if (!e) return 'bg-zinc-100 dark:bg-zinc-800/60';
    if (e.done >= 5) return 'bg-emerald-600';
    if (e.done >= 3) return 'bg-emerald-500';
    if (e.done >= 1) return 'bg-emerald-400/70';
    if (e.total > 0 || e.dumped || e.story) return 'bg-emerald-300/40';
    if (e.suggested) return 'bg-indigo-400/60';
    return 'bg-zinc-100 dark:bg-zinc-800/60';
  }
  // A gap = a PAST day that had activity (tasks or a dump) but you never told its story. (BEA-1062)
  const isGap = (day: string) => {
    const e = map.get(day);
    return !!e && day < todayStr && !e.story && (e.total > 0 || e.dumped);
  };
  let gapCount = 0;
  for (const d of cal.days) if (isGap(d.day)) gapCount++;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        {gapCount > 0 ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">{gapCount} day{gapCount === 1 ? '' : 's'} missing a story — the amber rings. Tap one to fill it.</span>
        ) : <span />}
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))} className="shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs">
          <option value={3}>3 months</option>
          <option value={6}>6 months</option>
          <option value={12}>12 months</option>
        </select>
      </div>
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 overflow-x-auto">
        <div className="flex gap-1.5">
          {weeks.map((w, wi) => (
            <div key={wi} className="flex flex-col gap-1.5">
              {w.map((c) => {
                const e = map.get(c.day);
                const future = c.day > cal.end;
                const gap = isGap(c.day);
                const hasStory = !!e?.story;
                const isToday = c.day === todayStr;
                return (
                  <button
                    key={c.day}
                    disabled={future}
                    onClick={() => (gap ? setFillDay(c.day) : onPick(c.day))}
                    title={future ? '' : `${c.day} — ${e ? `${e.done}/${e.total} done` : 'nothing'}${e?.dumped ? ' · dumped' : ''}${hasStory ? ' · story ✓' : gap ? ' · NO story (tap to fill)' : ''}${e?.suggested ? ` · ✨${e.suggested} suggested` : ''}`}
                    className={
                      'relative grid h-6 w-6 place-items-center rounded-md transition-transform hover:scale-110 sm:h-7 sm:w-7 ' +
                      (future ? 'opacity-0' : tint(c.day)) +
                      (gap ? ' ring-2 ring-amber-400 ring-inset' : '') +
                      (isToday ? ' outline outline-2 outline-offset-1 outline-zinc-400 dark:outline-zinc-500' : '')
                    }
                  >
                    {hasStory && <span className={'h-1.5 w-1.5 rounded-full ' + (e!.done >= 3 ? 'bg-white/90' : 'bg-indigo-500')} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {/* legend */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-zinc-400">
          <span className="inline-flex items-center gap-1.5"><span className="inline-flex h-4 w-4 items-center justify-center rounded-md bg-emerald-500"><span className="h-1.5 w-1.5 rounded-full bg-white/90" /></span> work done + story</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-4 w-4 rounded-md bg-emerald-300/40 ring-2 ring-amber-400 ring-inset" /> activity, no story (tap to fill)</span>
          <span className="inline-flex items-center gap-1.5"><span className="grid h-4 w-4 place-items-center rounded-md bg-zinc-100 dark:bg-zinc-800/60"><span className="h-1.5 w-1.5 rounded-full bg-indigo-500" /></span> story only</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-4 w-4 rounded-md bg-indigo-400/60" /> suggested ahead</span>
        </div>
      </section>
      <p className="text-center text-xs text-zinc-400">Green = work done · a dot means the story is told · an amber ring is a day you skipped the story. Tap a ring to fill it.</p>

      {fillDay && <CloseDaySheet day={fillDay} onClose={() => setFillDay(null)} onClosed={() => { setFillDay(null); load(); }} />}
    </div>
  );
}

// ---------- Me (personality + Validate) ----------
type Insight = { id: string; dimension: string; claim: string; evidence?: string | null; status: 'pending' | 'confirmed' | 'rejected' };
type Persona = { daysCovered: number; minDays: number; unlocked: boolean; summary: string | null; generation: number; generatedAt: string | null; lastRun: string | null; insights: Insight[] };

function MeView() {
  const [p, setP] = useState<Persona | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    const r = await fetch('/api/daily/personality');
    if (r.ok) setP(await r.json());
  }
  useEffect(() => {
    load();
  }, []);

  async function regenerate() {
    setBusy(true);
    try {
      const r = await fetch('/api/daily/personality/regenerate', { method: 'POST' });
      if (r.ok) {
        setP(await r.json());
        toast('success', 'Profile refreshed');
      } else toast('error', 'Could not refresh');
    } finally {
      setBusy(false);
    }
  }

  async function validate(id: string, status: 'confirmed' | 'rejected') {
    const cur = p?.insights.find((i) => i.id === id);
    const next = cur?.status === status ? 'pending' : status;
    const r = await fetch(`/api/daily/personality/insight/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
    if (r.ok) setP((prev) => (prev ? { ...prev, insights: prev.insights.map((i) => (i.id === id ? { ...i, status: next as any } : i)) } : prev));
  }

  if (!p) return <p className="text-sm text-zinc-400">Loading…</p>;

  if (!p.unlocked) {
    const pct = Math.round((p.daysCovered / p.minDays) * 100);
    // People memory is independent of the personality unlock — it must show here too.
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-center">
          <Fingerprint className="mx-auto text-emerald-500 mb-2" size={28} />
          <h2 className="font-semibold">Getting to know you</h2>
          <p className="text-sm text-zinc-500 mt-1">Your honest personality read unlocks after <b>{p.minDays} days</b> of real use — so it's built on evidence, not guesswork.</p>
          <div className="mt-4 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden max-w-xs mx-auto">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-zinc-400 mt-2">{p.daysCovered} / {p.minDays} active days</p>
        </div>
        <PeopleCard />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-gradient-to-br from-emerald-500/5 to-transparent p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="flex items-center gap-2 font-semibold"><Fingerprint size={17} className="text-emerald-500" /> Your portrait</h2>
          <button onClick={regenerate} disabled={busy} className="text-xs text-zinc-400 hover:text-emerald-600 inline-flex items-center gap-1"><RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> refresh</button>
        </div>
        {p.summary ? (
          <Markdown className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">{p.summary}</Markdown>
        ) : (
          <div className="text-sm text-zinc-500">
            <p className="mb-3">Enough data to build your profile. Generate it now.</p>
            <button onClick={regenerate} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">{busy ? 'Thinking…' : 'Build my profile'}</button>
          </div>
        )}
        {p.generatedAt && <p className="text-[11px] text-zinc-400 mt-3">Updated {new Date(p.generatedAt).toLocaleDateString()} · refreshes every 3 days</p>}
      </section>

      {p.insights.length > 0 && (
        <section>
          <h2 className="font-semibold text-sm mb-1 text-zinc-500">Is this you?</h2>
          <p className="text-xs text-zinc-400 mb-3">Confirm or reject each read so it sharpens over time and never drifts.</p>
          <ul className="space-y-2.5">
            {p.insights.map((i) => (
              <li key={i.id} className={'rounded-xl border bg-white dark:bg-zinc-900 p-3.5 ' + (i.status === 'confirmed' ? 'border-emerald-500/50' : i.status === 'rejected' ? 'border-rose-500/40 opacity-70' : 'border-zinc-200 dark:border-zinc-800')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wide text-emerald-600 font-medium">{i.dimension}</div>
                    <div className={'text-sm font-medium mt-0.5 ' + (i.status === 'rejected' ? 'line-through text-zinc-400' : '')}>{i.claim}</div>
                    {i.evidence && <div className="text-xs text-zinc-400 mt-1">📊 {i.evidence}</div>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => validate(i.id, 'confirmed')} title="Correct" className={'p-1.5 rounded-md ' + (i.status === 'confirmed' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-emerald-600')}><Check size={15} /></button>
                    <button onClick={() => validate(i.id, 'rejected')} title="Not me" className={'p-1.5 rounded-md ' + (i.status === 'rejected' ? 'bg-rose-600 text-white' : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-rose-600')}><X size={15} /></button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PeopleCard />
    </div>
  );
}

// ---------- People in your stories ----------
type PersonT = { name: string; mentions: number; firstSeen: string; lastSeen: string; fading: boolean };

function PeopleCard() {
  const [data, setData] = useState<{ people: PersonT[]; count: number } | null>(null);
  const [overName, setOverName] = useState<string | null>(null); // chip currently hovered by a drag
  const [merge, setMerge] = useState<{ from: string; into: string } | null>(null);
  const [editFor, setEditFor] = useState<string | null>(null); // long-press → rename
  const [detailFor, setDetailFor] = useState<string | null>(null); // double-tap → full history
  const chipRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef<{ name: string; at: number }>({ name: '', at: 0 });
  const dragging = useRef(false);
  const toast = useToast();

  function tap(name: string) {
    const now = Date.now();
    if (lastTap.current.name === name && now - lastTap.current.at < 350) {
      endPress(); // a double-tap is not a long-press
      setDetailFor(name);
      lastTap.current = { name: '', at: 0 };
    } else lastTap.current = { name, at: now };
  }

  async function load() {
    const r = await fetch('/api/daily/people');
    if (r.ok) setData(await r.json());
  }
  useEffect(() => { load(); }, []);

  function chipUnder(x: number, y: number, except: string): string | null {
    for (const [name, el] of Object.entries(chipRefs.current)) {
      if (!el || name === except) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return name;
    }
    return null;
  }

  async function doMerge(from: string, into: string, rename = false) {
    setMerge(null);
    setEditFor(null);
    const r = await fetch('/api/daily/people/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, into }) });
    if (r.ok) {
      toast('success', rename ? `Renamed to ${into} — future stories will use it too` : `${from} merged into ${into} — and remembered for future stories`);
      load();
    } else toast('error', rename ? 'Could not rename' : 'Could not merge');
  }

  function startPress(name: string) {
    dragging.current = false;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      if (!dragging.current) setEditFor(name); // held still → rename
    }, 550);
  }
  function endPress() {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }

  if (!data || !data.count) return null; // appears once stories start mentioning people
  const fading = data.people.filter((p) => p.fading);
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">👥 People in your stories <span className="text-xs font-normal text-zinc-400">{data.count}</span></h2>
      <p className="text-xs text-zinc-500 mb-3">Who shows up when you tell your days — straight from your own words. Double-tap a name for your full history together · drag one onto another to merge · hold to rename.</p>
      <div className="flex flex-wrap gap-2">
        {data.people.slice(0, 30).map((p) => (
          <motion.span
            key={p.name}
            ref={(el: HTMLSpanElement | null) => { chipRefs.current[p.name] = el; }}
            drag
            dragSnapToOrigin
            dragMomentum={false}
            whileDrag={{ scale: 1.08, zIndex: 40 }}
            onPointerDown={() => startPress(p.name)}
            onPointerUp={endPress}
            onClick={() => tap(p.name)}
            onDragStart={() => { dragging.current = true; endPress(); }}
            onDrag={(_e, info) => setOverName(chipUnder(info.point.x - window.scrollX, info.point.y - window.scrollY, p.name))}
            onDragEnd={(_e, info) => {
              const target = chipUnder(info.point.x - window.scrollX, info.point.y - window.scrollY, p.name);
              setOverName(null);
              if (target) setMerge({ from: p.name, into: target });
            }}
            title={`${p.mentions} mention${p.mentions === 1 ? '' : 's'} · first ${p.firstSeen} · last ${p.lastSeen}`}
            className={
              'inline-block cursor-grab active:cursor-grabbing touch-none select-none rounded-full px-3 py-1 text-sm border ' +
              (overName === p.name
                ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-2 ring-emerald-500/40 '
                : p.fading
                  ? 'border-amber-300/60 dark:border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/5 '
                  : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 bg-white dark:bg-zinc-900 ')
            }
          >
            {p.name} <span className="text-[11px] text-zinc-400">×{p.mentions}</span>
          </motion.span>
        ))}
      </div>
      {fading.length > 0 && (
        <p className="mt-3 text-xs rounded-lg bg-amber-500/5 border border-amber-300/30 dark:border-amber-500/20 px-2.5 py-1.5">
          <span className="font-semibold text-amber-600">Fading:</span> {fading.map((p) => p.name).join(', ')} — not mentioned in over two weeks.
        </p>
      )}
      {merge && (
        <ConfirmDialog
          title={`Merge ${merge.from} into ${merge.into}?`}
          message={`All of ${merge.from}'s mentions move to ${merge.into}, and future stories saying "${merge.from}" will count as ${merge.into} automatically.`}
          confirmLabel="Merge"
          onConfirm={() => doMerge(merge.from, merge.into)}
          onCancel={() => setMerge(null)}
        />
      )}
      {editFor && <RenamePersonDialog name={editFor} onCancel={() => setEditFor(null)} onSave={(to) => doMerge(editFor, to, true)} />}
      {detailFor && <PersonDetailSheet name={detailFor} onClose={() => setDetailFor(null)} />}
    </section>
  );
}

/** Double-tap → the person's full history: every task, story sentence and note involving them. */
function PersonDetailSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const [d, setD] = useState<{ name: string; mentions: number; firstSeen: string; lastSeen: string; otherSpellings: string[]; contactId: string | null; days: { day: string; items: { type: string; text: string }[] }[] } | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => {
    fetch(`/api/daily/people/detail?name=${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => undefined);
  }, [name]);
  // Bridge story-people to Contacts: open the contact, or create one from this person. (BEA-762)
  async function addContact() {
    const r = await fetch('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (r.ok) { const c = await r.json(); toast('success', `${name} added to contacts`); navigate(`/contacts?contact=${c.id}`); }
    else toast('error', 'Could not add contact');
  }

  const ICONS: Record<string, { icon: any; cls: string; label: string }> = {
    task: { icon: CheckCircle2, cls: 'text-emerald-500 bg-emerald-500/10', label: 'Task' },
    story: { icon: Moon, cls: 'text-indigo-400 bg-indigo-500/10', label: 'Your story' },
    note: { icon: MessageSquare, cls: 'text-zinc-500 bg-zinc-500/10', label: 'Note' },
  };
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <>
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-bold flex items-center gap-2">👤 {name}</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          {!d ? (
            <p className="text-sm text-zinc-400 py-6 text-center">Loading…</p>
          ) : (
            <>
              <p className="text-xs text-zinc-500 mb-3">
                {d.mentions} day{d.mentions === 1 ? '' : 's'} · first {prettyDay(d.firstSeen).replace(/^[A-Za-z]+, /, '')} · last {prettyDay(d.lastSeen).replace(/^[A-Za-z]+, /, '')}
                {d.otherSpellings.length > 0 && <> · also written as {d.otherSpellings.join(', ')}</>}
              </p>
              {d.contactId ? (
                <button onClick={() => { navigate(`/contacts?contact=${d.contactId}`); onClose(); }} className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">Open contact page →</button>
              ) : (
                <button onClick={addContact} className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-300"><Plus size={14} /> Add as contact</button>
              )}
              <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
                {d.days.map((dayEntry) => (
                  <div key={dayEntry.day}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-semibold text-zinc-500">{prettyDay(dayEntry.day)}</span>
                      <span className="flex-1 h-px bg-zinc-100 dark:bg-zinc-800" />
                    </div>
                    {dayEntry.items.length ? (
                      <ul className="space-y-1.5">
                        {dayEntry.items.map((it, i) => {
                          const m = ICONS[it.type] || ICONS.note;
                          return (
                            <li key={i} className="flex items-start gap-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 p-2.5">
                              <span className={'shrink-0 rounded-lg p-1.5 ' + m.cls}><m.icon size={14} /></span>
                              <div className="min-w-0 flex-1">
                                <span className="block text-[10px] uppercase tracking-wide text-zinc-400">{m.label}</span>
                                <span className="text-sm text-zinc-700 dark:text-zinc-200 break-words">{it.text}</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-xs text-zinc-400">Mentioned this day — no exact lines matched.</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

/** Long-press rename: small dialog with the name prefilled. */
function RenamePersonDialog({ name, onCancel, onSave }: { name: string; onCancel: () => void; onSave: (to: string) => void }) {
  const [val, setVal] = useState(name);
  const ok = val.trim().length >= 2 && val.trim() !== name;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl">
        <h3 className="font-bold mb-1">Rename {name}</h3>
        <p className="text-sm text-zinc-500 mb-3">Future stories using the old spelling will be filed under the new name automatically.</p>
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) onSave(val.trim()); }}
          className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm">Cancel</button>
          <button onClick={() => onSave(val.trim())} disabled={!ok} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-50">Rename</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Suggested tasks view ----------
type Suggestion = { id: string; forDay: string; title: string; category?: string | null; reason?: string | null };
function SuggestedView() {
  const [forDay, setForDay] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [gen, setGen] = useState(false);
  const toast = useToast();

  async function load() {
    // NOTE: no setLoading(true) on refresh — keep current content on screen so scroll position survives
    try {
      const r = await fetch('/api/daily/suggestions');
      if (r.ok) {
        const j = await r.json();
        setForDay(j.forDay);
        setItems(j.suggestions || []);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function generate() {
    setGen(true);
    try {
      const r = await fetch('/api/daily/suggestions/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (r.ok) { toast('success', 'Suggested tomorrow’s tasks'); load(); }
      else toast('error', 'Could not generate');
    } finally { setGen(false); }
  }
  async function add(s: Suggestion) {
    const r = await fetch(`/api/daily/suggestions/${s.id}/add`, { method: 'POST' });
    if (r.ok) { toast('success', `Added “${s.title}” to ${prettyDay(s.forDay)}`); setItems((xs) => xs.filter((x) => x.id !== s.id)); }
    else toast('error', 'Could not add');
  }
  async function dismiss(s: Suggestion) {
    const r = await fetch(`/api/daily/suggestions/${s.id}/dismiss`, { method: 'POST' });
    if (r.ok) setItems((xs) => xs.filter((x) => x.id !== s.id));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-semibold"><ListChecks size={16} className="text-emerald-500" /> Suggested for {forDay ? prettyDay(forDay) : 'tomorrow'}</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Predicted from your Story of the Day. Tap + to add to your tasks.</p>
        </div>
        <button onClick={generate} disabled={gen} className="text-xs text-zinc-400 hover:text-emerald-600 inline-flex items-center gap-1 shrink-0"><RefreshCw size={12} /> {gen ? 'Thinking…' : 'Refresh'}</button>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : items.length ? (
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={s.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium leading-snug">{s.title}</span>
                  {s.category && <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-500">{s.category}</span>}
                </div>
                {s.reason && <p className="text-xs text-zinc-500 mt-1">{s.reason}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => add(s)} title="Add to tasks" className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"><Plus size={15} /></button>
                <button onClick={() => dismiss(s)} title="Dismiss" className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-rose-600"><X size={15} /></button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
          <ListChecks size={22} className="mx-auto mb-2 text-zinc-400" />
          <p className="mb-3">Each night your Story of the Day suggests fresh next-steps for the next day.<br />Want a set now (from your last story)?</p>
          <button onClick={generate} disabled={gen} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">{gen ? 'Thinking…' : 'Suggest tasks'}</button>
        </div>
      )}
    </div>
  );
}


/** Professional / Personal tabs on the Story of the Day (when both spheres were woven). */
function StoryTabs({ ds }: { ds: NonNullable<DayStoryT> }) {
  const [tab, setTab] = useState<'pro' | 'personal'>('pro');
  const score = tab === 'pro' ? ds.proMoodScore : ds.personalMoodScore;
  return (
    <div>
      <div className="flex gap-1.5 mb-2">
        <button onClick={() => setTab('pro')} className={'rounded-full px-3 py-1 text-xs border ' + (tab === 'pro' ? 'bg-emerald-600 text-white border-transparent' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500')}>💼 Professional{ds.proMoodScore != null ? ` · ${ds.proMoodScore}` : ''}</button>
        <button onClick={() => setTab('personal')} className={'rounded-full px-3 py-1 text-xs border ' + (tab === 'personal' ? 'bg-violet-600 text-white border-transparent' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500')}>🏠 Personal{ds.personalMoodScore != null ? ` · ${ds.personalMoodScore}` : ''}</button>
      </div>
      <Markdown className="text-sm text-zinc-700 dark:text-zinc-200 leading-relaxed">{tab === 'pro' ? ds.text : ds.personalText}</Markdown>
      {score != null && <p className="mt-1.5 text-[11px] text-zinc-400">{tab === 'pro' ? 'Work' : 'Personal'} mood: {score}/100</p>}
    </div>
  );
}

// ---------- Your book: a real illustrated life-book (BEA-1061) ----------
type BookChapter = { month: string; title?: string | null; text: string; excerpt: string | null; moodAvg: number | null };
type BookData = { year: string; yearStory: { year: string; title?: string | null; text: string; partial: boolean } | null; chapters: BookChapter[]; pending: string[]; moodArc: { month: string; mood: number | null }[] };

function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function monthShort(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}
const moodEmoji = (n: number | null) => (n == null ? '' : n >= 75 ? '😊' : n >= 55 ? '🙂' : n >= 40 ? '😐' : '😔');

/** Strip markdown to readable plain text for the print edition. */
function stripMd(t: string): string {
  return (t || '').replace(/^#+\s*/gm, '').replace(/[*_`>~]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
}

/** Build a clean printable HTML book and open the browser print dialog → Save as PDF. (BEA-1061) */
function printBook(data: BookData) {
  const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const para = (t: string) => stripMd(t).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`).join('');
  const chapters = data.chapters.map((c) => `
    <section class="chapter">
      <div class="ch-month">${esc(monthLabel(c.month))} ${c.moodAvg != null ? `· mood ${c.moodAvg}` : ''}</div>
      <h2>${esc(c.title || 'Chapter')}</h2>
      ${c.excerpt ? `<blockquote>${esc(c.excerpt)}</blockquote>` : ''}
      ${para(c.text)}
    </section>`).join('');
  const yearSec = data.yearStory ? `<section class="chapter year"><div class="ch-month">The year in full</div><h2>${esc(data.yearStory.title || `The Story of ${data.year}`)}</h2>${para(data.yearStory.text)}</section>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>The Story of ${esc(data.year)}</title>
    <style>
      @page { margin: 22mm 18mm; }
      body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; line-height: 1.7; }
      .cover { text-align:center; page-break-after: always; padding-top: 40mm; }
      .cover .big { font-size: 42px; font-weight: 700; letter-spacing: -0.5px; }
      .cover .sub { font-size: 15px; color:#666; margin-top: 8px; letter-spacing: 3px; text-transform: uppercase; }
      .cover .title { font-size: 24px; font-style: italic; color:#444; margin-top: 40px; }
      .chapter { page-break-before: always; }
      .ch-month { font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color:#999; }
      h2 { font-size: 26px; margin: 4px 0 14px; font-weight: 700; }
      blockquote { border-left: 3px solid #bbb; margin: 16px 0; padding: 4px 0 4px 16px; font-style: italic; font-size: 18px; color:#555; }
      p { margin: 0 0 12px; text-align: justify; }
      p:first-of-type::first-letter { font-size: 46px; font-weight:700; float:left; line-height:0.8; padding: 6px 8px 0 0; }
    </style></head><body>
    <div class="cover"><div class="sub">The Story of</div><div class="big">${esc(data.year)}</div>${data.yearStory?.title ? `<div class="title">"${esc(data.yearStory.title)}"</div>` : ''}</div>
    ${yearSec}${chapters}
    </body></html>`;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 400);
  return true;
}

/** A single chapter, read like a memoir page — drop-cap, pull-quote, prose. */
function ChapterReader({ c, onBack, onRewrite, rewriting }: { c: BookChapter; onBack: () => void; onRewrite: () => void; rewriting: boolean }) {
  return (
    <article className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 sm:p-8">
      <button onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-indigo-500"><ChevronLeft size={13} /> All chapters</button>
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">{monthLabel(c.month)} {c.moodAvg != null ? `· mood ${c.moodAvg} ${moodEmoji(c.moodAvg)}` : ''}</p>
      <h1 className="mt-1 font-serif text-3xl font-bold leading-tight">{c.title || 'Chapter'}</h1>
      {c.excerpt && <blockquote className="my-5 border-l-4 border-indigo-400/50 pl-4 font-serif text-xl italic leading-relaxed text-zinc-500 dark:text-zinc-400">“{c.excerpt}”</blockquote>}
      <div className="dropcap font-serif text-[15px] leading-[1.85] text-zinc-700 dark:text-zinc-200">
        <Markdown>{c.text}</Markdown>
      </div>
      <button onClick={onRewrite} disabled={rewriting} className="mt-6 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-indigo-500"><RefreshCw size={12} className={rewriting ? 'animate-spin' : ''} /> {rewriting ? 'Rewriting…' : 'rewrite this chapter'}</button>
    </article>
  );
}

function BookView() {
  const [data, setData] = useState<BookData | null>(null);
  const [reading, setReading] = useState<string | null>(null); // month key being read, or 'year'
  const [writing, setWriting] = useState<string | null>(null);
  const toast = useToast();

  async function load() {
    const r = await fetch('/api/daily/book');
    if (r.ok) setData(await r.json());
  }
  useEffect(() => { load(); }, []);

  async function write(month: string, force = false) {
    setWriting(month);
    try {
      const r = await fetch('/api/daily/month-story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, force }) });
      const j = await r.json();
      if (r.ok && j.text) { toast('success', `Chapter written — ${monthLabel(month)}`); await load(); }
      else toast('error', j.message || 'Could not write the chapter');
    } finally { setWriting(null); }
  }
  async function writeYear() {
    setWriting('year');
    try {
      const r = await fetch('/api/daily/year-story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year: data?.year, force: true }) });
      const j = await r.json();
      if (r.ok && j.text) { toast('success', 'Your year, written ✨'); await load(); setReading('year'); }
      else toast('error', j.message || 'Write a monthly chapter first');
    } finally { setWriting(null); }
  }

  if (!data) return <p className="text-sm text-zinc-400">Loading…</p>;

  const arc = data.moodArc.filter((m) => m.mood != null);
  const readingChapter = reading && reading !== 'year' ? data.chapters.find((c) => c.month === reading) : null;

  // Reading a single chapter — full page.
  if (readingChapter) return <ChapterReader c={readingChapter} onBack={() => setReading(null)} onRewrite={() => write(readingChapter.month, true)} rewriting={writing === readingChapter.month} />;
  if (reading === 'year' && data.yearStory) {
    return (
      <ChapterReader
        c={{ month: `${data.year}-13`, title: data.yearStory.title || `The Story of ${data.year}`, text: data.yearStory.text, excerpt: null, moodAvg: arc.length ? Math.round(arc.reduce((a, b) => a + (b.mood || 0), 0) / arc.length) : null }}
        onBack={() => setReading(null)} onRewrite={writeYear} rewriting={writing === 'year'}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* The cover */}
      <section className="relative overflow-hidden rounded-2xl border border-indigo-400/25 bg-gradient-to-br from-indigo-600/25 via-violet-600/15 to-amber-500/10 p-8 text-center">
        <div aria-hidden className="pointer-events-none absolute -top-20 -right-16 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-16 h-56 w-56 rounded-full bg-amber-500/15 blur-3xl" />
        <p className="relative text-[11px] uppercase tracking-[0.35em] text-indigo-500 dark:text-indigo-300">The Story of</p>
        <h1 className="relative font-serif text-6xl font-extrabold tracking-tight">{data.year}</h1>
        {data.yearStory?.title && <p className="relative mt-3 font-serif text-xl italic text-zinc-600 dark:text-zinc-300">“{data.yearStory.title}”</p>}
        <p className="relative mt-2 text-xs text-zinc-500">{data.chapters.length} chapter{data.chapters.length === 1 ? '' : 's'}{data.yearStory?.partial ? ' · year so far' : ''}</p>
        <div className="relative mt-5 flex flex-wrap items-center justify-center gap-2">
          {data.yearStory ? (
            <button onClick={() => setReading('year')} className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"><BookOpen size={15} /> Read the year</button>
          ) : (
            <button onClick={writeYear} disabled={writing === 'year'} className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{writing === 'year' ? 'Writing…' : 'Write my year so far'}</button>
          )}
          <button onClick={() => printBook(data)} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium hover:border-indigo-400 hover:text-indigo-500"><FileText size={15} /> Export PDF</button>
        </div>
      </section>

      {/* The mood arc across the year */}
      {arc.length >= 2 && (
        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><HeartPulse size={15} className="text-pink-500" /> Your mood, across the year</h2>
          <TrendLine points={data.moodArc.map((m) => m.mood)} color="#6366f1" h={56} />
          <div className="mt-1 flex justify-between text-[10px] text-zinc-400">
            {data.moodArc.map((m) => <span key={m.month}>{monthShort(m.month)[0]}</span>)}
          </div>
        </section>
      )}

      {/* Pending months */}
      {data.pending.length > 0 && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h3 className="mb-2 text-sm font-semibold">Months ready to become a chapter</h3>
          <div className="flex flex-wrap gap-2">
            {data.pending.map((m) => (
              <button key={m} onClick={() => write(m)} disabled={writing === m} className="rounded-full border border-indigo-300/50 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-500/10 disabled:opacity-50 dark:border-indigo-500/30 dark:text-indigo-300">
                {writing === m ? 'Writing…' : `✍️ ${monthLabel(m)}`}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Contents */}
      {data.chapters.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-10 text-center text-sm text-zinc-400">No chapters yet — a month becomes a chapter once it has at least 3 recorded days.</p>
      ) : (
        <section>
          <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Chapters</h3>
          <div className="space-y-2.5">
            {data.chapters.slice().reverse().map((c) => (
              <button key={c.month} onClick={() => setReading(c.month)} className="group flex w-full items-start gap-4 rounded-xl border border-zinc-200 bg-white p-4 text-left transition-all hover:border-indigo-400/50 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <div className="shrink-0 text-center">
                  <div className="font-serif text-2xl font-bold leading-none">{monthShort(c.month)}</div>
                  {c.moodAvg != null && <div className="mt-1 text-lg">{moodEmoji(c.moodAvg)}</div>}
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="font-serif text-lg font-semibold leading-snug group-hover:text-indigo-500">{c.title || monthLabel(c.month)}</h4>
                  {c.excerpt && <p className="mt-1 line-clamp-2 text-sm italic text-zinc-500 dark:text-zinc-400">“{c.excerpt}”</p>}
                </div>
                <ChevronRight size={18} className="mt-1 shrink-0 text-zinc-300 group-hover:text-indigo-400 dark:text-zinc-600" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- Shell with tabs ----------
type TabId = 'day' | 'suggested' | 'insights' | 'calendar' | 'book' | 'me';

export function Activity() {
  const [params] = useSearchParams();
  const dayParam = params.get('day');
  // Deep-link from an Explore story source: ?day=YYYY-MM-DD opens that day on the Day tab. (BEA-340)
  const [tab, setTab] = useState<TabId>('day');
  const [day, setDay] = useState<string | null>(dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : null);

  const tabs: { id: TabId; label: string; icon: any }[] = [
    { id: 'day', label: 'Day', icon: ListTree },
    { id: 'suggested', label: 'Suggested tasks', icon: ListChecks },
    { id: 'insights', label: 'Insights', icon: BarChart3 },
    { id: 'calendar', label: 'Calendar', icon: CalendarDays },
    { id: 'book', label: 'Your book', icon: BookOpen },
    { id: 'me', label: 'Me', icon: Fingerprint },
  ];

  function openDay(d: string) {
    setDay(d);
    setTab('day');
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2"><ActivityIcon className="text-emerald-500" /> Activity</h1>
        <p className="text-zinc-500 text-sm">Your day, captured — what you did, finished, and felt.</p>
      </div>

      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={'shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ' + (tab === t.id ? 'border-emerald-500 text-emerald-600 font-medium' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'day' && <DayView day={day} onDay={setDay} />}
      {tab === 'suggested' && <SuggestedView />}
      {tab === 'insights' && <InsightsView />}
      {tab === 'calendar' && <CalendarView onPick={openDay} />}
      {tab === 'book' && <BookView />}
      {tab === 'me' && <MeView />}
    </div>
  );
}
