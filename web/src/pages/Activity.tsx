import { useEffect, useState } from 'react';
import { Activity as ActivityIcon, ChevronLeft, ChevronRight, FileText, Bookmark, Lightbulb, Wand2, CheckCircle2, Brain, Moon, MessageSquare, Sparkles, RefreshCw, Flame, BarChart3, CalendarDays, ListTree, Fingerprint, Check, X, Plus, ListChecks } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Ev = { type: string; title: string; detail?: string; at: string };
type Stats = { tasksTotal: number; tasksDone: number; tasksOpen: number; minutesSpent: number; minutesEstimated: number };
type Summary = { day: string; text: string; stats: Stats | null } | null;
type Story = { text: string; mood?: string | null } | null;
type DayStoryT = { text: string; mood?: string | null; moodScore?: number | null } | null;
type DayData = { day: string; isToday: boolean; stats: Stats; story: Story; summary: Summary; dayStory: DayStoryT; timeline: Ev[] };

type Dash = {
  days: number;
  totals: { tasksTotal: number; tasksDone: number; followThrough: number };
  minutesSpent: number;
  categoryTime: { category: string; minutes: number }[];
  estimateVsActual: { estimated: number; actual: number; count: number };
  streak: number;
  perDay: { day: string; done: number; total: number }[];
};
type Cal = { start: string; end: string; days: { day: string; done: number; total: number; dumped: boolean; story: boolean; suggested?: number }[] };

