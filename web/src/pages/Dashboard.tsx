import { useEffect, useState, type ReactNode } from 'react';
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
  counts: { documents: number; bookmarks: number; ideas: number; skills: number; notes: number; contacts: number; meetings: number; emoCards: number; brain?: number };
  /** The operational state, grouped as the bands render it. (BEA-1136/1137) */
  facts?: {
    needsYou: { needsYou: number; toReview: number; missedToday: number; overdue: number };
    yourDay: { open: number; doneToday: number; carriedOver: number; dumped: boolean; storyDone: boolean };
    owed: { delegatedOpen: number; stalling: number; dailyIn: number; dailyOwed: number; restDay: boolean; remindersQueued: number };
  };
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
  const needs = d?.needsYou ?? [];
  const cooking = d?.cooking ?? [];
  const ft = d?.insights.followTrend;
  const ftDelta = ft && ft.week !== null && ft.prevWeek !== null ? ft.week - ft.prevWeek : null;


  const guidance = d?.insights.guidance || null;
  const summary = d?.insights.daySummary || null;
  const portrait = d?.personality.unlocked ? d?.personality.summary : null;
  const readText = read === 'guidance' ? guidance : read === 'summary' ? summary : portrait;


  const card = 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900';
  const label = 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400';

  const F = d?.facts;
  const needBand = F ? [
    { n: F.needsYou.needsYou, label: 'Needs you', to: '/agent', tone: 'rose' as const },
    { n: F.needsYou.toReview, label: 'To review', to: '/today', tone: 'violet' as const },
    { n: F.needsYou.missedToday, label: 'Missed today', to: '/tasks?tab=daily', tone: 'rose' as const },
    { n: F.needsYou.overdue, label: 'Overdue', to: '/tasks', tone: 'amber' as const },
  ] : [];
  const allClear = F && needBand.every((t) => !t.n);

  return (
    <div className="space-y-4">
      {/* One line, not a greeting paragraph. The largest thing on the page used to say the least. (BEA-1137) */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold tracking-tight">{dateLabel}</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            {d && F ? (
              <>
                <b className={F.needsYou.needsYou ? 'text-rose-500' : 'text-emerald-500'}>{F.needsYou.needsYou} need you</b>
                <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">·</span>
                {/* The SAME definition the Today page uses, or the two screens disagree — Home said
                    8/52 while Today said 8/46 for the same day. (BEA-1138) */}
                <span className="tabular-nums">{c ? `${c.done}/${c.total}` : '—'}</span> done today
              </>
            ) : <Skeleton className="h-3.5 w-40" />}
          </p>
        </div>
        <button onClick={openSearch} title="Search your brain" className="shrink-0 inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-500 hover:border-emerald-500/50 dark:border-zinc-800 dark:bg-zinc-900">
          <Search size={16} /><span className="hidden sm:inline">Search your brain</span>
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Cbtn primary icon={Mic} label="Record" onClick={() => navigate('/emo')} />
        <Cbtn icon={Brain} label="Dump" onClick={() => navigate('/today')} />
        <Cbtn icon={MessageCircle} label="Talk" onClick={() => navigate('/chat')} />
        <Cbtn icon={Upload} label="Capture" onClick={() => navigate('/capture')} />
      </div>

      {/* NEEDS YOU — a row of four zeros reads as broken, so when nothing is outstanding it
          collapses to one line. Still a fact, not prose. (BEA-1137) */}
      {allClear ? (
        <div className="rounded-xl border border-emerald-300/40 bg-emerald-500/[0.04] px-4 py-3 text-sm font-medium text-emerald-600 dark:border-emerald-500/30 dark:text-emerald-400">
          ✓ Nothing needs you
        </div>
      ) : (
        <Band title="Needs you" tiles={needBand} navigate={navigate} loading={!F} cols={4} />
      )}

      {!!needs.length && (
        <section className="rounded-xl border border-rose-300/40 bg-rose-500/[0.04] p-2 dark:border-rose-500/30">
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {needs.map((n, i) => (
              <button key={i} onClick={() => navigate(n.href)} className="flex w-full min-w-0 items-center gap-3 py-2.5 text-left hover:opacity-90">
                <span className="w-6 shrink-0 text-center text-lg">{n.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{n.title}</span>
                  <span className="block truncate text-xs text-zinc-500">{n.sub}</span>
                </span>
                <span className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white">{n.action}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <TodayCard />

      <Band
        title="Your day"
        loading={!F}
        cols={3}
        navigate={navigate}
        tiles={F ? [
          { n: c?.open ?? F.yourDay.open, label: 'Open today', to: '/today' },
          { n: c?.done ?? F.yourDay.doneToday, label: 'Done today', to: '/today', tone: 'emerald' },
          { n: F.yourDay.carriedOver, label: 'Carried over', to: '/tasks', tone: F.yourDay.carriedOver ? 'amber' : undefined },
        ] : []}
        after={
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip ok={d?.today.dumped} label="Brain dumped" />
            <Chip ok={d?.today.storyDone} label="Story told" />
            {d && !d.today.storyDone && <button onClick={() => navigate('/today')} className="ml-auto text-xs font-medium text-emerald-600 hover:underline">Tell today’s story →</button>}
          </div>
        }
      />

      <Band
        title="Who owes you"
        loading={!F}
        cols={5}
        navigate={navigate}
        tiles={F ? [
          { n: F.owed.delegatedOpen, label: 'Delegated', to: '/tasks?tab=delegated' },
          { n: F.owed.stalling, label: 'Stalling', to: '/tasks?tab=delegated', tone: F.owed.stalling ? 'rose' : undefined },
          { n: F.owed.dailyIn, label: F.owed.restDay ? 'Daily (day off)' : `Daily of ${F.owed.dailyOwed}`, to: '/tasks?tab=daily', tone: F.owed.restDay ? undefined : (F.owed.dailyIn >= F.owed.dailyOwed ? 'emerald' : 'amber') },
          { n: F.owed.remindersQueued, label: 'Reminders', to: '/contacts' },
          { n: d?.counts.contacts ?? 0, label: 'Contacts', to: '/contacts' },
        ] : []}
      />

      <Band
        title="Library"
        loading={!d}
        cols={4}
        navigate={navigate}
        tiles={d ? [
          { n: d.counts.brain ?? 0, label: 'In your brain', to: '/explore' },
          { n: d.counts.documents, label: 'Documents', to: '/documents' },
          { n: d.counts.bookmarks, label: 'Bookmarks', to: '/bookmarks' },
          { n: d.counts.emoCards, label: 'Emo', to: '/emo' },
          { n: d.counts.ideas, label: 'Ideas', to: '/ideas' },
          { n: d.counts.notes, label: 'Notes', to: '/notes' },
          { n: d.counts.meetings, label: 'Meetings', to: '/meetings' },
          { n: d.counts.skills, label: 'Skills', to: '/skills' },
        ] : []}
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi icon={Flame} tint="text-amber-500" label="Streak" value={String(d?.insights.streak ?? '—')} context="days in a row" />
        <Kpi icon={Target} tint="text-emerald-500" label="Follow-through" value={d ? `${d.insights.followThrough}%` : '—'} trend={ftDelta} context="last 30 days" />
        <Kpi icon={Timer} tint="text-sky-500" label="Time spent" value={d ? mins(d.insights.minutesToday ?? 0) : '—'} context="today" />
        <Kpi icon={Coins} tint="text-violet-500" label="AI cost" value={aiWeek === null ? '—' : fmtUsd(aiWeek)} context="this week" />
      </div>

      {!!d?.today.mustDos.length && (
        <section className={card + ' p-4'}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className={label}>Today’s must-dos</h2>
            <button onClick={() => navigate('/today')} className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline">Open <ArrowRight size={12} /></button>
          </div>
          <ul className="space-y-1.5">
            {d.today.mustDos.map((t) => (
              <li key={t.id} className="flex min-w-0 items-center gap-2 text-sm">
                {t.pinned ? <Star size={13} className="shrink-0 fill-amber-500 text-amber-500" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />}
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!cooking.length && (
        <section className={card + ' p-3'}>
          <h2 className={label + ' mb-2 text-amber-600 dark:text-amber-400'}>⏳ In the background</h2>
          <div className="space-y-1.5">
            {cooking.map((k, i) => (
              <button key={i} onClick={() => navigate(k.href)} className="flex w-full min-w-0 items-center gap-2 text-left text-[13px] text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">
                <Loader2 size={12} className="shrink-0 animate-spin text-amber-500" />
                <span className="min-w-0 flex-1 truncate">{k.label}</span>
                <ChevronRight size={13} className="shrink-0 text-zinc-400" />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* The essays stay, but CLOSED — the page is numbers until you choose to read. Both of these
          used to render mid-sentence truncated paragraphs on the dashboard. (BEA-1137) */}
      <div className="space-y-2">
        {([
          ['guidance', '✨', 'Your guidance', d?.insights.guidance] as const,
          ['summary', '📖', `Day summary${d?.insights.daySummaryFor === 'yesterday' ? ' (yesterday)' : ''}`, d?.insights.daySummary] as const,
          ['portrait', '🫆', 'Portrait', d?.personality.summary] as const,
        ]).map(([key, icon, text, content]) => (
          <details key={key} className={card + ' group'}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium">
              <span>{icon}</span>
              <span className="flex-1">{text}</span>
              <span className="text-xs text-zinc-400">{content ? 'Read' : 'Not ready'}</span>
              <ChevronRight size={14} className="text-zinc-400 transition-transform group-open:rotate-90" />
            </summary>
            <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
              {content
                ? <Markdown className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">{content}</Markdown>
                : <p className="text-xs text-zinc-400">{key === 'guidance' ? 'Written after your Story of the Day.' : key === 'summary' ? 'Appears in the evening.' : d ? `Unlocks after ${d.personality.minDays} days of stories — ${d.personality.daysCovered} so far.` : '…'}</p>}
            </div>
          </details>
        ))}
      </div>
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

type Tile = { n: number; label: string; to: string; tone?: 'rose' | 'amber' | 'emerald' | 'violet' };

const TONE: Record<string, string> = {
  rose: 'text-rose-500',
  amber: 'text-amber-500',
  emerald: 'text-emerald-500',
  violet: 'text-violet-500',
};

/**
 * A band of facts. Home used to tell its numbers three different ways at once — stat cards, a grey
 * strip, and figures buried inside sentences. One shape, used everywhere. (BEA-1137)
 */
function Band({
  title, tiles, navigate, loading, cols, after,
}: { title: string; tiles: Tile[]; navigate: (to: string) => void; loading?: boolean; cols: number; after?: ReactNode }) {
  const grid = cols === 3 ? 'grid-cols-3' : cols === 5 ? 'grid-cols-3 sm:grid-cols-5' : cols === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-4';
  return (
    <section>
      <h2 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>
      <div className={'grid gap-2 ' + grid}>
        {loading
          ? Array.from({ length: cols }).map((_, i) => <div key={i} className="h-[68px] animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)
          : tiles.map((t) => (
            <button
              key={t.label}
              onClick={() => navigate(t.to)}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-emerald-500/50 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className={'text-2xl font-extrabold leading-none tabular-nums ' + (t.tone ? TONE[t.tone] : '')}>{t.n}</div>
              <div className="mt-1 truncate text-[11px] text-zinc-400">{t.label}</div>
            </button>
          ))}
      </div>
      {after}
    </section>
  );
}
