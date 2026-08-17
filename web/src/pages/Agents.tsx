import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bot, Play, Loader2, FileText, CheckCircle2, AlertTriangle, Clock, XCircle, PauseCircle, Plus, Trash2, Power, History as HistoryIcon, CalendarClock, Sparkles, Search, ShieldCheck, X, Send, Pencil, MoreHorizontal, Copy, Check } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { Sheet } from '../ui/Sheet';
import { GrowTextarea } from '../ui/GrowTextarea';
import { DictateButton } from '../ui/DictateButton';
import { DepthDial, type Depth } from '../ui/DepthDial';
import { STARTERS, type Starter } from '../ui/agentStarters';
import { enablePush, pushPermission, pushEnabledHere } from '../ui/push';
import { SchedulePicker, schedText, type Sched } from '../ui/SchedulePicker';
import { AgentBuilder } from './AgentBuilder';
import { EMPTY_THRESHOLD, KEEP_AS_FETCHED, OutputDestPicker, ThresholdDraft, ToolArgsEditor, WatchModePicker, thresholdOfDraft } from '../ui/agentJobFields';

/** What a Social result hands the builder (BEA-1357): the tool, the exact arguments just used, a label. */
export type SocialPrefill = { tool: string; args: Record<string, any>; label?: string; mode?: string };

/** "Instagram · Search · smarthomeindia" — the label plus the argument values, in the owner's words. */
export function socialAgentName(p: SocialPrefill): string {
  const vals = Object.values(p.args || {}).filter((v) => v !== '' && v !== null && v !== undefined).map((v) => String(v)).slice(0, 3);
  const base = p.label || p.tool.replace(/^svc:/, '').replace('.', ' · ');
  return [base, ...vals].join(' · ').slice(0, 120);
}

/** Read `?builder=1&tool=&args=&label=` off the Agents URL. Null when it is not a Social handoff. */
export function readSocialPrefill(params: URLSearchParams): SocialPrefill | null {
  const tool = params.get('tool') || '';
  if (params.get('builder') !== '1' || !/^svc:[a-z0-9_]+\.[a-z0-9_]+$/.test(tool)) return null;
  let args: Record<string, any> = {};
  try { const a = JSON.parse(params.get('args') || '{}'); if (a && typeof a === 'object' && !Array.isArray(a)) args = a; } catch { args = {}; }
  const mode = params.get('mode') || '';
  return { tool, args, label: params.get('label') || undefined, ...(mode === 'watch' || mode === 'alert' ? { mode } : {}) };
}

export type Run = { id: string; title?: string; status: string; startedAt: string; endedAt?: string | null; outputDocId?: string | null };

