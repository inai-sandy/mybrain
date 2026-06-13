import { useEffect, useMemo, useState } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { Wand2, Pencil, Plus, X, GripVertical, Play, Lightbulb, Target, Save, Sparkles, Copy, Check, Terminal } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

type Node = { id: string; type: 'skill' | 'text'; skill?: string; text?: string; slug?: string | null };
type SkillT = { id: string; title: string; slug?: string | null };

function kebab(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Compile the built workflow into a Claude Code prompt the user can paste & run by hand. */
function buildPrompt(ideaTitle: string, ideaContent: string, nodes: Node[]): string {
  const out: string[] = [];
  out.push("I'm working on the idea below. Run the workflow step by step, carrying each step's output into the next.");
  out.push('');
  out.push(`## Idea: ${ideaTitle}`);
  if (ideaContent?.trim()) out.push(ideaContent.trim());
  out.push('');
  if (!nodes.length) {
    out.push('## Workflow\n(Add steps above to build the workflow.)');
    return out.join('\n');
  }
  out.push('## Workflow');
  nodes.forEach((n, i) => {
    const where = i === 0 ? 'the idea above' : "the previous step's result";
    if (n.type === 'skill') {
      const cmd = n.slug || kebab(n.skill || '');
      out.push(`${i + 1}. Use the \`/${cmd}\` skill (${n.skill}) on ${where}.`);
    } else {
      out.push(`${i + 1}. ${(n.text || '').trim() || '(instruction)'}`);
    }
  });
  out.push('');
  out.push('When finished, share the final result.');
  return out.join('\n');
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/** The agentic workflow builder for an idea — a phone-friendly draggable card stack
 *  (Idea → skills + text steps → finish). Execution is wired in a later phase. */
export function IdeaWorkflow({ ideaId, ideaTitle, ideaContent }: { ideaId: string; ideaTitle: string; ideaContent?: string }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [skills, setSkills] = useState<SkillT[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [palette, setPalette] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const prompt = useMemo(() => buildPrompt(ideaTitle, ideaContent || '', nodes), [ideaTitle, ideaContent, nodes]);
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('error', 'Could not copy');
    }
  }

  useEffect(() => {
    fetch(`/api/ideas/${ideaId}/workflow`).then((r) => (r.ok ? r.json() : null)).then((w) => w && setNodes(w.nodes || [])).catch(() => undefined);
    fetch('/api/skills').then((r) => (r.ok ? r.json() : [])).then((d) => setSkills((Array.isArray(d) ? d : d.skills || []).map((s: any) => ({ id: s.id, title: s.title, slug: s.slug })))).catch(() => undefined);
  }, [ideaId]);

  function setN(next: Node[]) {
    setNodes(next);
    setDirty(true);
  }
  function addSkill(title: string, slug?: string | null) {
    setN([...nodes, { id: uid(), type: 'skill', skill: title, slug: slug || null }]);
    setPalette(false);
  }
  function addText() {
    setN([...nodes, { id: uid(), type: 'text', text: '' }]);
    setPalette(false);
  }
  function editText(id: string, text: string) {
    setN(nodes.map((n) => (n.id === id ? { ...n, text } : n)));
  }
  function remove(id: string) {
    setN(nodes.filter((n) => n.id !== id));
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(`/api/ideas/${ideaId}/workflow`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes }) });
      if (r.ok) {
        toast('success', 'Workflow saved');
        setDirty(false);
      } else toast('error', 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-indigo-300/40 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-500/5 to-transparent p-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="flex items-center gap-2 font-semibold"><Sparkles size={16} className="text-indigo-400" /> Workflow</h2>
        <div className="flex items-center gap-2">
          {dirty && <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 disabled:opacity-50"><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button>}
        </div>
      </div>
      <p className="text-xs text-zinc-500 mb-3">Build an agent flow: drag steps in order, drop in your skills and text instructions. Run comes online soon.</p>

      {/* Start */}
      <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/5 p-3 flex items-start gap-2.5">
        <span className="rounded-lg bg-emerald-500/15 text-emerald-500 p-1.5 shrink-0"><Lightbulb size={15} /></span>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-zinc-400">Start · this idea</div>
          <div className="text-sm font-medium truncate">{ideaTitle}</div>
        </div>
      </div>

      <Connector />

      {/* The editable node stack */}
      {nodes.length > 0 && (
        <Reorder.Group axis="y" values={nodes} onReorder={setN} className="space-y-0">
          {nodes.map((n) => (
            <WorkflowCard key={n.id} node={n} onEditText={editText} onRemove={remove} />
          ))}
        </Reorder.Group>
      )}

      {/* Add step */}
      <button onClick={() => setPalette(true)} className="w-full mt-1 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-indigo-400/50 text-indigo-500 hover:bg-indigo-500/5 py-2.5 text-sm font-medium">
        <Plus size={15} /> Add a step
      </button>

      <Connector />

      {/* Finish */}
      <div className="rounded-xl border border-zinc-300/50 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 flex items-start gap-2.5">
        <span className="rounded-lg bg-zinc-500/15 text-zinc-500 p-1.5 shrink-0"><Target size={15} /></span>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-400">Finish</div>
          <div className="text-sm font-medium">Save the result back to this idea</div>
        </div>
      </div>

      {/* Claude Code prompt — run it manually now (live-updates as you build) */}
      <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Terminal size={14} className="text-emerald-500" /> Claude Code prompt</h3>
          <button onClick={copyPrompt} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 text-xs">
            {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
          </button>
        </div>
        <p className="text-[11px] text-zinc-400 mb-2">Paste this into your Claude Code to run the flow by hand — it updates as you add or reorder steps.</p>
        <pre className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300 font-mono max-h-64 overflow-auto bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5">{prompt}</pre>
      </div>

      {/* Run (stub until the agent engine ships) */}
      <button disabled title="Auto-run is coming soon — use the prompt above for now" className="w-full mt-3 flex items-center justify-center gap-2 rounded-xl bg-zinc-200 dark:bg-zinc-800 text-zinc-400 py-3 text-sm font-medium cursor-not-allowed">
        <Play size={15} /> Auto-run — coming soon (use the prompt above)
      </button>

      {palette && (
        <Sheet onClose={() => setPalette(false)}>
          {(close) => (
            <>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold">Add a step</h3>
                <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
              </div>
              <button onClick={addText} className="w-full flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 mb-2 text-left hover:border-indigo-500/40">
                <span className="rounded-lg bg-amber-500/15 text-amber-500 p-2"><Pencil size={16} /></span>
                <div><div className="font-medium text-sm">Text / instruction</div><div className="text-xs text-zinc-500">Steer the flow — add as many as you like</div></div>
              </button>
              <div className="text-[11px] uppercase tracking-wide text-zinc-400 mt-3 mb-1.5">Your skills</div>
              {skills.length ? (
                <div className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-1">
                  {skills.map((s) => (
                    <button key={s.id} onClick={() => addSkill(s.title, s.slug)} className="w-full flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 p-2.5 text-left hover:border-indigo-500/40">
                      <span className="rounded-lg bg-indigo-500/15 text-indigo-500 p-2 shrink-0"><Wand2 size={15} /></span>
                      <span className="text-sm truncate">{s.title}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-400">No skills tracked yet — add some in the Skills section first.</p>
              )}
            </>
          )}
        </Sheet>
      )}
    </section>
  );
}

function Connector() {
  return <div className="flex justify-center"><div className="w-px h-4 bg-indigo-400/40" /></div>;
}

/** One draggable node card (skill or text). */
function WorkflowCard({ node, onEditText, onRemove }: { node: Node; onEditText: (id: string, t: string) => void; onRemove: (id: string) => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item value={node} dragListener={false} dragControls={controls} className="my-1.5">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex items-start gap-2">
        <span onPointerDown={(e) => controls.start(e)} className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing touch-none text-zinc-300 dark:text-zinc-600"><GripVertical size={16} /></span>
        {node.type === 'skill' ? (
          <>
            <span className="rounded-lg bg-indigo-500/15 text-indigo-500 p-1.5 shrink-0"><Wand2 size={14} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wide text-zinc-400">Skill</div>
              <div className="text-sm font-medium break-words">{node.skill}</div>
            </div>
          </>
        ) : (
          <>
            <span className="rounded-lg bg-amber-500/15 text-amber-500 p-1.5 shrink-0"><Pencil size={14} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wide text-zinc-400">Text / instruction</div>
              <textarea
                value={node.text || ''}
                onChange={(e) => onEditText(node.id, e.target.value)}
                rows={2}
                placeholder="e.g. turn this into a one-pager, keep it under 500 words…"
                className="w-full mt-1 resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500"
              />
            </div>
          </>
        )}
        <button onClick={() => onRemove(node.id)} className="shrink-0 p-1 text-zinc-400 hover:text-rose-600"><X size={15} /></button>
      </div>
    </Reorder.Item>
  );
}
