import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, RefreshCw, Loader2, Check, X, Pencil, Pin, Trash2, ChevronDown, Search, Target, Wrench, Plus, Sparkles, Eye, Ban } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useSearchParams } from 'react-router-dom';
import { Mentor } from './Mentor';
import { FindingSheet, type FindingView } from '../mind/FindingSheet';
import { mindApi, chainApi, valenceClass, fmtRelative, fmtWhen, type Finding, type Stats, type MindChain, type Recap } from '../mind/client';
import { TrustLadder } from '../mind/TrustLadder';

/**
 * The Lab, rebuilt. (BEA-1143)
 *
 * It had eight tabs — Situation, Map, Mood, Heatmaps, Findings, Review, About Me, Mentor — and the
 * owner's verdict was that he could not use it: "the map is completely useless", "mood, I don't know
 * what information it is showing", "review, I don't know how it is helping me", and above all
 * "I don't see any dot connecting in the entire lab section".
 *
 * He was right, and the reason is structural. Every tab showed one slice of the machine's working
 * and left the joining-up to him. So: Map and Mood are gone, and eight tabs become two.
 *
 * WHAT I KNOW — opens with the picture in plain sentences, built from his own numbers: his best and
 * worst weekday, where he stalls, what lifts and drains him, and the one thing to do. THEN the
 * findings behind it, each judged right there with yes/no, so Review stops being a separate place.
 *
 * YOUR PLAN — the situation chains (goal → what's blocking → the lever) and the daily guidance.
 */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const trendArrow = (t: string) => (t === 'rising' ? '\u25b2' : t === 'fading' ? '\u25bc' : '\u2013');

type Tab = 'know' | 'plan';
const TABS: { id: Tab; label: string; help: string }[] = [
  { id: 'know', label: 'What I know', help: "The picture from your own days \u2014 in numbers, not adjectives. Tell me yes or no on anything and I'll learn from it." },
  { id: 'plan', label: 'Your plan', help: "What you're stuck on and the one move that unblocks it, plus your day-to-day guidance." },
];