const STATUS: Record<string, { label: string; cls: string; icon: any; spin?: boolean }> = {
  running: { label: 'Running', cls: 'text-blue-600 bg-blue-50 dark:text-blue-300 dark:bg-blue-500/10', icon: Loader2, spin: true },
  awaiting_input: { label: 'Waiting on you', cls: 'text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10', icon: PauseCircle },
  waiting: { label: 'Waiting on you', cls: 'text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10', icon: PauseCircle },
  paused: { label: 'Paused — waiting on you', cls: 'text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10', icon: PauseCircle },
  scheduled: { label: 'Scheduled', cls: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800', icon: Clock },
  done: { label: 'Done', cls: 'text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/10', icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'text-red-600 bg-red-50 dark:text-red-300 dark:bg-red-500/10', icon: XCircle },
  cancelled: { label: 'Cancelled', cls: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800', icon: XCircle },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] || STATUS.scheduled;
  const Icon = s.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      <Icon className={'h-3 w-3 ' + (s.spin ? 'animate-spin' : '')} />
      {s.label}
    </span>
  );
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

function elapsed(iso?: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- the home payload (BEA-1087) ----------
type WaitItem = { source: 'agent' | 'flow'; waitpointId: string | null; runId: string; title: string; icon: string; color: string; question: string; kind: string; options: any; defaultValue?: string | null; askedAt: string; expiresAt?: string | null; paused?: boolean };
type RunningItem = { source: 'agent' | 'flow'; id: string; title: string; startedAt: string; steps: { label: string; status?: string }[] };
type LandedItem = { source: 'agent' | 'flow'; id: string; title: string; status: string; endedAt?: string | null; outputDocId?: string | null; error?: string | null };
type ShelfAgent = any; // shaped agent + { category, color, lastRun }
type HomeData = { waiting: WaitItem[]; running: RunningItem[]; landed: LandedItem[]; agents: ShelfAgent[] };

const runUrl = (source: 'agent' | 'flow', id: string) => (source === 'flow' ? `/flows/runs/${id}` : `/agent/runs/${id}`);

/** One "the agent needs you" card — answerable in place. (BEA-1066 display, inside BEA-1087) */
function WaitingCard({ w, focus, onAnswered }: { w: WaitItem; focus: boolean; onAnswered: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [focus]);

  async function answer(value: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = w.source === 'flow'
        ? await fetch(`/api/flows/runs/${w.runId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: value }) })
        : await fetch(`/api/agent/waitpoints/${w.waitpointId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not send the answer');
      if (d?.ok === false && d?.message) throw new Error(d.message);
      toast('success', 'Answered — resuming the run');
      onAnswered();
    } catch (e: any) {
      toast('error', e?.message || 'Could not answer');
      setBusy(false);
    }
  }

  const choices: string[] = Array.isArray(w.options) ? w.options.filter((o: any) => typeof o === 'string') : [];
  const isApprove = w.kind === 'approve_edit_reject';
  const draft = !isApprove ? '' : typeof w.options === 'object' && w.options && !Array.isArray(w.options) ? String((w.options as any).description || (w.options as any).command || '') : '';
  // The four clear kinds of ask (BEA-1067) — the tag tells you at a glance what's being asked of you.
  const tag = isApprove
    ? { label: 'Check before it acts', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' }
    : w.kind === 'choice'
      ? { label: 'Pick one', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' }
      : w.kind === 'form'
        ? { label: 'Fill this in', cls: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' }
        : { label: 'Answer a question', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' };

  return (
    <div ref={ref} id={w.waitpointId ? `wp-${w.waitpointId}` : `fw-${w.runId}`}
      className={'rounded-2xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-500/25 dark:bg-amber-500/5 ' + (focus ? 'ring-2 ring-amber-400' : '')}>
      <span className={'mb-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ' + tag.cls}>{tag.label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xl leading-none">{w.icon}</span>
        <button onClick={() => nav(runUrl(w.source, w.runId))} className="min-w-0 truncate text-sm font-semibold hover:text-amber-700 dark:hover:text-amber-300">{w.title}</button>
        <span className="ml-auto shrink-0 text-[11px] text-amber-700/80 dark:text-amber-300/80">asked {timeAgo(w.askedAt)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-xl bg-white/70 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200">{w.question}</p>
      {isApprove && draft && <p className="mt-2 rounded-lg border-l-2 border-amber-400 bg-white/50 px-3 py-1.5 text-xs text-zinc-600 dark:bg-zinc-900/40 dark:text-zinc-300">{draft}</p>}
      {/* The quiet double-check's warning (BEA-1078) — only shows when something looked off. */}
      {isApprove && typeof w.options === 'object' && w.options && (w.options as any).validatorNote && (
        <p className="mt-2 rounded-lg bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-700 dark:text-rose-300">⚠️ Check closely: {(w.options as any).validatorNote}</p>
      )}

      {editing || (!choices.length && !isApprove) ? (
        <div className="mt-3 flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) answer(text.trim()); }} autoFocus={editing}
            placeholder={editing ? 'Your version…' : 'Type your answer…'}
            className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm outline-none focus:border-amber-500 dark:border-amber-500/40 dark:bg-zinc-900" />
          <button onClick={() => text.trim() && answer(text.trim())} disabled={busy || !text.trim()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-400 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Send
          </button>
        </div>
      ) : isApprove ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => answer('approve')} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Approve</button>
          <button onClick={() => { setEditing(true); setText(draft); }} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3.5 py-2 text-sm font-medium hover:border-amber-400 dark:border-zinc-700"><Pencil className="h-4 w-4" />Edit first</button>
          <button onClick={() => answer('reject')} disabled={busy} className="rounded-lg px-3.5 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">Don't</button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {choices.map((c) => (
            <button key={c} onClick={() => answer(c)} disabled={busy}
              className="rounded-full border border-amber-300 bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-700 hover:border-amber-500 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-amber-500/10">{c}</button>
          ))}
          <button onClick={() => setEditing(true)} disabled={busy} className="rounded-full px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">something else…</button>
        </div>
      )}
      {w.paused ? (
        <div className="mt-2 text-[11px] text-amber-600/80 dark:text-amber-400/70">⏸ it waited a while and paused itself — answering continues it from where it stopped</div>
      ) : w.expiresAt ? (
        <div className="mt-2 text-[11px] text-amber-600/80 dark:text-amber-400/70">⏳ falls back to the safe default {timeAgo(w.expiresAt).includes('ago') ? 'soon' : 'by ' + new Date(w.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      ) : null}
    </div>
  );
}

/** One live run with its readable last steps. */
// RunningCard removed with the "Running now" strip (BEA-1181) — History shows live runs.

/**
 * The ordinary operations on an agent, reachable from the list (BEA-1182) — the owner went looking
 * for rename and delete and couldn't find them, because they were buried inside the agent's page.
 */
function AgentCardMenu({ area, onChanged }: { area: any; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(area.name);
  const [desc, setDesc] = useState(area.description || '');
  const [icon, setIcon] = useState(area.icon || '🤖');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  async function save() {
    if (!name.trim()) { toast('error', 'It needs a name'); return; }
    setBusy(true);
    const r = await fetch(`/api/agent/areas/${area.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), description: desc.trim(), icon }) });
    setBusy(false);
    if (r.ok) { setEditing(false); onChanged(); toast('success', 'Saved'); } else toast('error', 'Could not save');
  }
  async function duplicate() {
    setBusy(true);
    const r = await fetch(`/api/agent/areas/${area.id}/duplicate`, { method: 'POST' });
    setBusy(false);
    if (r.ok) { onChanged(); toast('success', `Copied — "${area.name} copy" is ready to edit`); } else toast('error', 'Could not copy');
  }
  async function remove() {
    const n = area.jobCount || 0;
    const msg = n === 0
      ? `Delete "${area.name}"? It has no jobs.`
      : `Delete "${area.name}" and its ${n} job${n === 1 ? '' : 's'}? Their run history goes too. Saved documents are kept.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    const r = await fetch(`/api/agent/areas/${area.id}${n > 0 ? '?withJobs=1' : ''}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { onChanged(); toast('success', 'Agent deleted'); } else toast('error', d.message || 'Could not delete');
  }

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={`Actions for ${area.name}`}
        className="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-zinc-400 opacity-100 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} className="absolute right-2 top-10 z-20 w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <button onClick={() => { setOpen(false); setEditing(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil className="h-3.5 w-3.5 text-zinc-400" />Rename &amp; edit</button>
          <button onClick={() => { setOpen(false); duplicate(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Copy className="h-3.5 w-3.5 text-zinc-400" />Duplicate</button>
          <button onClick={() => { setOpen(false); remove(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 className="h-3.5 w-3.5" />Delete</button>
        </div>
      )}
      {editing && (
        <Sheet onClose={() => setEditing(false)} size="sm">
          {(close) => (
            <div className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">Edit agent</h2>
              <div className="flex gap-2">
                <input value={icon} onChange={(e) => setIcon(e.target.value.slice(0, 4))} aria-label="Icon" className="w-14 shrink-0 rounded-lg border border-zinc-200 bg-transparent px-2 py-2 text-center text-lg outline-none focus:border-emerald-400 dark:border-zinc-700" />
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 sm:text-sm" />
              </div>
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is this agent for?" className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 sm:text-sm" />
              <div className="flex justify-end gap-2">
                <button onClick={close} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">Cancel</button>
                <button onClick={async () => { await save(); close(); }} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save</button>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </>
  );
}

function ImportGithubModal({ onDone, onClose }: { onDone: (url?: string) => void; onClose: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [installDeps, setInstallDeps] = useState(true);

  async function loadPreview() {
    if (!url.trim()) { toast('error', 'Paste a GitHub link first'); return; }
    setBusy(true);
    setPreview(null);
    try {
      const r = await fetch('/api/agent/import/github/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || "Couldn't read that link");
      setPreview(d);
      setPicked(new Set(d.agents.slice(0, 10).map((a: any) => a.name)));
    } catch (e: any) { toast('error', e?.message || "Couldn't read that link"); } finally { setBusy(false); }
  }

  async function doImport() {
    if (!picked.size) { toast('error', 'Pick at least one agent'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/agent/import/github/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim(), pick: [...picked], installDeps }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Import failed');
      const mcpOk = (d.installed?.mcp || []).filter((x: any) => x.ok).length;
      const cliOk = (d.installed?.clis || []).filter((x: any) => x.ok).length;
      toast('success', `Imported ${d.imported.length} agent${d.imported.length === 1 ? '' : 's'}${mcpOk || cliOk ? ` · installed ${mcpOk} MCP + ${cliOk} CLI` : ''}`);
      onDone(d.url); // v2: the repo landed as ONE agent — open it (BEA-1105)
    } catch (e: any) { toast('error', e?.message || 'Import failed'); setBusy(false); }
  }

  const deps = preview?.deps;
  const hasDeps = !!deps && (deps.mcpServers.length > 0 || deps.clis.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col gap-3 overflow-hidden rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">📦 Bring an agent from GitHub</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex gap-2">
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadPreview()} placeholder="https://github.com/owner/repo (or a folder / file link)" className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
          <button onClick={loadPreview} disabled={busy} className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{busy && !preview ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Read it'}</button>
        </div>
        {preview && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">{preview.agents.length} agent{preview.agents.length === 1 ? '' : 's'} found — pick which to bring in</div>
              <div className="space-y-1.5">
                {preview.agents.map((a: any) => (
                  <label key={a.name} className={'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition-colors ' + (picked.has(a.name) ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10' : 'border-zinc-200 dark:border-zinc-700')}>
                    <input type="checkbox" checked={picked.has(a.name)} onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(a.name) : n.delete(a.name); return n; })} className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{a.name}</span>
                      <span className="block text-xs text-zinc-500">{a.description}</span>
                      {a.tools?.length > 0 && <span className="mt-0.5 block truncate text-[11px] text-zinc-400">tools: {a.tools.join(', ')}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {hasDeps ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/25 dark:bg-amber-500/5">
                <div className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">Install plan — needs your OK</div>
                <ul className="mt-1.5 space-y-1 text-sm text-zinc-700 dark:text-zinc-200">
                  {deps.mcpServers.map((s: any) => <li key={s.name}>🔌 MCP server <b>{s.name}</b> <span className="text-xs text-zinc-500">({s.command} {s.args.join(' ')})</span></li>)}
                  {deps.clis.map((c: string) => <li key={c}>💻 CLI <b>{c}</b> <span className="text-xs text-zinc-500">(npm install -g)</span></li>)}
                </ul>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={installDeps} onChange={(e) => setInstallDeps(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
                  Install these on my server
                </label>
                <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/70">Only these exact items are installed — the repo's own install scripts are never run.</p>
              </div>
            ) : (
              <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-800/60">Nothing extra to install — these agents run on your existing tools.</div>
            )}
            {deps?.notes?.length > 0 && <div className="text-[11px] text-zinc-400">{deps.notes.map((n: string, i: number) => <div key={i}>ℹ️ {n}</div>)}</div>}
            <button onClick={doImport} disabled={busy || !picked.size} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Import {picked.size} agent{picked.size === 1 ? '' : 's'}{hasDeps && installDeps ? ' + install the plan' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function NewAgentForm({ initial, areaId, social, onCreated, onCancel }: { initial?: Starter | null; areaId?: string; social?: SocialPrefill | null; onCreated: (id?: string) => void; onCancel: () => void }) {
  const toast = useToast();
  // A Social handoff (BEA-1357) skips the "describe it" step: the tool and its arguments ARE the job.
  const [step, setStep] = useState<'describe' | 'form'>(social ? 'form' : 'describe');
  const [idea, setIdea] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [rubric, setRubric] = useState('');
  const [defaultDepth, setDefaultDepth] = useState<Depth>('standard');
  const [evals, setEvals] = useState<string[]>([]);
  const [newEval, setNewEval] = useState('');
  const [sched, setSched] = useState<Sched>(null); // shared plain-English picker (BEA-1075/1076)
  // The rest of the drafted identity (BEA-1063) — the meta-agent fills these; you can still tweak.
  const [icon, setIcon] = useState('🤖');
  const [color, setColor] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('');
  const [description, setDescription] = useState('');
  const [autonomy, setAutonomy] = useState('cautious');
  const [draftTools, setDraftTools] = useState<any[]>([]); // toolbox inferred from the idea (BEA-1100)
  // Where the result goes + WhatsApp (BEA-1357) — first-class on every job, pre-set for a Social one.
  const [outputDest, setOutputDest] = useState<string>(social ? 'sheet' : 'document');
  const [sheetId, setSheetId] = useState('');
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(false);
  const [toolArgs, setToolArgs] = useState<Record<string, any>>(social?.args || {});
  // Watch / Alert (BEA-1358): fetch every time · watch for changes · alert when… (+ condition / threshold)
  const [mode, setMode] = useState<string>(social?.mode || 'run');
  const [alertCondition, setAlertCondition] = useState('');
  const [threshold, setThreshold] = useState<ThresholdDraft>(EMPTY_THRESHOLD);

  function pickStarter(s: Starter) {
    setName(s.name); setTask(s.task); setRubric(s.rubric); setDefaultDepth(s.depth);
    if (s.icon) setIcon(s.icon);
    if (s.color) setColor(s.color);
    if (s.category) setCategory(s.category);
    if (s.blurb) setDescription(s.blurb);
    if (s.autonomy) setAutonomy(s.autonomy);
    setSched(s.every && s.every !== 'manual' ? (s.every === 'hour' ? { every: 'hour', minute: 0 } : s.every === 'week' ? { every: 'week', dow: 0, at: s.at || '08:00' } : { every: s.every, at: s.at || '07:00' }) : null);
    setStep('form');
  }
  useEffect(() => { if (initial) pickStarter(initial); /* eslint-disable-next-line */ }, []);
  // The pre-fill (BEA-1357): a name in the owner's words, the Social shelf, and a task that means
  // "rows as fetched" until the owner asks for columns or a filter.
  useEffect(() => {
    if (!social) return;
    setName(socialAgentName(social)); setTask(KEEP_AS_FETCHED); setIcon('📣'); setColor('#ec4899'); setCategory('Social');
    setDescription(`${social.label || 'Social'} — fetched directly, on a schedule`);
    setStep('form'); /* eslint-disable-next-line */
  }, []);
  const [saving, setSaving] = useState(false);
  const inp = 'w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';

  async function draft() {
    if (!idea.trim()) { toast('error', 'Describe what you want it to do'); return; }
    setDrafting(true);
    try {
      const r = await fetch('/api/agent/agents/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not draft');
      setName(d.name || ''); setTask(d.prompt || ''); setRubric(d.rubric || ''); setEvals(Array.isArray(d.evals) ? d.evals : []);
      if (d.icon) setIcon(d.icon);
      if (d.color) setColor(d.color);
      if (d.category) setCategory(d.category);
      if (d.description) setDescription(d.description);
      if (d.autonomy) setAutonomy(d.autonomy);
      if (d.defaultDepth) setDefaultDepth(d.defaultDepth === 'quick' ? 'quick' : 'standard');
      if (d.schedule) setSched(d.schedule);
      setDraftTools(Array.isArray(d.tools) ? d.tools : []);
      setStep('form');
    } catch (e: any) { toast('error', e?.message || 'Could not draft'); } finally { setDrafting(false); }
  }

  async function save() {
    if (!name.trim() || !task.trim()) { toast('error', 'Give it a name and a task'); return; }
    const schedule: any = sched;
    const scheduleText = schedText(sched) || undefined;
    setSaving(true);
    try {
      const evalCases = evals.map((x) => x.trim()).filter(Boolean).map((input) => ({ id: 'ev_' + Math.random().toString(36).slice(2, 9), input }));
      const r = await fetch('/api/agent/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), prompt: task.trim(), rubric: rubric.trim() || undefined, defaultDepth, evals: evalCases, schedule, scheduleText,
          icon, color: color || undefined, category: category || undefined, description: description.trim() || undefined, autonomy,
          ...(areaId ? { areaId } : {}), // creating a job inside an existing agent (BEA-1098)
          ...(draftTools.length ? { tools: draftTools } : {}), // inferred toolbox → the area's Tools section (BEA-1100)
          outputDest, sheetId: sheetId.trim() || null, notifyWhatsApp, // BEA-1357
          // A Social job (BEA-1357): the tool id + its exact arguments, run directly, no engine turn.
          // A ready run screen too — no inputs to design, so the job page never spends an engine turn on one.
          ...(social ? { tools: [social.tool], toolArgs: { [social.tool]: toolArgs }, origin: 'social', ui: { headline: name.trim(), inputs: [], view: 'report', runLabel: mode === 'run' ? 'Fetch now →' : 'Check now →' } } : {}),
          // Watch / Alert (BEA-1358)
          ...(social ? { mode, alertCondition: mode === 'alert' ? alertCondition.trim() || null : null, threshold: mode === 'alert' ? thresholdOfDraft(threshold) : null } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'Could not save');
      onCreated(d?.id);
    } catch (e: any) { toast('error', e?.message || 'Could not save'); } finally { setSaving(false); }
  }

  if (step === 'describe') {
    return (
      <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Start from a template — first run uses YOUR real brain</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {STARTERS.map((s) => <StarterCard key={s.key} s={s} onPick={pickStarter} />)}
        </div>
        <div className="flex items-center gap-2 pt-1 text-sm font-medium"><Sparkles className="h-4 w-4 text-emerald-600" />…or describe your own</div>
        <div className="relative">
          <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="In a sentence or two, what should this agent do?  e.g. “Every morning, summarise my unread emails and flag anything urgent.”" className={inp + ' resize-none pr-11'} />
          <DictateButton onText={(t) => setIdea((p) => (p ? p + ' ' : '') + t)} className="absolute right-2 top-2" />
        </div>
        <p className="text-xs text-zinc-400">I'll draft the task, a clear Outcome to grade it against, and a couple of test cases — you review and tweak before saving.</p>
        <div className="flex items-center justify-between gap-2">
          <button onClick={() => setStep('form')} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Fill it in myself</button>
          <div className="flex gap-2">
            <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
            <button onClick={draft} disabled={drafting} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Draft it for me</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" style={color ? { borderLeft: `4px solid ${color}` } : undefined}>
      <div className="flex gap-2">
        <input value={icon} onChange={(e) => setIcon(e.target.value.slice(0, 4))} title="Icon" className="w-14 shrink-0 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-center text-lg outline-none focus:border-emerald-400 dark:border-zinc-700" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name (e.g. Morning Brief)" className={inp} />
      </div>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line: what it does and when (shows on its card)" className={inp} />
      <div className="flex flex-wrap gap-2">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <option value="">Category: auto</option>
          {['Daily', 'Research', 'People', 'Brain care', 'Social', 'Other'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {!social && (
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <option value="cautious">Cautious — checks before acting</option>
          <option value="balanced">Balanced — asks only on big ones</option>
          <option value="autopilot">Autopilot — never asks</option>
        </select>
        )}
      </div>
      {/* A Social job (BEA-1357): the fetch is the tool + these exact arguments — no engine turn. */}
      {social && <ToolArgsEditor tool={social.tool} args={toolArgs} onChange={setToolArgs} toolName={social.label} />}
      {/* Watch / Alert (BEA-1358): remember last time, say only what changed, push when the condition is true. */}
      {social && <WatchModePicker mode={mode} condition={alertCondition} threshold={threshold} onChange={(v) => { setMode(v.mode); setAlertCondition(v.condition); setThreshold(v.threshold); }} />}
      {/* A Watch/Alert writes only what changed — the shaping task does not apply, so it is not shown. */}
      {(!social || mode === 'run') && (
      <label className="block text-xs text-zinc-500">{social ? 'What to do with the rows — name the columns you want, or a filter like “only posts about India”. Leave it as is to keep every result.' : 'Task'}
        <div className="relative mt-1">
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="What should it do each time it runs?" className={inp + ' resize-none pr-11'} />
          <DictateButton onText={(t) => setTask((p) => (p ? p + ' ' : '') + t)} className="absolute right-2 top-2" />
        </div>
      </label>
      )}
      <OutputDestPicker dest={outputDest} sheetId={sheetId} onChange={(v) => { setOutputDest(v.outputDest); setSheetId(v.sheetId); }} />
      <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
        <span className="text-xs text-zinc-500">Send me the link on WhatsApp when it finishes <span className="text-zinc-400">(needs your number in Settings → Agent Engine)</span></span>
        <input type="checkbox" checked={notifyWhatsApp} onChange={(e) => setNotifyWhatsApp(e.target.checked)} className="h-5 w-9 shrink-0 accent-emerald-600" aria-label="Send to WhatsApp when it finishes" />
      </label>
      {!social && (<>
      <label className="block text-xs text-zinc-500">Outcome — what does a good result look like? (graded each run)
        <div className="relative mt-1">
          <textarea value={rubric} onChange={(e) => setRubric(e.target.value)} rows={3} placeholder="e.g. Has 3 bullets. Each is one short sentence. Flags anything urgent." className={inp + ' resize-none pr-11'} />
          <DictateButton onText={(t) => setRubric((p) => (p ? p + ' ' : '') + t)} className="absolute right-2 top-2" />
        </div>
      </label>
      <div>
        <div className="mb-1 text-xs text-zinc-500">How deep should each run go?</div>
        <DepthDial value={defaultDepth} onChange={setDefaultDepth} />
      </div>
      </>)}
      {!social && (
      <div className="space-y-1.5">
        <div className="text-xs text-zinc-500">Eval cases — example inputs to test it (optional)</div>
        {evals.map((e, i) => (
          <div key={i} className="flex gap-2">
            <input value={e} onChange={(ev) => setEvals((p) => p.map((x, j) => (j === i ? ev.target.value : x)))} className={inp} />
            <button onClick={() => setEvals((p) => p.filter((_, j) => j !== i))} className="shrink-0 px-1 text-zinc-400 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <div className="flex gap-2">
          <input value={newEval} onChange={(e) => setNewEval(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newEval.trim()) { setEvals((p) => [...p, newEval.trim()]); setNewEval(''); } }} placeholder="Add a test input…" className={inp} />
          <button onClick={() => { if (newEval.trim()) { setEvals((p) => [...p, newEval.trim()]); setNewEval(''); } }} className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700"><Plus className="h-4 w-4" /></button>
        </div>
      </div>
      )}
      {draftTools.length > 0 && (
        <div>
          <div className="text-xs font-medium text-zinc-500">Tools it will need <span className="font-normal text-zinc-400">· lands on the agent's Tools section</span></div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {draftTools.map((t: any, i: number) => (
              <span key={i} title={t.note || ''} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                <span className="uppercase opacity-50">{t.kind}</span>{t.name}
                <button onClick={() => setDraftTools((p) => p.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-rose-500">✕</button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <SchedulePicker value={sched} onChange={setSched} />
        <div className="ml-auto flex gap-2">
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Save agent</button>
        </div>
      </div>
    </div>
  );
}

const CATEGORY_ORDER = ['Daily', 'Research', 'People', 'Brain care', 'Imported', 'Other'];

/** One template card on the shelf gallery (BEA-1064): icon, what it does, example runs, rhythm. */
function StarterCard({ s, onPick }: { s: Starter; onPick: (s: Starter) => void }) {
  return (
    <button onClick={() => onPick(s)} style={{ borderLeftColor: s.color }}
      className="rounded-xl border border-l-4 border-zinc-200 bg-white p-3 text-left transition-all hover:-translate-y-0.5 hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg" style={{ background: s.color + '22' }}>{s.icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{s.name}</span>
          <span className="block truncate text-[11px] text-zinc-500">{s.blurb}</span>
        </span>
      </div>
      {s.examples?.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {s.examples.slice(0, 2).map((ex, i) => <div key={i} className="truncate text-[11px] italic text-zinc-400">{ex}</div>)}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {s.every && s.every !== 'manual' && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{s.every === 'day' ? `daily ${s.at}` : s.every === 'week' ? `Sundays ${s.at}` : s.every === 'weekday' ? `weekdays ${s.at}` : 'hourly'}</span>}
        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] capitalize text-zinc-500 dark:bg-zinc-800">{s.category}</span>
      </div>
    </button>
  );
}

export function Agents() {
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const focusId = params.get('focus'); // push-notification deep link (BEA-1088 groundwork)
  // The Social handoff (BEA-1357): `/agent?builder=1&tool=<svc id>&args=<json>&label=…` opens the
  // builder form pre-filled. Read once; the params are cleared when the form closes.
  const [socialPrefill] = useState<SocialPrefill | null>(() => readSocialPrefill(params));
  const clearBuilderParams = () => { if (params.get('builder')) { const p = new URLSearchParams(params); ['builder', 'tool', 'args', 'label'].forEach((k) => p.delete(k)); setParams(p, { replace: true }); } };
  const [engine, setEngine] = useState<{ ok?: boolean; version?: string } | null>(null);
  const [home, setHome] = useState<HomeData | null>(null);
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [starting, setStarting] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null); // guard a saved-agent Run against double-tap (BEA-819)
  const [saveResult, setSaveResult] = useState(true);
  const [depth, setDepth] = useState<Depth>('standard');
  const [showNew, setShowNew] = useState(!!readSocialPrefill(params));
  const [starterPick, setStarterPick] = useState<Starter | null>(null);
  const [showAsk, setShowAsk] = useState(false);
  // Run popup: after planning a deep research, pick which sub-questions to run. (BEA-773)
  const [planFor, setPlanFor] = useState<{ flowId: string; subs: { id: string; branchIdx: number; sub: string; on: boolean }[] } | null>(null);
  const [q, setQ] = useState('');
  // Agents list standards (BEA-1183) — always on, 12 per page.
  const [agentFilter, setAgentFilter] = useState<'all' | 'waiting' | 'ran' | 'never'>('all');
  const [agentSort, setAgentSort] = useState<'recent' | 'name' | 'jobs'>('recent');
  const [agentPage, setAgentPage] = useState(1);
  const [showImport, setShowImport] = useState(false); // GitHub agent import (BEA-1081)
  const [showBuilder, setShowBuilder] = useState(params.get('builder') === '1' && !readSocialPrefill(params)); // chat builder (BEA-1104); `?builder=1` alone opens it
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // big shelf groups expanded (BEA-1083)
  // Slim one-tap push opt-in (BEA-1088) — shown while this device could get notifications but isn't
  // subscribed yet (covers both "never asked" and "allowed but not registered").
  const [pushNudge, setPushNudge] = useState(false);
  const [pushBusy, setPushBusy] = useState(false); // BEA-1089: spinner + guard so the tap always gives feedback
  useEffect(() => {
    if (localStorage.getItem('push.nudgeDismissed') === '1') return;
    const perm = pushPermission();
    if (perm === 'denied' || perm === 'unsupported') return;
    pushEnabledHere().then((on) => { if (!on) setPushNudge(true); }).catch(() => undefined);
  }, []);
  async function turnOnPush() {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const r = await enablePush();
      if (r.ok) { toast('success', 'Phone notifications are ON'); setPushNudge(false); }
      else { toast('error', r.message || 'Could not turn on notifications'); } // keep the banner so they can retry
    } catch { toast('error', 'Could not turn on notifications — try reopening the app'); }
    finally { setPushBusy(false); }
  }

  const loadHome = useCallback(() => fetch('/api/agent/home').then((r) => r.json()).then(setHome).catch(() => setHome((p) => p || { waiting: [], running: [], landed: [], agents: [] })), []);

  useEffect(() => {
    fetch('/api/agent/engine').then((r) => r.json()).then(setEngine).catch(() => setEngine({ ok: false }));
    loadHome();
  }, [loadHome]);

  // Live refresh: quick while something is running or waiting, relaxed otherwise.
  useEffect(() => {
    const busy = !!home && (home.running.length > 0 || home.waiting.length > 0);
    const t = setInterval(loadHome, busy ? 5000 : 30000);
    return () => clearInterval(t);
  }, [home, loadHome]);

  async function runSaved(id: string) {
    if (runningId) return; // already starting a run — ignore the double-tap (BEA-819)
    setRunningId(id);
    try {
      const r = await fetch(`/api/agent/agents/${id}/run`, { method: 'POST' });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).message || 'Could not start');
      const row = await r.json();
      nav(`/agent/runs/${row.id}`);
    } catch (e: any) { toast('error', e?.message || 'Could not run that agent'); setRunningId(null); }
  }
  async function toggleSaved(a: any) {
    await fetch(`/api/agent/agents/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !a.enabled }) });
    loadHome();
  }
  async function delSaved(id: string) {
    await fetch(`/api/agent/agents/${id}`, { method: 'DELETE' });
    loadHome();
  }

  async function run() {
    const text = prompt.trim();
    if (!text) { toast('error', 'Type a task for the agent first'); return; }
    setStarting(true);
    try {
      if (depth === 'deep') {
        // Deep = a full flow: create one, plan it into sub-questions, then let the user pick which to run. (BEA-773)
        const fl = await (await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: title.trim() || text.slice(0, 60), question: text }) })).json();
        await fetch(`/api/flows/${fl.id}/plan`, { method: 'POST' }).catch(() => undefined);
        const flow = await (await fetch(`/api/flows/${fl.id}`)).json();
        const subs = ((flow.graph?.nodes || []) as any[])
          .filter((n) => n.data?.kind === 'subquestion')
          .map((n) => ({ id: n.id, branchIdx: Number(/^b(\d+)_/.exec(n.id)?.[1] ?? 0), sub: (n.data?.sub || '').toString(), on: true }));
        if (subs.length > 1) { setPlanFor({ flowId: fl.id, subs }); setStarting(false); return; } // show the picker
        const run = await (await fetch(`/api/flows/${fl.id}/run`, { method: 'POST' })).json();
        if (run?.runId) { nav(`/flows/runs/${run.runId}`); return; }
        throw new Error('Could not start the deep run');
      }
      const r = await fetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, title: title.trim() || undefined, save: depth === 'quick' ? false : saveResult, depth }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).message || 'Could not start');
      const row = await r.json();
      nav(`/agent/runs/${row.id}`);
    } catch (e: any) {
      toast('error', e?.message || 'Could not start the agent');
      setStarting(false);
    }
  }

  // Run the planned flow with only the ticked sub-questions (disable the rest for this run). (BEA-773)
  async function runSelected() {
    if (!planFor) return;
    const chosen = planFor.subs.filter((s) => s.on);
    if (!chosen.length) { toast('error', 'Pick at least one sub-question'); return; }
    setStarting(true);
    try {
      // Skip the unticked branches for THIS run only — sent to the run endpoint, never saved onto the
      // flow (a saved enabled:false used to cripple every later plain Run / schedule). (BEA-796)
      const skipBranches = planFor.subs.filter((s) => !s.on).map((s) => s.branchIdx);
      const run = await (await fetch(`/api/flows/${planFor.flowId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skipBranches }),
      })).json();
      setPlanFor(null);
      if (run?.runId) nav(`/flows/runs/${run.runId}`);
      else throw new Error('Could not start');
    } catch (e: any) { toast('error', e?.message || 'Could not start'); setStarting(false); }
  }

  const waiting = home?.waiting || [];
  // running / landed are no longer shown here (BEA-1181) — History owns them.
  const agents = home?.agents || null;
  // Areas (BEA-1098): the home now shows agents-as-areas; jobs live inside each area's page.
  const [areasList, setAreasList] = useState<any[] | null>(null);
  const loadAreas = useCallback(() => fetch('/api/agent/areas').then((r) => r.json()).then((d) => setAreasList(Array.isArray(d) ? d : [])).catch(() => setAreasList([])), []);
  useEffect(() => { loadAreas(); }, [loadAreas]);

  // The page is about your agents now (BEA-1181), so the subtitle counts THEM — not today's runs.
  const greet = home
    ? [
        areasList ? `${areasList.length} agent${areasList.length === 1 ? '' : 's'}` : null,
        waiting.length ? `${waiting.length} need${waiting.length > 1 ? '' : 's'} you` : null,
      ].filter(Boolean).join(' · ') || 'Your agents live here.'
    : ' ';

  return (
    <div className="space-y-6">
      {planFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !starting && setPlanFor(null)}>
          <div className="w-full max-w-md space-y-3 rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-emerald-600" />What should I research?</h2>
              <button onClick={() => setPlanFor(null)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
            </div>
            <p className="text-xs text-zinc-500">I split your ask into these questions. Untick any you don't want — or run them all.</p>
            <div className="space-y-1.5">
              {planFor.subs.map((s, i) => (
                <label key={s.id} className={'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition-colors ' + (s.on ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10' : 'border-zinc-200 dark:border-zinc-700')}>
                  <input type="checkbox" checked={s.on} onChange={(e) => setPlanFor((p) => p ? { ...p, subs: p.subs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) } : p)} className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600" />
                  <span className={s.on ? 'text-zinc-700 dark:text-zinc-100' : 'text-zinc-400'}>{s.sub}</span>
                </label>
              ))}
            </div>
            <button onClick={runSelected} disabled={starting || !planFor.subs.some((s) => s.on)} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{starting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Research {planFor.subs.filter((s) => s.on).length} question{planFor.subs.filter((s) => s.on).length === 1 ? '' : 's'}</button>
          </div>
        </div>
      )}

      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-indigo-500 text-white">
          <Bot className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Agents</h1>
          <p className="truncate text-sm text-zinc-500">{greet}</p>
        </div>
        <div className="ml-auto shrink-0">
          {engine === null ? null : engine.ok ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"><span className="h-2 w-2 rounded-full bg-emerald-500" />Engine online</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-600"><AlertTriangle className="h-3.5 w-3.5" />Engine offline</span>
          )}
        </div>
      </header>

      {/* Floating "Quick ask" — a one-off run without saving an agent (capture pattern, BEA-698) */}
      <button
        onClick={() => setShowAsk(true)}
        className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg transition-colors hover:bg-emerald-500"
      >
        <Sparkles className="h-4 w-4" />Quick ask
      </button>

      {showAsk && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !starting && setShowAsk(false)}>
          <div className="w-full max-w-lg space-y-3 rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-emerald-600" />Quick ask</h2>
              <button onClick={() => setShowAsk(false)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><XCircle className="h-5 w-5" /></button>
            </div>
            <div className="rounded-xl border border-zinc-300 bg-zinc-50 transition-colors focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950">
              <GrowTextarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do?  e.g. “Research the best electric cars and write a short brief.”" className="w-full bg-transparent px-3 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100" minHeight={76} maxHeight={240} autoFocus />
            </div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name this run (optional)" className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <DepthDial value={depth} onChange={setDepth} />
              {depth === 'standard' && (
                <label className="flex items-center gap-2 text-xs text-zinc-500">
                  <input type="checkbox" checked={saveResult} onChange={(e) => setSaveResult(e.target.checked)} className="accent-emerald-600" />
                  Save to Documents
                </label>
              )}
            </div>
            {engine && !engine.ok && <p className="text-xs text-amber-600">The agent engine isn’t reachable right now, so a run may not start.</p>}
            <button onClick={run} disabled={starting || !prompt.trim()} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run
            </button>
          </div>
        </div>
      )}

      {/* One-tap phone notifications (BEA-1088) — shown until this device opts in or dismisses. */}
      {pushNudge && (
        <button onClick={turnOnPush} disabled={pushBusy} aria-busy={pushBusy}
          className="flex w-full items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-left text-sm text-emerald-800 hover:bg-emerald-100 disabled:opacity-70 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {pushBusy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <span aria-hidden>🔔</span>}
          <span className="flex-1">{pushBusy ? <b>Turning on…</b> : <><b>Get notified on your phone</b> when an agent needs you or finishes — tap to turn on.</>}</span>
          {!pushBusy && <span onClick={(e) => { e.stopPropagation(); setPushNudge(false); localStorage.setItem('push.nudgeDismissed', '1'); }} className="px-1 text-emerald-600/70 hover:text-emerald-800 dark:hover:text-emerald-200">✕</span>}
        </button>
      )}

      {/* 🗂 Your agents — the shelf (BEA-1083 + BEA-1087 + BEA-1091) */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold">Your agents{areasList && areasList.length > 0 ? <span className="ml-1 text-sm font-normal text-zinc-400">· {areasList.length}</span> : null}</h2>
          <div className="flex items-center gap-1.5">
            <button onClick={() => nav('/agent/saved')} title="Everything agents have saved" className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><ShieldCheck className="h-4 w-4" /><span className="hidden sm:inline">Saves</span></button>
            <button onClick={() => nav('/agent/history')} title="All past runs" className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><HistoryIcon className="h-4 w-4" /><span className="hidden sm:inline">All runs</span></button>
            <button onClick={() => setShowImport(true)} title="Bring any public Claude agent from GitHub" className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300">🔗<span className="hidden sm:inline">GitHub</span></button>
            <button onClick={() => setShowBuilder(true)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"><Plus className="h-4 w-4" />New agent</button>
          </div>
        </div>
        {showImport && <ImportGithubModal onDone={(url) => { setShowImport(false); loadHome(); loadAreas(); if (url) nav(url); }} onClose={() => setShowImport(false)} />}
        {showBuilder && <AgentBuilder onCreated={(url) => { setShowBuilder(false); loadHome(); loadAreas(); if (url) nav(url); }} onUseForm={() => { setShowBuilder(false); setShowNew(true); }} onClose={() => { setShowBuilder(false); clearBuilderParams(); }} />}
        {showNew && <NewAgentForm initial={starterPick} social={socialPrefill} onCreated={(id) => { setShowNew(false); setStarterPick(null); clearBuilderParams(); loadHome(); loadAreas(); if (id && socialPrefill) nav(`/agent/a/${id}`); }} onCancel={() => { setShowNew(false); setStarterPick(null); clearBuilderParams(); }} />}
        {areasList === null ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
        ) : areasList.length === 0 ? (
          !showNew && (
            <div className="rounded-2xl border border-dashed border-zinc-300 p-5 dark:border-zinc-700">
              <p className="mb-3 text-center text-sm text-zinc-500">No agents yet — start from a template (the first run uses YOUR real brain):</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => <StarterCard key={s.key} s={s} onPick={(st) => { setStarterPick(st); setShowNew(true); }} />)}
              </div>
            </div>
          )
        ) : (() => {
          // Areas grid (BEA-1098): each tile is a whole agent; its jobs live inside.
          // Search · filter · sort · count · pagination — ALWAYS on, never behind a threshold
          // (BEA-1183). A list with one item still shows its controls.
          const needle = q.trim().toLowerCase();
          const matched = areasList.filter((ar) => {
            if (needle && !(ar.name + ' ' + (ar.description || '') + ' ' + ar.jobs.map((j: any) => j.name).join(' ')).toLowerCase().includes(needle)) return false;
            const jobs = ar.jobs || [];
            if (agentFilter === 'waiting') return jobs.some((j: any) => j.lastRun?.status === 'awaiting_input' || j.lastRun?.status === 'paused');
            if (agentFilter === 'ran') return jobs.some((j: any) => j.lastRun);
            if (agentFilter === 'never') return jobs.every((j: any) => !j.lastRun);
            return true;
          });
          const lastAt = (ar: any) => Math.max(0, ...(ar.jobs || []).map((j: any) => (j.lastRun?.at ? new Date(j.lastRun.at).getTime() : 0)));
          const sorted = [...matched].sort((a, b) => {
            if (agentSort === 'name') return String(a.name).localeCompare(String(b.name));
            if (agentSort === 'jobs') return (b.jobCount || 0) - (a.jobCount || 0) || String(a.name).localeCompare(String(b.name));
            return lastAt(b) - lastAt(a) || String(a.name).localeCompare(String(b.name));
          });
          const PER = 12;
          const pages = Math.max(1, Math.ceil(sorted.length / PER));
          const page = Math.min(agentPage, pages);
          const filtered = sorted.slice((page - 1) * PER, page * PER);
          const narrowed = needle || agentFilter !== 'all';
          return (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-48">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={q}
                    onChange={(e) => { setQ(e.target.value); setAgentPage(1); }}
                    placeholder="Search agents…"
                    className="w-full rounded-lg border border-zinc-200 bg-transparent py-1.5 pl-8 pr-3 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 sm:text-sm"
                  />
                </div>
                <select value={agentFilter} onChange={(e) => { setAgentFilter(e.target.value as any); setAgentPage(1); }} aria-label="Filter agents" className="shrink-0 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-900">
                  <option value="all">All agents</option>
                  <option value="waiting">Waiting on you</option>
                  <option value="ran">Has run</option>
                  <option value="never">Never run</option>
                </select>
                <select value={agentSort} onChange={(e) => setAgentSort(e.target.value as any)} aria-label="Sort agents" className="shrink-0 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-900">
                  <option value="recent">Most recent</option>
                  <option value="name">By name</option>
                  <option value="jobs">Most jobs</option>
                </select>
                <span className="shrink-0 text-xs text-zinc-400">{narrowed ? `${sorted.length} of ${areasList.length}` : `${areasList.length}`}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map((ar) => {
                  const color = ar.color || '#818cf8';
                  const runningJob = ar.jobs.find((j: any) => j.lastRun?.status === 'running');
                  const waitingJob = ar.jobs.find((j: any) => j.lastRun?.status === 'awaiting_input' || j.lastRun?.status === 'paused');
                  const lastDone = ar.jobs.map((j: any) => j.lastRun).filter((r: any) => r?.status === 'done').sort((a: any, b: any) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
                  return (
                    <div key={ar.id} style={{ borderLeftColor: color }} className="group relative flex flex-col rounded-2xl border border-l-4 border-zinc-200 bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                    {/* Rename · duplicate · delete, right where you can see them (BEA-1182). */}
                    <AgentCardMenu area={ar} onChanged={() => { loadAreas(); loadHome(); }} />
                    <button onClick={() => nav(`/agent/ar/${ar.id}`)} className="flex flex-1 flex-col text-left">
                      <div className="flex items-start gap-2.5">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl" style={{ background: color + '22' }}>{ar.icon || '🤖'}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium group-hover:text-emerald-600">{ar.name}</span>
                          <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500">{ar.description || (ar.jobCount === 1 && ar.jobs[0]?.name && ar.jobs[0].name !== ar.name ? ar.jobs[0].name : 'Your agent')}</span>
                        </span>
                      </div>
                      <span className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800">
                        <span className="font-medium">{ar.jobCount} job{ar.jobCount === 1 ? '' : 's'}</span>
                        {waitingJob && <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><PauseCircle className="h-3 w-3" />needs you</span>}
                        {runningJob && <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"><Loader2 className="h-3 w-3 animate-spin" />running</span>}
                        {!runningJob && !waitingJob && lastDone && <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" />ran {timeAgo(lastDone.at)}</span>}
                        {(ar.tools || []).length > 0 && <span className="ml-auto">🔧 {ar.tools.length}</span>}
                      </span>
                    </button>
                    </div>
                  );
                })}
              </div>
              {filtered.length === 0 && (
                <div className="rounded-2xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  Nothing matches{needle ? ` “${q}”` : ' that filter'}.{' '}
                  <button onClick={() => { setQ(''); setAgentFilter('all'); setAgentPage(1); }} className="text-emerald-600 hover:underline">Clear</button>
                </div>
              )}
              {pages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button onClick={() => setAgentPage(Math.max(1, page - 1))} disabled={page <= 1} className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-zinc-700">Back</button>
                  <span className="text-xs text-zinc-500">Page {page} of {pages}</span>
                  <button onClick={() => setAgentPage(Math.min(pages, page + 1))} disabled={page >= pages} className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-zinc-700">Next</button>
                </div>
              )}
            </div>
          );
        })()}
      </section>
      {/* ⚡ Needs you — kept below the grid (BEA-1181): a job waiting on your answer is a blocker,
          so it must never be hidden, but the agents themselves are what this page is for.
          "Running now" and "Landed today" were removed — they live in History. */}
      {waiting.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-amber-600 dark:text-amber-400"><PauseCircle className="h-4 w-4" />Needs you<span className="rounded-full bg-amber-100 px-1.5 text-xs font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">{waiting.length}</span></h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {waiting.map((w) => (
              <WaitingCard key={w.waitpointId || w.runId} w={w} focus={!!focusId && (w.waitpointId === focusId || w.runId === focusId)} onAnswered={loadHome} />
            ))}
          </div>
        </section>
      )}


    </div>
  );
}
