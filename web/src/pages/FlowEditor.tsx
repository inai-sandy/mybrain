import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useGoBack } from '../ui/useGoBack';
import { FlowProcess } from '../ui/FlowProcess';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position,
  useNodesState, useEdgesState, addEdge, useReactFlow,
  BaseEdge, EdgeLabelRenderer, getBezierPath,
  type Node, type Edge, type Connection, type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Loader2, Sparkles, Search, Wand2, Server, Plus, X, Boxes, Play, Trash2, Bot, History, CheckCircle2, AlertCircle, MinusCircle, Clock, ListOrdered } from 'lucide-react';
import { useToast } from '../ui/Toast';

type PaletteItem = { type: 'skill' | 'tool' | 'generic'; kind?: string; id: string; name: string; description?: string; group?: string };
type Palette = { generics: PaletteItem[]; tools: PaletteItem[]; skills: PaletteItem[] };

const KIND_STYLE: Record<string, string> = {
  question: 'border-emerald-400 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10',
  subquestion: 'border-indigo-400 bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/10',
  skill: 'border-violet-400 bg-violet-50 dark:border-violet-500/40 dark:bg-violet-500/10',
  tool: 'border-sky-400 bg-sky-50 dark:border-sky-500/40 dark:bg-sky-500/10',
  merge: 'border-amber-400 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10',
  text: 'border-zinc-400 bg-zinc-50 dark:border-zinc-500/40 dark:bg-zinc-700/40',
  note: 'border-yellow-400 bg-yellow-50 dark:border-yellow-500/40 dark:bg-yellow-500/10',
  if: 'border-rose-400 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10',
  filter: 'border-teal-400 bg-teal-50 dark:border-teal-500/40 dark:bg-teal-500/10',
  wait: 'border-zinc-400 bg-zinc-50 dark:border-zinc-500/40 dark:bg-zinc-700/40',
  ask_user: 'border-amber-400 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10',
  ask_ai: 'border-fuchsia-400 bg-fuchsia-50 dark:border-fuchsia-500/40 dark:bg-fuchsia-500/10',
  output: 'border-zinc-400 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800',
};

// Every block wears its kind on its face (BEA-1074): an icon + a plain name, so the canvas reads
// at a glance — "🔀 Merge", "✋ Ask me", "🧰 Tool" — instead of look-alike boxes.
const KIND_META: Record<string, { icon: string; name: string }> = {
  question: { icon: '❓', name: 'The question' },
  subquestion: { icon: '🌿', name: 'Branch' },
  skill: { icon: '🪄', name: 'Skill' },
  tool: { icon: '🧰', name: 'Tool' },
  merge: { icon: '🔀', name: 'Merge' },
  text: { icon: '📝', name: 'Text' },
  note: { icon: '💬', name: 'Note' },
  if: { icon: '🔱', name: 'If' },
  filter: { icon: '🚦', name: 'Filter' },
  wait: { icon: '⏳', name: 'Wait' },
  ask_user: { icon: '✋', name: 'Ask me' },
  ask_ai: { icon: '✨', name: 'Ask AI' },
  output: { icon: '🏁', name: 'Answer' },
};

// Lets a node's controls (inline "+", on/off) reach the editor.
const NodeCtx = createContext<{ addAfter: (id: string) => void; toggleEnabled: (id: string) => void }>({ addAfter: () => undefined, toggleEnabled: () => undefined });
const TOGGLEABLE = new Set(['skill', 'tool', 'ask_ai', 'subquestion']);

function RunBadge({ s }: { s?: string }) {
  if (!s) return null;
  const cls = 'absolute -right-2 -top-2 z-10 rounded-full bg-white dark:bg-zinc-900';
  if (s === 'running') return <span className={cls}><Loader2 className="h-4 w-4 animate-spin text-blue-500" /></span>;
  if (s === 'done') return <span className={cls}><CheckCircle2 className="h-4 w-4 text-emerald-500" /></span>;
  if (s === 'failed') return <span className={cls}><AlertCircle className="h-4 w-4 text-rose-500" /></span>;
  if (s === 'skipped') return <span className={cls}><MinusCircle className="h-4 w-4 text-zinc-400" /></span>;
  return null;
}