export function Lab() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const initialTab: Tab = params.get('tab') === 'plan' ? 'plan' : 'know';
  const [tab, setTabState] = useState<Tab>(initialTab);
  const setTab = (t: Tab) => { setTabState(t); setParams(t === 'know' ? {} : { tab: t }, { replace: true }); };
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const statsReq = useRef(false);
  const [info, setInfo] = useState<FindingView | null>(null);
  const [lastLearn, setLastLearn] = useState<{ at: string; detail: string } | null>(null);
  const [chains, setChains] = useState<MindChain[]>([]);
  const loadRuns = () => mindApi.runs().then((s) => setLastLearn(s.lastLearn ? { at: s.lastLearn.at, detail: s.lastLearn.detail } : null)).catch(() => undefined);
  useEffect(() => { loadRuns(); chainApi.list().then(setChains).catch(() => setChains([])); }, []);

  async function load() {
    try { setFindings(await mindApi.findings()); } catch { setFindings([]); }
  }
  useEffect(() => { load(); }, []);

  // The picture needs the numbers, so stats load with the first screen rather than on a tab click.
  useEffect(() => {
    if (tab === 'know' && !statsReq.current) {
      statsReq.current = true;
      mindApi.stats().then(setStats).catch(() => setStats({ moodSeries: [], dowMood: [], energizers: [], drainers: [], categories: [] }));
    }
  }, [tab]);

  async function runNow() {
    setRunning(true);
    try {
      await mindApi.run();
      toast('success', 'Ran a pass over your recent days');
      await load();
      await loadRuns();
    } catch {
      toast('error', 'Could not run');
    } finally {
      setRunning(false);
    }
  }

  const patch = (id: string, fn: (f: Finding) => Finding | null) =>
    setFindings((fs) => (fs ? (fs.map((f) => (f.id === id ? fn(f) : f)).filter(Boolean) as Finding[]) : fs));
  const pruneStats = (id: string) => setStats((s) => (s ? { ...s, energizers: s.energizers.filter((e) => e.id !== id), drainers: s.drainers.filter((d) => d.id !== id) } : s));
  const onConfirm = (id: string) => { mindApi.confirm(id).catch(() => undefined); patch(id, (f) => ({ ...f, validated: 'confirmed', surfaced: true, confidence: Math.min(0.99, f.confidence + (1 - f.confidence) * 0.35) })); toast('success', "Got it \u2014 I'll trust that more"); };
  const onRefute = (id: string) => { mindApi.refute(id).catch(() => undefined); patch(id, () => null); pruneStats(id); toast('success', "Got it \u2014 I won't think that"); };
  const onPin = (id: string, pinned: boolean) => { mindApi.pin(id, pinned).catch(() => undefined); patch(id, (f) => ({ ...f, pinned, surfaced: pinned || f.surfaced })); };
  const onRemove = (id: string) => { mindApi.remove(id).catch(() => undefined); patch(id, () => null); toast('success', 'Removed'); };
  const onAmend = (id: string, statement: string) => { mindApi.amend(id, { statement }).catch(() => undefined); patch(id, (f) => ({ ...f, statement, validated: 'confirmed', surfaced: true })); };
  const onNote = async (id: string, text: string) => { try { await mindApi.note(id, text); await load(); toast('success', 'Saved \u2014 thanks for telling me'); } catch { toast('error', 'Could not save your note'); } };

  const active = TABS.find((t) => t.id === tab)!;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold flex items-center gap-2">
            <FlaskConical size={22} className="text-violet-500" /> The Lab
          </h1>
          <p className="text-zinc-500 text-sm">What your days say about you.</p>
          {lastLearn && <p className="text-xs text-zinc-400 mt-0.5" title={fmtWhen(lastLearn.at)}>Last learned {fmtRelative(lastLearn.at)} · {lastLearn.detail}</p>}
        </div>
        <button onClick={runNow} disabled={running} className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">
          {running ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Run now
        </button>
      </div>

      <LabRecap onGoSituation={() => setTab('plan')} />

      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={'shrink-0 px-3.5 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' + (tab === t.id ? 'border-violet-500 text-violet-600 dark:text-violet-400' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')}>
            {t.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-zinc-500 leading-relaxed -mt-1">{active.help}</p>

      {tab === 'plan' ? (
        <div className="space-y-8">
          <SituationView />
          <div>
            <h2 className="text-sm font-semibold mb-2">Your daily guidance</h2>
            <Mentor />
          </div>
        </div>
      ) : findings === null ? (
        <div className="flex justify-center py-12 text-zinc-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : (
        <div className="space-y-8">
          <Picture stats={stats} findings={findings} chains={chains} />
          <FindingsFeed findings={findings} onConfirm={onConfirm} onRefute={onRefute} onPin={onPin} onRemove={onRemove} onAmend={onAmend} onOpen={setInfo} />
          <HeatmapsView stats={stats} />
          <div>
            <h2 className="text-sm font-semibold">About you</h2>
            <p className="text-xs text-zinc-500 mb-2">Tell me who you are in your own words. I use it from day one — it shapes what I notice and the guidance you get.</p>
            <AboutMe />
          </div>
        </div>
      )}

      {info && <FindingSheet item={info} onClose={() => setInfo(null)} onConfirm={onConfirm} onRefute={onRefute} onPin={onPin} onNote={onNote} />}
    </div>
  );
}

/**
 * The joined-up picture, in sentences. (BEA-1143)
 *
 * This is the direct answer to "I don't see any dot connecting". Every line is one fact with its
 * own number next to it, and a line only appears when there is real data behind it — no
 * placeholders, no "not enough data yet" filler pretending to be an insight.
 */
function Picture({ stats, findings, chains }: { stats: Stats | null; findings: Finding[]; chains: MindChain[] }) {
  const lines = useMemo(() => {
    const out: { icon: 'up' | 'down' | 'stall' | 'do' | 'lever'; text: string; strong?: string }[] = [];
    const dow = (stats?.dowMood || []).filter((d) => d.avg != null && d.n >= 2);
    if (dow.length >= 2) {
      const best = dow.reduce((a, b) => (b.avg! > a.avg! ? b : a));
      const worst = dow.reduce((a, b) => (b.avg! < a.avg! ? b : a));
      if (best.dow !== worst.dow) {
        out.push({ icon: 'up', text: `${DOW[best.dow]} is your best day \u2014 mood ${best.avg} across ${best.n} of them.` });
        out.push({ icon: 'down', text: `${DOW[worst.dow]} is your worst \u2014 mood ${worst.avg} across ${worst.n}.` });
      }
    }
    const stall = (stats?.categories || []).filter((c) => c.deferred > 0).sort((a, b) => b.deferred - a.deferred)[0];
    if (stall) out.push({ icon: 'stall', text: `You stall most on ${stall.category} \u2014 ${stall.deferred} put off, ${stall.done} finished.` });

    const lever = chains.find((c) => c.status === 'active' && c.lever) || chains.find((c) => !!c.lever);
    if (lever) out.push({ icon: 'lever', text: `To move "${lever.goal}": ${lever.lever}` });

    const withAction = findings.filter((f) => f.surfaced !== false && f.action && f.validated !== 'refuted');
    const top = withAction.sort((a, b) => (b.daysSeen ?? 1) - (a.daysSeen ?? 1))[0];
    if (top?.action) out.push({ icon: 'do', text: top.action, strong: `Seen on ${top.daysSeen ?? 1} day${(top.daysSeen ?? 1) === 1 ? '' : 's'}` });
    return out;
  }, [stats, findings, chains]);

  if (stats === null) {
    return <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-5"><div className="h-4 w-40 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse mb-3" /><div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-3.5 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" style={{ width: `${85 - i * 14}%` }} />)}</div></div>;
  }
  if (!lines.length) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center">
        <FlaskConical size={20} className="mx-auto mb-2 text-violet-500" />
        <p className="text-sm font-medium">Nothing solid to tell you yet.</p>
        <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto">I only speak up once something has been true on three separate days. Keep closing days and telling your story — the picture builds itself.</p>
      </div>
    );
  }
  const ICON = { up: '\u25b2', down: '\u25bc', stall: '\u23f8', lever: '\u2192', do: '\u2713' };
  const TONE = { up: 'text-emerald-600 dark:text-emerald-400', down: 'text-rose-600 dark:text-rose-400', stall: 'text-amber-600 dark:text-amber-400', lever: 'text-violet-600 dark:text-violet-400', do: 'text-violet-600 dark:text-violet-400' };
  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 sm:p-5">
      <h2 className="text-sm font-semibold mb-3">The picture right now</h2>
      <ul className="space-y-2.5">
        {lines.map((l, i) => (
          <li key={i} className={'flex gap-2.5 text-sm leading-snug ' + (l.icon === 'do' ? 'pt-2.5 mt-0.5 border-t border-zinc-100 dark:border-zinc-800' : '')}>
            <span className={'shrink-0 tabular-nums ' + TONE[l.icon]} aria-hidden>{ICON[l.icon]}</span>
            <span className="min-w-0">
              {l.icon === 'do' && <span className="font-semibold text-violet-600 dark:text-violet-400">Do this: </span>}
              {l.text}
              {l.strong && <span className="text-[11px] text-zinc-400 ml-1.5">· {l.strong}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------- About Me: the user's own words, grounds the engine + Mentor (BEA-463) ----------------
const ABOUT_PLACEHOLDER = `Who are you? Write it however you like. A few things that help me:
• What matters most to you right now (work, family, health…)
• What recharges you, and what drains you
• What you tend to avoid or put off
• What a really good day looks like
• Your goals for the next few months`;

function AboutMe() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mindApi.getAbout().then((r) => { setText(r.text); setSaved(r.text); }).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  const dirty = text.trim() !== saved.trim();
  async function save() {
    setBusy(true);
    try {
      const r = await mindApi.setAbout(text);
      setSaved(r.text);
      setText(r.text);
      toast('success', 'Saved — thanks for telling me');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="flex justify-center py-12 text-zinc-400"><Loader2 className="animate-spin" size={20} /></div>;

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => dirty && save()}
        rows={14}
        placeholder={ABOUT_PLACEHOLDER}
        className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-violet-500 resize-y"
      />
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy || !dirty} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 text-white px-4 py-2 text-sm font-medium hover:bg-violet-500 disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : null} {dirty ? 'Save' : 'Saved'}
        </button>
        <span className="text-xs text-zinc-400">Your words are private. I use them to understand you and to ground your findings and daily guidance.</span>
      </div>
    </div>
  );
}

// ---------------- Situation: Goals → Blockers → Levers (BEA-515) ----------------
/** "What the Lab connected" from your last closed day — dismissible per day. (BEA-544) */
function LabRecap({ onGoSituation }: { onGoSituation: () => void }) {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { mindApi.recap().then(setRecap).catch(() => setRecap(null)); }, []);
  if (!recap || !recap.day) return null;
  const total = recap.findings.length + recap.situationsAdded.length + recap.situationsUpdated.length;
  if (total === 0) return null;
  if (localStorage.getItem('lab.recap.dismissed') === recap.day) return null;
  const dismiss = () => { localStorage.setItem('lab.recap.dismissed', recap.day!); setRecap(null); };
  const pretty = (() => { const d = new Date(recap.day + 'T12:00:00'); return Number.isNaN(d.getTime()) ? recap.day : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); })();
  return (
    <section className="rounded-xl border border-violet-300/50 dark:border-violet-500/30 bg-gradient-to-br from-violet-500/5 to-transparent p-3.5">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="text-violet-500 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <button onClick={() => setOpen((o) => !o)} className="text-sm font-medium text-left flex items-center gap-1.5">
            From your {pretty}: I connected{' '}
            {[recap.findings.length && `${recap.findings.length} finding${recap.findings.length === 1 ? '' : 's'}`, recap.situationsAdded.length && `${recap.situationsAdded.length} new situation${recap.situationsAdded.length === 1 ? '' : 's'}`, recap.situationsUpdated.length && `${recap.situationsUpdated.length} updated`].filter(Boolean).join(' · ')}
            <ChevronDown size={14} className={'text-zinc-400 transition-transform ' + (open ? 'rotate-180' : '')} />
          </button>
          {open && (
            <div className="mt-2 space-y-1.5 text-xs text-zinc-600 dark:text-zinc-300">
              {recap.findings.map((f, i) => <div key={'f' + i} className="flex items-start gap-1.5"><span className="text-violet-400">•</span> {f.statement}</div>)}
              {recap.situationsAdded.map((s, i) => <div key={'s' + i} className="flex items-start gap-1.5"><Target size={12} className="text-violet-500 mt-0.5 shrink-0" /> {s.goal}{s.lever ? <span className="text-emerald-600 dark:text-emerald-400"> → {s.lever}</span> : null}</div>)}
              {recap.situationsUpdated.map((s, i) => <div key={'u' + i} className="flex items-start gap-1.5"><Wrench size={12} className="text-amber-500 mt-0.5 shrink-0" /> blocker shifted on “{s.goal}”</div>)}
              <button onClick={onGoSituation} className="text-violet-600 dark:text-violet-400 hover:underline pt-0.5">Open Situation →</button>
            </div>
          )}
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"><X size={15} /></button>
      </div>
    </section>
  );
}

