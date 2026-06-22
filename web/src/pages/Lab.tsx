import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, RefreshCw, Loader2, Check, X, Pencil, Pin, Trash2, ChevronDown, Search } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { MindReview } from '../mind/MindReview';
import { mindApi, valenceClass, type Finding } from '../mind/client';

const YOU = '__you__';
const isYou = (s: string) => /^(you|me|i|myself)$/i.test(s.trim());
const edgeColor = (v: string) => (v === 'energizing' ? '#34d399' : v === 'draining' ? '#f43f5e' : '#71717a');
const trendArrow = (t: string) => (t === 'rising' ? '▲' : t === 'fading' ? '▼' : '–');

type Tab = 'map' | 'findings' | 'review';

export function Lab() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('map');
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [running, setRunning] = useState(false);

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

  async function runNow() {
    setRunning(true);
    try {
      await mindApi.run();
      toast('success', 'Ran a pass over your recent days');
      await load();
    } catch {
      toast('error', 'Could not run');
    } finally {
      setRunning(false);
    }
  }

  // Optimistic local mutations shared by Map + Findings.
  const patch = (id: string, fn: (f: Finding) => Finding | null) =>
    setFindings((fs) => (fs ? (fs.map((f) => (f.id === id ? fn(f) : f)).filter(Boolean) as Finding[]) : fs));
  const onConfirm = (id: string) => { mindApi.confirm(id).catch(() => undefined); patch(id, (f) => ({ ...f, validated: 'confirmed', confidence: Math.min(0.99, f.confidence + (1 - f.confidence) * 0.35) })); toast('success', 'Confirmed'); };
  const onRefute = (id: string) => { mindApi.refute(id).catch(() => undefined); patch(id, () => null); toast('success', "Got it — I won't think that"); };
  const onPin = (id: string, pinned: boolean) => { mindApi.pin(id, pinned).catch(() => undefined); patch(id, (f) => ({ ...f, pinned })); };
  const onRemove = (id: string) => { mindApi.remove(id).catch(() => undefined); patch(id, () => null); toast('success', 'Removed'); };
  const onAmend = (id: string, statement: string) => { mindApi.amend(id, { statement }).catch(() => undefined); patch(id, (f) => ({ ...f, statement, validated: 'confirmed' })); };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2">
            <FlaskConical size={22} className="text-violet-500" /> The Lab
          </h1>
          <p className="text-zinc-500 text-sm">The science of you — what your brain has learned from your days.</p>
        </div>
        <button onClick={runNow} disabled={running} className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">
          {running ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Run now
        </button>
      </div>

      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(['map', 'findings', 'review'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ' + (tab === t ? 'border-violet-500 text-violet-600 dark:text-violet-400' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')}>
            {t === 'map' ? 'Map' : t === 'findings' ? 'Findings' : 'Review'}
          </button>
        ))}
      </div>

      {findings === null ? (
        <div className="flex justify-center py-12 text-zinc-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : tab === 'review' ? (
        <MindReview />
      ) : tab === 'map' ? (
        <MindGraph findings={findings} onConfirm={onConfirm} onRefute={onRefute} onPin={onPin} />
      ) : (
        <FindingsFeed findings={findings} onConfirm={onConfirm} onRefute={onRefute} onPin={onPin} onRemove={onRemove} onAmend={onAmend} />
      )}
    </div>
  );
}

// ---------------- Map: self-contained force-directed graph ----------------
type Node = { id: string; label: string; x: number; y: number; deg: number; fixed?: boolean };
type Edge = { from: string; to: string; f: Finding };

