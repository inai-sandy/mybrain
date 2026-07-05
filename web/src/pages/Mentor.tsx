import { useEffect, useState } from 'react';
import { Compass, Sparkles, Plus, Check, X, Trash2, RefreshCw, TrendingUp, Target, ChevronLeft, ChevronRight, CalendarRange } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { Markdown } from '../ui/markdown';

type Focus = { id: string; title: string; description?: string | null; source: string; status: string };
type MentorDay = { day: string; adherenceScore: number; moodScore?: number | null; guidance: string; prev?: { day: string; adherenceScore: number } | null; missing?: boolean };
type Trend = { day: string; adherence: number; mood?: number | null };
type Overview = {
  focusAreas: { active: Focus[]; proposed: Focus[] };
  latest: MentorDay | null;
  trend: Trend[];
  avgAdherence: number | null;
  days: number;
};

function prettyDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function Mentor() {
  const [o, setO] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [selDay, setSelDay] = useState<string | null>(null); // null = latest
  const [dayData, setDayData] = useState<MentorDay | null>(null);
  const toast = useToast();

  async function load(target?: string | null) {
    const r = await fetch('/api/mentor/overview');
    if (r.ok) {
      const j = await r.json();
      setO(j);
      // (re)load the shown day — explicit target, else the user's selection, else the latest read
      const want = target !== undefined ? target : selDay;
      const d = want || j.latest?.day;
      if (d) loadDay(d);
    }
  }
  async function loadDay(d: string) {
    const r = await fetch(`/api/mentor/day?day=${d}`);
    if (r.ok) setDayData(await r.json());
  }
  function pickDay(d: string) {
    setSelDay(d);
    loadDay(d);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function derive() {
    setBusy(true);
    try {
      const r = await fetch('/api/mentor/focus/derive', { method: 'POST' });
      if (r.ok) { const j = await r.json(); toast('success', j.proposed?.length ? `${j.proposed.length} focus area(s) suggested — keep the ones that fit` : 'Not enough clear patterns yet to suggest confidently — add your own, or try again after a few more days of stories'); load(); }
      else toast('error', 'Could not analyze');
    } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true);
    try {
      const r = await fetch('/api/mentor/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
      const j = await r.json();
      if (r.ok && j.guidance) { toast('success', 'Guidance refreshed'); setSelDay(null); load(null); }
      else toast('error', j.message || 'Tell your story or finish a task first');
    } finally { setBusy(false); }
  }
  async function setStatus(f: Focus, status: string) {
    const r = await fetch(`/api/mentor/focus/${f.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    if (r.ok) load();
  }
  async function addFocus() {
    if (!newTitle.trim()) return;
    const r = await fetch('/api/mentor/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle.trim() }) });
    if (r.ok) { setNewTitle(''); setAdding(false); load(); }
  }

  if (!o) return <p className="text-sm text-zinc-400">Loading…</p>;
  const active = o.focusAreas.active;
  const proposed = o.focusAreas.proposed;

  // Day navigation across the days that actually have a read (from the trend series).
  const days = o.trend.map((t) => t.day);
  const shown: MentorDay | null = dayData || o.latest;
  const curDay = shown?.day || null;
  const idx = curDay ? days.indexOf(curDay) : -1;
  const prevDay = idx > 0 ? days[idx - 1] : null;
  const nextDay = idx >= 0 && idx < days.length - 1 ? days[idx + 1] : null;
  const delta = shown && !shown.missing && shown.prev ? shown.adherenceScore - shown.prev.adherenceScore : null;
  const isLatest = !!curDay && curDay === o.latest?.day;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><Compass className="text-indigo-500" /> Mentor</h1>
          <p className="text-zinc-500 text-sm">Reads your stories, sets your focus, and keeps you honest about following it.</p>
        </div>
        <button onClick={run} disabled={busy} className="shrink-0 text-xs text-zinc-400 hover:text-indigo-500 inline-flex items-center gap-1"><RefreshCw size={12} /> {busy ? '…' : 'Refresh'}</button>
      </div>

      {/* Guidance — browse any past day with ◀ ▶, the date picker, or by tapping a bar in the graph */}
      <section className="rounded-xl border border-indigo-300/50 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 to-transparent p-5">
        {shown && (
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-1.5 min-w-0">
              <button onClick={() => prevDay && pickDay(prevDay)} disabled={!prevDay} aria-label="Previous day" className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-indigo-400 disabled:opacity-30"><ChevronLeft size={15} /></button>
              <div className="text-center min-w-0">
                <div className="font-semibold text-sm truncate">{curDay ? prettyDay(curDay) : '—'}{isLatest && <span className="ml-1.5 text-[11px] font-normal text-indigo-500">latest</span>}</div>
              </div>
              <button onClick={() => nextDay && pickDay(nextDay)} disabled={!nextDay} aria-label="Next day" className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-indigo-400 disabled:opacity-30"><ChevronRight size={15} /></button>
            </div>
            <input type="date" value={curDay || ''} max={o.latest?.day} onChange={(e) => e.target.value && pickDay(e.target.value)} className="shrink-0 rounded-lg bg-white/60 dark:bg-zinc-950/60 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs" />
          </div>
        )}
        <div className="flex items-center justify-between mb-2">
          <h2 className="flex items-center gap-2 font-semibold"><Sparkles size={16} className="text-indigo-400" /> Your guidance</h2>
          {shown && !shown.missing && (
            <span className="flex items-center gap-1.5">
              <span className="text-xs rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 px-2 py-0.5">on-track {shown.adherenceScore}/100</span>
              {delta !== null && delta !== 0 && (
                <span className={'text-xs rounded-full px-2 py-0.5 font-medium ' + (delta > 0 ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-600')}>
                  {delta > 0 ? '▲' : '▼'} {delta > 0 ? '+' : ''}{delta} vs prev
                </span>
              )}
            </span>
          )}
        </div>
        {shown && shown.missing ? (
          <p className="text-sm text-zinc-500">No mentor read for this day. Pick another day, or tap a bar in the graph below.</p>
        ) : shown ? (
          <Markdown className="text-sm text-zinc-700 dark:text-zinc-200 leading-relaxed">{shown.guidance}</Markdown>
        ) : (
          <div className="text-sm text-zinc-500">
            <p className="mb-3">Your Mentor writes guidance each night after your Story of the Day. Want a read now?</p>
            <button onClick={run} disabled={busy} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">{busy ? 'Thinking…' : 'Get guidance now'}</button>
          </div>
        )}
      </section>

      {/* Focus areas */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2 font-semibold"><Target size={16} className="text-emerald-500" /> Your focus areas</h2>
          <div className="flex items-center gap-2">
            <button onClick={derive} disabled={busy} className="text-xs text-zinc-400 hover:text-indigo-500 inline-flex items-center gap-1"><Sparkles size={12} /> Suggest</button>
            <button onClick={() => setAdding((a) => !a)} className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-1"><Plus size={13} /> Add</button>
          </div>
        </div>

        {adding && (
          <div className="flex items-center gap-2 mb-3">
            <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addFocus()} placeholder="e.g. Protect deep-work mornings" className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
            <button onClick={addFocus} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">Add</button>
          </div>
        )}

        {active.length ? (
          <ul className="space-y-2">
            {active.map((f) => (
              <li key={f.id} className="group flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                <span className="mt-0.5 h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{f.title}</div>
                  {f.description && <p className="text-xs text-zinc-500 mt-0.5">{f.description}</p>}
                </div>
                <button onClick={() => setStatus(f, 'archived')} title="Remove" className="shrink-0 p-1 rounded text-zinc-400 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 hover:text-rose-600"><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">No focus areas yet. Tap <b>Suggest</b> to let the Mentor read your stories and propose a few, or <b>Add</b> your own.</p>
        )}

        {/* Proposed (confirm) */}
        {proposed.length > 0 && (
          <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
            <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-300 mb-2 flex items-center gap-1"><Sparkles size={12} /> Mentor suggests — keep these?</div>
            <ul className="space-y-2">
              {proposed.map((f) => (
                <li key={f.id} className="flex items-start gap-3 rounded-lg border border-indigo-300/40 dark:border-indigo-500/30 bg-indigo-500/5 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{f.title}</div>
                    {f.description && <p className="text-xs text-zinc-500 mt-0.5">{f.description}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setStatus(f, 'active')} title="Keep" className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"><Check size={14} /></button>
                    <button onClick={() => setStatus(f, 'archived')} title="Dismiss" className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-rose-600"><X size={14} /></button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Trend graph */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2 font-semibold"><TrendingUp size={16} className="text-indigo-500" /> Are you following it?</h2>
          {o.avgAdherence !== null && <span className="text-xs text-zinc-500">avg on-track {o.avgAdherence}/100 · {o.days}d</span>}
        </div>
        <TrendChart trend={o.trend} selected={curDay} onPick={pickDay} />
        <div className="flex items-center justify-center gap-4 mt-2 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-indigo-500/80" /> On-track (bars)</span>
          <span className="inline-flex items-center gap-1"><span className="h-1 w-4 rounded bg-amber-400" /> Mood / wellbeing (line)</span>
          <span className="text-zinc-400">· tap a bar to open that day</span>
        </div>
      </section>

      <WeeklyReviews />
    </div>
  );
}

type Weekly = { weekStart: string; weekEnd: string; text: string; pattern?: string | null; experiment?: string | null; stats?: any; createdAt: string };

/** The Sunday weekly reviews — latest open, history collapsible. */
function WeeklyReviews() {
  const [data, setData] = useState<{ reviews: Weekly[]; count: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    const r = await fetch('/api/mentor/weekly');
    if (r.ok) {
      const j = await r.json();
      setData(j);
      setOpen((cur) => cur ?? j.reviews?.[0]?.weekStart ?? null);
    }
  }
  useEffect(() => { load(); }, []);

  async function generate() {
    setBusy(true);
    try {
      const r = await fetch('/api/mentor/weekly/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
      const j = await r.json();
      if (r.ok && j.text) { toast('success', 'Weekly review written'); load(); }
      else toast('error', j.message || 'Not enough recorded days this week yet');
    } finally { setBusy(false); }
  }

  const reviews = data?.reviews || [];
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="flex items-center gap-2 font-semibold"><CalendarRange size={16} className="text-indigo-500" /> Weekly reviews {data ? <span className="text-xs font-normal text-zinc-400">{data.count}</span> : null}</h2>
        <button onClick={generate} disabled={busy} className="text-xs text-zinc-400 hover:text-indigo-500 inline-flex items-center gap-1"><RefreshCw size={12} /> {busy ? 'Writing…' : 'Review this week now'}</button>
      </div>
      <p className="text-xs text-zinc-500 mb-3">Every Sunday night: the week's wins, the drift, one pattern, one experiment — pushed to Telegram too.</p>
      {reviews.length === 0 ? (
        <p className="text-sm text-zinc-400">Your first review arrives Sunday night — or write one now with the button above.</p>
      ) : (
        <ul className="space-y-2">
          {reviews.map((w) => {
            const isOpen = open === w.weekStart;
            return (
              <li key={w.weekStart} className="rounded-lg border border-zinc-100 dark:border-zinc-800">
                <button onClick={() => setOpen(isOpen ? null : w.weekStart)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left">
                  <span className="text-sm font-medium">Week of {prettyDay(w.weekStart).replace(/^[A-Za-z]+, /, '')}</span>
                  <span className="flex items-center gap-2 text-[11px] text-zinc-400">
                    {w.stats?.followThrough != null && <span>{w.stats.followThrough}% follow-through</span>}
                    <ChevronRight size={14} className={'transition-transform ' + (isOpen ? 'rotate-90' : '')} />
                  </span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3">
                    <Markdown className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{w.text}</Markdown>
                    {w.pattern && <p className="mt-2 text-xs rounded-lg bg-indigo-500/5 border border-indigo-300/30 dark:border-indigo-500/20 px-2.5 py-1.5"><span className="font-semibold text-indigo-500">🔍 The pattern:</span> {w.pattern}</p>}
                    {w.experiment && <p className="mt-1.5 text-xs rounded-lg bg-amber-500/5 border border-amber-300/30 dark:border-amber-500/20 px-2.5 py-1.5"><span className="font-semibold text-amber-600">🧪 The experiment:</span> {w.experiment}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function shortDate(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${d}/${m}`;
}

/** Daily on-track bars (indigo) with the mood/wellbeing line drawn over the top (amber). Bars are tappable. */
function TrendChart({ trend, selected, onPick }: { trend: Trend[]; selected: string | null; onPick: (day: string) => void }) {
  if (!trend.length) return <p className="text-sm text-zinc-400 text-center py-8">Your trend appears once you have a few nightly reads.</p>;
  const W = 640, H = 180, padL = 26, padR = 8, padT = 10, padB = 22;
  const n = trend.length;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / n;
  const barW = Math.max(3, Math.min(26, slot * 0.6));
  const cx = (i: number) => padL + slot * i + slot / 2;
  const y = (v: number) => padT + plotH - (v / 100) * plotH;

  const moodPts = trend.map((t, i) => ({ i, v: t.mood })).filter((p) => typeof p.v === 'number') as { i: number; v: number }[];
  const moodPath = moodPts.map((p, k) => `${k === 0 ? 'M' : 'L'}${cx(p.i).toFixed(1)},${y(p.v as number).toFixed(1)}`).join(' ');
  // show ~6 date ticks max, evenly spaced
  const tickEvery = Math.max(1, Math.ceil(n / 6));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 200 }}>
      {/* gridlines + y labels */}
      {[0, 50, 100].map((g) => (
        <g key={g}>
          <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={1} />
          <text x={padL - 6} y={y(g) + 3} textAnchor="end" className="fill-zinc-400 text-[9px]">{g}</text>
        </g>
      ))}
      {/* on-track bars — tap to open that day's guidance (full-height hit area so thin bars are easy to tap) */}
      {trend.map((t, i) => {
        const h = (t.adherence / 100) * plotH;
        const sel = t.day === selected;
        return (
          <g key={i} onClick={() => onPick(t.day)} className="cursor-pointer">
            <rect x={cx(i) - slot / 2} y={padT} width={slot} height={plotH} fill="transparent" />
            <rect x={cx(i) - barW / 2} y={padT + plotH - h} width={barW} height={h} rx={2} className={sel ? 'fill-indigo-600' : 'fill-indigo-500/60 hover:fill-indigo-500'}>
              <title>{`${t.day} — on-track ${t.adherence}/100${typeof t.mood === 'number' ? ` · mood ${t.mood}/100` : ''} · tap to open`}</title>
            </rect>
            {sel && <rect x={cx(i) - barW / 2 - 2} y={padT + plotH - h - 2} width={barW + 4} height={h + 4} rx={3} fill="none" className="stroke-indigo-400" strokeWidth={1.5} />}
          </g>
        );
      })}
      {/* mood line over the bars */}
      {moodPath && <path d={moodPath} fill="none" className="stroke-amber-400" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
      {moodPts.map((p) => <circle key={p.i} cx={cx(p.i)} cy={y(p.v as number)} r={2.5} className="fill-amber-400" />)}
      {/* x date labels */}
      {trend.map((t, i) => (i % tickEvery === 0 || i === n - 1) ? (
        <text key={t.day} x={cx(i)} y={H - 6} textAnchor="middle" className="fill-zinc-400 text-[9px]">{shortDate(t.day)}</text>
      ) : null)}
    </svg>
  );
}
