import { useEffect, useMemo, useState } from 'react';
import { Wand2, Pencil, Plus, X, ChevronUp, ChevronDown, Play, Lightbulb, Target, Save, Sparkles, Copy, Check, Terminal, RotateCcw } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

type Node = { id: string; type: 'skill' | 'text'; skill?: string; text?: string; slug?: string | null };
type SkillT = { id: string; title: string; slug?: string | null };

function kebab(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Compile the built workflow into a Claude Code prompt the user can paste & run by hand. */
// The workflow prompt IS the idea's deep-research prompt, verbatim — then any extra workflow steps
// are appended below. The base must stay identical to what the idea's Deep-research prompt shows. (BEA-957)
function buildPrompt(researchPrompt: string, nodes: Node[]): string {
  const base = (researchPrompt || '').trim();
  if (!nodes.length) return base || '(No deep-research prompt for this idea yet.)';
  const out: string[] = [base, '', '---', '', '## Additional workflow steps', "After the research above, continue with these steps, carrying each step's output into the next:"];
  nodes.forEach((n, i) => {
    const where = i === 0 ? 'the research result above' : "the previous step's result";
    if (n.type === 'skill') {
      const cmd = n.slug || kebab(n.skill || '');
      out.push(`${i + 1}. Use the \`/${cmd}\` skill (${n.skill}) on ${where}.`);
    } else {
      out.push(`${i + 1}. ${(n.text || '').trim() || '(instruction)'}`);
    }
  });
  out.push('', 'When finished, share the final result.');
  return out.join('\n');
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/** The agentic workflow builder for an idea — a phone-friendly draggable card stack
 *  (Idea → skills + text steps → finish). Execution is wired in a later phase. */
export function IdeaWorkflow({ ideaId, ideaTitle, researchPrompt }: { ideaId: string; ideaTitle: string; researchPrompt?: string }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [skills, setSkills] = useState<SkillT[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [palette, setPalette] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState<string | null>(null); // null = use the auto-generated prompt
  const toast = useToast();

  const autoPrompt = useMemo(() => buildPrompt(researchPrompt || '', nodes), [researchPrompt, nodes]);
  const prompt = editedPrompt ?? autoPrompt; // what's shown / copied / saved
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
    fetch(`/api/ideas/${ideaId}/workflow`).then((r) => (r.ok ? r.json() : null)).then((w) => { if (w) { setNodes(w.nodes || []); setEditedPrompt(w.customPrompt ?? null); } }).catch(() => undefined);
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
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= nodes.length) return;
    const next = nodes.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setN(next);
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(`/api/ideas/${ideaId}/workflow`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes, customPrompt: editedPrompt }) });
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
      <p className="text-xs text-zinc-500 mb-3">Build an agent flow: add your skills and text instructions, reorder with the arrows. Run comes online soon.</p>

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
        <div>
          {nodes.map((n, i) => (
            <WorkflowCard key={n.id} node={n} index={i} total={nodes.length} onEditText={editText} onRemove={remove} onMove={move} />
          ))}
        </div>
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

      {/* Claude Code prompt — editable; run it manually now */}
      <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Terminal size={14} className="text-emerald-500" /> Claude Code prompt {editedPrompt !== null && <span className="text-[10px] uppercase tracking-wide rounded-full bg-amber-500/15 text-amber-600 px-2 py-0.5">edited</span>}</h3>
          <div className="flex items-center gap-1.5">
            {editedPrompt !== null && (
              <button onClick={() => { setEditedPrompt(null); setDirty(true); }} title="Discard edits, rebuild from the steps" className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-indigo-500"><RotateCcw size={13} /> Regenerate</button>
            )}
            <button onClick={copyPrompt} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 text-xs">
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-zinc-400 mb-2">Edit it freely, then paste into your Claude Code. Untouched, it rebuilds itself as you change the steps; once you edit, your version is kept (tap Regenerate to rebuild). Remember to Save.</p>
        <textarea
          value={prompt}
          onChange={(e) => { setEditedPrompt(e.target.value); setDirty(true); }}
          rows={10}
          spellCheck={false}
          className="w-full resize-y text-xs text-zinc-700 dark:text-zinc-200 font-mono max-h-80 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 outline-none focus:border-emerald-500"
        />
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

/** One node card (skill or text). Reorder via the up/down buttons — no drag library (avoids a layout loop). */
function WorkflowCard({ node, index, total, onEditText, onRemove, onMove }: { node: Node; index: number; total: number; onEditText: (id: string, t: string) => void; onRemove: (id: string) => void; onMove: (i: number, dir: -1 | 1) => void }) {
  return (
    <div className="my-1.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex items-start gap-2">
      <div className="flex flex-col -my-0.5 shrink-0 text-zinc-400">
        <button onClick={() => onMove(index, -1)} disabled={index === 0} aria-label="Move up" className="p-0.5 disabled:opacity-25 hover:text-indigo-500"><ChevronUp size={15} /></button>
        <button onClick={() => onMove(index, 1)} disabled={index === total - 1} aria-label="Move down" className="p-0.5 disabled:opacity-25 hover:text-indigo-500"><ChevronDown size={15} /></button>
      </div>
      {node.type === 'skill' ? (
        <>
          <span className="rounded-lg bg-indigo-500/15 text-indigo-500 p-1.5 shrink-0"><Wand2 size={14} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-zinc-400">Skill · step {index + 1}</div>
            <div className="text-sm font-medium break-words">{node.skill}</div>
          </div>
        </>
      ) : (
        <>
          <span className="rounded-lg bg-amber-500/15 text-amber-500 p-1.5 shrink-0"><Pencil size={14} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-zinc-400">Text · step {index + 1}</div>
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
      <button onClick={() => onRemove(node.id)} aria-label="Remove step" className="shrink-0 p-1 text-zinc-400 hover:text-rose-600"><X size={15} /></button>
    </div>
  );
}
