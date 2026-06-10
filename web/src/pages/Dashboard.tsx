import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Brain, MessageCircle, Upload, Sun, Flame, Activity as ActivityIcon, FileText, Bookmark, Lightbulb, Wand2, ArrowRight, Fingerprint, Star, BookOpen, type LucideIcon } from 'lucide-react';
import { openSearch } from '../ui/SearchOverlay';
import { Skeleton } from '../ui/Skeleton';

type Home = {
  today: { dumped: boolean; storyDone: boolean; counts: { total: number; done: number; open: number }; mustDos: { id: string; title: string; pinned: boolean; priority: string }[] };
  insights: { streak: number; followThrough: number; minutesSpent: number; daySummary: string | null };
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
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const c = d?.today.counts;
  const pct = c && c.total ? Math.round((c.done / c.total) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-extrabold">{greeting(now.getHours())}, Sandeep</h1>
        <p className="text-zinc-500 text-sm">{dateLabel}</p>
      </div>

      {/* Search your brain */}
      <button onClick={openSearch} className="w-full flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 text-sm text-zinc-400 hover:border-emerald-500/50">
        <Search size={16} /> Search your brain — find anything, or ask a question…
      </button>

      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-3">
        <Action icon={Brain} label="Dump my brain" onClick={() => navigate('/today')} />
        <Action icon={MessageCircle} label="Talk to your brain" onClick={() => navigate('/chat')} />
        <Action icon={Upload} label="Capture" onClick={() => navigate('/capture')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Today */}
        <section className="min-w-0 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-1.5 font-semibold text-sm"><Sun size={16} className="text-amber-500" /> Today</h2>
            <button onClick={() => navigate('/today')} className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-0.5">Open <ArrowRight size={12} /></button>
          </div>
          {c && c.total > 0 ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-1 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
                <span className="text-xs text-zinc-500 tabular-nums">{c.done}/{c.total}</span>
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
        </section>

        {/* Insights */}
        <section className="min-w-0 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-1.5 font-semibold text-sm"><ActivityIcon size={16} className="text-emerald-500" /> Your pulse</h2>
            <button onClick={() => navigate('/activity')} className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-0.5">Activity <ArrowRight size={12} /></button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <Mini icon={Flame} value={String(d?.insights.streak ?? '—')} label="streak" />
            <Mini value={d ? `${d.insights.followThrough}%` : '—'} label="follow-through" />
            <Mini value={d ? mins(d.insights.minutesSpent) : '—'} label="time spent" />
            <Mini value={aiWeek === null ? '—' : '$' + (aiWeek > 0 && aiWeek < 0.01 ? aiWeek.toFixed(4) : aiWeek.toFixed(2))} label="AI this week" />
          </div>
          {d?.insights.daySummary ? (
            <p className="text-xs text-zinc-500 line-clamp-3 border-l-2 border-emerald-500/40 pl-2">{d.insights.daySummary}</p>
          ) : (
            <p className="text-xs text-zinc-400">Your day-summary appears here after 9:30 PM.</p>
          )}
        </section>
      </div>

      {/* Personality (once unlocked) */}
      {d?.personality.unlocked && d.personality.summary && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-gradient-to-br from-emerald-500/5 to-transparent p-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="flex items-center gap-1.5 font-semibold text-sm"><Fingerprint size={16} className="text-emerald-500" /> Your portrait</h2>
            <button onClick={() => navigate('/activity')} className="text-xs text-emerald-600 hover:underline">Validate</button>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300 line-clamp-3">{d.personality.summary}</p>
        </section>
      )}

      {/* Brain at a glance */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">Your brain at a glance</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Count icon={FileText} label="Documents" value={d?.counts.documents} onClick={() => navigate('/capture')} />
          <Count icon={Bookmark} label="Bookmarks" value={d?.counts.bookmarks} onClick={() => navigate('/bookmarks')} />
          <Count icon={Lightbulb} label="Ideas" value={d?.counts.ideas} onClick={() => navigate('/ideas')} />
          <Count icon={Wand2} label="Skills" value={d?.counts.skills} onClick={() => navigate('/skills')} />
        </div>
      </section>

      {/* Recent */}
      {d && d.recent.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">Recently saved</h2>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 divide-y divide-zinc-100 dark:divide-zinc-800">
            {d.recent.map((it) => (
              <button key={it.id} onClick={() => navigate(`/doc/${it.id}`)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 min-w-0">
                <BookOpen size={15} className="text-zinc-400 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-sm">{it.title}</span>
                <span className="text-[11px] text-zinc-400 shrink-0">{new Date(it.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Action({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-3.5 text-center hover:border-emerald-500/50 hover:shadow-sm transition-all">
      <span className="rounded-lg bg-emerald-500/10 text-emerald-600 p-2"><Icon size={18} /></span>
      <span className="text-xs font-medium leading-tight">{label}</span>
    </button>
  );
}
function Mini({ icon: Icon, value, label }: { icon?: LucideIcon; value: string; label: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 p-2 text-center">
      <div className="text-lg font-extrabold tabular-nums flex items-center justify-center gap-1">{Icon && <Icon size={14} className="text-amber-500" />}{value}</div>
      <div className="text-[10px] text-zinc-400">{label}</div>
    </div>
  );
}
function Count({ icon: Icon, label, value, onClick }: { icon: LucideIcon; label: string; value?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-left hover:border-emerald-500/50">
      <Icon size={18} className="text-emerald-600" />
      <div className="mt-2 text-xl font-bold tabular-nums">{value ?? '—'}</div>
      <div className="text-xs text-zinc-400">{label}</div>
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