/**
 * The situations list. (BEA-1143)
 *
 * It rendered every chain the Lab had ever inferred, in one unbroken column with no count, no
 * search and no way to put the finished ones away — dozens of cards deep. Live it was a wall.
 * Now it opens on what's still live, says how many there are, and the resolved ones are one tap away.
 */
const PAGE = 8;

function SituationView() {
  const [chains, setChains] = useState<MindChain[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MindChain | null>(null);
  const [tidying, setTidying] = useState(false);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'active' | 'resolved' | 'all'>('active');
  const [limit, setLimit] = useState(PAGE);
  const toast = useToast();
  const load = () => chainApi.list().then(setChains).catch(() => setChains([]));
  useEffect(() => { load(); }, []);
  const onSaved = () => { setAdding(false); setEditing(null); load(); };
  async function tidy() {
    setTidying(true);
    try {
      const r = await chainApi.dedupe();
      toast('success', r.merged ? `Merged ${r.merged} duplicate${r.merged === 1 ? '' : 's'}` : 'No duplicates found');
      load();
    } catch {
      toast('error', 'Could not tidy');
    } finally {
      setTidying(false);
    }
  }

  if (chains === null) return <div className="flex justify-center py-12 text-zinc-400"><Loader2 className="animate-spin" size={20} /></div>;

  const isResolved = (c: MindChain) => c.status === 'resolved';
  const counts = { active: chains.filter((c) => !isResolved(c)).length, resolved: chains.filter(isResolved).length, all: chains.length };
  const filtered = chains
    .filter((c) => (show === 'all' ? true : show === 'resolved' ? isResolved(c) : !isResolved(c)))
    .filter((c) => !q.trim() || `${c.goal} ${c.blocker} ${c.lever} ${c.note || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const visible = filtered.slice(0, limit);

  return (
    <div className="space-y-4">
      {!adding && !editing && (
        <div className="flex items-center gap-2">
          <button onClick={() => setAdding(true)} className="flex-1 rounded-xl border border-dashed border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 px-4 py-3 text-sm font-medium hover:bg-violet-500/5 inline-flex items-center justify-center gap-1.5">
            <Plus size={16} /> Add what's blocking you
          </button>
          {(chains?.length || 0) >= 2 && (
            <button onClick={tidy} disabled={tidying} title="Merge near-duplicate situations" className="shrink-0 rounded-xl border border-zinc-200 dark:border-zinc-800 text-zinc-500 px-3 py-3 text-sm hover:border-violet-400 hover:text-violet-600 disabled:opacity-50">{tidying ? '…' : 'Tidy duplicates'}</button>
          )}
        </div>
      )}
      {(adding || editing) && <ChainForm chain={editing} onSaved={onSaved} onCancel={() => { setAdding(false); setEditing(null); }} />}

      {chains.length === 0 && !adding ? (
        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center text-sm text-zinc-500">
          Nothing here yet. Tell me one thing you're stuck on — your goal, what's blocking it, and the one lever that would unblock it. I'll use it to guide your day.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-800 p-0.5">
              {([['active', 'Still live'], ['resolved', 'Sorted'], ['all', 'All']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => { setShow(k); setLimit(PAGE); }}
                  className={'px-2.5 py-1 text-xs font-medium rounded-md transition-colors ' + (show === k ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}
                >
                  {label} <span className="tabular-nums opacity-70">{counts[k]}</span>
                </button>
              ))}
            </div>
            {chains.length > 4 && (
              <div className="relative flex-1 min-w-[9rem]">
                <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Search what you're stuck on…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 pl-8 pr-3 py-1.5 text-sm outline-none focus:border-violet-500" />
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-zinc-400 py-6 text-center">{q.trim() ? `Nothing matches “${q}”.` : show === 'resolved' ? 'Nothing sorted out yet.' : 'Nothing live right now.'}</p>
          ) : (
            <>
              <div className="space-y-3">{visible.map((c) => <ChainCard key={c.id} c={c} onEdit={() => setEditing(c)} onChange={load} />)}</div>
              {filtered.length > visible.length && (
                <button onClick={() => setLimit((n) => n + PAGE)} className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-2.5 text-sm text-zinc-500 hover:border-violet-400 hover:text-violet-600">
                  Show {Math.min(PAGE, filtered.length - visible.length)} more · {visible.length} of {filtered.length}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ChainCard({ c, onEdit, onChange }: { c: MindChain; onEdit: () => void; onChange: () => void }) {
  const toast = useToast();
  const [del, setDel] = useState(false);
  const resolved = c.status === 'resolved';
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast('success', msg); onChange(); } catch { toast('error', 'Could not save'); } };
  return (
    <div className={'rounded-xl border p-4 ' + (resolved ? 'opacity-60 border-zinc-200 dark:border-zinc-800' : c.shifted ? 'border-amber-400/50 dark:border-amber-500/40 bg-amber-50/40 dark:bg-amber-500/5' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900')}>
      {!resolved && c.shifted && (
        <div className="mb-2.5 text-[12px] text-amber-700 dark:text-amber-300 bg-amber-500/10 rounded-lg px-2.5 py-1.5">
          I think your blocker may have shifted — does this still fit? Tap ✓ to keep it, or edit it.
        </div>
      )}
      <div className="space-y-1.5">
        <div className="flex items-start gap-2"><Target size={15} className="text-violet-500 shrink-0 mt-0.5" /><div className="min-w-0"><div className="text-[10px] uppercase tracking-wide text-zinc-400">Goal{resolved ? ' · resolved ✓' : ''}</div><div className={'text-sm font-semibold ' + (resolved ? 'line-through' : '')}>{c.goal || '—'}</div></div></div>
        <div className="pl-1.5 text-[11px] text-zinc-300 dark:text-zinc-600">↓ blocked by</div>
        <div className="flex items-start gap-2"><Ban size={15} className="text-rose-500 shrink-0 mt-0.5" /><div className="min-w-0"><div className="text-sm">{c.blocker || '—'}</div></div></div>
        <div className="pl-1.5 text-[11px] text-zinc-300 dark:text-zinc-600">↓ the lever</div>
        <div className="flex items-start gap-2"><Wrench size={15} className="text-emerald-500 shrink-0 mt-0.5" /><div className="min-w-0"><div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">{c.lever || '—'}</div></div></div>
        {c.note && <p className="text-xs text-zinc-500 pl-6 pt-0.5">{c.note}</p>}
        {c.provenance && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 pl-6 pt-1 italic flex items-start gap-1"><Sparkles size={11} className="mt-0.5 shrink-0 text-violet-400" />{c.provenance}</p>}
      </div>
      <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800">
        <TrustLadder confidence={c.confidence} validated={c.validated} />
        {c.source === 'engine' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">I noticed this</span>}
        <div className="flex-1" />
        {!resolved && <button title="Yes, that's right" onClick={() => act(() => chainApi.confirm(c.id), 'Confirmed')} className="h-7 w-7 grid place-items-center rounded-lg bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25"><Check size={14} /></button>}
        {!resolved && c.validated !== 'confirmed' && <button title="Not right" onClick={() => act(() => chainApi.refute(c.id), "Got it — I won't suggest that")} className="h-7 w-7 grid place-items-center rounded-lg bg-rose-500/15 text-rose-600 hover:bg-rose-500/25"><X size={14} /></button>}
        <button title="Edit" onClick={onEdit} className="h-7 w-7 grid place-items-center rounded-lg text-zinc-400 hover:text-violet-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil size={13} /></button>
        {!resolved && <button title="Mark resolved" onClick={() => act(() => chainApi.resolve(c.id), 'Resolved ✓')} className="text-[11px] px-2 py-1 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500">Resolved</button>}
        <button title={c.pinned ? 'Unpin' : 'Pin'} onClick={() => act(() => chainApi.pin(c.id, !c.pinned), c.pinned ? 'Unpinned' : 'Pinned')} className={'h-7 w-7 grid place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (c.pinned ? 'text-amber-500' : 'text-zinc-400')}><Pin size={13} className={c.pinned ? 'fill-amber-400' : ''} /></button>
        <button title="Remove" onClick={() => setDel(true)} className="h-7 w-7 grid place-items-center rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-500/10"><Trash2 size={13} /></button>
      </div>
      <ConfirmDialog open={del} title="Remove this?" message="This situation card will be deleted." confirmLabel="Remove" onCancel={() => setDel(false)} onConfirm={() => { chainApi.remove(c.id).then(onChange); setDel(false); }} />
    </div>
  );
}

function ChainField({ label, v, set, ph }: { label: string; v: string; set: (s: string) => void; ph: string }) {
  return (
    <div>
      <label className="text-xs text-zinc-500">{label}</label>
      <input value={v} onChange={(e) => set(e.target.value)} placeholder={ph} className="mt-1 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
    </div>
  );
}

function ChainForm({ chain, onSaved, onCancel }: { chain: MindChain | null; onSaved: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [goal, setGoal] = useState(chain?.goal || '');
  const [blocker, setBlocker] = useState(chain?.blocker || '');
  const [lever, setLever] = useState(chain?.lever || '');
  const [note, setNote] = useState(chain?.note || '');
  const [sentence, setSentence] = useState('');
  const [parsing, setParsing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function parse() {
    if (!sentence.trim()) return;
    setParsing(true);
    try {
      const r = await chainApi.parse(sentence.trim());
      if (r.goal) setGoal(r.goal);
      if (r.blocker) setBlocker(r.blocker);
      if (r.lever) setLever(r.lever);
      toast('success', 'Filled it in — tweak anything, then add it');
    } catch {
      toast('error', 'Could not read that');
    } finally {
      setParsing(false);
    }
  }
  async function save() {
    if (!goal.trim() && !blocker.trim() && !lever.trim()) return;
    setBusy(true);
    try {
      if (chain) {
        await chainApi.update(chain.id, { goal, blocker, lever, note });
      } else {
        const r = await chainApi.create({ goal, blocker, lever, note });
        toast('success', r?.reinforced ? 'You already had a similar one — I strengthened it instead of adding a duplicate' : 'Added');
      }
      onSaved();
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-violet-300/50 dark:border-violet-700/50 bg-violet-500/5 p-4 space-y-3">
      {!chain && (
        <div>
          <label className="text-xs text-zinc-500">Say it in your own words</label>
          <div className="flex gap-2 mt-1">
            <input value={sentence} onChange={(e) => setSentence(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && parse()} placeholder="e.g. I can't do Beakn tasks until production is sorted" className="flex-1 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-violet-500" />
            <button onClick={parse} disabled={parsing || !sentence.trim()} className="shrink-0 rounded-lg bg-violet-600 text-white px-3 py-2 text-sm font-medium hover:bg-violet-500 disabled:opacity-50 inline-flex items-center gap-1.5">{parsing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Turn into a chain</button>
          </div>
          <div className="text-[11px] text-zinc-400 mt-1.5">…or fill it in yourself below.</div>
        </div>
      )}
      <ChainField label="🎯 Goal — what you're trying to achieve" v={goal} set={setGoal} ph="Get Beakn products out" />
      <ChainField label="⛔ Blocked by — what's stopping it" v={blocker} set={setBlocker} ph="Production isn't aligned" />
      <ChainField label="🔧 Lever — the next action that unblocks it" v={lever} set={setLever} ph="When I get to my desk, I'll call the production lead" />
      <ChainField label="Note (optional)" v={note} set={setNote} ph="Any context…" />
      <div className="flex gap-2">
        <button onClick={save} disabled={busy} className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">{chain ? 'Save changes' : 'Add it'}</button>
        <button onClick={onCancel} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm">Cancel</button>
      </div>
    </div>
  );
}

// ---------------- What I know ----------------
/**
 * Findings, split by whether the Lab actually believes them yet. (BEA-1143)
 *
 * Before, everything sat in one list sorted by an internal "status" word — established / emerging /
 * proposed / fading — which is the machine's vocabulary, not his. A guess from one Tuesday looked
 * exactly like something backed by 44 days. Now the believed ones are the page, and the rest sit
 * behind one honest line: "I'm watching N more."
 *
 * Yes/no lives on the card itself. The separate Review tab is gone: judging a finding is the same
 * act as reading it, and making it a different screen is why he never knew what Review was for.
 */
function FindingsFeed({ findings, onConfirm, onRefute, onPin, onRemove, onAmend, onOpen }: { findings: Finding[]; onConfirm: (id: string) => void; onRefute: (id: string) => void; onPin: (id: string, p: boolean) => void; onRemove: (id: string) => void; onAmend: (id: string, s: string) => void; onOpen: (v: FindingView) => void }) {
  const [q, setQ] = useState('');
  const [showWatching, setShowWatching] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDel, setConfirmDel] = useState<Finding | null>(null);

  const believed = findings.filter((f) => f.surfaced !== false);
  const watching = findings.filter((f) => f.surfaced === false);
  const match = (f: Finding) => !q.trim() || `${f.statement} ${f.action || ''} ${f.subject} ${f.object}`.toLowerCase().includes(q.toLowerCase());
  const shown = believed.filter(match).sort((a, b) => (b.daysSeen ?? 1) - (a.daysSeen ?? 1));
  const shownWatching = watching.filter(match);

  const card = (f: Finding, quiet = false) => (
    <div key={f.id} className={'rounded-xl border p-3.5 ' + (quiet ? 'border-zinc-200/70 dark:border-zinc-800/70 bg-zinc-50 dark:bg-zinc-900/40' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900')}>
      {editing === f.id ? (
        <div className="space-y-2">
          <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full text-sm rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:border-violet-500" />
          <div className="flex gap-2">
            <button onClick={() => { onAmend(f.id, draft.trim() || f.statement); setEditing(null); }} className="rounded-lg bg-violet-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-violet-500">Save</button>
            <button onClick={() => setEditing(null)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <button onClick={() => onOpen(f)} className="text-left w-full">
            <p className={'text-sm font-medium leading-snug ' + valenceClass(f.valence)}>{f.statement}</p>
            {f.action && <p className="mt-1.5 text-sm text-violet-600 dark:text-violet-400 leading-snug"><span className="font-semibold">Do this: </span>{f.action}</p>}
          </button>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span className="text-[11px] text-zinc-400 tabular-nums">
              Seen on {f.daysSeen ?? 1} day{(f.daysSeen ?? 1) === 1 ? '' : 's'} {trendArrow(f.trend)}
            </span>
            {!quiet && f.validated !== 'confirmed' && <TrustLadder confidence={f.confidence} validated={f.validated} />}
            {f.pinned && <Pin size={11} className="text-amber-500 fill-amber-400" />}
            <div className="flex-1" />
            {f.validated === 'confirmed' ? (
              <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><Check size={12} /> You said yes</span>
            ) : (
              <div className="flex items-center gap-1.5">
                <button onClick={() => onConfirm(f.id)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-2.5 py-1 text-xs font-medium hover:bg-emerald-500/25"><Check size={13} /> Yes</button>
                <button onClick={() => onRefute(f.id)} className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-400 px-2.5 py-1 text-xs font-medium hover:bg-rose-500/25"><X size={13} /> No</button>
              </div>
            )}
            <button title="Almost — fix the wording" onClick={() => { setEditing(f.id); setDraft(f.statement); }} className="grid place-items-center h-7 w-7 rounded-lg text-zinc-400 hover:text-violet-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil size={13} /></button>
            <button title={f.pinned ? 'Unpin' : 'Pin \u2014 keep this forever'} onClick={() => onPin(f.id, !f.pinned)} className={'grid place-items-center h-7 w-7 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (f.pinned ? 'text-amber-500' : 'text-zinc-400 hover:text-amber-500')}><Pin size={13} className={f.pinned ? 'fill-amber-400' : ''} /></button>
            <button title="Remove" onClick={() => setConfirmDel(f)} className="grid place-items-center h-7 w-7 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-500/10"><Trash2 size={13} /></button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">What I’m sure about <span className="text-zinc-400 font-normal tabular-nums">· {believed.length}</span></h2>
        {findings.length > 4 && (
          <div className="relative w-full sm:w-56">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 pl-8 pr-3 py-1.5 text-sm outline-none focus:border-violet-500" />
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        q.trim() ? (
          <p className="text-sm text-zinc-400 py-4">Nothing matches “{q}”.</p>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            Nothing has held up on three separate days yet. {watching.length > 0 ? `I\u2019m watching ${watching.length} idea${watching.length === 1 ? '' : 's'} below.` : 'Close a few more days and I\u2019ll start.'}
          </div>
        )
      ) : (
        <div className="space-y-2">{shown.map((f) => card(f))}</div>
      )}

      {watching.length > 0 && (
        <div className="pt-1">
          <button onClick={() => setShowWatching((v) => !v)} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            <Eye size={14} /> I’m watching {watching.length} more — not sure enough to say yet
            <ChevronDown size={14} className={'transition-transform ' + (showWatching ? 'rotate-180' : '')} />
          </button>
          {showWatching && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-zinc-400">These turned up on one or two days only. I need three before I’ll claim them — but you can settle it now.</p>
              {shownWatching.map((f) => card(f, true))}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog open={!!confirmDel} title="Remove this?" message="This finding will be deleted, along with what I learned from it." confirmLabel="Remove" onCancel={() => setConfirmDel(null)} onConfirm={() => { if (confirmDel) onRemove(confirmDel.id); setConfirmDel(null); }} />
    </section>
  );
}

// ---------------- Your week, in numbers ----------------
function moodCell(avg: number | null): string {
  if (avg == null) return 'rgba(113,113,122,0.14)';
  return avg < 50 ? `rgba(244,63,94,${(0.2 + ((50 - avg) / 50) * 0.45).toFixed(2)})` : `rgba(52,211,153,${(0.2 + ((avg - 50) / 50) * 0.45).toFixed(2)})`;
}

/**
 * The two charts the owner said were useful but unreadable. (BEA-1143)
 *
 * The fix isn't a prettier chart, it's a sentence. Each one now states its own conclusion above the
 * squares — "Wednesday lifts you most" — so the chart becomes the proof rather than the puzzle.
 * A grey square used to mean "no data", which read as a bad mood; it now says so.
 */
function HeatmapsView({ stats }: { stats: Stats | null }) {
  if (stats === null) {
    return <div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-40 rounded-2xl bg-zinc-100 dark:bg-zinc-800 animate-pulse" />)}</div>;
  }
  const dow = stats.dowMood.filter((d) => d.avg != null && d.n >= 2);
  const best = dow.length ? dow.reduce((a, b) => (b.avg! > a.avg! ? b : a)) : null;
  const worst = dow.length ? dow.reduce((a, b) => (b.avg! < a.avg! ? b : a)) : null;
  const cats = [...stats.categories].filter((c) => c.deferred + c.done > 0).sort((a, b) => b.deferred - a.deferred).slice(0, 6);
  const stall = cats[0];
  if (!dow.length && !cats.length) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {dow.length > 0 && (
        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h3 className="text-sm font-semibold">How your week feels</h3>
          <p className="text-xs text-zinc-500 mt-0.5 mb-3 leading-snug">
            {best && worst && best.dow !== worst.dow
              ? <>{DOW[best.dow]} lifts you most (<span className="tabular-nums">{best.avg}</span>). {DOW[worst.dow]} weighs on you (<span className="tabular-nums">{worst.avg}</span>). Out of 100.</>
              : <>Your average mood by weekday, out of 100.</>}
          </p>
          <div className="grid grid-cols-7 gap-1.5">
            {stats.dowMood.map((d) => (
              <div key={d.dow} className="text-center">
                <div
                  title={d.avg == null ? 'No days logged yet' : `${d.avg} out of 100, from ${d.n} ${DOW[d.dow]}${d.n === 1 ? '' : 's'}`}
                  className="rounded-lg h-11 grid place-items-center text-sm font-semibold tabular-nums"
                  style={{ background: moodCell(d.avg) }}
                >
                  {d.avg ?? <span className="text-[10px] font-normal text-zinc-400">–</span>}
                </div>
                <div className="text-[10px] text-zinc-400 mt-1">{DOW[d.dow]}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">Grey means no days logged for that weekday yet.</p>
        </section>
      )}

      {cats.length > 0 && (
        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h3 className="text-sm font-semibold">Where you get stuck</h3>
          <p className="text-xs text-zinc-500 mt-0.5 mb-3 leading-snug">
            {stall ? <>You put off <b>{stall.category}</b> more than anything else — {stall.deferred} pushed back against {stall.done} finished.</> : <>How often you push a kind of task back instead of finishing it.</>}
          </p>
          <div className="space-y-2.5">
            {cats.map((c) => (
              <div key={c.category}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-sm font-medium truncate">{c.category}</span>
                  <span className="text-[11px] text-zinc-400 shrink-0 tabular-nums">{c.deferred} put off · {c.done} done</span>
                </div>
                <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(3, c.avoidance)}%`, background: `rgba(244,63,94,${(0.35 + (c.avoidance / 100) * 0.5).toFixed(2)})` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-zinc-400 mt-2.5">Longer bar = you push it back more often than you finish it.</p>
        </section>
      )}
    </div>
  );
}