function MindGraph({ findings, onConfirm, onRefute, onPin }: { findings: Finding[]; onConfirm: (id: string) => void; onRefute: (id: string) => void; onPin: (id: string, p: boolean) => void }) {
  const W = 720;
  const H = 520;
  const [sel, setSel] = useState<string | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const reduce = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const { nodes, edges } = useMemo(() => {
    const top = [...findings].sort((a, b) => b.confidence - a.confidence).slice(0, 40);
    const nodeMap = new Map<string, Node>();
    nodeMap.set(YOU, { id: YOU, label: 'You', x: W / 2, y: H / 2, deg: 0, fixed: true });
    const edges: Edge[] = [];
    const keyOf = (s: string) => (isYou(s) ? YOU : s.trim().toLowerCase());
    for (const f of top) {
      const sk = keyOf(f.subject);
      const ok = keyOf(f.object);
      for (const [k, lbl] of [[sk, f.subject], [ok, f.object]] as const) {
        if (k === YOU) continue;
        if (!nodeMap.has(k)) nodeMap.set(k, { id: k, label: lbl, x: W / 2 + (Math.random() - 0.5) * 200, y: H / 2 + (Math.random() - 0.5) * 200, deg: 0 });
      }
      if (sk !== ok) {
        edges.push({ from: sk, to: ok, f });
        nodeMap.get(sk)!.deg++;
        nodeMap.get(ok)!.deg++;
      }
    }
    return { nodes: [...nodeMap.values()], edges };
  }, [findings]);

  // One-shot force layout (settles, then stops — reduced-motion friendly).
  useEffect(() => {
    if (!nodes.length) return;
    const n = nodes.map((nd) => ({ ...nd }));
    const byId = new Map(n.map((nd) => [nd.id, nd]));
    const iters = reduce.current ? 120 : 320;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n.length; i++) {
        for (let j = i + 1; j < n.length; j++) {
          const a = n[i]; const b = n[j];
          let dx = a.x - b.x; let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const force = 9000 / d2;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d;
          if (!a.fixed) { a.x += dx * force; a.y += dy * force; }
          if (!b.fixed) { b.x -= dx * force; b.y -= dy * force; }
        }
      }
      for (const e of edges) {
        const a = byId.get(e.from)!; const b = byId.get(e.to)!;
        let dx = b.x - a.x; let dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const k = (d - 110) * 0.02;
        dx = (dx / d) * k; dy = (dy / d) * k;
        if (!a.fixed) { a.x += dx; a.y += dy; }
        if (!b.fixed) { b.x -= dx; b.y -= dy; }
      }
      for (const nd of n) {
        if (nd.fixed) continue;
        nd.x += (W / 2 - nd.x) * 0.012;
        nd.y += (H / 2 - nd.y) * 0.012;
        nd.x = Math.max(28, Math.min(W - 28, nd.x));
        nd.y = Math.max(28, Math.min(H - 28, nd.y));
      }
    }
    const out: Record<string, { x: number; y: number }> = {};
    for (const nd of n) out[nd.id] = { x: nd.x, y: nd.y };
    setPos(out);
  }, [nodes, edges]);

  if (!findings.length) return <Empty />;

  const selFindings = sel ? edges.filter((e) => e.from === sel || e.to === sel).map((e) => e.f) : [];
  const connected = (id: string) => sel === null || id === sel || edges.some((e) => (e.from === sel && e.to === id) || (e.to === sel && e.from === id));

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ touchAction: 'manipulation' }} onClick={() => setSel(null)}>
          {edges.map((e, i) => {
            const a = pos[e.from]; const b = pos[e.to];
            if (!a || !b) return null;
            const lit = sel === null || e.from === sel || e.to === sel;
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={edgeColor(e.f.valence)} strokeWidth={1 + e.f.confidence * 4} strokeOpacity={(lit ? 0.5 : 0.08) * (e.f.status === 'fading' ? 0.5 : 1)} />;
          })}
          {nodes.map((nd) => {
            const p = pos[nd.id];
            if (!p) return null;
            const r = nd.id === YOU ? 16 : 6 + Math.min(10, nd.deg * 2);
            const on = connected(nd.id);
            return (
              <g key={nd.id} onClick={(ev) => { ev.stopPropagation(); setSel(nd.id === sel ? null : nd.id); }} style={{ cursor: 'pointer' }} opacity={on ? 1 : 0.25}>
                <circle cx={p.x} cy={p.y} r={r} fill={nd.id === YOU ? '#8b5cf6' : sel === nd.id ? '#34d399' : '#3f3f46'} stroke={sel === nd.id ? '#34d399' : 'transparent'} strokeWidth={2} />
                <text x={p.x} y={p.y + r + 11} textAnchor="middle" className="fill-zinc-500 dark:fill-zinc-400" style={{ fontSize: 10 }}>{nd.label.length > 18 ? nd.label.slice(0, 17) + '…' : nd.label}</text>
              </g>
            );
          })}
        </svg>
        <div className="flex items-center gap-3 px-3 py-2 border-t border-zinc-100 dark:border-zinc-800 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-full" style={{ background: '#34d399' }} /> energizing</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-full" style={{ background: '#f43f5e' }} /> draining</span>
          <span className="ml-auto">{nodes.length - 1} things · {edges.length} links · tap a node</span>
        </div>
      </div>

      {sel && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">{nodes.find((n) => n.id === sel)?.label}</div>
          <div className="space-y-2">
            {selFindings.map((f) => (
              <div key={f.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex items-center gap-2">
                <p className="flex-1 text-sm min-w-0"><span className={'font-medium ' + valenceClass(f.valence)}>{f.statement}</span> <span className="text-[10px] text-zinc-400 tabular-nums">· {Math.round(f.confidence * 100)}% · {f.evidenceCount}× {trendArrow(f.trend)}</span></p>
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
function FindingsFeed({ findings, onConfirm, onRefute, onPin, onRemove, onAmend }: { findings: Finding[]; onConfirm: (id: string) => void; onRefute: (id: string) => void; onPin: (id: string, p: boolean) => void; onRemove: (id: string) => void; onAmend: (id: string, s: string) => void }) {
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
                  <button onClick={() => setOpen(open === f.id ? null : f.id)} className="flex-1 text-left min-w-0">
                    {editing === f.id ? (
                      <textarea autoFocus rows={2} value={draft} onClick={(e) => e.stopPropagation()} onChange={(e) => setDraft(e.target.value)} className="w-full text-sm rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 outline-none focus:border-emerald-500" />
                    ) : (
                      <p className="text-sm leading-snug"><span className={'font-medium ' + valenceClass(f.valence)}>{f.statement}</span></p>
                    )}
                    <div className="text-[10px] text-zinc-400 tabular-nums mt-1 flex items-center gap-2">
                      <span>{Math.round(f.confidence * 100)}%</span>
                      <span className="inline-block h-1 w-16 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden align-middle"><span className="block h-full bg-emerald-500" style={{ width: `${Math.round(f.confidence * 100)}%` }} /></span>
                      <span>{f.evidenceCount}× {trendArrow(f.trend)}</span>
                      {f.cadence && <span className="px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800">{f.cadence}</span>}
                      {f.pinned && <Pin size={10} className="text-amber-500 fill-amber-400" />}
                    </div>
                  </button>
                  <ChevronDown size={15} className={'text-zinc-400 shrink-0 transition-transform mt-0.5 ' + (open === f.id ? 'rotate-180' : '')} />
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
