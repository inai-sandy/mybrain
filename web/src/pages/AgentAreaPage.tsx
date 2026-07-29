import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Loader2, CheckCircle2, XCircle, PauseCircle, CalendarClock, ChevronRight, Wrench, Trash2, Pencil, Check, X } from 'lucide-react';
import { useGoBack } from '../ui/useGoBack';
import { useToast } from '../ui/Toast';
import { NewAgentForm, timeAgo } from './Agents';
import { ToolPicker, type CatalogTool } from '../ui/ToolPicker';

// `id` is the catalog id (BEA-1167). Older saved tools have no id — they were typed by hand and
// still render fine; picking from the catalog is how new ones are added.
type AreaTool = { id?: string; kind: string; name: string; note?: string; status?: string };

const TOOL_KIND: Record<string, { label: string; cls: string }> = {
  skill: { label: 'Skill', cls: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' },
  api: { label: 'API', cls: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' },
  mcp: { label: 'MCP', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' },
  cli: { label: 'CLI', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' },
};

/**
 * One agent AREA (BEA-1098): the container the owner calls "an agent" — its identity, its Tools
 * toolbox, and the list of jobs inside it. Jobs open their own home (/agent/a/:id).
 */
export function AgentAreaPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const goBack = useGoBack('/agent');
  const toast = useToast();
  const [area, setArea] = useState<any>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [picking, setPicking] = useState(false); // the shared catalog picker (BEA-1167)
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customKind, setCustomKind] = useState('api');

  async function saveTools(next: AreaTool[]) {
    const r = await fetch(`/api/agent/areas/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tools: next }) });
    if (r.ok) load(); else toast('error', 'Could not save the tools');
  }

  /** Catalog kinds map onto the badge kinds this page already shows. */
  function kindOf(k: string) { return k === 'skill' ? 'skill' : k === 'mcp' ? 'mcp' : 'api'; }

  /** Replace every catalog-backed tool with the new pick; hand-typed customs are left alone. */
  function savePicked(_ids: string[], picked: CatalogTool[]) {
    const customs = (area?.tools || []).filter((t: AreaTool) => !t.id);
    const next: AreaTool[] = picked.map((t) => ({ id: t.id, kind: kindOf(t.kind), name: t.name, note: t.description, status: t.connected ? 'installed' : 'needed' }));
    saveTools([...next, ...customs]);
  }

  function addCustom() {
    const n = customName.trim();
    if (!n) return;
    saveTools([...(area?.tools || []), { kind: customKind, name: n, status: 'needed' }]);
    setCustomName(''); setCustomOpen(false);
  }

  function load() {
    fetch(`/api/agent/areas/${id}`).then((r) => (r.ok ? r.json() : null)).then((d) => { setArea(d); if (d) { setName(d.name); setDesc(d.description || ''); } }).catch(() => setArea(null));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function saveIdentity() {
    const r = await fetch(`/api/agent/areas/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: desc }) });
    if (r.ok) { setEditing(false); load(); toast('success', 'Saved'); } else toast('error', 'Could not save');
  }
  async function removeArea(withJobs: boolean) {
    const r = await fetch(`/api/agent/areas/${id}${withJobs ? '?withJobs=1' : ''}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { toast('success', 'Agent removed'); nav('/agent'); }
    else toast('error', d.message || 'Could not remove');
  }

  if (area === null) return <div className="space-y-3"><div className="h-16 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /><div className="h-40 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /></div>;
  if (!area?.id) return <div className="p-6 text-sm text-zinc-500">This agent doesn't exist any more. <button onClick={() => nav('/agent')} className="text-emerald-600 hover:underline">Back to Agents</button></div>;

  const color = area.color || '#818cf8';
  const jobs = area.jobs || [];
  const tools: AreaTool[] = area.tools || [];

  return (
    <div className="space-y-4">
      <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Agents</button>

      <header className="flex items-start gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl" style={{ background: color + '22' }}>{area.icon || '🤖'}</span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-1.5">
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-zinc-200 bg-transparent px-2 py-1 text-lg font-bold outline-none focus:border-emerald-400 dark:border-zinc-700" />
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is this agent for?" className="w-full rounded-lg border border-zinc-200 bg-transparent px-2 py-1 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
              <div className="flex gap-1.5">
                <button onClick={saveIdentity} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white"><Check className="h-3.5 w-3.5" />Save</button>
                <button onClick={() => { setEditing(false); setName(area.name); setDesc(area.description || ''); }} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-zinc-500 dark:border-zinc-700"><X className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ) : (
            <>
              <h1 className="truncate text-xl font-bold">{area.name}</h1>
              <p className="truncate text-sm text-zinc-500">{area.description || `${jobs.length} job${jobs.length === 1 ? '' : 's'}`}</p>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-1">
            <button onClick={() => setEditing(true)} title="Rename" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><Pencil className="h-4 w-4" /></button>
            <button onClick={() => {
              const msg = jobs.length === 0
                ? `Remove "${area.name}"? It has no jobs.`
                : `Delete "${area.name}" and its ${jobs.length} job${jobs.length === 1 ? '' : 's'}? All their run history goes too. Saved documents are kept.`;
              if (window.confirm(msg)) removeArea(jobs.length > 0);
            }} title="Delete this agent" className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
          </div>
        )}
      </header>

      {/* Tools — the agent's visible toolbox (BEA-1100): filled by import/inference, editable here. */}
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4 text-zinc-400" />Tools</h2>
          <button onClick={() => setPicking(true)} className="text-xs font-medium text-emerald-600 hover:underline">{tools.length ? 'Choose tools' : '＋ Choose tools'}</button>
        </div>
        {tools.length === 0 ? (
          <p className="mt-1.5 text-xs text-zinc-400">Nothing picked yet. Choose from your brain, the web, Google, your skills and MCP servers — this agent can only use what you tick.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tools.map((t, i) => {
              const k = TOOL_KIND[t.kind] || TOOL_KIND.api;
              return (
                <span key={i} title={t.note || ''} className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ' + k.cls}>
                  <span className="opacity-60">{k.label}</span>{t.name}
                  {t.status === 'needed' && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">needs connecting</span>}
                  <button onClick={() => saveTools(tools.filter((_, j) => j !== i))} title="Remove" className="opacity-50 hover:opacity-100">✕</button>
                </span>
              );
            })}
          </div>
        )}
        {/* The escape hatch: something the catalog doesn't know about yet. */}
        {customOpen ? (
          <div className="mt-2 flex gap-1.5">
            <select value={customKind} onChange={(e) => setCustomKind(e.target.value)} className="shrink-0 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-900">
              <option value="skill">Skill</option><option value="api">API</option><option value="mcp">MCP</option><option value="cli">CLI</option>
            </select>
            <input autoFocus value={customName} onChange={(e) => setCustomName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addCustom()} placeholder="Name it…" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-emerald-400 dark:border-zinc-700" />
            <button onClick={addCustom} disabled={!customName.trim()} className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">Add</button>
            <button onClick={() => { setCustomOpen(false); setCustomName(''); }} className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setCustomOpen(true)} className="mt-2 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">＋ Add something else by name</button>
        )}

        {picking && (
          <ToolPicker
            value={tools.filter((t) => t.id).map((t) => t.id!)}
            onSave={savePicked}
            onClose={() => setPicking(false)}
            title={`Tools for ${area.name}`}
            subtitle="This agent can only use what you tick here."
          />
        )}
      </section>

      {/* Jobs */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-500">Jobs · {jobs.length}</h2>
          <button onClick={() => setShowNew((v) => !v)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"><Plus className="h-4 w-4" />New job</button>
        </div>
        {showNew && <NewAgentForm areaId={area.id} onCreated={() => { setShowNew(false); load(); }} onCancel={() => setShowNew(false)} />}
        {jobs.length === 0 && !showNew ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">No jobs yet — give this agent its first one.</div>
        ) : (
          jobs.map((j: any) => (
            <button key={j.id} onClick={() => nav(`/agent/a/${j.id}`)} className="flex w-full items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 text-left transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl" style={{ background: (j.color || color) + '22' }}>{j.icon || '📄'}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{j.name}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                  {j.lastRun ? (
                    j.lastRun.status === 'done' ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" />ran {timeAgo(j.lastRun.at)}</span>
                    : j.lastRun.status === 'failed' ? <span className="inline-flex items-center gap-1 text-rose-600"><XCircle className="h-3 w-3" />failed {timeAgo(j.lastRun.at)}</span>
                    : j.lastRun.status === 'running' ? <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400"><Loader2 className="h-3 w-3 animate-spin" />running</span>
                    : <span className="inline-flex items-center gap-1 text-amber-600"><PauseCircle className="h-3 w-3" />waiting on you</span>
                  ) : <span>never ran</span>}
                  {j.scheduleText && <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />{j.scheduleText}</span>}
                  {!j.enabled && <span className="rounded-full bg-zinc-100 px-1.5 dark:bg-zinc-800">paused</span>}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />
            </button>
          ))
        )}
      </section>
    </div>
  );
}
