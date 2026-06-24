import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, RefreshCw, Loader2, Check, X, Pencil, Pin, Trash2, ChevronDown, Search } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useSearchParams } from 'react-router-dom';
import { MindReview } from '../mind/MindReview';
import { Mentor } from './Mentor';
import { FindingSheet, type FindingView } from '../mind/FindingSheet';
import { mindApi, valenceClass, sureWord, trustRung, fmtRelative, fmtWhen, type Finding, type Stats } from '../mind/client';
import { TrustLadder } from '../mind/TrustLadder';

// One-line plain-English explainer shown under each tab. (BEA-462)
const TAB_HELP: Record<Tab, string> = {
  map: 'A map of what affects you. Dots are things and people; lines are patterns. Green lifts you, red drains you. "You" is in the middle — tap a dot to read it.',
  mood: 'How you feel over time, and what gives you energy vs. what takes it. Tap any bar to read the full thing.',
  heatmaps: 'Your week at a glance — which days lift you, and which kinds of tasks you keep putting off.',
  findings: "Things My Brain has noticed about you from your days. A guess, not a fact — until you say. Tap one to read it and tell me if it's right.",
  review: "Is this really you? Tap ✓ if it's true (I'll trust it more), or ✗ if it's wrong (I'll drop it).",
  about: 'Tell me who you are in your own words. I use this to understand you from day one — it shapes what I notice and the guidance you get.',
  mentor: 'Your day-to-day guidance, grounded in what the Lab knows about you — focus areas plus how each day went.',
};

const YOU = '__you__';
const isYou = (s: string) => /^(you|me|i|myself)$/i.test(s.trim());
const edgeColor = (v: string) => (v === 'energizing' ? '#34d399' : v === 'draining' ? '#f43f5e' : '#71717a');
const trendArrow = (t: string) => (t === 'rising' ? '▲' : t === 'fading' ? '▼' : '–');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Tab = 'map' | 'mood' | 'heatmaps' | 'findings' | 'review' | 'about' | 'mentor';
const TABS: Tab[] = ['map', 'mood', 'heatmaps', 'findings', 'review', 'about', 'mentor'];

