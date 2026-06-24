import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Brain, MessageCircle, Upload, Sun, Flame, FileText, Bookmark, Lightbulb, Wand2, ArrowRight, Fingerprint, Star, BookOpen, Sparkles, Coins, Timer, Target, type LucideIcon } from 'lucide-react';
import { openSearch } from '../ui/SearchOverlay';
import { Skeleton } from '../ui/Skeleton';
import { TodayCard } from '../ui/TodayCard';

type Home = {
  today: { dumped: boolean; storyDone: boolean; counts: { total: number; done: number; open: number }; mustDos: { id: string; title: string; pinned: boolean; priority: string }[] };
  insights: {
    streak: number;
    followThrough: number;
    followTrend?: { week: number | null; prevWeek: number | null };
    minutesSpent: number;
    minutesToday?: number;
    daySummary: string | null;
    daySummaryFor?: 'today' | 'yesterday' | null;
  };
  personality: { unlocked: boolean; summary: string | null; daysCovered: number; minDays: number };
  counts: { documents: number; bookmarks: number; ideas: number; skills: number };
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
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
function fmtUsd(n: number): string {
  return '$' + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));
}

export function Dashboard() {
  const navigate = useNavigate();
  const [d, setD] = useState<Home | null>(null);
  const [aiWeek, setAiWeek] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/home').then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => undefined);
    fetch('/api/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (!u) return;
        const wk = (u.openrouter?.week ?? 0) + (u.openai?.available ? u.openai.week ?? 0 : 0);
        setAiWeek(wk);
      })
      .catch(() => undefined);
  }, []);

  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' });
  const c = d?.today.counts;
  const pct = c && c.total ? Math.round((c.done / c.total) * 100) : 0;

  const ft = d?.insights.followTrend;
  const ftDelta = ft && ft.week !== null && ft.prevWeek !== null ? ft.week - ft.prevWeek : null;

  return (
    <div className="space-y-5">
      {/* Greeting */}
      <div className="flex items-end justify-between gap-3">
        <h1 className="text-2xl font-extrabold">{greeting(now.getHours())}, Sandeep</h1>
        <p className="text-zinc-500 text-sm shrink-0">{dateLabel}</p>
      </div>

      {/* Search your brain */}
      <button onClick={openSearch} className="w-full flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 text-sm text-zinc-400 hover:border-emerald-500/50">
        <Search size={16} /> Search your brain — find anything, or ask a question…
      </button>

      {/* KPI row — four matched cards, 2×2 on phones */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Flame} tint="text-amber-500" label="Streak" value={String(d?.insights.streak ?? '—')} context="days in a row" />
        <Kpi
          icon={Target}
          tint="text-emerald-500"
          label="Follow-through"
          value={ft && ft.week !== null ? `${ft.week}%` : d ? `${d.insights.followThrough}%` : '—'}
          trend={ftDelta}
          context={ftDelta !== null ? 'this week vs last' : 'this week'}
        />
        <Kpi icon={Timer} tint="text-sky-500" label="Time spent" value={d ? mins(d.insights.minutesToday ?? 0) : '—'} context={d ? `today · ${mins(d.insights.minutesSpent)} in 30 days` : 'today'} />
        <Kpi icon={Coins} tint="text-violet-500" label="AI cost" value={aiWeek === null ? '—' : fmtUsd(aiWeek)} context="this week" />
      </div>

      {/* Proactive connections the brain surfaced (hidden when none) */}
      <TodayCard />

      {/* Work area — Today (hero) + Day summary / Portrait */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 min-w-0 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <SectionLabel><Sun size={13} className="text-amber-500" /> Today</SectionLabel>
            <button onClick={() => navigate('/today')} className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-0.5">Open <ArrowRight size={12} /></button>
          </div>
          {c && c.total > 0 ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-1 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
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
          ) : !d ? (
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No tasks yet — dump your brain to build today’s list.</p>
          )}
          <div className="flex gap-1.5 mt-3">
            <Chip ok={d?.today.dumped} label="Brain dumped" />
            <Chip ok={d?.today.storyDone} label="Story told" />
          </div>
          {/* Quick actions live inside the hero — they're all about acting on today */}
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
            <ActionSm icon={Brain} label="Dump" onClick={() => navigate('/today')} />
            <ActionSm icon={MessageCircle} label="Talk" onClick={() => navigate('/chat')} />
            <ActionSm icon={Upload} label="Capture" onClick={() => navigate('/capture')} />
          </div>
        </section>

        <div className="min-w-0 space-y-4">
          {/* Day summary */}
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
            <div className="flex items-center justify-between mb-2">
              <SectionLabel><Sparkles size={13} className="text-emerald-500" /> Day summary</SectionLabel>
              {d?.insights.daySummaryFor && <span className="text-[10px] uppercase tracking-wide text-zinc-400">{d.insights.daySummaryFor}</span>}
            </div>
            {d?.insights.daySummary ? (
              <p className="text-xs text-zinc-500 leading-relaxed line-clamp-5 border-l-2 border-emerald-500/40 pl-2">{d.insights.daySummary}</p>
            ) : (
              <p className="text-xs text-zinc-400">Your day-summary appears here after 9:30 PM.</p>
            )}
          </section>

          {/* Portrait */}
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-gradient-to-br from-emerald-500/5 to-transparent p-4">
            <div className="flex items-center justify-between mb-2">
              <SectionLabel><Fingerprint size={13} className="text-emerald-500" /> Your portrait</SectionLabel>
              {d?.personality.unlocked && <button onClick={() => navigate('/activity')} className="text-xs text-emerald-600 hover:underline">Validate</button>}
            </div>
            {d?.personality.unlocked && d.personality.summary ? (
              <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed line-clamp-4">{d.personality.summary}</p>
            ) : (
              <p className="text-xs text-zinc-400">{d ? `Unlocks after ${d.personality.minDays} days of stories — ${d.personality.daysCovered} so far.` : '…'}</p>
            )}
          </section>
        </div>
      </div>

      {/* Your brain — one slim tappable row */}
      <section>
        <SectionLabel className="mb-2">Your brain</SectionLabel>
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 grid grid-cols-2 sm:grid-cols-4">
          <BrainCount icon={FileText} label="Documents" value={d?.counts.documents} onClick={() => navigate('/capture')} />
          <BrainCount icon={Bookmark} label="Bookmarks" value={d?.counts.bookmarks} onClick={() => navigate('/bookmarks')} />
          <BrainCount icon={Lightbulb} label="Ideas" value={d?.counts.ideas} onClick={() => navigate('/ideas')} />
          <BrainCount icon={Wand2} label="Skills" value={d?.counts.skills} onClick={() => navigate('/skills')} />
        </div>
      </section>

      {/* Recently saved */}
      {d && d.recent.length > 0 && (
        <section>
          <SectionLabel className="mb-2">Recently saved</SectionLabel>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 divide-y divide-zinc-100 dark:divide-zinc-800">
            {d.recent.map((it) => (
              <button key={it.id} onClick={() => navigate(`/doc/${it.id}`)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 min-w-0">
                <BookOpen size={15} className="text-zinc-400 shrink-0" />
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

function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <h2 className={'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 ' + className}>{children}</h2>;
}

function Kpi({ icon: Icon, tint, label, value, context, trend }: { icon: LucideIcon; tint: string; label: string; value: string; context: string; trend?: number | null }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 truncate">{label}</span>
        <Icon size={14} className={tint + ' shrink-0'} />
      </div>
      <div className="mt-1 text-xl font-extrabold tabular-nums whitespace-nowrap flex items-baseline gap-1.5">
        {value}
        {typeof trend === 'number' && trend !== 0 && (
          <span className={'text-[11px] font-semibold ' + (trend > 0 ? 'text-emerald-500' : 'text-rose-500')}>{trend > 0 ? '▲' : '▼'}{Math.abs(trend)}%</span>
        )}
      </div>
      <div className="text-[11px] text-zinc-400 truncate">{context}</div>
    </div>
  );
}

function ActionSm({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 px-2 py-2 text-xs font-medium hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors">
      <Icon size={15} className="text-emerald-600 shrink-0" /> {label}
    </button>
  );
}

function BrainCount({ icon: Icon, label, value, onClick }: { icon: LucideIcon; label: string; value?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2.5 px-3.5 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 min-w-0">
      <Icon size={16} className="text-emerald-600 shrink-0" />
      <span className="text-lg font-bold tabular-nums">{value ?? '—'}</span>
      <span className="text-xs text-zinc-400 truncate">{label}</span>
    </button>
  );
}

function Chip({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <span className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ' + (ok ? 'bg-emerald-500/10 text-emerald-600' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400')}>
      <span className={'h-1.5 w-1.5 rounded-full ' + (ok ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600')} /> {label}
    </span>
  );
}
