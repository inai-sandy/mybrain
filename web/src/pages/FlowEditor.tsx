import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position,
  useNodesState, useEdgesState, addEdge, useReactFlow,
  type Node, type Edge, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Loader2, Sparkles, Search, Wand2, Server, Plus, X, Boxes } from 'lucide-react';
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
  output: 'border-zinc-400 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800',
};

// Lets a node's inline "+" reach the editor to open the picker targeting that node.
const AddCtx = createContext<(nodeId: string) => void>(() => undefined);

function NodeBox({ id, data }: { id: string; data: any }) {
  const addAfter = useContext(AddCtx);
  return (
    <div className={'relative rounded-lg border px-3 py-2 text-xs shadow-sm ' + (KIND_STYLE[data.kind] || KIND_STYLE.tool)} style={{ minWidth: 130, maxWidth: 220 }}>
      {data.kind !== 'question' && <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-zinc-400" />}
      <div className="truncate font-medium text-zinc-800 dark:text-zinc-100">{data.label}</div>
      {data.sub && <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-zinc-500">{data.sub}</div>}
      {data.kind === 'merge' && <div className="mt-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">{(data.mode || 'ai') === 'ai' ? 'AI synthesise' : 'Stack raw'}</div>}
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

let idc = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}_${idc++}`;

function Editor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { screenToFlowPosition } = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('Untitled flow');
  const [question, setQuestion] = useState('');
  const [palette, setPalette] = useState<Palette>({ generics: [], tools: [], skills: [] });
  const [saving, setSaving] = useState(false);
  const [splitting, setSplitting] = useState(false);
  // picker: { pos, target? } — target set when opened from a node's "+", to auto-connect
  const [picker, setPicker] = useState<{ pos: { x: number; y: number }; target?: string } | null>(null);

  useEffect(() => {
    fetch('/api/flows/palette').then((r) => r.json()).then(setPalette).catch(() => undefined);
    fetch(`/api/flows/${id}`).then((r) => r.json()).then((f) => {
      setName(f.name || 'Untitled flow');
      setQuestion(f.question || '');
      const g = f.graph || { nodes: [], edges: [] };
      if (!g.nodes?.length) {
        setNodes([
          { id: 'question', type: 'box', position: { x: 250, y: 20 }, data: { kind: 'question', label: 'Question', sub: f.question || 'your one big ask' } },
          { id: 'merge', type: 'box', position: { x: 250, y: 360 }, data: { kind: 'merge', label: 'Merge', mode: 'ai' } },
          { id: 'output', type: 'box', position: { x: 250, y: 460 }, data: { kind: 'output', label: 'Output' } },
        ]);
        setEdges([{ id: 'm-o', source: 'merge', target: 'output' }]);
      } else { setNodes(g.nodes); setEdges(g.edges || []); }
    }).catch(() => toast('error', 'Could not load flow'));
    // eslint-disable-next-line
  }, [id]);

  const onConnect = useCallback((c: Connection) => setEdges((e) => addEdge({ ...c, animated: true }, e)), [setEdges]);

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

  async function autoSplit() {
    if (!question.trim()) { toast('error', 'Type the question first'); return; }
    setSplitting(true);
    try {
      const r = await fetch('/api/flows/decompose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      const d = await r.json();
      const subs: string[] = d.subquestions || [];
      if (!subs.length) { toast('error', 'Could not split that — try rephrasing'); return; }
      setNodes((ns) => {
        const others = ns.filter((n) => n.data.kind !== 'subquestion');
        const branches = subs.map((s, i) => ({ id: nid('subq'), type: 'box', position: { x: 60 + i * 210, y: 160 }, data: { kind: 'subquestion', label: `Sub-question ${i + 1}`, sub: s } } as Node));
        return others.concat(branches);
      });
      toast('success', `Split into ${subs.length} sub-questions — use “+” on each to add a skill or tool`);
    } catch { toast('error', 'Could not split'); } finally { setSplitting(false); }
  }

  async function save() {
    setSaving(true);
    try {
      const graph = { nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })), edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: e.animated })) };
      const r = await fetch(`/api/flows/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, question, graph }) });
      if (!r.ok) throw new Error();
      toast('success', 'Flow saved');
    } catch { toast('error', 'Could not save'); } finally { setSaving(false); }
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 1px)' }}>
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <button onClick={() => nav('/flows')} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" /></button>
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:border-zinc-200 focus:border-emerald-400 dark:hover:border-zinc-700" />
        <button onClick={openToolbarPicker} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700"><Plus className="h-4 w-4" />Add block</button>
        <button onClick={save} disabled={saving} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save</button>
      </header>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <span className="shrink-0 text-xs font-medium text-zinc-500">Question</span>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The one big ask… e.g. “Full competitor analysis of Tesla.”" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
        <button onClick={autoSplit} disabled={splitting} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{splitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Auto-split</button>
      </div>
      <div className="relative min-h-0 flex-1" ref={wrap}>
        <AddCtx.Provider value={addAfter}>
          <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }} colorMode="system">
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </AddCtx.Provider>
        {picker && <BlockPicker palette={palette} onPick={pick} onClose={() => setPicker(null)} />}
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

export function FlowEditor() {
  return <ReactFlowProvider><Editor /></ReactFlowProvider>;
}