export function Lab() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const initialTab = (TABS as string[]).includes(params.get('tab') || '') ? (params.get('tab') as Tab) : 'map';
  const [tab, setTabState] = useState<Tab>(initialTab);
  const setTab = (t: Tab) => { setTabState(t); setParams(t === 'map' ? {} : { tab: t }, { replace: true }); };
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null); // null = not loaded yet
  const statsReq = useRef(false);
  const [info, setInfo] = useState<FindingView | null>(null); // tap-to-read popup (BEA-462)
  const [lastLearn, setLastLearn] = useState<{ at: string; detail: string } | null>(null); // run-log (BEA-468)
  const loadRuns = () => mindApi.runs().then((s) => setLastLearn(s.lastLearn ? { at: s.lastLearn.at, detail: s.lastLearn.detail } : null)).catch(() => undefined);
  useEffect(() => { loadRuns(); }, []);

  async function load() {
    try {
      setFindings(await mindApi.findings());
    } catch {
      setFindings([]);
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Lazy-load analytics the first time the Mood/Heatmaps tab is opened.
  useEffect(() => {
    if ((tab === 'mood' || tab === 'heatmaps') && !statsReq.current) {
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

  // Optimistic local mutations shared by Map + Findings.
  const patch = (id: string, fn: (f: Finding) => Finding | null) =>
    setFindings((fs) => (fs ? (fs.map((f) => (f.id === id ? fn(f) : f)).filter(Boolean) as Finding[]) : fs));
  // Drop a refuted finding from the Mood "movers" too, so it disappears everywhere at once.
  const pruneStats = (id: string) => setStats((s) => (s ? { ...s, energizers: s.energizers.filter((e) => e.id !== id), drainers: s.drainers.filter((d) => d.id !== id) } : s));
  const onConfirm = (id: string) => { mindApi.confirm(id).catch(() => undefined); patch(id, (f) => ({ ...f, validated: 'confirmed', confidence: Math.min(0.99, f.confidence + (1 - f.confidence) * 0.35) })); toast('success', 'Confirmed'); };
  const onRefute = (id: string) => { mindApi.refute(id).catch(() => undefined); patch(id, () => null); pruneStats(id); toast('success', "Got it — I won't think that"); };
  const onPin = (id: string, pinned: boolean) => { mindApi.pin(id, pinned).catch(() => undefined); patch(id, (f) => ({ ...f, pinned })); };
  const onRemove = (id: string) => { mindApi.remove(id).catch(() => undefined); patch(id, () => null); toast('success', 'Removed'); };
  const onAmend = (id: string, statement: string) => { mindApi.amend(id, { statement }).catch(() => undefined); patch(id, (f) => ({ ...f, statement, validated: 'confirmed' })); };
  const onNote = async (id: string, text: string) => { try { await mindApi.note(id, text); await load(); toast('success', 'Saved — thanks for telling me'); } catch { toast('error', 'Could not save your note'); } };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2">
            <FlaskConical size={22} className="text-violet-500" /> The Lab
          </h1>
          <p className="text-zinc-500 text-sm">The science of you — what your brain has learned from your days.</p>
          {lastLearn && <p className="text-xs text-zinc-400 mt-0.5" title={fmtWhen(lastLearn.at)}>Last learned {fmtRelative(lastLearn.at)} · {lastLearn.detail}</p>}
        </div>
        {tab !== 'about' && tab !== 'mentor' && (
          <button onClick={runNow} disabled={running} className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">
            {running ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Run now
          </button>
        )}
      </div>

      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={'shrink-0 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ' + (tab === t ? 'border-violet-500 text-violet-600 dark:text-violet-400' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')}>
            {t === 'about' ? 'About Me' : t}
          </button>
        ))}
      </div>

      <p className="text-xs text-zinc-500 leading-relaxed -mt-1">{TAB_HELP[tab]}</p>

      {tab === 'review' ? (
        <MindReview />
      ) : tab === 'mentor' ? (
        <Mentor />
      ) : tab === 'about' ? (
        <AboutMe />
      ) : tab === 'mood' ? (
        <MoodView stats={stats} onOpen={setInfo} />
      ) : tab === 'heatmaps' ? (
        <HeatmapsView stats={stats} />
      ) : findings === null ? (
        <div className="flex justify-center py-12 text-zinc-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : tab === 'map' ? (
        <MindGraph findings={findings} onConfirm={onConfirm} onRefute={onRefute} onPin={onPin} onOpen={setInfo} />
      ) : (
        <FindingsFeed findings={findings} onConfirm={onConfirm} onRefute={onRefute} onPin={onPin} onRemove={onRemove} onAmend={onAmend} onOpen={setInfo} />
      )}

      {info && <FindingSheet item={info} onClose={() => setInfo(null)} onConfirm={onConfirm} onRefute={onRefute} onPin={onPin} onNote={onNote} />}
    </div>
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

// ---------------- Map: Obsidian-style force graph ----------------
type GNode = { id: string; label: string; x: number; y: number; vx: number; vy: number; deg: number; fixed: boolean; fx: number | null; fy: number | null };
type GEdge = { from: string; to: string; f: Finding };

// One physics step: charge repulsion + edge springs (rest ~110) + centering, with velocity damping. Mutates nodes.
function stepSim(nodes: GNode[], edges: GEdge[], W: number, H: number, alpha = 1) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const d2 = dx * dx + dy * dy || 0.01;
      const d = Math.sqrt(d2);
      const force = ((9000 / d2) * alpha);
      dx /= d;
      dy /= d;
      a.vx += dx * force; a.vy += dy * force;
      b.vx -= dx * force; b.vy -= dy * force;
    }
  }
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const k = (d - 110) * 0.05 * alpha;
    dx = (dx / d) * k; dy = (dy / d) * k;
    a.vx += dx; a.vy += dy;
    b.vx -= dx; b.vy -= dy;
  }
  for (const n of nodes) {
    if (n.fixed) { n.x = W / 2; n.y = H / 2; n.vx = 0; n.vy = 0; continue; }
    if (n.fx != null && n.fy != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue; }
    n.vx += (W / 2 - n.x) * 0.005 * alpha;
    n.vy += (H / 2 - n.y) * 0.005 * alpha;
    n.vx *= 0.85; n.vy *= 0.85;
    n.x += n.vx; n.y += n.vy;
    n.x = Math.max(24, Math.min(W - 24, n.x));
    n.y = Math.max(24, Math.min(H - 24, n.y));
  }
}

function MindGraph({ findings, onConfirm, onRefute, onPin, onOpen }: { findings: Finding[]; onConfirm: (id: string) => void; onRefute: (id: string) => void; onPin: (id: string, p: boolean) => void; onOpen: (v: FindingView) => void }) {
  const W = 720;
  const H = 520;
  const svgRef = useRef<SVGSVGElement>(null);
  const reduce = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => (t + 1) % 1000000);

  // Graph topology (nodes meta + edges + adjacency) — rebuilt only when findings change.
  const { metaList, edges, adj } = useMemo(() => {
    const top = [...findings].sort((a, b) => b.confidence - a.confidence).slice(0, 40);
    const meta = new Map<string, { id: string; label: string; deg: number }>();
    meta.set(YOU, { id: YOU, label: 'You', deg: 0 });
    const edges: GEdge[] = [];
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    const keyOf = (s: string) => (isYou(s) ? YOU : s.trim().toLowerCase());
    for (const f of top) {
      const sk = keyOf(f.subject);
      const ok = keyOf(f.object);
      for (const [k, lbl] of [[sk, f.subject], [ok, f.object]] as const) {
        if (k === YOU) continue;
        if (!meta.has(k)) meta.set(k, { id: k, label: lbl, deg: 0 });
      }
      if (sk !== ok) {
        edges.push({ from: sk, to: ok, f });
        meta.get(sk)!.deg++;
        meta.get(ok)!.deg++;
        link(sk, ok);
        link(ok, sk);
      }
    }
    return { metaList: [...meta.values()], edges, adj };
  }, [findings]);

  const nodesRef = useRef<GNode[]>([]);
  const alphaRef = useRef(1);
  const runningRef = useRef(false);
  const reheatRef = useRef<() => void>(() => {});
  const reheat = () => reheatRef.current();

  // Rebuild node bodies (keeping positions for ids that survive), then run a continuous, cooling simulation.
  useEffect(() => {
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    nodesRef.current = metaList.map((m, i) => {
      const p = prev.get(m.id);
      const fixed = m.id === YOU;
      // Index-based seeding (no Math.random — keeps it deterministic and sandbox-safe).
      const seedX = W / 2 + Math.cos(i * 1.7) * (60 + (i % 7) * 16);
      const seedY = H / 2 + Math.sin(i * 2.3) * (60 + (i % 5) * 18);
      return {
        id: m.id,
        label: m.label,
        deg: m.deg,
        fixed,
        x: fixed ? W / 2 : p ? p.x : seedX,
        y: fixed ? H / 2 : p ? p.y : seedY,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      };
    });

    if (!nodesRef.current.length) { bump(); return; }

    if (reduce.current) {
      for (let i = 0; i < 300; i++) stepSim(nodesRef.current, edges, W, H, 1);
      reheatRef.current = () => {};
      bump();
      return;
    }

    let raf = 0;
    const loop = () => {
      const a = alphaRef.current;
      stepSim(nodesRef.current, edges, W, H, a);
      alphaRef.current = a * 0.98;
      bump();
      if (alphaRef.current > 0.005) {
        raf = requestAnimationFrame(loop);
      } else {
        runningRef.current = false;
        raf = 0;
      }
    };
    const start = () => {
      if (!runningRef.current) {
        runningRef.current = true;
        raf = requestAnimationFrame(loop);
      }
    };
    reheatRef.current = () => {
      alphaRef.current = Math.max(alphaRef.current, 0.6);
      start();
    };
    alphaRef.current = 0.9;
    start();
    return () => {
      runningRef.current = false;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [metaList, edges]);

  // Screen → graph-space coordinate conversion (undoes the SVG CTM and our pan/zoom <g> transform).
  const toGraph = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const loc = pt.matrixTransform(ctm.inverse());
    const v = viewRef.current;
    return { x: (loc.x - v.tx) / v.k, y: (loc.y - v.ty) / v.k };
  };

  // Pointer drag / pan tracking.
  const drag = useRef<{ id: string | null; pan: boolean; moved: boolean; sx: number; sy: number; startTx: number; startTy: number } | null>(null);

  const onNodeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id, pan: false, moved: false, sx: e.clientX, sy: e.clientY, startTx: 0, startTy: 0 };
  };
  const onBgDown = (e: React.PointerEvent) => {
    const v = viewRef.current;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id: null, pan: true, moved: false, sx: e.clientX, sy: e.clientY, startTx: v.tx, startTy: v.ty };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
    if (d.pan) {
      const rect = svgRef.current?.getBoundingClientRect();
      const sx = rect ? W / rect.width : 1;
      const sy = rect ? H / rect.height : 1;
      setView((vw) => ({ ...vw, tx: d.startTx + (e.clientX - d.sx) * sx, ty: d.startTy + (e.clientY - d.sy) * sy }));
    } else if (d.id) {
      const g = toGraph(e.clientX, e.clientY);
      const n = g && nodesRef.current.find((nn) => nn.id === d.id);
      if (g && n && !n.fixed) {
        n.fx = g.x;
        n.fy = g.y;
        reheat();
      }
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.id && !d.pan) {
      const n = nodesRef.current.find((nn) => nn.id === d.id);
      if (n) { n.fx = null; n.fy = null; }
      if (!d.moved) setSel((s) => (s === d.id ? null : d.id)); // a tap (not a drag) selects
      reheat();
    } else if (d.pan && !d.moved) {
      setSel(null); // tap on empty canvas clears selection
    }
  };

  // Wheel zoom toward the cursor — native non-passive listener so preventDefault works.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const g = toGraph(e.clientX, e.clientY);
      const k = Math.max(0.4, Math.min(3, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      if (g) {
        const locX = g.x * v.k + v.tx;
        const locY = g.y * v.k + v.ty;
        setView({ k, tx: locX - k * g.x, ty: locY - k * g.y });
      } else {
        setView((vw) => ({ ...vw, k }));
      }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  if (!findings.length) return <Empty />;

  const nodes = nodesRef.current;
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const active = hover ?? sel;
  const neigh = active ? adj.get(active) : undefined;
  const nodeLit = (id: string) => !active || id === active || (neigh?.has(id) ?? false);
  const edgeLit = (e: GEdge) => !active || e.from === active || e.to === active;
  const showLabel = (n: GNode) => n.id === YOU || (!!active && nodeLit(n.id)) || view.k > 1.4 || n.deg >= 2;

  const selFindings = sel ? edges.filter((e) => e.from === sel || e.to === sel).map((e) => e.f) : [];
  const selLabel = nodes.find((n) => n.id === sel)?.label;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full select-none"
          style={{ touchAction: 'none', cursor: drag.current?.pan ? 'grabbing' : 'grab' }}
          onPointerDown={onBgDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
            {edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={edgeColor(e.f.valence)} strokeWidth={1 + e.f.confidence * 4} strokeOpacity={(edgeLit(e) ? 0.55 : 0.12) * (e.f.status === 'fading' ? 0.5 : 1)} />;
            })}
            {nodes.map((nd) => {
              const r = nd.id === YOU ? 16 : 6 + Math.min(10, nd.deg * 2);
              const lit = nodeLit(nd.id);
              return (
                <g key={nd.id} opacity={lit ? 1 : 0.16} style={{ cursor: 'pointer' }} onPointerDown={(ev) => onNodeDown(ev, nd.id)} onPointerEnter={() => setHover(nd.id)} onPointerLeave={() => setHover((h) => (h === nd.id ? null : h))}>
                  <circle cx={nd.x} cy={nd.y} r={r} fill={nd.id === YOU ? '#8b5cf6' : sel === nd.id ? '#34d399' : '#3f3f46'} stroke={sel === nd.id ? '#34d399' : 'transparent'} strokeWidth={2} />
                  {showLabel(nd) && (
                    <text x={nd.x} y={nd.y + r + 11} textAnchor="middle" className="fill-zinc-500 dark:fill-zinc-400" style={{ fontSize: 10, pointerEvents: 'none' }}>
                      {nd.label.length > 18 ? nd.label.slice(0, 17) + '…' : nd.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="flex items-center gap-3 px-3 py-2 border-t border-zinc-100 dark:border-zinc-800 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-full" style={{ background: '#34d399' }} /> energizing</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-full" style={{ background: '#f43f5e' }} /> draining</span>
          <button onClick={() => setView({ k: 1, tx: 0, ty: 0 })} className="ml-2 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">Reset view</button>
          <span className="ml-auto">{nodes.length - 1} things · {edges.length} links</span>
        </div>
        <div className="px-3 pb-2 text-[10px] text-zinc-400">drag a node · scroll to zoom · drag the canvas to pan</div>
      </div>

      {sel && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">{selLabel}</div>
          <div className="space-y-2">
            {selFindings.map((f) => (
              <div key={f.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex items-center gap-2">
                <button onClick={() => onOpen(f)} className="flex-1 text-left min-w-0"><span className={'text-sm font-medium ' + valenceClass(f.valence)}>{f.statement}</span> <span className="text-[10px] text-zinc-400 tabular-nums">· {trustRung(f.confidence, f.validated).label} · {f.evidenceCount}× {trendArrow(f.trend)}</span></button>
                <button title="Yes" onClick={() => onConfirm(f.id)} className="grid place-items-center h-7 w-7 rounded-lg bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25"><Check size={14} /></button>
                <button title="No" onClick={() => onRefute(f.id)} className="grid place-items-center h-7 w-7 rounded-lg bg-rose-500/15 text-rose-600 hover:bg-rose-500/25"><X size={14} /></button>
                <button title="Pin" onClick={() => onPin(f.id, !f.pinned)} className={'grid place-items-center h-7 w-7 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (f.pinned ? 'text-amber-500' : 'text-zinc-400')}><Pin size={13} className={f.pinned ? 'fill-amber-400' : ''} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Findings feed ----------------
function FindingsFeed({ findings, onConfirm, onRefute, onPin, onRemove, onAmend, onOpen }: { findings: Finding[]; onConfirm: (id: string) => void; onRefute: (id: string) => void; onPin: (id: string, p: boolean) => void; onRemove: (id: string) => void; onAmend: (id: string, s: string) => void; onOpen: (v: FindingView) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDel, setConfirmDel] = useState<Finding | null>(null);

  const filtered = findings.filter((f) => !q.trim() || `${f.statement} ${f.subject} ${f.object}`.toLowerCase().includes(q.toLowerCase()));
  const order = ['established', 'emerging', 'proposed', 'fading'];
  const groups = order.map((st) => ({ st, items: filtered.filter((f) => f.status === st) })).filter((g) => g.items.length);
  const label: Record<string, string> = { established: 'Established', emerging: 'Emerging', proposed: 'Emerging', fading: 'Fading' };

  if (!findings.length) return <Empty />;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what I've learned…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 pl-9 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
      </div>
      {groups.map((g) => (
        <div key={g.st}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">{label[g.st]} · {g.items.length}</div>
          <div className="space-y-2">
            {g.items.map((f) => (
              <div key={f.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    {editing === f.id ? (
                      <textarea autoFocus rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full text-sm rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:border-emerald-500" />
                    ) : (
                      <button onClick={() => onOpen(f)} className="text-left w-full">
                        <p className="text-sm leading-snug"><span className={'font-medium ' + valenceClass(f.valence)}>{f.statement}</span></p>
                      </button>
                    )}
                    <div className="text-[10px] text-zinc-400 tabular-nums mt-1 flex items-center gap-2">
                      <TrustLadder confidence={f.confidence} validated={f.validated} />
                      <span>{f.evidenceCount}× {trendArrow(f.trend)}</span>
                      {f.cadence && <span className="px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800">{f.cadence}</span>}
                      {f.pinned && <Pin size={10} className="text-amber-500 fill-amber-400" />}
                    </div>
                  </div>
                  <button onClick={() => setOpen(open === f.id ? null : f.id)} title="More" className="shrink-0 mt-0.5 text-zinc-400"><ChevronDown size={15} className={'transition-transform ' + (open === f.id ? 'rotate-180' : '')} /></button>
                </div>
                {open === f.id && (
                  <div className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    {(f.evidence ?? []).length > 0 ? (
                      <ul className="space-y-1 mb-2">
                        {f.evidence!.map((e) => (
                          <li key={e.id} className="text-xs text-zinc-500 flex gap-1.5"><span className="text-[9px] uppercase tracking-wide text-zinc-400 shrink-0 mt-0.5">{e.signal}</span><span className="min-w-0">{e.snippet || '—'}</span></li>
                        ))}
                      </ul>
                    ) : <p className="text-xs text-zinc-400 mb-2">No stored evidence snippets.</p>}
                    <div className="flex items-center gap-1.5">
                      {editing === f.id ? (
                        <>
                          <button onClick={() => { onAmend(f.id, draft.trim() || f.statement); setEditing(null); }} className="rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-xs hover:bg-emerald-500">Save</button>
                          <button onClick={() => setEditing(null)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button title="Yes" onClick={() => onConfirm(f.id)} className="grid place-items-center h-7 w-7 rounded-lg bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25"><Check size={14} /></button>
                          <button title="No" onClick={() => onRefute(f.id)} className="grid place-items-center h-7 w-7 rounded-lg bg-rose-500/15 text-rose-600 hover:bg-rose-500/25"><X size={14} /></button>
                          <button title="Almost — fix it" onClick={() => { setEditing(f.id); setDraft(f.statement); }} className="grid place-items-center h-7 w-7 rounded-lg text-zinc-400 hover:text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil size={13} /></button>
                          <button title={f.pinned ? 'Unpin' : 'Pin'} onClick={() => onPin(f.id, !f.pinned)} className={'grid place-items-center h-7 w-7 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (f.pinned ? 'text-amber-500' : 'text-zinc-400 hover:text-amber-500')}><Pin size={13} className={f.pinned ? 'fill-amber-400' : ''} /></button>
                          <button title="Remove" onClick={() => setConfirmDel(f)} className="grid place-items-center h-7 w-7 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-500/10"><Trash2 size={13} /></button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {groups.length === 0 && <p className="text-sm text-zinc-400 text-center py-6">Nothing matches “{q}”.</p>}
      <ConfirmDialog open={!!confirmDel} title="Remove this?" message="This finding will be deleted from your mind graph." confirmLabel="Remove" onCancel={() => setConfirmDel(null)} onConfirm={() => { if (confirmDel) onRemove(confirmDel.id); setConfirmDel(null); }} />
    </div>
  );
}

function Empty() {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center text-sm text-zinc-500">
      <FlaskConical size={22} className="mx-auto mb-2 text-violet-500" />
      The Lab is still warming up. As you log tasks and tell your nightly story, your brain learns patterns about you — they'll appear here. Tap <b>Run now</b> to reflect on your recent days.
    </div>
  );
}

// ---------------- Mood: trend sparkline + what-moves-your-mood ----------------
function MoodView({ stats, onOpen }: { stats: Stats | null; onOpen: (v: FindingView) => void }) {
  if (!stats) return <div className="flex justify-center py-12 text-zinc-400"><Loader2 className="animate-spin" size={20} /></div>;
  const noData = stats.moodSeries.length === 0 && stats.energizers.length === 0 && stats.drainers.length === 0;
  if (noData) return <Empty />;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Mood over time</h3>
          {stats.moodSeries.length > 0 && (
            <span className="text-xs text-zinc-400 tabular-nums">latest {stats.moodSeries[stats.moodSeries.length - 1].mood}/100 · last {stats.moodSeries.length} days</span>
          )}
        </div>
        <Sparkline data={stats.moodSeries} />
      </section>
      <section>
        <h3 className="text-sm font-semibold mb-1">What moves your mood</h3>
        <p className="text-xs text-zinc-400 mb-3">From the patterns you've confirmed. Tap any one to read it in full.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Movers title="Energizes you" items={stats.energizers} tone="emerald" onOpen={onOpen} />
          <Movers title="Drains you" items={stats.drainers} tone="rose" onOpen={onOpen} />
        </div>
      </section>
    </div>
  );
}

function Sparkline({ data }: { data: { day: string; mood: number }[] }) {
  if (data.length < 2) return <p className="text-sm text-zinc-400 py-6 text-center">Not enough mood data yet — tell a few more nightly stories and your trend will appear.</p>;
  const W = 600, H = 120, pad = 10;
  const xs = data.map((_, i) => pad + (i / (data.length - 1)) * (W - 2 * pad));
  const ys = data.map((d) => H - pad - (Math.max(0, Math.min(100, d.mood)) / 100) * (H - 2 * pad));
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const area = `${line} L${xs[xs.length - 1].toFixed(1)},${H - pad} L${xs[0].toFixed(1)},${H - pad} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: 120 }}>
      <defs>
        <linearGradient id="moodgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={pad} y1={H - pad - 0.5 * (H - 2 * pad)} x2={W - pad} y2={H - pad - 0.5 * (H - 2 * pad)} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth={1} strokeDasharray="3 4" />
      <path d={area} fill="url(#moodgrad)" />
      <path d={line} fill="none" stroke="#34d399" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={3.5} fill="#34d399" />
    </svg>
  );
}

function Movers({ title, items, tone, onOpen }: { title: string; items: Stats['energizers']; tone: 'emerald' | 'rose'; onOpen: (v: FindingView) => void }) {
  const bar = tone === 'emerald' ? 'bg-emerald-500' : 'bg-rose-500';
  const head = tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  const valence = tone === 'emerald' ? 'energizing' : 'draining';
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
      <div className={'text-[11px] font-semibold uppercase tracking-wide mb-2 ' + head}>{title}</div>
      {items.length === 0 ? (
        <p className="text-xs text-zinc-400 py-3">Nothing strong enough yet.</p>
      ) : (
        <div className="space-y-2.5">
          {items.map((m, i) => (
            <button key={i} onClick={() => onOpen({ id: m.id, label: m.label, statement: m.statement, valence, confidence: m.strength, evidenceCount: m.n })} className="w-full text-left block">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium truncate">{m.label}</span>
                <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums">{sureWord(m.strength)}</span>
              </div>
              {m.statement && <p className="text-[11px] text-zinc-500 leading-snug truncate">{m.statement}</p>}
              <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden"><div className={'h-full ' + bar} style={{ width: `${Math.max(4, Math.min(100, m.strength))}%` }} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- Heatmaps: mood by day-of-week + the avoidance map ----------------
function moodCell(avg: number | null): string {
  if (avg == null) return 'rgba(113,113,122,0.14)';
  return avg < 50 ? `rgba(244,63,94,${(0.2 + ((50 - avg) / 50) * 0.45).toFixed(2)})` : `rgba(52,211,153,${(0.2 + ((avg - 50) / 50) * 0.45).toFixed(2)})`;
}

function HeatmapsView({ stats }: { stats: Stats | null }) {
  if (!stats) return <div className="flex justify-center py-12 text-zinc-400"><Loader2 className="animate-spin" size={20} /></div>;
  const hasDow = stats.dowMood.some((d) => d.avg != null);
  if (!hasDow && stats.categories.length === 0) return <Empty />;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h3 className="text-sm font-semibold mb-1">Mood by day of the week</h3>
        <p className="text-xs text-zinc-400 mb-3">Average mood per weekday — which days lift you, which weigh on you.</p>
        <div className="grid grid-cols-7 gap-1.5">
          {stats.dowMood.map((d) => (
            <div key={d.dow} className="text-center">
              <div title={`${d.n} day${d.n === 1 ? '' : 's'}`} className="rounded-lg h-12 grid place-items-center text-sm font-semibold tabular-nums" style={{ background: moodCell(d.avg) }}>
                {d.avg ?? '–'}
              </div>
              <div className="text-[10px] text-zinc-400 mt-1">{DOW[d.dow]}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h3 className="text-sm font-semibold mb-1">The avoidance map</h3>
        <p className="text-xs text-zinc-400 mb-3">By task category — how much you defer vs. finish. The longest bars are where the friction lives.</p>
        {stats.categories.length === 0 ? (
          <p className="text-xs text-zinc-400 py-3">Not enough categorised tasks yet.</p>
        ) : (
          <div className="space-y-2.5">
            {stats.categories.map((c) => (
              <div key={c.category}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-sm font-medium truncate">{c.category}</span>
                  <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums">{c.deferred} deferred · {c.done} done</span>
                </div>
                <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(3, c.avoidance)}%`, background: `rgba(244,63,94,${(0.35 + (c.avoidance / 100) * 0.5).toFixed(2)})` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
