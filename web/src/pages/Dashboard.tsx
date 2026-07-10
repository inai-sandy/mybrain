import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Mic, Brain, MessageCircle, Upload, Flame, Target, Timer, Coins, Star, ArrowRight, Sparkles, Loader2, ChevronRight } from 'lucide-react';
import { openSearch } from '../ui/SearchOverlay';
import { Skeleton } from '../ui/Skeleton';
import { TodayCard } from '../ui/TodayCard';
import { Markdown } from '../ui/markdown';

type Need = { kind: string; icon: string; title: string; sub: string; href: string; action: string };
type Cook = { icon: string; label: string; href: string };
type Home = {
  today: { dumped: boolean; storyDone: boolean; counts: { total: number; done: number; open: number }; mustDos: { id: string; title: string; pinned: boolean; priority: string }[] };
  insights: {
    streak: number; followThrough: number; followTrend?: { week: number | null; prevWeek: number | null };
    minutesSpent: number; minutesToday?: number;
    daySummary: string | null; daySummaryFor?: 'today' | 'yesterday' | null;
    guidance?: string | null; guidanceDay?: string | null;
  };
  personality: { unlocked: boolean; summary: string | null; daysCovered: number; minDays: number };
  counts: { documents: number; bookmarks: number; ideas: number; skills: number; notes: number; contacts: number; meetings: number; emoCards: number };
  countsNew?: Partial<Home['counts']>;
  needsYou?: Need[];
  cooking?: Cook[];
  recent: { id: string; title: string; source: string; createdAt: string }[];
};