const ICON: Record<string, any> = { capture: FileText, bookmark: Bookmark, idea: Lightbulb, skill: Wand2, task: CheckCircle2, dump: Brain, story: Moon, note: MessageSquare };
const TINT: Record<string, string> = {
  capture: 'text-sky-500 bg-sky-500/10', bookmark: 'text-emerald-500 bg-emerald-500/10', idea: 'text-amber-500 bg-amber-500/10',
  skill: 'text-violet-500 bg-violet-500/10', task: 'text-emerald-600 bg-emerald-600/10', dump: 'text-emerald-500 bg-emerald-500/10',
  story: 'text-indigo-400 bg-indigo-500/10', note: 'text-zinc-500 bg-zinc-500/10',
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
  const toast = useToast();

  async function load(d?: string) {
    // NOTE: no setLoading(true) on refresh — keep current content on screen so scroll position survives
    try {
      const r = await fetch('/api/daily/activity' + (d ? `?day=${d}` : ''));
      if (r.ok) {
        const j = await r.json();
        setData(j);
        if (j.day !== day) onDay(j.day);
      }
    } finally {
      setLoading(false);
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

      {st && (
        <div className="grid grid-cols-3 gap-3">
          <Stat big={`${st.tasksDone}/${st.tasksTotal}`} label="tasks done" />
          <Stat big={mins(st.minutesSpent)} label="time spent" />
          <Stat big={`${pct}%`} label="follow-through" />
        </div>
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
        {data?.dayStory ? (
          <p className="text-sm text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap leading-relaxed">{data.dayStory.text}</p>
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
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">{data.summary.text}</p>
        ) : (
          <div className="text-sm text-zinc-500">
            <p className="mb-3">{data?.isToday ? 'Auto-generates at 9:30 PM — or build it now.' : 'No summary was generated for this day.'}</p>
            <button onClick={() => generate(false)} disabled={gen} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">{gen ? 'Generating…' : 'Generate summary'}</button>
          </div>
        )}
      </section>

      {data?.story && (
        <section className="rounded-xl border border-indigo-300/40 dark:border-indigo-500/30 bg-indigo-500/5 p-4">
          <h2 className="flex items-center gap-2 font-semibold text-sm mb-1.5"><Moon size={15} className="text-indigo-400" /> Your story {data.story.mood && <span className="text-xs font-normal">· {data.story.mood}</span>}</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{data.story.text}</p>
        </section>
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
function InsightsView() {
  const [d, setD] = useState<Dash | null>(null);
  const [range, setRange] = useState(30);
  useEffect(() => {
    fetch(`/api/daily/dashboard?days=${range}`).then((r) => r.json()).then(setD).catch(() => undefined);
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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-amber-300/40 bg-amber-500/5 p-3 text-center">
          <div className="text-xl font-extrabold tabular-nums flex items-center justify-center gap-1"><Flame size={16} className="text-amber-500" />{d.streak}</div>
          <div className="text-[11px] text-zinc-400">dump streak</div>
        </div>
        <Stat big={`${d.totals.tasksDone}/${d.totals.tasksTotal}`} label="tasks done" />
        <Stat big={`${d.totals.followThrough}%`} label="follow-through" />
        <Stat big={mins(d.minutesSpent)} label="time spent" />
      </div>

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
  useEffect(() => {
    fetch(`/api/daily/calendar?months=${months}`).then((r) => r.json()).then(setCal).catch(() => undefined);
  }, [months]);
  if (!cal) return <p className="text-sm text-zinc-400">Loading…</p>;

  const map = new Map(cal.days.map((d) => [d.day, d]));
  // build weeks from the Sunday on/before start, to today
  const startD = new Date(cal.start + 'T12:00:00Z');
  startD.setUTCDate(startD.getUTCDate() - startD.getUTCDay()); // back to Sunday
  const cells: { day: string }[] = [];
  let cursor = startD.toISOString().slice(0, 10);
  while (cursor <= cal.end) {
    cells.push({ day: cursor });
    cursor = addDays(cursor, 1);
  }
  const weeks: { day: string }[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  function tint(day: string): string {
    const e = map.get(day);
    if (!e) return 'bg-zinc-100 dark:bg-zinc-800/50';
    if (e.done >= 5) return 'bg-emerald-600';
    if (e.done >= 3) return 'bg-emerald-500';
    if (e.done >= 1) return 'bg-emerald-400/70';
    if (e.total > 0 || e.dumped || e.story) return 'bg-emerald-300/40';
    if (e.suggested) return 'bg-indigo-400/70'; // upcoming day with suggested tasks waiting
    return 'bg-zinc-100 dark:bg-zinc-800/50';
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs">
          <option value={3}>3 months</option>
          <option value={6}>6 months</option>
          <option value={12}>12 months</option>
        </select>
      </div>
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 overflow-x-auto">
        <div className="flex gap-1">
          {weeks.map((w, wi) => (
            <div key={wi} className="flex flex-col gap-1">
              {w.map((c) => {
                const e = map.get(c.day);
                const future = c.day > cal.end;
                return (
                  <button
                    key={c.day}
                    disabled={future}
                    onClick={() => onPick(c.day)}
                    title={future ? '' : `${c.day} — ${e ? `${e.done}/${e.total} done` : 'nothing'}${e?.dumped ? ' · dumped' : ''}${e?.story ? ' · story' : ''}${e?.suggested ? ` · ✨${e.suggested} suggested` : ''}`}
                    className={'h-3.5 w-3.5 rounded-sm transition-transform hover:scale-125 ' + (future ? 'opacity-0' : tint(c.day))}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-1.5 mt-3 text-[11px] text-zinc-400">
          <span>less</span>
          <span className="h-3 w-3 rounded-sm bg-zinc-100 dark:bg-zinc-800/50" />
          <span className="h-3 w-3 rounded-sm bg-emerald-300/40" />
          <span className="h-3 w-3 rounded-sm bg-emerald-400/70" />
          <span className="h-3 w-3 rounded-sm bg-emerald-500" />
          <span className="h-3 w-3 rounded-sm bg-emerald-600" />
          <span>more</span>
          <span className="ml-2 h-3 w-3 rounded-sm bg-indigo-400/70" />
          <span>suggested</span>
        </div>
      </section>
      <p className="text-xs text-zinc-400 text-center">Tap any day to open it. Indigo = upcoming day with suggested tasks.</p>
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
    return (
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-center">
        <Fingerprint className="mx-auto text-emerald-500 mb-2" size={28} />
        <h2 className="font-semibold">Getting to know you</h2>
        <p className="text-sm text-zinc-500 mt-1">Your honest personality read unlocks after <b>{p.minDays} days</b> of real use — so it's built on evidence, not guesswork.</p>
        <div className="mt-4 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden max-w-xs mx-auto">
          <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-zinc-400 mt-2">{p.daysCovered} / {p.minDays} active days</p>
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
          <p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">{p.summary}</p>
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

// ---------- Shell with tabs ----------
type TabId = 'day' | 'suggested' | 'insights' | 'calendar' | 'me';

export function Activity() {
  const [tab, setTab] = useState<TabId>('day');
  const [day, setDay] = useState<string | null>(null);

  const tabs: { id: TabId; label: string; icon: any }[] = [
    { id: 'day', label: 'Day', icon: ListTree },
    { id: 'suggested', label: 'Suggested tasks', icon: ListChecks },
    { id: 'insights', label: 'Insights', icon: BarChart3 },
    { id: 'calendar', label: 'Calendar', icon: CalendarDays },
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
      {tab === 'me' && <MeView />}
    </div>
  );
}
