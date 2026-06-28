import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position,
  useNodesState, useEdgesState, addEdge, useReactFlow,
  type Node, type Edge, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Loader2, Sparkles, Search, Wand2, Server, Plus } from 'lucide-react';
import { useToast } from '../ui/Toast';

type PaletteItem = { type: 'skill' | 'tool'; id: string; name: string; description?: string; group?: string };

const KIND_STYLE: Record<string, string> = {
  question: 'border-emerald-400 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10',
  subquestion: 'border-indigo-400 bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/10',
  skill: 'border-violet-400 bg-violet-50 dark:border-violet-500/40 dark:bg-violet-500/10',
  tool: 'border-sky-400 bg-sky-50 dark:border-sky-500/40 dark:bg-sky-500/10',
  merge: 'border-amber-400 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10',
  output: 'border-zinc-400 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800',
};

function NodeBox({ data }: { data: any }) {
  return (
    <div className={'rounded-lg border px-3 py-2 text-xs shadow-sm ' + (KIND_STYLE[data.kind] || KIND_STYLE.tool)} style={{ minWidth: 130, maxWidth: 220 }}>
      {data.kind !== 'question' && <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-zinc-400" />}
      <div className="truncate font-medium text-zinc-800 dark:text-zinc-100">{data.label}</div>
      {data.sub && <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-zinc-500">{data.sub}</div>}
      {data.kind === 'merge' && <div className="mt-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">{(data.mode || 'ai') === 'ai' ? 'AI synthesise' : 'Stack raw'}</div>}
      {data.kind !== 'output' && <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-zinc-400" />}
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
  const [palette, setPalette] = useState<{ skills: PaletteItem[]; tools: PaletteItem[] }>({ skills: [], tools: [] });
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [splitting, setSplitting] = useState(false);

  useEffect(() => {
    fetch('/api/flows/palette').then((r) => r.json()).then(setPalette).catch(() => undefined);
    fetch(`/api/flows/${id}`).then((r) => r.json()).then((f) => {
      setName(f.name || 'Untitled flow');
      setQuestion(f.question || '');
      const g = f.graph || { nodes: [], edges: [] };
      if (!g.nodes?.length) {
        // seed with a Question node + a Merge + Output
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

  function addNode(item: PaletteItem, pos: { x: number; y: number }) {
    setNodes((ns) => ns.concat({ id: nid(item.type), type: 'box', position: pos, data: { kind: item.type, label: item.name, sub: item.description, refId: item.id } }));
  }
  const onDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    const raw = ev.dataTransfer.getData('application/flow');
    if (!raw) return;
    const item = JSON.parse(raw) as PaletteItem;
    addNode(item, screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
    // eslint-disable-next-line
  }, [screenToFlowPosition]);
  const onDragOver = useCallback((ev: React.DragEvent) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; }, []);

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
        const branches = subs.map((s, i) => ({ id: nid('subq'), type: 'box', position: { x: 60 + i * 200, y: 160 }, data: { kind: 'subquestion', label: `Sub-question ${i + 1}`, sub: s } } as Node));
        return others.concat(branches);
      });
      // wire question → each subquestion
      setEdges((es) => {
        const kept = es.filter((e) => e.source !== 'question');
        return kept; // edges to new branches are drawn by the user (or we could auto-wire); keep simple
      });
      toast('success', `Split into ${subs.length} sub-questions — drag skills/tools onto each`);
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

  const filt = (arr: PaletteItem[]) => arr.filter((x) => !filter || (x.name + ' ' + (x.description || '')).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 1px)' }}>
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <button onClick={() => nav('/flows')} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" /></button>
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:border-zinc-200 focus:border-emerald-400 dark:hover:border-zinc-700" />
        <button onClick={save} disabled={saving} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save</button>
      </header>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <span className="shrink-0 text-xs font-medium text-zinc-500">Question</span>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The one big ask… e.g. “Full competitor analysis of Tesla.”" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
        <button onClick={autoSplit} disabled={splitting} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{splitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Auto-split</button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* palette */}
        <aside className="w-52 shrink-0 overflow-auto border-r border-zinc-200 p-2 dark:border-zinc-800">
          <div className="relative mb-2"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-zinc-400" /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a block…" className="w-full rounded-lg border border-zinc-200 bg-transparent py-1.5 pl-7 pr-2 text-xs outline-none focus:border-emerald-400 dark:border-zinc-700" /></div>
          <PaletteGroup icon={<Wand2 className="h-3.5 w-3.5 text-violet-500" />} title="Skills" items={filt(palette.skills)} />
          <PaletteGroup icon={<Server className="h-3.5 w-3.5 text-sky-500" />} title="Tools & connectors" items={filt(palette.tools)} />
        </aside>
        {/* canvas */}
        <div className="min-w-0 flex-1" ref={wrap} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }} colorMode="system">
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

function PaletteGroup({ icon, title, items }: { icon: React.ReactNode; title: string; items: PaletteItem[] }) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{icon}{title}</div>
      <div className="space-y-1">
        {items.length === 0 ? <div className="px-1 text-[11px] text-zinc-400">none</div> : items.map((it) => (
          <div key={it.type + it.id} draggable onDragStart={(e) => { e.dataTransfer.setData('application/flow', JSON.stringify(it)); e.dataTransfer.effectAllowed = 'move'; }}
            className="group flex cursor-grab items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs hover:border-emerald-400 active:cursor-grabbing dark:border-zinc-700 dark:bg-zinc-900">
            <Plus className="h-3 w-3 shrink-0 text-zinc-300 group-hover:text-emerald-500" />
            <span className="truncate" title={it.description}>{it.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FlowEditor() {
  return <ReactFlowProvider><Editor /></ReactFlowProvider>;
}