function greeting(h: number): string {
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}
function mins(n: number): string {
  if (!n) return '0m';
  const h = Math.floor(n / 60); const m = n % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
function fmtUsd(n: number): string { return '$' + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)); }
/** This week's Monday (YYYY-MM-DD) in IST — the reminder/day engine's timezone. AI cost = Mon–Sun. (BEA-932) */
function mondayIstKey(): string {
  const ist = new Date(Date.now() + 330 * 60000);
  const daysSinceMon = (ist.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(ist.getTime() - daysSinceMon * 86400000).toISOString().slice(0, 10);
}
type Phase = 'morning' | 'midday' | 'evening';
function phaseOf(h: number): Phase { return h < 12 ? 'morning' : h >= 18 ? 'evening' : 'midday'; }

export function Dashboard() {
  const navigate = useNavigate();
  const [d, setD] = useState<Home | null>(null);
  const [aiWeek, setAiWeek] = useState<number | null>(null);
  const [read, setRead] = useState<'guidance' | 'summary' | 'portrait'>('guidance');

  async function load() {
    const h = await fetch('/api/home').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (h) setD(h);
  }
  useEffect(() => {
    load();
    fetch('/api/usage/features?from=' + mondayIstKey()).then((r) => (r.ok ? r.json() : null)).then((u) => u && setAiWeek(u.totalCost ?? 0)).catch(() => undefined);
    // keep the "cooking / needs you" surface fresh while things are in flight
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const now = new Date();
  const phase = phaseOf(now.getHours());
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' });
  const c = d?.today.counts;
  const pct = c && c.total ? Math.round((c.done / c.total) * 100) : 0;
  const needs = d?.needsYou ?? [];
  const cooking = d?.cooking ?? [];
  const ft = d?.insights.followTrend;
  const ftDelta = ft && ft.week !== null && ft.prevWeek !== null ? ft.week - ft.prevWeek : null;

  const phaseMsg = phase === 'morning' ? 'let’s set up the day' : phase === 'evening' ? 'time to wind down' : 'stay on the must-dos';

  const guidance = d?.insights.guidance || null;
  const summary = d?.insights.daySummary || null;
  const portrait = d?.personality.unlocked ? d?.personality.summary : null;
  const readText = read === 'guidance' ? guidance : read === 'summary' ? summary : portrait;

  const tiles = d ? [
    { label: 'Documents', n: d.counts.documents, nw: d.countsNew?.documents, to: '/documents' },
    { label: 'Bookmarks', n: d.counts.bookmarks, nw: d.countsNew?.bookmarks, to: '/bookmarks' },
    { label: 'Ideas', n: d.counts.ideas, nw: d.countsNew?.ideas, to: '/ideas' },
    { label: 'Skills', n: d.counts.skills, nw: d.countsNew?.skills, to: '/skills' },
    { label: 'Notes', n: d.counts.notes, nw: d.countsNew?.notes, to: '/notes' },
    { label: 'Contacts', n: d.counts.contacts, nw: d.countsNew?.contacts, to: '/contacts' },
    { label: 'Meetings', n: d.counts.meetings, nw: d.countsNew?.meetings, to: '/meetings' },
    { label: 'Emo', n: d.counts.emoCards, nw: d.countsNew?.emoCards, to: '/emo' },
  ] : [];

  const card = 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900';
  const label = 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400';

  return (
    <div className="space-y-4">
      {/* Greeting + compact search */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{greeting(now.getHours())}, Sandeep</h1>
          <p className="text-zinc-400 text-sm">{dateLabel}</p>
        </div>
        <button onClick={openSearch} title="Search your brain" className="shrink-0 inline-flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-500 hover:border-emerald-500/50">
          <Search size={16} /><span className="hidden sm:inline">Search your brain</span>
        </button>
      </div>

      {/* State of you */}
      <p className="text-sm text-zinc-500 -mt-1">
        {d ? (
          <>
            <b className="text-zinc-700 dark:text-zinc-200">{needs.length} {needs.length === 1 ? 'thing needs' : 'things need'} you</b>
            <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">·</span>{cooking.length} cooking
            {c && c.total > 0 && <><span className="mx-1.5 text-zinc-300 dark:text-zinc-600">·</span><span className="tabular-nums">{c.done}/{c.total}</span> done</>}
            <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">·</span>{phaseMsg}
          </>
        ) : <Skeleton className="h-3.5 w-2/3" />}
      </p>

      {/* NEEDS YOU — the hero */}
      <section className={'rounded-xl border p-3.5 ' + (needs.length ? 'border-rose-300/40 bg-rose-500/[0.04] dark:border-rose-500/30' : 'border-emerald-300/40 bg-emerald-500/[0.04] dark:border-emerald-500/30')}>
        <div className="flex items-center justify-between mb-1">
          <div className={label + ' text-zinc-700 dark:text-zinc-200'}>
            {needs.length ? <>⚠ Needs you <span className="ml-1 rounded-full bg-rose-500 text-white text-[11px] font-bold px-2 py-0.5">{needs.length}</span></> : <>✓ You’re all caught up</>}
          </div>
        </div>
        {needs.length ? (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {needs.map((n, i) => (
              <button key={i} onClick={() => navigate(n.href)} className="w-full flex items-center gap-3 py-2.5 text-left hover:opacity-90 min-w-0">
                <span className="text-lg w-6 text-center shrink-0">{n.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{n.title}</span>
                  <span className="block truncate text-xs text-zinc-500">{n.sub}</span>
                </span>
                <span className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white text-xs font-semibold px-3 py-1.5">{n.action}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 pt-1">Nothing’s waiting on you right now — capture something, or take the win.</p>
        )}
      </section>

      {/* Proactive connections (self-hides when empty) */}
      <TodayCard />

      {/* CAPTURE bar */}
      <div className="grid grid-cols-4 gap-2">
        <Cbtn primary icon={Mic} label="Record" onClick={() => navigate('/emo')} />
        <Cbtn icon={Brain} label="Dump" onClick={() => navigate('/today')} />
        <Cbtn icon={MessageCircle} label="Talk" onClick={() => navigate('/chat')} />
        <Cbtn icon={Upload} label="Capture" onClick={() => navigate('/capture')} />
      </div>

      {/* AT A GLANCE — KPIs + brain tiles */}
      <div>
        <h2 className={label + ' mb-2'}>At a glance</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-2.5">
          <Kpi icon={Flame} tint="text-amber-500" label="Streak" value={String(d?.insights.streak ?? '—')} context="days in a row" />
          <Kpi icon={Target} tint="text-emerald-500" label="Follow-through" value={ft && ft.week !== null ? `${ft.week}%` : d ? `${d.insights.followThrough}%` : '—'} trend={ftDelta} context={ftDelta !== null ? 'this week vs last' : 'this week'} />
          <Kpi icon={Timer} tint="text-sky-500" label="Time spent" value={d ? mins(d.insights.minutesToday ?? 0) : '—'} context="today" />
          <Kpi icon={Coins} tint="text-violet-500" label="AI cost" value={aiWeek === null ? '—' : fmtUsd(aiWeek)} context="this week (Mon–Sun)" />
        </div>
        <div className={card + ' grid grid-cols-4 sm:grid-cols-8 overflow-hidden'}>
          {tiles.length === 0
            ? Array.from({ length: 8 }).map((_, i) => <div key={i} className="p-3 border-r border-b sm:border-b-0 border-zinc-100 dark:border-zinc-800"><Skeleton className="h-5 w-8 mx-auto" /></div>)
            : tiles.map((t, i) => (
              <button key={t.label} onClick={() => navigate(t.to)} className={'p-3 text-center hover:bg-zinc-50 dark:hover:bg-zinc-800/50 border-zinc-100 dark:border-zinc-800 ' + ((i % 4 !== 3) ? 'border-r ' : '') + (i < 4 ? 'border-b sm:border-b-0 ' : '') + 'sm:border-r sm:last:border-r-0'}>
                <div className="text-lg font-extrabold tracking-tight tabular-nums">{t.n}</div>
                <div className="text-[10.5px] text-zinc-400">{t.label}</div>
                <div className="text-[10px] font-bold text-emerald-500 h-3">{t.nw ? `+${t.nw}` : ''}</div>
              </button>
            ))}
        </div>
      </div>

      {/* ADAPTIVE — Today / plan / wind-down */}
      <section className={card + ' p-4'}>
        <div className="flex items-start justify-between mb-2 gap-2">
          <div>
            <h3 className="font-bold text-[15px]">{phase === 'morning' ? 'Start your day' : phase === 'evening' ? 'Wind down' : 'Today’s focus'}</h3>
            <p className="text-xs text-zinc-400">{phase === 'morning' ? 'Empty your head — it becomes today’s tasks.' : phase === 'evening' ? 'Tell today’s story and close it out.' : 'Keep moving on the must-dos.'}</p>
          </div>
          <button onClick={() => navigate('/today')} className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-0.5 shrink-0">Open <ArrowRight size={12} /></button>
        </div>
        {c && c.total > 0 ? (
          <>
            <div className="flex items-center gap-2 mb-2.5">
              <div className="flex-1 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden"><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} /></div>
              <span className="text-xs text-zinc-500 tabular-nums">{c.done}/{c.total} · {pct}%</span>
            </div>
            <ul className="space-y-1.5">
              {d!.today.mustDos.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm min-w-0">
                  {t.pinned ? <Star size={13} className="text-amber-500 fill-amber-500 shrink-0" /> : <span className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0" />}
                  <span className="flex-1 min-w-0 truncate">{t.title}</span>
                </li>
              ))}
              {d!.today.mustDos.length === 0 && <li className="text-sm text-zinc-400">All done — nice. 🎉</li>}
            </ul>
          </>
        ) : d ? (
          <p className="text-sm text-zinc-500">No tasks yet — {phase === 'evening' ? 'wind down and' : ''} dump your brain to build today’s list.</p>
        ) : <div className="space-y-2"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3.5 w-1/2" /></div>}
        <div className="flex gap-1.5 mt-3">
          <Chip ok={d?.today.dumped} label="Brain dumped" />
          <Chip ok={d?.today.storyDone} label="Story told" />
          {phase === 'evening' && !d?.today.storyDone && <button onClick={() => navigate('/today')} className="ml-auto text-xs font-medium text-emerald-600 hover:underline">Tell today’s story →</button>}
          {phase === 'morning' && !d?.today.dumped && <button onClick={() => navigate('/today')} className="ml-auto text-xs font-medium text-emerald-600 hover:underline">Brain dump →</button>}
        </div>
      </section>

      {/* YOUR READ + IN THE BACKGROUND */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className={card + ' p-4 lg:col-span-2 min-w-0'}>
          <div className="flex gap-4 mb-2 text-xs overflow-x-auto">
            <Tab on={read === 'guidance'} onClick={() => setRead('guidance')} icon="✨" text="Your guidance" />
            <Tab on={read === 'summary'} onClick={() => setRead('summary')} icon="📖" text={`Day summary${d?.insights.daySummaryFor === 'yesterday' ? ' (yesterday)' : ''}`} />
            <Tab on={read === 'portrait'} onClick={() => setRead('portrait')} icon="🫆" text="Portrait" />
          </div>
          {readText ? (
            <div className="border-l-2 border-emerald-500/40 pl-3 max-h-52 overflow-hidden">
              <Markdown className="text-[13px] text-zinc-600 dark:text-zinc-300 leading-relaxed">{readText.length > 900 ? readText.slice(0, 900) + '…' : readText}</Markdown>
            </div>
          ) : (
            <p className="text-xs text-zinc-400 pt-1">{read === 'guidance' ? 'Your Mentor writes guidance after your Story of the Day.' : read === 'summary' ? 'Your day summary appears in the evening.' : d ? `Portrait unlocks after ${d.personality.minDays} days of stories — ${d.personality.daysCovered} so far.` : '…'}</p>
          )}
        </section>

        <section className={card + ' p-4 min-w-0'}>
          <h2 className={label + ' mb-2.5 text-amber-600 dark:text-amber-400'}>⏳ In the background</h2>
          {cooking.length ? (
            <div className="space-y-2">
              {cooking.map((k, i) => (
                <button key={i} onClick={() => navigate(k.href)} className="w-full flex items-center gap-2 text-left text-[13px] text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 min-w-0">
                  <Loader2 size={12} className="animate-spin text-amber-500 shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{k.label}</span>
                  <ChevronRight size={13} className="text-zinc-400 shrink-0" />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-400">Nothing running right now. When a research, agent or reminder is working, it shows here.</p>
          )}
        </section>
      </div>

      {/* RECENTLY SAVED */}
      {d && d.recent.length > 0 && (
        <section>
          <h2 className={label + ' mb-2'}>Recently saved</h2>
          <div className={card + ' divide-y divide-zinc-100 dark:divide-zinc-800'}>
            {d.recent.map((it) => (
              <button key={it.id} onClick={() => navigate(`/doc/${it.id}`)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 min-w-0">
                <span className="flex-1 min-w-0 truncate text-sm">{it.title}</span>
                <span className="text-[11px] text-zinc-400 shrink-0 tabular-nums">{new Date(it.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Cbtn({ icon: Icon, label, onClick, primary }: { icon: any; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button onClick={onClick} className={'flex flex-col sm:flex-row items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 text-[12px] sm:text-sm font-semibold ' + (primary ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:border-emerald-500/40')}>
      <Icon size={17} />{label}
    </button>
  );
}

function Kpi({ icon: Icon, tint, label, value, context, trend }: { icon: any; tint: string; label: string; value: string; context: string; trend?: number | null }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
      <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400"><span>{label}</span><Icon size={14} className={tint} /></div>
      <div className="text-[22px] font-extrabold tracking-tight mt-1 mb-0.5 tabular-nums">{value}{trend != null && trend !== 0 && <span className={'ml-1 text-xs font-bold ' + (trend > 0 ? 'text-emerald-500' : 'text-rose-500')}>{trend > 0 ? '▲' : '▼'}{Math.abs(trend)}</span>}</div>
      <div className="text-[11.5px] text-zinc-400">{context}</div>
    </div>
  );
}

function Chip({ ok, label }: { ok?: boolean; label: string }) {
  return <span className={'text-[11.5px] font-medium rounded-full px-2.5 py-0.5 border ' + (ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : 'border-zinc-200 dark:border-zinc-700 text-zinc-400')}>{ok ? '✓ ' : ''}{label}</span>;
}

function Tab({ on, onClick, icon, text }: { on: boolean; onClick: () => void; icon: string; text: string }) {
  return <button onClick={onClick} className={'pb-1.5 font-semibold whitespace-nowrap border-b-2 ' + (on ? 'border-emerald-500 text-zinc-900 dark:text-zinc-100' : 'border-transparent text-zinc-400')}>{icon} {text}</button>;
}