function NodeBox({ id, data, selected }: { id: string; data: any; selected?: boolean }) {
  const { addAfter, toggleEnabled } = useContext(NodeCtx);
  const off = data.enabled === false;
  const rs = data.runStatus as string | undefined;
  const runRing = rs === 'running' ? ' ring-2 ring-blue-400' : rs === 'done' ? ' ring-2 ring-emerald-400' : rs === 'failed' ? ' ring-2 ring-rose-400' : '';
  return (
    <div className={'relative cursor-pointer rounded-lg border px-3 py-2 text-xs shadow-sm transition-shadow hover:ring-2 hover:ring-emerald-400/40 ' + (KIND_STYLE[data.kind] || KIND_STYLE.tool) + (off ? ' opacity-40' : '') + (selected ? ' ring-2 ring-emerald-500' : runRing)} style={{ minWidth: 130, maxWidth: 220 }}>
      <RunBadge s={rs} />
      {data.pin?.output != null && <span title="Frozen — tests reuse this result" className="absolute -right-1.5 -top-1.5 rounded-full bg-sky-500 px-1 text-[9px] leading-4 text-white shadow">❄</span>}
      {data.kind !== 'question' && <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-zinc-400" />}
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            <span className="text-[11px] leading-none">{(KIND_META[data.kind] || KIND_META.tool).icon}</span>
            {(KIND_META[data.kind] || KIND_META.tool).name}
          </div>
          <div className="truncate font-medium text-zinc-800 dark:text-zinc-100">{data.label}</div>
          {data.sub && <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-zinc-500">{data.sub}</div>}
          {data.kind === 'merge' && <div className="mt-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">{(data.mode || 'ai') === 'ai' ? 'AI synthesise' : 'Stack raw'}</div>}
        </div>
        {TOGGLEABLE.has(data.kind) && (
          <button className="nodrag nopan mt-0.5 shrink-0" title={off ? 'Disabled — click to include' : 'Click to skip this branch'} onClick={(e) => { e.stopPropagation(); toggleEnabled(id); }}>
            <span className={'flex h-3.5 w-6 items-center rounded-full px-0.5 transition-colors ' + (off ? 'bg-zinc-300 dark:bg-zinc-600' : 'bg-emerald-500')}><span className={'block h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ' + (off ? 'translate-x-0' : 'translate-x-2.5')} /></span>
          </button>
        )}
      </div>
      {data.kind !== 'output' && <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-zinc-400" />}
      {data.kind !== 'output' && (
        <button
          className="nodrag nopan absolute -bottom-3 left-1/2 z-10 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-500 shadow-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-600 dark:bg-zinc-900"
          title="Add the next block" onClick={(e) => { e.stopPropagation(); addAfter(id); }}
        ><Plus className="h-3 w-3" /></button>
      )}
    </div>
  );
}
const nodeTypes = { box: NodeBox };

// Edge with a ✕ at its midpoint so a connection can be disconnected (BEA-705). Also deletable via Backspace.
// The ⚠ button flips it to an "on failure" path (BEA-1071): it fires ONLY when the source step fails.
const EdgeCtx = createContext<(id: string) => void>(() => undefined);
const EdgeErrCtx = createContext<(id: string) => void>(() => undefined);
function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected, data }: EdgeProps) {
  const remove = useContext(EdgeCtx);
  const toggleErr = useContext(EdgeErrCtx);
  const onError = !!(data as any)?.onError;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={onError ? { ...style, stroke: '#f87171', strokeDasharray: '6 4' } : style} />
      <EdgeLabelRenderer>
        <div className="nodrag nopan pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1" style={{ left: labelX, top: labelY }}>
          {onError && <span className="rounded-full bg-rose-500/90 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm">on failure</span>}
          <button
            className={'flex h-5 w-5 items-center justify-center rounded-full border bg-white shadow-sm transition-colors dark:bg-zinc-900 ' + (onError ? 'border-rose-400 text-rose-500' : 'border-zinc-300 text-zinc-400 hover:border-amber-400 hover:text-amber-600 dark:border-zinc-600')}
            title={onError ? 'Make this a normal path again' : 'Only run this path when the step FAILS'}
            onClick={(e) => { e.stopPropagation(); toggleErr(id); }}
          ><span className="text-[10px] leading-none">⚠</span></button>
          <button
            className={'flex h-5 w-5 items-center justify-center rounded-full border bg-white text-zinc-400 shadow-sm transition-colors hover:border-rose-400 hover:text-rose-600 dark:bg-zinc-900 ' + (selected ? 'border-rose-400 text-rose-500' : 'border-zinc-300 dark:border-zinc-600')}
            title="Disconnect this link"
            onClick={(e) => { e.stopPropagation(); remove(id); }}
          ><X className="h-3 w-3" /></button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { deletable: DeletableEdge };

let idc = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}_${idc++}`;

function Editor({ flowId, embedded }: { flowId?: string; embedded?: boolean }) {
  const params = useParams();
  const id = flowId ?? params.id;
  const nav = useNavigate();
  const goBack = useGoBack('/flows');
  const toast = useToast();
  const { screenToFlowPosition } = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('Untitled flow');
  const [question, setQuestion] = useState('');
  const [palette, setPalette] = useState<Palette>({ generics: [], tools: [], skills: [] });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [splitting, setSplitting] = useState(false);
  // picker: { pos, target? } — target set when opened from a node's "+", to auto-connect
  const [picker, setPicker] = useState<{ pos: { x: number; y: number }; target?: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  // live run watching — show statuses on the canvas instead of leaving the editor
  const [watchRunId, setWatchRunId] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<string>('');
  const [runStatuses, setRunStatuses] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<any>(null);
  const [schedOpen, setSchedOpen] = useState(false);
  const [proc, setProc] = useState<{ process: any; prompt: string } | null>(null);
  const [showProc, setShowProc] = useState(false);
  const [searchParams] = useSearchParams();

  async function loadProcess() {
    try { const d = await fetch(`/api/flows/${id}/prompt`).then((r) => r.json()); setProc({ process: d.process, prompt: d.prompt }); }
    catch { /* noop */ }
  }
  function openProcess() { loadProcess(); setShowProc(true); }

  useEffect(() => {
    fetch('/api/flows/palette').then((r) => r.json()).then(setPalette).catch(() => undefined);
    fetch(`/api/flows/${id}`).then((r) => r.json()).then((f) => {
      setName(f.name || 'Untitled flow');
      setQuestion(f.question || '');
      setAgentId(f.agentId || null);
      setSchedule(f.schedule || null);
      const g = f.graph || { nodes: [], edges: [] };
      if (!g.nodes?.length) {
        setNodes([
          { id: 'question', type: 'box', position: { x: 250, y: 20 }, data: { kind: 'question', label: 'Question', sub: f.question || 'your one big ask' } },
          { id: 'merge', type: 'box', position: { x: 250, y: 360 }, data: { kind: 'merge', label: 'Merge', mode: 'ai' } },
          { id: 'output', type: 'box', position: { x: 250, y: 460 }, data: { kind: 'output', label: 'Output' } },
        ]);
        setEdges([{ id: 'm-o', source: 'merge', target: 'output' }]);
      } else { setNodes(g.nodes); setEdges(g.edges || []); }
      // Just generated from an agent → show "How it runs" right away (BEA-669).
      if (searchParams.get('generated') && g.nodes?.length) { setTimeout(() => openProcess(), 300); }
    }).catch(() => toast('error', 'Could not load flow'));
    // eslint-disable-next-line
  }, [id]);

  const onConnect = useCallback((c: Connection) => setEdges((e) => addEdge({ ...c, animated: true }, e)), [setEdges]);
  const removeEdge = useCallback((eid: string) => setEdges((es) => es.filter((e) => e.id !== eid)), [setEdges]);
  // Flip a link to an "on failure" path and back (BEA-1071).
  const toggleEdgeError = useCallback((eid: string) => setEdges((es) => es.map((e) => (e.id === eid ? { ...e, data: { ...(e.data || {}), onError: !(e.data as any)?.onError } } : e))), [setEdges]);

  function addNode(item: PaletteItem, pos: { x: number; y: number }): string {
    const newId = nid(item.type);
    setNodes((ns) => ns.concat({ id: newId, type: 'box', position: pos, data: { kind: item.kind || item.type, label: item.name, sub: item.description, refId: item.id } }));
    return newId;
  }
  function pick(item: PaletteItem) {
    if (!picker) return;
    const newId = addNode(item, picker.pos);
    if (picker.target) setEdges((es) => addEdge({ id: `e_${picker.target}_${newId}`, source: picker.target!, target: newId, animated: true }, es));
    setPicker(null);
  }
  // open from a node's "+": place below that node + remember target to connect
  const addAfter = useCallback((nodeId: string) => {
    setNodes((ns) => {
      const n = ns.find((x) => x.id === nodeId);
      setPicker({ pos: n ? { x: n.position.x, y: n.position.y + 120 } : { x: 250, y: 250 }, target: nodeId });
      return ns;
    });
  }, [setNodes]);
  // open from the toolbar: place near the centre of the visible canvas
  function openToolbarPicker() {
    const rect = wrap.current?.getBoundingClientRect();
    const pos = rect ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 250, y: 250 };
    setPicker({ pos });
  }

  // Auto-plan: the agent reads the question and lays out the WHOLE flow (branches + tools/skills + merge + output).
  async function autoPlan() {
    if (!question.trim()) { toast('error', 'Type the question first'); return; }
    setSplitting(true);
    try {
      await fetch(`/api/flows/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      const r = await fetch(`/api/flows/${id}/plan`, { method: 'POST' });
      const f = await r.json();
      if (!r.ok) throw new Error();
      const g = f.graph || { nodes: [], edges: [] };
      setNodes(g.nodes || []);
      setEdges(g.edges || []);
      setSelected(null);
      toast('success', 'Planned the whole flow — tweak any block, then Run');
      openProcess(); // show how it will run
    } catch { toast('error', 'Could not plan the flow'); } finally { setSplitting(false); }
  }

  function toggleEnabled(nodeId: string) {
    setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, enabled: n.data.enabled === false } } : n)));
  }
  // edit a node's fields from the inspector
  function setNodeData(nodeId: string, patch: Record<string, any>) {
    setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
  }
  function deleteNode(nodeId: string) {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelected(null);
  }
  function graphJson() {
    // edge data (e.g. onError, BEA-1071) must survive the round-trip — it drives the executor.
    return { nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })), edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: e.animated, data: e.data })) };
  }
  // "Run to here" (BEA-1072): save silently, then test one block with its upstream feeders.
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ nodeId: string; label: string; data: any } | null>(null);
  async function testToNode(nodeId: string) {
    setTesting(nodeId);
    try {
      await fetch(`/api/flows/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, question, graph: graphJson() }) }); // silent save so the test sees your edits
      const r = await fetch(`/api/flows/${id}/test-node`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not test');
      const label = (nodes.find((n) => n.id === nodeId)?.data as any)?.label || 'Block';
      setTestResult({ nodeId, label, data: d });
    } catch (e: any) { toast('error', e?.message || 'Could not test'); }
    setTesting(null);
  }
  function freezeResult(nodeId: string, output: string) {
    setNodeData(nodeId, { pin: { output, at: new Date().toISOString() } });
    toast('success', 'Frozen — tests reuse this result until you unfreeze (real runs ignore it)');
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(`/api/flows/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, question, graph: graphJson() }) });
      if (!r.ok) throw new Error();
      toast('success', 'Flow saved');
      if (agentId) setSyncOffer(true); // canvas → words (BEA-1065): offer to re-sync the agent's Task
    } catch { toast('error', 'Could not save'); } finally { setSaving(false); }
  }

  // Canvas → words sync (BEA-1065): preview the rewritten agent Task, apply only on confirm.
  const [syncOffer, setSyncOffer] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncData, setSyncData] = useState<any>(null); // {oldTask, newTask, changes}
  async function openSync() {
    setSyncOpen(true); setSyncBusy(true); setSyncData(null);
    try {
      const r = await fetch(`/api/flows/${id}/sync-agent/preview`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not compare');
      setSyncData(d);
    } catch (e: any) { toast('error', e.message || 'Could not compare'); setSyncOpen(false); }
    setSyncBusy(false);
  }
  async function applySync() {
    if (!syncData || syncBusy) return;
    setSyncBusy(true);
    try {
      const r = await fetch(`/api/flows/${id}/sync-agent/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: syncData.newTask }) });
      if (!r.ok) throw new Error();
      toast('success', "Done — the agent's words now match this canvas");
      setSyncOpen(false); setSyncOffer(false);
    } catch { toast('error', 'Could not update the agent'); }
    setSyncBusy(false);
  }
  async function saveSchedule(s: any) {
    setSchedule(s);
    try {
      await fetch(`/api/flows/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: s }) });
      toast('success', s ? 'Schedule saved' : 'Schedule turned off');
    } catch { toast('error', 'Could not save schedule'); }
    setSchedOpen(false);
  }
  async function run() {
    setRunning(true);
    try {
      await fetch(`/api/flows/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, question, graph: graphJson() }) });
      const r = await fetch(`/api/flows/${id}/run`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not run');
      // stay on the canvas and watch it light up live
      setRunStatuses({}); setWatchStatus('running'); setWatchRunId(d.runId); setSelected(null);
    } catch (e: any) { toast('error', e?.message || 'Could not run'); } finally { setRunning(false); }
  }

  // poll the watched run and project node statuses onto the canvas
  useEffect(() => {
    if (!watchRunId) return;
    let alive = true; let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const run = await fetch(`/api/flows/runs/${watchRunId}`).then((r) => r.json()).catch(() => null);
      if (!alive) return;
      if (run) {
        const sts: Record<string, string> = {};
        for (const [k, v] of Object.entries(run.results || {})) sts[k] = (v as any).status;
        setRunStatuses(sts); setWatchStatus(run.status);
      }
      if (!run || run.status === 'running') t = setTimeout(tick, 2000);
      else if (run.status === 'done') toast('success', 'Flow finished');
    };
    tick();
    return () => { alive = false; if (t) clearTimeout(t); };
    // eslint-disable-next-line
  }, [watchRunId]);

  const selectedNode = nodes.find((n) => n.id === selected) || null;
  // Nodes reachable from the Merge (stopping at Output) run as "finishing steps" after combining.
  const postMergeIds = (() => {
    const merge = nodes.find((n) => n.data?.kind === 'merge');
    const set = new Set<string>();
    if (!merge) return set;
    const adj = new Map<string, string[]>();
    for (const e of edges) { if (!adj.has(e.source)) adj.set(e.source, []); adj.get(e.source)!.push(e.target); }
    const stack = [...(adj.get(merge.id) || [])];
    while (stack.length) {
      const id = stack.pop()!;
      const node = nodes.find((n) => n.id === id);
      if (!node || set.has(id) || node.data?.kind === 'output') continue;
      set.add(id);
      stack.push(...(adj.get(id) || []));
    }
    return set;
  })();
  const dispNodes = nodes.map((n) => ({ ...n, selected: n.id === selected, data: { ...n.data, runStatus: watchRunId ? runStatuses[n.id] : undefined } }));
  const dispEdges = edges.map((e) => ({ ...e, type: 'deletable' })); // render every link with a ✕ to disconnect

  return (
    <div className="flex flex-col" style={{ height: embedded ? '100%' : 'calc(100dvh - 1px)' }}>
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        {!embedded && <button onClick={goBack} title="Back" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" /></button>}
        {embedded ? <div className="min-w-0 flex-1" /> : <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:border-zinc-200 focus:border-emerald-400 dark:hover:border-zinc-700" />}
        {agentId && !embedded && <button onClick={() => nav(`/agent/agents/${agentId}`)} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-violet-300 px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"><Bot className="h-4 w-4" />Open agent</button>}
        <button onClick={openToolbarPicker} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700"><Plus className="h-4 w-4" />Add block</button>
        <button onClick={() => setSchedOpen((o) => !o)} title="Run on a schedule" className={'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ' + (schedule ? 'border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-300' : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800')}><Clock className="h-4 w-4" /><span className="hidden sm:inline">{schedLabel(schedule)}</span></button>
        <button onClick={openProcess} title="How this flow will run" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"><ListOrdered className="h-4 w-4" /><span className="hidden sm:inline">How it runs</span></button>
        {!embedded && <button onClick={() => nav(`/flows/${id}/runs`)} title="Run history & documents" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"><History className="h-4 w-4" /></button>}
        <button onClick={save} disabled={saving} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save</button>
        <button onClick={run} disabled={running} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run</button>
      </header>
      {schedOpen && <SchedulePopover schedule={schedule} onSave={saveSchedule} onClose={() => setSchedOpen(false)} />}
      {/* canvas → words offer (BEA-1065) */}
      {syncOffer && agentId && (
        <div className="flex items-center gap-2 border-b border-violet-200 bg-violet-50 px-4 py-2 text-sm dark:border-violet-500/30 dark:bg-violet-500/10">
          <Bot className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" />
          <span className="min-w-0 flex-1 truncate text-violet-800 dark:text-violet-200">Saved. Update the agent's words to match this canvas?</span>
          <button onClick={openSync} className="shrink-0 rounded-lg bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500">See what changes</button>
          <button onClick={() => setSyncOffer(false)} title="Not now" className="shrink-0 rounded p-1 text-violet-400 hover:text-violet-600"><X className="h-4 w-4" /></button>
        </div>
      )}
      {syncOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !syncBusy && setSyncOpen(false)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Bot className="h-4 w-4 text-violet-500" />Update the agent's words</h3>
            {!syncData ? (
              <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Reading the canvas and rewriting the words…</div>
            ) : (
              <>
                <p className="mt-1 text-xs text-zinc-400">Nothing changes until you confirm.</p>
                <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-500/30 dark:bg-violet-500/10">
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">What changed</p>
                  <ul className="mt-1.5 space-y-1">
                    {(syncData.changes || []).map((c: string, i: number) => (
                      <li key={i} className="flex items-start gap-1.5 text-sm text-zinc-700 dark:text-zinc-200"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />{c}</li>
                    ))}
                  </ul>
                </div>
                <div className="mt-3 space-y-2">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Before</p>
                    <p className="mt-0.5 whitespace-pre-wrap rounded-lg bg-zinc-50 p-2.5 text-xs text-zinc-400 line-through decoration-zinc-300 dark:bg-zinc-800/60 dark:decoration-zinc-600">{syncData.oldTask || '(empty)'}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-600">After</p>
                    <p className="mt-0.5 whitespace-pre-wrap rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5 text-xs text-zinc-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-zinc-200">{syncData.newTask}</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={applySync} disabled={syncBusy} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">{syncBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Update the words</button>
                  <button onClick={() => setSyncOpen(false)} disabled={syncBusy} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Keep as is</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <span className="shrink-0 text-xs font-medium text-zinc-500">Question</span>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The one big ask… e.g. “Full competitor analysis of Tesla.”" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
        <button onClick={autoPlan} disabled={splitting} title="Let the agent plan the whole flow from your question" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{splitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Auto-plan</button>
      </div>
      <div className="min-h-0 flex-1">
        <div className="flex h-full">
          <div className="relative min-h-0 flex-1" ref={wrap}>
            <NodeCtx.Provider value={{ addAfter, toggleEnabled }}>
             <EdgeCtx.Provider value={removeEdge}>
              <EdgeErrCtx.Provider value={toggleEdgeError}>
              <ReactFlow nodes={dispNodes} edges={dispEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} nodeTypes={nodeTypes} edgeTypes={edgeTypes} defaultEdgeOptions={{ type: 'deletable', animated: true }} deleteKeyCode={['Backspace', 'Delete']} fitView proOptions={{ hideAttribution: true }} colorMode="system">
                <Background gap={16} />
                <Controls showInteractive={false} />
              </ReactFlow>
              </EdgeErrCtx.Provider>
             </EdgeCtx.Provider>
            </NodeCtx.Provider>
            {picker && <BlockPicker palette={palette} onPick={pick} onClose={() => setPicker(null)} />}
            {/* Test-to-here result: exactly what went IN and what came OUT of one block (BEA-1072) */}
            {testResult && (
              <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setTestResult(null)}>
                <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold">▶ Tested: {testResult.label}</h2>
                    <button onClick={() => setTestResult(null)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
                  </div>
                  <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto sm:grid-cols-2">
                    <div className="min-w-0">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">What went in</div>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">{testResult.data.input || '(nothing — this block starts the chain)'}</pre>
                    </div>
                    <div className="min-w-0">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">What came out</div>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">{testResult.data.output || (testResult.data.message ? '✗ ' + testResult.data.message : '(empty)')}</pre>
                    </div>
                  </div>
                  {testResult.data.nodes && Object.values(testResult.data.nodes).some((n: any) => n.pinned) && (
                    <p className="text-[11px] text-sky-600 dark:text-sky-400">❄ Some feeding steps used their frozen results — nothing expensive re-ran.</p>
                  )}
                  <div className="flex gap-2">
                    {testResult.data.ok && testResult.data.output && (
                      <button onClick={() => { freezeResult(testResult.nodeId, testResult.data.output); setTestResult(null); }} className="flex-1 rounded-lg border border-sky-300 px-3 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 dark:border-sky-500/40 dark:text-sky-300 dark:hover:bg-sky-500/10">❄ Freeze this result for tests</button>
                    )}
                    <button onClick={() => setTestResult(null)} className="flex-1 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">Done</button>
                  </div>
                </div>
              </div>
            )}
            {showProc && (
              <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/30 p-4 pt-12" onClick={() => setShowProc(false)}>
                <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
                  <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                    <span className="text-sm font-semibold">How this flow runs</span>
                    <button onClick={() => setShowProc(false)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-3">{proc ? <FlowProcess process={proc.process} prompt={proc.prompt} /> : <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Working out the plan…</div>}</div>
                </div>
              </div>
            )}
            {watchRunId && (
              <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-zinc-200 bg-white/95 px-4 py-1.5 text-sm shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
                {watchStatus === 'running' ? <span className="flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin text-blue-500" />Running…</span> : watchStatus === 'done' ? <span className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-500" />Finished</span> : <span className="flex items-center gap-1.5"><AlertCircle className="h-4 w-4 text-rose-500" />Failed</span>}
                <Link to={`/flows/runs/${watchRunId}`} className="font-medium text-emerald-600 hover:underline dark:text-emerald-400">View results</Link>
                <button onClick={() => { setWatchRunId(null); setRunStatuses({}); }} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
              </div>
            )}
          </div>
          {selectedNode && <Inspector node={selectedNode} postMerge={postMergeIds.has(selectedNode.id)} onChange={setNodeData} onDelete={deleteNode} onClose={() => setSelected(null)} onTest={testToNode} testing={testing === selectedNode.id} />}
        </div>
      </div>
    </div>
  );
}

function BlockPicker({ palette, onPick, onClose }: { palette: Palette; onPick: (i: PaletteItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const filt = (arr: PaletteItem[]) => (arr || []).filter((x) => !q || (x.name + ' ' + (x.description || '')).toLowerCase().includes(q.toLowerCase()));
  const generics = filt(palette.generics);
  const skills = filt(palette.skills);
  const tools = filt(palette.tools);
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/30 p-4 pt-16" onClick={onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <Search className="h-4 w-4 shrink-0 text-zinc-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills & tools…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          <button onClick={onClose} className="shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-80 overflow-auto p-2">
          <PickerGroup icon={<Boxes className="h-3.5 w-3.5 text-zinc-500" />} title="Building blocks" items={generics} onPick={onPick} />
          <PickerGroup icon={<Server className="h-3.5 w-3.5 text-sky-500" />} title="Tools & connectors" items={tools} onPick={onPick} />
          <PickerGroup icon={<Wand2 className="h-3.5 w-3.5 text-violet-500" />} title="Skills" items={skills} onPick={onPick} />
          {!skills.length && !tools.length && !generics.length && <div className="px-2 py-6 text-center text-sm text-zinc-400">No blocks match “{q}”.</div>}
        </div>
      </div>
    </div>
  );
}
function PickerGroup({ icon, title, items, onPick }: { icon: React.ReactNode; title: string; items: PaletteItem[]; onPick: (i: PaletteItem) => void }) {
  if (!items.length) return null;
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{icon}{title}</div>
      <div className="space-y-0.5">
        {items.map((it) => (
          <button key={it.type + it.id} onClick={() => onPick(it)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-300" />
            <span className="min-w-0"><span className="font-medium">{it.name}</span>{it.description && <span className="ml-1 text-xs text-zinc-500">— {it.description}</span>}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Which field holds the editable text, per kind.
const TEXT_FIELD: Record<string, { key: string; label: string; placeholder: string }> = {
  question: { key: 'sub', label: 'Question', placeholder: 'Your one big ask…' },
  subquestion: { key: 'sub', label: 'Sub-question', placeholder: 'A focused part of the question…' },
  text: { key: 'text', label: 'Text', placeholder: 'A fixed value or instruction…' },
  note: { key: 'sub', label: 'Note', placeholder: 'A comment for yourself…' },
  ask_ai: { key: 'sub', label: 'Prompt (optional)', placeholder: 'Used when nothing is connected above…' },
  ask_user: { key: 'sub', label: 'Question to ask you', placeholder: 'e.g. Approve this draft? / Which option?' },
};

function Inspector({ node, postMerge, onChange, onDelete, onClose, onTest, testing }: { node: Node; postMerge?: boolean; onChange: (id: string, patch: Record<string, any>) => void; onDelete: (id: string) => void; onClose: () => void; onTest?: (id: string) => void; testing?: boolean }) {
  const d: any = node.data;
  const kind: string = d.kind;
  const set = (patch: Record<string, any>) => onChange(node.id, patch);
  const tf = TEXT_FIELD[kind];
  const labelCls = 'block text-[11px] font-medium uppercase tracking-wide text-zinc-500';
  const inputCls = 'mt-1 w-full rounded-lg border border-zinc-200 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';
  return (
    <>
      {/* dim the canvas on phone so the sheet reads as a focused editor; tap to close */}
      <div className="fixed inset-0 z-[55] bg-black/40 sm:hidden" onClick={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[82vh] flex-col rounded-t-2xl border-t border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:static sm:z-auto sm:h-full sm:max-h-none sm:w-80 sm:shrink-0 sm:rounded-none sm:border-l sm:border-t-0">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600 sm:hidden" />
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">Edit · {kind.replace('_', ' ')}</span>
          <button onClick={onClose} className="ml-auto text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 space-y-3 overflow-auto p-3 pb-24 sm:pb-3">
        <div>
          <label className={labelCls}>Name</label>
          <input value={d.label || ''} onChange={(e) => set({ label: e.target.value })} className={inputCls} />
        </div>
        {tf && (
          <div>
            <label className={labelCls}>{tf.label}</label>
            <textarea value={d[tf.key] || ''} onChange={(e) => set({ [tf.key]: e.target.value })} placeholder={tf.placeholder} rows={4} className={inputCls + ' resize-y leading-snug'} />
          </div>
        )}
        {kind === 'merge' && (
          <div>
            <label className={labelCls}>How to combine</label>
            <select value={d.mode || 'ai'} onChange={(e) => set({ mode: e.target.value })} className={inputCls}>
              <option value="ai">AI synthesise — blend into one answer</option>
              <option value="raw">Stack raw — keep each part as-is</option>
            </select>
          </div>
        )}
        {(kind === 'skill' || kind === 'tool') && (
          <>
            {postMerge && <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-2.5 py-1.5 text-xs text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">This runs as a <strong>finishing step</strong>, after the parts are combined — it shapes the final answer.</div>}
            {d.sub && kind === 'skill' && <div className="rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-500 dark:bg-zinc-800/60">{d.sub}</div>}
            <div>
              <label className={labelCls}>Extra guidance (optional)</label>
              <textarea value={d.guidance || ''} onChange={(e) => set({ guidance: e.target.value })} placeholder="e.g. keep it under 5 bullet points" rows={3} className={inputCls + ' resize-y leading-snug'} />
            </div>
          </>
        )}
        {(kind === 'skill' || kind === 'tool' || kind === 'ask_ai') && (
          <div>
            <label className={labelCls}>If it fails</label>
            <select value={String(d.retries ?? 0)} onChange={(e) => set({ retries: Number(e.target.value) })} className={inputCls}>
              <option value="0">Give up (or follow an ⚠ on-failure path)</option>
              <option value="1">Retry once first</option>
              <option value="2">Retry twice first</option>
              <option value="3">Retry 3 times first</option>
            </select>
            <p className="mt-1 text-[11px] text-zinc-400">Tip: tap the ⚠ on any outgoing link to make it an <em>on-failure</em> path — it runs only when this step breaks.</p>
          </div>
        )}
        {kind === 'wait' && (
          <div>
            <label className={labelCls}>Wait for (seconds)</label>
            <input type="number" min={0} max={600} value={d.seconds ?? 0} onChange={(e) => set({ seconds: Math.min(600, Math.max(0, Number(e.target.value) || 0)) })} className={inputCls} />
            <p className="mt-1 text-[11px] text-zinc-400">The run genuinely pauses here (up to 10 minutes) before the next step.</p>
          </div>
        )}
        {kind === 'if' && (
          <div className="space-y-2">
            <label className={labelCls}>If the input…</label>
            <select value={d.cond?.op || 'contains'} onChange={(e) => set({ cond: { ...(d.cond || {}), op: e.target.value } })} className={inputCls}>
              <option value="contains">contains the words…</option>
              <option value="not_contains">does NOT contain…</option>
              <option value="longer_than">is longer than (characters)…</option>
              <option value="number_gte">has a number ≥ …</option>
              <option value="number_lte">has a number ≤ …</option>
              <option value="empty">is empty</option>
            </select>
            {(d.cond?.op || 'contains') !== 'empty' && (
              <input value={d.cond?.value ?? ''} onChange={(e) => set({ cond: { op: d.cond?.op || 'contains', value: e.target.value } })} placeholder="the words / the number" className={inputCls} />
            )}
            <p className="text-[11px] text-zinc-400">Plain links leaving this block = the <b>yes</b> path. Tap ⚠ on a link to make it the <b>no</b> path.</p>
          </div>
        )}
        {kind === 'filter' && (
          <div>
            <label className={labelCls}>Keep only lines containing</label>
            <input value={d.match ?? ''} onChange={(e) => set({ match: e.target.value })} placeholder="e.g. urgent" className={inputCls} />
            <p className="mt-1 text-[11px] text-zinc-400">Everything else is dropped before the next step. Empty = keep all.</p>
          </div>
        )}
        {kind === 'ask_user' && (
          <div>
            <label className={labelCls}>Choices (optional, one per line)</label>
            <textarea value={(d.options || []).join('\n')} onChange={(e) => set({ options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} placeholder={'Leave empty for a free-text answer.\nApprove\nReject'} rows={3} className={inputCls + ' resize-y leading-snug'} />
            <p className="mt-1 text-[11px] text-zinc-400">Empty = free text. Add lines to get tap buttons. The flow pauses here until you answer (in-app or later).</p>
          </div>
        )}
          {d.pin?.output != null && (
            <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-2.5 py-1.5 text-xs text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
              ❄ Frozen — tests reuse this result instead of re-running the step. Real runs ignore it.
              <button onClick={() => onChange(node.id, { pin: undefined })} className="ml-2 font-semibold underline">Unfreeze</button>
            </div>
          )}
          {onTest && kind !== 'question' && kind !== 'note' && (
            <button onClick={() => onTest(node.id)} disabled={testing} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Test to here
            </button>
          )}
          <button onClick={() => onDelete(node.id)} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-200 px-2.5 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:hover:bg-rose-500/10"><Trash2 className="h-3.5 w-3.5" />Delete block</button>
        </div>
      </div>
    </>
  );
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function schedLabel(s: any): string {
  if (!s) return 'Schedule';
  const at = s.at || '';
  if (s.every === 'day') return `Daily ${at}`;
  if (s.every === 'weekday') return `Weekdays ${at}`;
  if (s.every === 'week') return `${DOW[s.dow ?? 1]} ${at}`;
  return 'Scheduled';
}

function SchedulePopover({ schedule, onSave, onClose }: { schedule: any; onSave: (s: any) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<any>(schedule);
  const every = draft?.every || 'off';
  const inputCls = 'mt-1 w-full rounded-lg border border-zinc-200 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';
  const setEvery = (v: string) => setDraft(v === 'off' ? null : { every: v, at: draft?.at || '08:00', dow: draft?.dow ?? 1 });
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-4 top-16 z-50 w-72 space-y-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Run automatically</div>
        <select value={every} onChange={(e) => setEvery(e.target.value)} className={inputCls}>
          <option value="off">Off</option>
          <option value="day">Every day</option>
          <option value="weekday">Weekdays (Mon–Fri)</option>
          <option value="week">Weekly</option>
        </select>
        {draft && (
          <div className="flex gap-2">
            <label className="flex-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Time<input type="time" value={draft.at || '08:00'} onChange={(e) => setDraft({ ...draft, at: e.target.value })} className={inputCls} /></label>
            {draft.every === 'week' && <label className="flex-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Day<select value={draft.dow ?? 1} onChange={(e) => setDraft({ ...draft, dow: Number(e.target.value) })} className={inputCls}>{DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></label>}
          </div>
        )}
        <p className="text-[11px] text-zinc-400">{draft ? `Runs ${schedLabel(draft).toLowerCase()} on your local time. Results land in Run history.` : 'This flow won’t run on its own.'}</p>
        <button onClick={() => onSave(draft)} className="w-full rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">Save schedule</button>
      </div>
    </>
  );
}

export function FlowEditor({ flowId, embedded }: { flowId?: string; embedded?: boolean } = {}) {
  return <ReactFlowProvider><Editor flowId={flowId} embedded={embedded} /></ReactFlowProvider>;
}
