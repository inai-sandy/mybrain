import { useCallback, useEffect, useRef, useState } from 'react';
import { agentKind } from '../ui/agentKind';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bot, Play, Loader2, FileText, CheckCircle2, AlertTriangle, Clock, XCircle, PauseCircle, Plus, Trash2, Power, History as HistoryIcon, CalendarClock, Sparkles, Search, ShieldCheck, X, Send, Pencil, MoreHorizontal, Copy, Check, CheckSquare, Square, FolderInput, ChevronDown } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { Sheet } from '../ui/Sheet';
import { GrowTextarea } from '../ui/GrowTextarea';
import { DictateButton } from '../ui/DictateButton';
import { DepthDial, type Depth } from '../ui/DepthDial';
import { STARTERS, type Starter } from '../ui/agentStarters';
import { enablePush, pushPermission, pushEnabledHere } from '../ui/push';
import { SchedulePicker, schedText, type Sched } from '../ui/SchedulePicker';
import { AgentBuilder, BuilderSeed } from './AgentBuilder';
import { EMPTY_THRESHOLD, KEEP_AS_FETCHED, OutputDestPicker, ThresholdDraft, ToolArgsEditor, WatchModePicker, thresholdOfDraft } from '../ui/agentJobFields';
import { AddSourcePanel, SocialSource } from './social/AddSourcePanel';
import { sourceIdFor, toolArgsOf, toolsOf } from '../ui/toolArgs';
import { AgentFolder, FolderNav, FolderPickerSheet, FolderSel, folderCounts, inFolder } from '../ui/AgentFolders';
import { DataTable } from '../ui/DataTable';

/** What a Social result hands the builder (BEA-1357): the tool, the exact arguments just used, a label. */
export type SocialPrefill = { tool: string; args: Record<string, any>; label?: string; mode?: string };

/** "Instagram · Search · smarthomeindia" — the label plus the argument values, in the owner's words. */
export function socialAgentName(p: SocialPrefill): string {
  const vals = Object.values(p.args || {}).filter((v) => v !== '' && v !== null && v !== undefined).map((v) => String(v)).slice(0, 3);
  const base = p.label || p.tool.replace(/^svc:/, '').replace('.', ' · ');
  return [base, ...vals].join(' · ').slice(0, 120);
}

/** Read `?builder=1&tool=&args=&label=` off the Agents URL. Null when it is not a Social handoff. */
export function readSocialPrefill(params: URLSearchParams, builder: string | string[] = '1'): SocialPrefill | null {
  const tool = params.get('tool') || '';
  const kinds = Array.isArray(builder) ? builder : [builder];
  if (!kinds.includes(params.get('builder') || '') || !/^svc:[a-z0-9_]+\.[a-z0-9_]+$/.test(tool)) return null;
  let args: Record<string, any> = {};
  try { const a = JSON.parse(params.get('args') || '{}'); if (a && typeof a === 'object' && !Array.isArray(a)) args = a; } catch { args = {}; }
  const mode = params.get('mode') || '';
  return { tool, args, label: params.get('label') || undefined, ...(mode === 'watch' || mode === 'alert' ? { mode } : {}) };
}

/**
 * Read `?builder=chat&tool=&args=&label=&sample=<json>` (BEA-1372) — the Social result → the THINKING
 * builder, the call just made as its first message. Null unless it is that hand-off. `sample` is the
 * compact answer ({count, listKey, credits, notFound, fields}); a bad one is simply left out.
 */
export function readBuilderSeed(params: URLSearchParams): BuilderSeed | null {
  const p = readSocialPrefill(params, 'chat');
  if (!p) return null;
  let sample: BuilderSeed['sample'];
  try { const v = JSON.parse(params.get('sample') || 'null'); if (v && typeof v === 'object' && !Array.isArray(v)) sample = v; } catch { sample = undefined; }
  return { tool: p.tool, args: p.args, label: p.label, ...(sample ? { sample } : {}) };
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
/**
 * RUNNING NOW (BEA-1533) — restored from concept-1-mission-control.html.
 *
 * A live run, with the steps it has actually taken. This existed and was deleted with the "Running
 * now" strip; History was judged enough. It is not: the point of this strip is that you can see the
 * thing working WITHOUT navigating, which is what makes an agent feel alive rather than opaque.
 *
 * Only the last few steps are shown — a long run has dozens and the newest is the one that matters.
 */
function RunningCard({ r }: { r: RunningItem }) {
  const nav = useNavigate();
  const started = new Date(r.startedAt).getTime();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.round((now - started) / 1000));
  const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const steps = (r.steps || []).slice(-3);
  return (
    <button
      onClick={() => nav(r.source === 'flow' ? `/flows/runs/${r.id}` : `/agent/runs/${r.id}`)}
      className="w-full rounded-2xl border border-zinc-200 bg-white p-3.5 text-left transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.title}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-zinc-400">{elapsed}</span>
      </div>
      {steps.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          {steps.map((st, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="shrink-0" aria-hidden>{st.status === 'done' ? '\u2705' : st.status === 'failed' ? '\u26A0\uFE0F' : '\u2022'}</span>
              <span className="min-w-0 break-words">{st.label}</span>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

/**
 * LANDED TODAY (BEA-1533) — one line per finished run: what it made, and how it went.
 *
 * The status pill is the point. "done · 6:00" and "failed" read at a glance, which is the difference
 * between a page you scan and a page you have to work through.
 */
function LandedRow({ l }: { l: LandedItem }) {
  const nav = useNavigate();
  const ok = l.status === 'done';
  const at = l.endedAt ? new Date(l.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <button
      onClick={() => nav(l.source === 'flow' ? `/flows/runs/${l.id}` : `/agent/runs/${l.id}`)}
      className="flex w-full items-center gap-2.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{l.title}</span>
        {l.error && <span className="block truncate text-xs text-rose-600 dark:text-rose-400">{l.error}</span>}
      </span>
      <span className={'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ' + (ok
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
        : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300')}>
        {ok ? 'done' : l.status}{at ? ` \u00B7 ${at}` : ''}
      </span>
    </button>
  );
}

/**
 * ONE AGENT, AS A ROW (BEA-1564, second pass).
 *
 * His words: *"this design has to be list view, not table view … check the link
 * https://mybrain.1site.ai/documents?folder=others … it has to follow the same design language."*
 *
 * So this is `/documents`' own list row, wearing an agent's facts: the tinted icon square, the
 * title that turns emerald on hover, one dot-separated meta line, and the row itself a bordered
 * card in a `space-y-2` stack. A column-headed table was the wrong instrument twice over — it made
 * this page look unlike the rest of the app, and it forced every agent's facts into the same five
 * boxes whether or not it had anything to put in them.
 *
 * The information from the first pass all survives the change: what it does, the last run's status
 * AND time, the real schedule, jobs and tools, on or off.
 */
function AgentListRow({ ar, onOpen }: { ar: any; onOpen: () => void }) {
  const r = latestRun(ar);
  const tone = r ? (RUN_TONE[r.status] || RUN_TONE.done) : null;
  const sched = schedOf(ar);
  const jobs = ar.jobCount || 0;
  const tools = (ar.tools || []).length;
  const does = whatItDoes(ar);
  const on = anyOn(ar);
  // The facts that vary, in one line. A manual agent says so once and the eye moves past it.
  const facts = [
    r ? timeAgo(r.at) : 'never run',
    sched || 'Manual',
    `${jobs} job${jobs === 1 ? '' : 's'}`,
    tools ? `${tools} tool${tools === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="group flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 transition-all hover:border-emerald-500/40 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mt-0.5 shrink-0 rounded-lg p-1.5 text-sm leading-none" style={{ backgroundColor: (ar.color || '#818cf8') + '1f' }}>
        <span aria-hidden>{ar.icon || '\u{1F916}'}</span>
      </div>
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5">
          <h3 className="min-w-0 truncate font-semibold leading-tight group-hover:text-emerald-600">{ar.name}</h3>
          <span aria-hidden className="shrink-0 text-xs" title={areaKind(ar) === 'tools' ? 'Acts in your accounts' : 'Reads the web and writes it up'}>{areaKind(ar) === 'tools' ? '\u{1F527}' : '\u{1F50E}'}</span>
        </div>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
          {/* The status of the LAST run, whatever happened in it — the whole point of the first
              pass, and it survives the change of instrument. */}
          {tone && <span className={'shrink-0 rounded px-1.5 py-0.5 font-medium ' + tone.cls}>{tone.label}</span>}
          <span className="truncate">{facts}</span>
        </p>
        {does && <p className="mt-1 truncate text-xs text-zinc-500">{does}</p>}
      </button>
      <span className={'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ' + (on
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
        : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')}>{on ? 'on' : 'off'}</span>
    </div>
  );
}

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
  // The four clear kinds of ask (BEA-1067) — it still tells you at a glance what is being asked of
  // you, but as a quiet word beside the title rather than a fourth coloured pill (BEA-1564). Four
  // different accent colours on a card that is already amber is what made it shout.
  const tag = isApprove
    ? { label: 'Check before it acts' }
    : w.kind === 'choice' ? { label: 'Pick one' }
      : w.kind === 'form' ? { label: 'Fill this in' }
        : { label: 'Answer a question' };

  return (
    /**
     * CALM, NOT LOUD (BEA-1564). His words: *"that particular window is popping out, and it's too
     * ugly."* It was an amber card, holding an amber pill, a coloured icon, a white inner box and a
     * second inner box — on a page that is otherwise quiet zinc, so the one thing asking for a
     * decision looked like an error state.
     *
     * Now it is an ordinary card with ONE accent: a 3px amber rail down the left edge. That still
     * makes it the only amber thing on the page, so it is found instantly, without shouting. The
     * question sits at body size on the card's own surface — no nested boxes — because the question
     * IS the content here, not a quote inside something else.
     */
    <div ref={ref} id={w.waitpointId ? `wp-${w.waitpointId}` : `fw-${w.runId}`}
      className={'overflow-hidden rounded-xl border border-zinc-200 border-l-[3px] border-l-amber-400 bg-white dark:border-zinc-800 dark:border-l-amber-400/70 dark:bg-zinc-900 ' + (focus ? 'ring-2 ring-amber-400/60' : '')}>
      <div className="p-4">
        <div className="flex items-baseline gap-2">
          <button onClick={() => nav(runUrl(w.source, w.runId))} className="min-w-0 truncate text-sm font-semibold text-zinc-900 hover:text-amber-700 dark:text-zinc-100 dark:hover:text-amber-300">{w.title}</button>
          <span className="shrink-0 text-xs text-zinc-400">{tag.label.toLowerCase()}</span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-zinc-400">{timeAgo(w.askedAt)}</span>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">{w.question}</p>
        {isApprove && draft && <p className="mt-2 border-l-2 border-zinc-200 pl-3 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">{draft}</p>}
        {/* The quiet double-check's warning (BEA-1078) — only shows when something looked off. */}
        {isApprove && typeof w.options === 'object' && w.options && (w.options as any).validatorNote && (
          <p className="mt-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-700 dark:text-rose-300">Check closely: {(w.options as any).validatorNote}</p>
        )}

        {/* Every control on one height (h-9) and one type size, so the row reads as a set of
            answers rather than a pile of differently-sized buttons. */}
        {editing || (!choices.length && !isApprove) ? (
          <div className="mt-3 flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) answer(text.trim()); }} autoFocus={editing}
              placeholder={editing ? 'Your version…' : 'Type your answer…'}
              className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-amber-500 dark:border-zinc-700 dark:bg-zinc-950" />
            <button onClick={() => text.trim() && answer(text.trim())} disabled={busy || !text.trim()}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 text-sm font-semibold text-white hover:bg-amber-400 disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Send
            </button>
          </div>
        ) : isApprove ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => answer('approve')} disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Approve</button>
            <button onClick={() => { setEditing(true); setText(draft); }} disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-300 px-3.5 text-sm font-medium hover:border-amber-400 dark:border-zinc-700"><Pencil className="h-4 w-4" />Edit first</button>
            <button onClick={() => answer('reject')} disabled={busy} className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">Don't</button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {choices.map((c) => (
              <button key={c} onClick={() => answer(c)} disabled={busy}
                className="inline-flex h-9 items-center rounded-lg border border-zinc-300 bg-white px-3.5 text-sm font-medium text-zinc-700 hover:border-amber-400 hover:bg-amber-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-amber-500/50 dark:hover:bg-amber-500/10">{c}</button>
            ))}
            <button onClick={() => setEditing(true)} disabled={busy} className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">something else…</button>
          </div>
        )}
        {w.paused ? (
          <div className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400">It waited a while and paused itself — answering continues it from where it stopped.</div>
        ) : w.expiresAt ? (
          <div className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400">Falls back to the safe default {timeAgo(w.expiresAt).includes('ago') ? 'soon' : 'by ' + new Date(w.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</div>
        ) : null}
      </div>
    </div>
  );
}

/** One live run with its readable last steps. */
// RunningCard removed with the "Running now" strip (BEA-1181) — History shows live runs.

/**
 * The ordinary operations on an agent, reachable from the list (BEA-1182) — the owner went looking
 * for rename and delete and couldn't find them, because they were buried inside the agent's page.
 */
function AgentCardMenu({ area, onChanged, onMoveToFolder }: { area: any; onChanged: () => void; onMoveToFolder?: () => void }) {
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
        onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}
        aria-label={`Actions for ${area.name}`}
        className="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-zinc-400 opacity-100 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} className="absolute right-2 top-10 z-20 w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <button onClick={() => { setOpen(false); setEditing(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil className="h-3.5 w-3.5 text-zinc-400" />Rename &amp; edit</button>
          <button onClick={() => { setOpen(false); duplicate(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Copy className="h-3.5 w-3.5 text-zinc-400" />Duplicate</button>
          {onMoveToFolder && <button onClick={() => { setOpen(false); onMoveToFolder(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><FolderInput className="h-3.5 w-3.5 text-zinc-400" />Move to folder…</button>}
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
                      {a.tools?.length > 0 && <span className="mt-0.5 block truncate text-xs text-zinc-400">tools: {a.tools.join(', ')}</span>}
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
                <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-300/70">Only these exact items are installed — the repo's own install scripts are never run.</p>
              </div>
            ) : (
              <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-800/60">Nothing extra to install — these agents run on your existing tools.</div>
            )}
            {deps?.notes?.length > 0 && <div className="text-xs text-zinc-400">{deps.notes.map((n: string, i: number) => <div key={i}>ℹ️ {n}</div>)}</div>}
            <button onClick={doImport} disabled={busy || !picked.size} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Import {picked.size} agent{picked.size === 1 ? '' : 's'}{hasDeps && installDeps ? ' + install the plan' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function NewAgentForm({ initial, areaId, social, folderId, onCreated, onCancel }: { initial?: Starter | null; areaId?: string; social?: SocialPrefill | null; folderId?: string | null; onCreated: (id?: string) => void; onCancel: () => void }) {
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
  const [sheetAppend, setSheetAppend] = useState(false); // "keep adding" to one sheet (BEA-1374)
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(false);
  // The sources a Social job fetches (BEA-1359): the one it was made from, plus any added here.
  // Each is a svc: id with its EXACT arguments pinned; the run fetches every one directly. Sources
  // are keyed by their own id (BEA-1374) — several may share one action (five hashtags = five sources).
  const [sources, setSources] = useState<(SocialSource & { id: string })[]>(social ? [{ id: social.tool, tool: social.tool, args: social.args || {}, label: social.label }] : []);
  const [addingSource, setAddingSource] = useState(false);
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
          ...(folderId ? { folderId } : {}), // created from inside a folder → it lands there (BEA-1380)
          ...(draftTools.length ? { tools: draftTools } : {}), // inferred toolbox → the area's Tools section (BEA-1100)
          outputDest, sheetId: sheetId.trim() || null, sheetAppend: outputDest === 'sheet' && !sheetId.trim() && sheetAppend, notifyWhatsApp, // BEA-1357 · BEA-1374
          // A Social job (BEA-1357): the sources — each its action id + exact arguments, keyed by source id (BEA-1374) — run directly, no engine turn.
          // A ready run screen too — no inputs to design, so the job page never spends an engine turn on one.
          ...(social ? { tools: toolsOf(sources.map((x) => ({ id: x.id, actionId: x.tool, value: x.args }))), toolArgs: toolArgsOf(sources.map((x) => ({ id: x.id, actionId: x.tool, value: x.args }))), origin: 'social', ui: { headline: name.trim(), inputs: [], view: 'report', runLabel: mode === 'run' ? 'Fetch now →' : 'Check now →' } } : {}),
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
      {/* A Social job (BEA-1357): the fetch is the tool + these exact arguments — no engine turn.
          Several sources (BEA-1359) are fetched one after the other and merged into one table. */}
      {social && sources.map((src, i) => (
        <ToolArgsEditor key={src.id} tool={src.tool} args={src.args} toolName={src.label}
          onChange={(next) => setSources((p) => p.map((x, j) => (j === i ? { ...x, args: next } : x)))}
          onRemove={sources.length > 1 ? () => setSources((p) => p.filter((_, j) => j !== i)) : undefined} />
      ))}
      {social && !addingSource && (
        <button type="button" onClick={() => setAddingSource(true)} className="inline-flex items-center gap-1 text-xs font-medium text-pink-700 hover:underline dark:text-pink-300"><Plus className="h-3.5 w-3.5" /> Add another source</button>
      )}
      {social && addingSource && (
        <AddSourcePanel defaultPlatform={social.tool.replace(/^svc:/, '').split('.')[0]} taken={sources.map((x) => x.tool)} onAdd={(x) => { setSources((p) => [...p, { ...x, id: sourceIdFor(x.tool, p.map((y) => y.id)) }]); setAddingSource(false); }} onCancel={() => setAddingSource(false)} />
      )}
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
      <OutputDestPicker dest={outputDest} sheetId={sheetId} sheetAppend={sheetAppend} onChange={(v) => { setOutputDest(v.outputDest); setSheetId(v.sheetId); setSheetAppend(v.sheetAppend); }} />
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

/** One template card on the shelf gallery (BEA-1064): icon, what it does, example runs, rhythm. */
function StarterCard({ s, onPick }: { s: Starter; onPick: (s: Starter) => void }) {
  return (
    <button onClick={() => onPick(s)} style={{ borderLeftColor: s.color }}
      className="rounded-xl border border-l-4 border-zinc-200 bg-white p-3 text-left transition-all hover:-translate-y-0.5 hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg" style={{ background: s.color + '22' }}>{s.icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{s.name}</span>
          <span className="block truncate text-xs text-zinc-500">{s.blurb}</span>
        </span>
      </div>
      {s.examples?.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {s.examples.slice(0, 2).map((ex, i) => <div key={i} className="truncate text-xs italic text-zinc-400">{ex}</div>)}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {s.every && s.every !== 'manual' && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">{s.every === 'day' ? `daily ${s.at}` : s.every === 'week' ? `Sundays ${s.at}` : s.every === 'weekday' ? `weekdays ${s.at}` : 'hourly'}</span>}
        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs capitalize text-zinc-500 dark:bg-zinc-800">{s.category}</span>
      </div>
    </button>
  );
}

/**
 * An area's kind, from the jobs inside it (BEA-1506).
 *
 * Any tools job makes the whole area a tools area — what it can touch in his accounts matters more
 * than what it also happens to read. An area with no jobs yet has nothing to act on, so it reads as
 * research until it does.
 */
/**
 * Is this agent parked on a question of his? (BEA-1514)
 *
 * ONE definition, used by the "Needs you" tab, its count and the "Waiting on you" dropdown — a count
 * that disagreed with the list it counts is the exact bug class this module keeps producing.
 */
export function waitingJobOf(ar: any): any | undefined {
  return (ar?.jobs || []).find((j: any) => j.lastRun?.status === 'awaiting_input' || j.lastRun?.status === 'paused');
}

export function areaNeedsYou(ar: any): boolean {
  return !!waitingJobOf(ar);
}

/** When this agent runs, in his words — the first job that has a schedule (BEA-1535). */
function schedOf(ar: any): string {
  const j = (ar?.jobs || []).find((x: any) => x?.scheduleText);
  const t = j?.scheduleText ? String(j.scheduleText) : '';
  // "Manual only. Runs when you press Run." is not a schedule — saying it on a row is noise.
  return /manual only/i.test(t) ? '' : t;
}

/**
 * An area with nothing inside it is an unfinished draft, not an agent (BEA-1564).
 *
 * `agent.controller.ts` creates the area first and writes the goal second, so any failure in
 * between leaves a shell. It is safe to keep these out of the list precisely BECAUSE they are
 * empty: there is no job, no run and no history in one, which is exactly what he found when he
 * tapped one — *"nothing is there inside"*.
 *
 * Deliberately NOT time-based. A shell created ten seconds ago and one created last week are the
 * same thing, and a clock here would make the list flicker as a draft aged past the threshold.
 * The builder navigates straight into the new area, so an in-progress build never needs to be
 * findable in this list.
 */
export function isDraftShell(ar: any): boolean {
  return (ar?.jobCount || 0) === 0 && !(ar?.jobs || []).length;
}

/**
 * THE MOST RECENT RUN, whatever happened in it (BEA-1564).
 *
 * The list used to reach for the last run that SUCCEEDED, which meant a failing agent wore the
 * timestamp of its last good day and looked healthy. This takes the newest run of any status, so a
 * failure is visible on the row it belongs to.
 *
 * Exported because the card view and the list must agree — the same bug in two renderers is this
 * module's most repeated mistake (`CLAUDE.md`: "a rule with two call sites should be a function
 * with one").
 */
export function latestRun(ar: any): { status: string; at: string } | undefined {
  return (ar?.jobs || [])
    .map((j: any) => j.lastRun)
    .filter((r: any) => r?.at)
    .sort((x: any, y: any) => new Date(y.at).getTime() - new Date(x.at).getTime())[0];
}

/** How a run's status reads on a row — one definition for every surface that shows one. */
export const RUN_TONE: Record<string, { label: string; cls: string }> = {
  done: { label: 'ok', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' },
  failed: { label: 'failed', cls: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300' },
  running: { label: 'running', cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300' },
  awaiting_input: { label: 'needs you', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' },
  paused: { label: 'needs you', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' },
  cancelled: { label: 'stopped', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
};

/**
 * What this agent actually does, in one line (BEA-1564).
 *
 * The list showed the name and nothing else, so twelve rows of "GitHub top 5" / "Daily Email Agent"
 * told him only what he already named them. The area's own description is the best line; failing
 * that, the single job's name, which for a built agent is the goal it was built from — but never the
 * area's own name echoed straight back.
 */
function whatItDoes(ar: any): string {
  const d = String(ar?.description || '').trim();
  if (d) return d;
  const jobs = ar?.jobs || [];
  const n = jobs.length === 1 ? String(jobs[0]?.name || '').trim() : '';
  return n && n !== String(ar?.name || '').trim() ? n : '';
}

/** Is anything in this agent switched on? Off means nothing in it will fire on its own. */
function anyOn(ar: any): boolean {
  const jobs = ar?.jobs || [];
  return jobs.length === 0 ? true : jobs.some((j: any) => j?.enabled !== false);
}

function areaKind(ar: any): 'tools' | 'research' {
  const jobs = ar?.jobs || [];
  return jobs.some((j: any) => agentKind(j) === 'tools') ? 'tools' : 'research';
}

export function Agents() {
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const focusId = params.get('focus'); // push-notification deep link (BEA-1088 groundwork)
  // The Social handoff (BEA-1357): `/agent?builder=1&tool=<svc id>&args=<json>&label=…` opens the
  // builder form pre-filled. Read once; the params are cleared when the form closes.
  // `builder=chat` (BEA-1372) is the same hand-off into the THINKING builder; the form stays one tap away
  // ("Repeat exactly this call"), so the prefill is read for both.
  const [socialPrefill] = useState<SocialPrefill | null>(() => readSocialPrefill(params, ['1', 'chat']));
  const [builderSeed] = useState<BuilderSeed | null>(() => readBuilderSeed(params));
  const clearBuilderParams = () => { if (params.get('builder')) { const p = new URLSearchParams(params); ['builder', 'tool', 'args', 'label', 'sample'].forEach((k) => p.delete(k)); setParams(p, { replace: true }); } };
  // Once the seed is on the server, drop `sample` from the URL — a reload must not start the conversation over.
  const dropSeedParam = () => { if (params.get('sample')) { const p = new URLSearchParams(params); p.delete('sample'); setParams(p, { replace: true }); } };
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
  // TOOLS OR RESEARCH (BEA-1506) — his segregation, as tabs above the list, plus the "Needs you" tab
  // he asked for (BEA-1514). It is the one that earns its place: an agent parked on a question was
  // otherwise invisible here until you checked WhatsApp.
  //
  // It sits in the tab row and is therefore exclusive with Tools/Research, which is the one thing this
  // comment used to argue against. Nothing is lost: "show me the RESEARCH ones that need me" is still
  // one pick away in the Waiting-on-you dropdown, which is orthogonal to the tabs by design. Both
  // roads read `areaNeedsYou`, so the tab, its count and the dropdown cannot drift apart.
  const [kindTab, setKindTab] = useState<'all' | 'tools' | 'research' | 'needs'>('all');
  const [agentSort, setAgentSort] = useState<'recent' | 'name' | 'jobs'>('recent');
  // CARDS OR LIST (BEA-1539) — his ask, and the `\u25A6 \u25A4` toggle the redesign mockup always had.
  // Cards are good for browsing ten agents; a list is better for scanning names, schedules and what
  // ran when. Remembered, because a view you have to re-pick every visit is not really a choice.
  const [view, setView] = useState<'cards' | 'list'>(() => {
    try { return localStorage.getItem('agents.view') === 'list' ? 'list' : 'cards'; } catch { return 'cards'; }
  });
  const pickView = (v: 'cards' | 'list') => { setView(v); try { localStorage.setItem('agents.view', v); } catch { /* private mode */ } };
  const [showImport, setShowImport] = useState(false); // GitHub agent import (BEA-1081)
  const [showBuilder, setShowBuilder] = useState((params.get('builder') === '1' && !readSocialPrefill(params)) || params.get('builder') === 'chat'); // chat builder (BEA-1104); `?builder=1` alone opens it; `builder=chat` = the Social hand-off (BEA-1372)
  // Folders (BEA-1380): flat, owner-made. The selection lives in the URL (`?folder=<id|unfiled>`)
  // so Back and refresh land where you were; null = All. The auto-category shelves are retired —
  // folders are the ONE organizing idea on this screen (Agent.category stays in the data for colors).
  const folderSel: FolderSel = params.get('folder');
  const [folders, setFolders] = useState<AgentFolder[] | null>(null);
  const loadFolders = useCallback(() => fetch('/api/agent/folders').then((r) => r.json()).then((d) => setFolders(Array.isArray(d?.folders) ? d.folders : [])).catch(() => setFolders((p) => p || [])), []);
  useEffect(() => { loadFolders(); }, [loadFolders]);
  // Multi-select (BEA-1380): checkbox at laptop widths, long-press on the phone; a bar moves them together.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerFor, setPickerFor] = useState<{ kind: 'one'; id: string; name: string } | { kind: 'bulk' } | null>(null);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
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
  // Mission Control's other two strips (BEA-1533). The API has served these the whole time.
  const running = home?.running || [];
  // ONE ROW PER AGENT, newest first (BEA-1533). The raw list is every finished run, so a job that ran
  // four times overnight filled this strip with four identical lines and pushed everything else off
  // the screen. The design shows what DIFFERENT agents did — the latest outcome per agent is the
  // useful fact; the rest is in History.
  const landed = (() => {
    const seen = new Set<string>();
    const out: LandedItem[] = [];
    for (const l of home?.landed || []) {
      const key = String(l.title || l.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    return out;
  })();
  // running / landed are no longer shown here (BEA-1181) — History owns them.
  const agents = home?.agents || null;
  // Areas (BEA-1098): the home now shows agents-as-areas; jobs live inside each area's page.
  const [areasList, setAreasList] = useState<any[] | null>(null);
  // Unfinished drafts, kept aside rather than deleted (BEA-1564) — see `isDraftShell`.
  const [drafts, setDrafts] = useState<any[]>([]);
  const [clearingDrafts, setClearingDrafts] = useState(false);
  /**
   * NO GHOST ROWS (BEA-1564). His words: *"Even after deleting an agent, it is showing in the list
   * of agents, but when I click on it, nothing is there inside."*
   *
   * The shells are real. `builder/send-to-codex` creates the area BEFORE the goal is written, so a
   * goal that fails — his AI budget ran out on 28 Aug — strands an area with no jobs in it; four of
   * them were sitting in his list. `deleteAgent` never removes the area it emptied either.
   *
   * The split happens HERE, at the one place the data arrives, so the header count, the folder
   * counts, the tab counts and the table can never disagree about how many agents he has. Nothing
   * is deleted behind his back — the drafts are counted below the list and he taps to clear them.
   */
  const loadAreas = useCallback(() => fetch('/api/agent/areas')
    .then((r) => r.json())
    .then((d) => {
      const all = Array.isArray(d) ? d : [];
      setAreasList(all.filter((a: any) => !isDraftShell(a)));
      setDrafts(all.filter(isDraftShell));
    })
    .catch(() => { setAreasList([]); setDrafts([]); }), []);
  useEffect(() => { loadAreas(); }, [loadAreas]);

  /**
   * Clear the unfinished drafts — only the ones just counted, one id at a time (BEA-1564).
   *
   * His standing rule is that the app deletes what he pointed at and nothing else, so this walks
   * the exact `drafts` array the line above him was drawn from. It never asks the server for
   * "everything empty", which could sweep up a shell created in the seconds since the page loaded.
   */
  async function clearDrafts() {
    if (clearingDrafts || !drafts.length) return;
    setClearingDrafts(true);
    const ids = drafts.map((d: any) => d.id);
    let gone = 0;
    for (const id of ids) {
      const r = await fetch(`/api/agent/areas/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r?.ok) gone++;
    }
    setClearingDrafts(false);
    toast(gone === ids.length ? 'success' : 'error',
      gone === ids.length
        ? `Cleared ${gone} unfinished draft${gone === 1 ? '' : 's'}`
        : `Cleared ${gone} of ${ids.length} — try the rest again`);
    loadAreas();
  }

  // ---- Folders (BEA-1380) ----
  const realFolderId = folderSel && folderSel !== 'unfiled' ? folderSel : null; // where a new agent lands
  function setFolder(sel: FolderSel) {
    const p = new URLSearchParams(params);
    if (sel) p.set('folder', sel); else p.delete('folder');
    setParams(p, { replace: true });
    setSelected(new Set());
  }
  async function createFolderReturning(name: string): Promise<AgentFolder | null> {
    try {
      const r = await fetch('/api/agent/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not make the folder');
      await loadFolders();
      return d;
    } catch (e: any) { toast('error', e?.message || 'Could not make the folder'); return null; }
  }
  async function createFolder(name: string): Promise<boolean> {
    const made = await createFolderReturning(name);
    if (made) { toast('success', `Folder "${made.name}" made`); setFolder(made.id); }
    return !!made;
  }
  async function renameFolder(id: string, name: string): Promise<boolean> {
    const r = await fetch(`/api/agent/folders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast('error', d.message || 'Could not rename'); return false; }
    loadFolders();
    return true;
  }
  async function deleteFolder(id: string) {
    const f = (folders || []).find((x) => x.id === id);
    const n = areasList ? areasList.filter((a: any) => a.folderId === id).length : 0;
    // Deleting a folder NEVER deletes agents — the dialog says so (BEA-1380).
    const msg = n === 0
      ? `Delete the empty folder "${f?.name || ''}"?`
      : `Delete the folder "${f?.name || ''}"? Its ${n} agent${n === 1 ? '' : 's'} move to Unfiled — nothing is deleted.`;
    if (!window.confirm(msg)) return;
    const r = await fetch(`/api/agent/folders/${id}`, { method: 'DELETE' });
    if (!r.ok) { toast('error', 'Could not delete the folder'); return; }
    if (folderSel === id) setFolder(null);
    toast('success', n > 0 ? `Folder deleted — ${n} agent${n === 1 ? '' : 's'} back in Unfiled` : 'Folder deleted');
    loadFolders(); loadAreas();
  }
  async function moveToFolder(ids: string[], folderId: string | null) {
    try {
      const r = ids.length === 1
        ? await fetch(`/api/agent/areas/${ids[0]}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId }) })
        : await fetch('/api/agent/areas/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, folderId }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not move');
      const fname = folderId ? (folders || []).find((x) => x.id === folderId)?.name || 'that folder' : 'Unfiled';
      toast('success', `Moved ${ids.length === 1 ? '' : ids.length + ' agents '}to ${fname}`);
      setSelected(new Set());
      loadAreas(); loadFolders();
    } catch (e: any) { toast('error', e?.message || 'Could not move'); }
  }
  /**
   * PAUSE OR RESUME SEVERAL AGENTS AT ONCE (BEA-1509).
   *
   * The selection holds AREAS, and it is the jobs inside them that have a schedule — so this walks
   * the jobs rather than the tiles. Deliberately sequential: these are writes to his own jobs and a
   * burst of parallel PATCHes buys nothing but a harder failure to read.
   */
  async function bulkEnabled(on: boolean) {
    const ids = [...selected];
    const jobs = (areasList || []).filter((ar: any) => ids.includes(ar.id)).flatMap((ar: any) => ar.jobs || []);
    if (!jobs.length) { toast('error', 'Those agents have no jobs to change'); return; }
    let done = 0;
    for (const j of jobs) {
      const r = await fetch(`/api/agent/agents/${j.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }),
      }).catch(() => null);
      if (r?.ok) done++;
    }
    toast(done === jobs.length ? 'success' : 'error', `${on ? 'Resumed' : 'Paused'} ${done} of ${jobs.length}`);
    setSelected(new Set());
    loadAreas();
  }

  /**
   * Delete several agents at once (BEA-1509).
   *
   * Says what goes and what stays before it does anything — his sheets and Notion pages live in his
   * own accounts and nothing here can reach them, which is the fact he would actually want.
   */
  async function bulkDelete() {
    const ids = [...selected];
    const areas = (areasList || []).filter((ar: any) => ids.includes(ar.id));
    const jobs = areas.reduce((n: number, ar: any) => n + (ar.jobs?.length || 0), 0);
    const msg =
      `Delete ${areas.length} agent${areas.length === 1 ? '' : 's'}?\n\n` +
      `GONE: ${jobs} job${jobs === 1 ? '' : 's'} and all their run history.\n\n` +
      'KEPT: everything they made. Sheets and Notion pages live in your own accounts and are not touched.';
    if (!window.confirm(msg)) return;
    let done = 0;
    for (const ar of areas) {
      const n = ar.jobs?.length || 0;
      const r = await fetch(`/api/agent/areas/${ar.id}${n > 0 ? '?withJobs=1' : ''}`, { method: 'DELETE' }).catch(() => null);
      if (r?.ok) done++;
    }
    toast(done === areas.length ? 'success' : 'error', `Deleted ${done} of ${areas.length}`);
    setSelected(new Set());
    loadAreas(); loadFolders();
  }

  function toggleSelected(id: string) {
    setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  // Long-press at 390 starts multi-select (BEA-1380); the flag swallows the click that follows.
  function pressStart(id: string) {
    longPressRef.current.fired = false;
    longPressRef.current.timer = setTimeout(() => { longPressRef.current.fired = true; toggleSelected(id); }, 500);
  }
  function pressEnd() {
    if (longPressRef.current.timer) { clearTimeout(longPressRef.current.timer); longPressRef.current.timer = null; }
  }

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

      {/* Floating "Quick ask" — a one-off run without saving an agent (capture pattern, BEA-698).
          Hidden while multi-select is on: the move bar owns the bottom of the screen (BEA-1380). */}
      {selected.size === 0 && <button
        onClick={() => setShowAsk(true)}
        className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg transition-colors hover:bg-emerald-500"
      >
        <Sparkles className="h-4 w-4" />Quick ask
      </button>}

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

      {/* MISSION CONTROL (BEA-1533) — restored from design/agents-redesign/concept-1-mission-control.html.
          What needs you, what is running, what landed — in that order, ABOVE the agents themselves.
          These were built, then stripped back to a flat grid (BEA-1181 removed "Running now" and
          "Landed today", and pushed "Needs you" below the grid where it sat off the bottom of the
          screen). A job waiting on an answer is the most urgent thing on this page and it was the
          least visible. The data never went away — /api/agent/home has served `running` and `landed`
          the whole time; only the drawing was missing. */}
      {waiting.length > 0 && (
        <section className="space-y-2" data-testid="mc-waiting">
          <div className="flex items-baseline justify-between">
            <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
              <PauseCircle className="h-3.5 w-3.5" />Waiting on you
              <span className="rounded-full bg-amber-100 px-1.5 text-xs font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">{waiting.length}</span>
            </h2>
          </div>
          {/* Two abreast only when there are two (BEA-1564). A lone question in a half-width cell
              left the other half empty beside the full-width strips below it, which read as a
              layout that had not finished loading rather than as the page's most urgent item. */}
          <div className={'grid gap-3 ' + (waiting.length > 1 ? 'lg:grid-cols-2' : '')}>
            {waiting.map((w) => (
              <WaitingCard key={w.waitpointId || w.runId} w={w} focus={!!focusId && (w.waitpointId === focusId || w.runId === focusId)} onAnswered={loadHome} />
            ))}
          </div>
        </section>
      )}

      {running.length > 0 && (
        <section className="space-y-2" data-testid="mc-running">
          <div className="flex items-baseline justify-between">
            <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.12em] text-emerald-600 dark:text-emerald-400">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
              Running now
            </h2>
            <button onClick={() => nav('/agent/runs')} className="text-xs font-medium text-emerald-600 hover:underline">all runs →</button>
          </div>
          <div className="space-y-2">
            {running.map((r) => <RunningCard key={r.id} r={r} />)}
          </div>
        </section>
      )}

      {landed.length > 0 && (
        <section data-testid="mc-landed">
          {/* AN ACCORDION, HIS ASK (BEA-1539). What landed is reassurance, not a decision — it does not
              deserve permanent height above the agents. Closed it still says the useful part (how many,
              and whether any failed); open it lists them. It stays OPEN when something failed, because
              that is the one case you want in front of you rather than behind a tap. */}
          <details open={landed.some((l) => l.status !== 'done')} className="group rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
              <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">Landed today</h2>
              <span className="text-xs text-zinc-400">
                {landed.length}
                {landed.some((l) => l.status !== 'done') && <span className="ml-1 font-semibold text-rose-600 dark:text-rose-400">· {landed.filter((l) => l.status !== 'done').length} failed</span>}
              </span>
              <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); nav('/agent/runs'); }} className="ml-auto text-xs font-medium text-emerald-600 hover:underline">everything →</button>
              <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-1.5 border-t border-zinc-100 p-2 dark:border-zinc-800">
              {landed.slice(0, 5).map((l) => <LandedRow key={l.id} l={l} />)}
            </div>
          </details>
        </section>
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
        {showImport && <ImportGithubModal onDone={(url) => { setShowImport(false); loadHome(); loadAreas(); loadFolders(); if (url) nav(url); }} onClose={() => setShowImport(false)} />}
        {showBuilder && <AgentBuilder seed={builderSeed} folderId={realFolderId} onSeeded={dropSeedParam} onCreated={(url) => { setShowBuilder(false); clearBuilderParams(); loadHome(); loadAreas(); loadFolders(); if (url) nav(url); }} onUseForm={() => { setShowBuilder(false); if (builderSeed) { const p = new URLSearchParams(params); p.set('builder', '1'); p.delete('sample'); setParams(p, { replace: true }); } setShowNew(true); }} onClose={() => { setShowBuilder(false); clearBuilderParams(); }} />}
        {showNew && <NewAgentForm initial={starterPick} social={socialPrefill} folderId={realFolderId} onCreated={(id) => { setShowNew(false); setStarterPick(null); clearBuilderParams(); loadHome(); loadAreas(); loadFolders(); if (id && socialPrefill) nav(`/agent/a/${id}`); }} onCancel={() => { setShowNew(false); setStarterPick(null); clearBuilderParams(); }} />}
        {/* Folders (BEA-1383): ONE horizontal chips row above the list at EVERY width — the BEA-1380
            laptop left rail was rejected and removed, so the agents list keeps the full width. */}
        {folders !== null && areasList !== null && (areasList.length > 0 || folders.length > 0) && (
          <FolderNav folders={folders} counts={folderCounts(areasList)} active={folderSel} onSelect={setFolder} onCreate={createFolder} onRename={renameFolder} onDelete={deleteFolder} />
        )}
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
          // (BEA-1183). A list with one item still shows its controls. The selected folder narrows
          // the scope first (BEA-1380): All searches everything, a folder searches that folder.
          //
          // NOT ON `DataTable`, ON PURPOSE (BEA-1528). The redesign plan said "the shared table", and
          // this is the one place that was not followed to the letter — a decision, not an oversight.
          // `DataTable` renders a single `emptyText`, and this screen needs two empty states that each
          // do something a string cannot: an empty FOLDER says how to fill it and offers "Show all",
          // and a search that matched nothing offers "Clear". It also carries multi-select bulk
          // actions and a skeleton loader, which `DataTable` does not model. Converting would lose
          // working affordances on his most-used screen and gain only component uniformity — every
          // FUNCTION the standard asks for is already here. `AgentsListStandard.test.tsx` enforces
          // each of them, so this cannot silently drift below the standard; if those empty states are
          // ever dropped, the justification goes with them and it SHOULD be converted.
          const scope = inFolder(areasList as any[], folderSel);
          const needle = q.trim().toLowerCase();
          const lastAt = (ar: any) => Math.max(0, ...(ar.jobs || []).map((j: any) => (j.lastRun?.at ? new Date(j.lastRun.at).getTime() : 0)));
          // Rows for the shared table (BEA-1531): the fields it searches and sorts on, materialised.
          // `DataTable` matches the search against its COLUMNS and sorts on the key straight off the
          // row, so the one `search` column below reproduces exactly what this screen always searched
          // — name, description and the names of the jobs inside.
          const rows = scope.map((ar: any) => ({
            ...ar,
            search: [ar.name, ar.description || '', (ar.jobs || []).map((j: any) => j.name).join(' ')].join(' '),
            lastAtNum: lastAt(ar),
            jobsNum: ar.jobCount || 0,
            nameKey: String(ar.name || '').toLowerCase(),
          }));
          const PER = 12;
          const narrowed = !!needle || agentFilter !== 'all' || kindTab !== 'all';
          return (
            <div className="space-y-3">
              {/* TOOLS OR RESEARCH (BEA-1506). Tabs rather than another dropdown: which kind am I
                  looking for is the first question you ask of a list of agents, and it should cost no
                  clicks. Counts come from the SAME scope the list is drawn from, so a tab never
                  promises rows a folder has already filtered out. */}
              <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 pb-1 dark:border-zinc-800">
                {([
                  { k: 'all' as const, label: 'All' },
                  { k: 'tools' as const, label: '\u{1F527} Tools' },
                  { k: 'research' as const, label: '\u{1F50E} Research' },
                  { k: 'needs' as const, label: '\u{23F3} Needs you' },
                ]).map((t) => {
                  const n =
                    t.k === 'all' ? scope.length
                    : t.k === 'needs' ? scope.filter(areaNeedsYou).length
                    : scope.filter((ar: any) => areaKind(ar) === t.k).length;
                  const on = kindTab === t.k;
                  return (
                    <button
                      key={t.k}
                      data-testid={`kind-tab-${t.k}`}
                      aria-pressed={on}
                      onClick={() => setKindTab(t.k)}
                      className={
                        'shrink-0 rounded-t-lg px-3 py-1.5 text-xs font-semibold transition-colors ' +
                        (on
                          ? 'border-b-2 border-emerald-500 text-emerald-700 dark:text-emerald-300'
                          : t.k === 'needs' && n > 0
                            // Something is actually parked on him — the tab says so without being tapped.
                            ? 'border-b-2 border-transparent text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300'
                            : 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
                      }
                    >
                      {t.label}<span className="ml-1.5 text-xs font-bold text-zinc-400">{n}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-48">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search agents…"
                    className="w-full rounded-lg border border-zinc-200 bg-transparent py-1.5 pl-8 pr-3 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 sm:text-sm"
                  />
                </div>
                <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value as any)} aria-label="Filter agents" className="shrink-0 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-900">
                  <option value="all">All agents</option>
                  <option value="waiting">Waiting on you</option>
                  <option value="ran">Has run</option>
                  <option value="never">Never run</option>
                </select>
                <div className="flex shrink-0 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700" role="group" aria-label="How to show them">
                  {([['cards', '\u25A6', 'Cards'], ['list', '\u25A4', 'List']] as const).map(([v, glyph, label]) => (
                    <button
                      key={v}
                      data-testid={`view-${v}`}
                      aria-pressed={view === v}
                      title={label}
                      onClick={() => pickView(v)}
                      className={'px-2.5 py-1.5 text-sm ' + (view === v ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200')}
                    >{glyph}</button>
                  ))}
                </div>
                <select value={agentSort} onChange={(e) => setAgentSort(e.target.value as any)} aria-label="Sort agents" className="shrink-0 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-900">
                  <option value="recent">Most recent</option>
                  <option value="name">By name</option>
                  <option value="jobs">Most jobs</option>
                </select>
              </div>
              {/* THE SHARED TABLE (BEA-1531). Search, filters, sort, count and pages all come from
                  `DataTable` now, in `controls` mode: this screen keeps its own control bar — the
                  kind tabs, the search box, the two selects — and hands their VALUES over, so the
                  table does the filtering and resets to page one when any of them changes. The
                  kind tab is passed as a filter for exactly that reason.
                  `cardsOnly` + `gridClassName` keep the card grid identical to before. */}
              {/* AN EMPTY FOLDER IS NOT "NOTHING MATCHES" (BEA-1380, kept through BEA-1531).
                  The shared table renders one `emptyText` string; this case needs a sentence that
                  says how to fill the folder and a button that leaves it, so it is answered BEFORE
                  the table rather than inside it. */}
              {scope.length === 0 && !narrowed ? (
                <div className="rounded-2xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  {folderSel === 'unfiled' ? 'Nothing is unfiled — every agent sits in a folder.' : 'This folder is empty — open an agent card\u2019s ⋯ menu and pick "Move to folder…", or create a new agent while you\u2019re in here.'}{' '}
                  <button onClick={() => setFolder(null)} className="text-emerald-600 hover:underline">Show all</button>
                </div>
              ) : (
              <>
              <DataTable<any>
                /**
                 * ONE COLUMN, BOTH VIEWS (BEA-1564, second pass).
                 *
                 * His words: *"this design has to be list view, not table view … it has to follow
                 * the same design language"*, pointing at `/documents`. Documents draws its list as
                 * a stack of bordered rows through `renderCard` + `space-y-2` — never an HTML table
                 * with column headers — and Agents now does the same, so the two pages read as one
                 * product.
                 *
                 * The `search` column stays because `DataTable` matches the search box against its
                 * COLUMNS: this one string is name + description + the names of the jobs inside,
                 * which is exactly what this screen has always searched.
                 */
                columns={[{ key: 'search', label: 'Agent' }]}
                rows={rows}
                filters={[
                  { key: 'kind', label: 'Kind', options: [], match: (row: any, v: string) => (v === 'needs' ? areaNeedsYou(row) : areaKind(row) === v) },
                  {
                    key: 'status', label: 'Status', options: [],
                    match: (row: any, v: string) => {
                      const jobs = row.jobs || [];
                      if (v === 'waiting') return areaNeedsYou(row);
                      if (v === 'ran') return jobs.some((j: any) => j.lastRun);
                      if (v === 'never') return jobs.every((j: any) => !j.lastRun);
                      return true;
                    },
                  },
                ]}
                controls={{
                  search: q,
                  filters: { kind: kindTab === 'all' ? '' : kindTab, status: agentFilter === 'all' ? '' : agentFilter },
                  sort: agentSort === 'name' ? { key: 'nameKey', dir: 1 } : agentSort === 'jobs' ? { key: 'jobsNum', dir: -1 } : { key: 'lastAtNum', dir: -1 },
                }}
                pageSize={PER}
                // Both views are drawn by `renderCard` now — the list is a STACK OF ROWS, exactly
                // as `/documents` draws its list, never an HTML table (BEA-1564, second pass).
                cardsOnly
                // `[&>*]:min-w-0` below is load-bearing (BEA-1531). DataTable wraps each card in a
                // div of its own, so THAT wrapper is the grid item, not the card — and a grid item
                // defaults to `min-width:auto` and refuses to shrink. Without it the conversion
                // silently reintroduced BEA-1525: agent names cut mid-word at 390. The ship gate
                // caught it and rolled the deploy back.
                gridClassName={view === 'list' ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0'}
                emptyText={`Nothing matches${needle ? ` \u201C${q}\u201D` : ' that filter'}${folderSel ? ' in this folder' : ''}.`}
                renderCard={view === 'list'
                  ? ((ar: any) => <AgentListRow key={ar.id} ar={ar} onOpen={() => nav(`/agent/a/${ar.jobCount === 1 && ar.jobs?.[0]?.id ? ar.jobs[0].id : ar.id}`)} />)
                  : ((ar: any) => {
                  const color = ar.color || '#818cf8';
                  const runningJob = ar.jobs.find((j: any) => j.lastRun?.status === 'running');
                  const waitingJob = waitingJobOf(ar);
                  const lastRun = latestRun(ar);
                  const isSel = selected.has(ar.id);
                  const selectMode = selected.size > 0;
                  return (
                    <div key={ar.id} style={{ borderLeftColor: color }}
                      onTouchStart={() => pressStart(ar.id)} onTouchEnd={pressEnd} onTouchMove={pressEnd} onTouchCancel={pressEnd}
                      // `min-w-0` is load-bearing (BEA-1514): a grid item defaults to `min-width:auto`,
                      // so this card refused to shrink below its content and rendered 478px wide inside
                      // a 343px cell at 390. The page never scrolled sideways — the overflow was hidden
                      // — so it looked fine while agent names were being cut mid-word ("Instagram dige").
                      // The inner spans already had `truncate`; they were truncating against a width the
                      // phone never had.
                      className={'group relative flex min-w-0 select-none flex-col rounded-2xl border border-l-4 border-zinc-200 bg-white p-4 transition-all touch-manipulation hover:-translate-y-0.5 hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900 ' + (isSel ? 'ring-2 ring-emerald-500' : '')}>
                    {/* Rename · duplicate · move to folder · delete, right where you can see them (BEA-1182 / BEA-1380). */}
                    <AgentCardMenu area={ar} onChanged={() => { loadAreas(); loadHome(); loadFolders(); }} onMoveToFolder={() => setPickerFor({ kind: 'one', id: ar.id, name: ar.name })} />
                    {/* Multi-select (BEA-1380): a checkbox on hover at laptop widths; long-press starts it on the phone. */}
                    <button onClick={(e) => { e.stopPropagation(); toggleSelected(ar.id); }} aria-label={`Select ${ar.name}`} aria-pressed={isSel}
                      onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}
                      className={'absolute right-9 top-2 z-10 rounded-lg p-1.5 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 ' + (selectMode ? 'opacity-100 ' : 'pointer-events-none opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 ') + (isSel ? 'text-emerald-600' : 'text-zinc-400 hover:text-emerald-600')}>
                      {isSel ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                    </button>
                    <button onClick={() => { if (longPressRef.current.fired) { longPressRef.current.fired = false; return; } if (selectMode) toggleSelected(ar.id); else nav(`/agent/ar/${ar.id}`); }} className="flex flex-1 flex-col text-left">
                      <div className="flex items-start gap-2.5">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl" style={{ background: color + '22' }}>{ar.icon || '🤖'}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 truncate text-sm font-semibold group-hover:text-emerald-600">{ar.name}</span>
                            {/* Which kind, on the tile itself (BEA-1506) — so the two are told apart
                                without reaching for a tab. */}
                            <span
                              data-testid={`area-kind-${areaKind(ar)}`}
                              title={areaKind(ar) === 'tools' ? 'Acts in your accounts' : 'Reads the web and writes it up'}
                              className={
                                'shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold ' +
                                (areaKind(ar) === 'tools'
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                                  : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300')
                              }
                            >{areaKind(ar) === 'tools' ? '\u{1F527}' : '\u{1F50E}'}</span>
                          </span>
                          <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500">{ar.description || (ar.jobCount === 1 && ar.jobs[0]?.name && ar.jobs[0].name !== ar.name ? ar.jobs[0].name : 'Your agent')}</span>
                        </span>
                      </div>
                      <span className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800">
                        <span className="font-medium">{ar.jobCount} job{ar.jobCount === 1 ? '' : 's'}</span>
                        {waitingJob && <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><PauseCircle className="h-3 w-3" />needs you</span>}
                        {runningJob && <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"><Loader2 className="h-3 w-3 animate-spin" />running</span>}
                        {/* The newest run of ANY status (BEA-1564) — this used to reach for the last
                            SUCCESS, so a card whose agent failed this morning wore a green tick and
                            the time of its last good day. Same bug as the list column, same fix, and
                            both now call `latestRun`. */}
                        {!runningJob && !waitingJob && lastRun && (
                          lastRun.status === 'done'
                            ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" />ran {timeAgo(lastRun.at)}</span>
                            : <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{(RUN_TONE[lastRun.status] || RUN_TONE.failed).label} {timeAgo(lastRun.at)}</span>
                        )}
                        {/* WHEN IT RUNS, AND WHETHER IT IS ON (BEA-1535). The approved mockup reads
                            "ran 3h ago · every day at 22:00" with an on/off pill — the two facts that
                            let you judge a row without opening it. Both were already on every job in
                            the payload (`scheduleText`, `enabled`); the card just never drew them. */}
                        {schedOf(ar) && <span className="inline-flex items-center gap-1 text-zinc-400"><CalendarClock className="h-3 w-3" />{schedOf(ar)}</span>}
                        <span className="ml-auto flex items-center gap-1.5">
                          {(ar.tools || []).length > 0 && <span>🔧 {ar.tools.length}</span>}
                          <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + (anyOn(ar)
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                            : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')}>{anyOn(ar) ? 'on' : 'off'}</span>
                        </span>
                      </span>
                    </button>
                    </div>
                  );
                })}
              />
              {/* The way out of a narrowed list (BEA-1531). It used to live inside the empty state;
                  the shared table renders that, so the button sits under the list instead — where it
                  is also reachable when the filter left you one result rather than none. */}
              {narrowed && (
                <div className="pt-1 text-center">
                  <button onClick={() => { setQ(''); setAgentFilter('all'); setKindTab('all'); }} className="text-xs font-medium text-emerald-600 hover:underline">Clear search and filters</button>
                </div>
              )}
              {/* The unfinished drafts, counted rather than hidden (BEA-1564). They are out of the
                  list because they are empty, but saying nothing at all would be its own kind of
                  lie — and deleting them unasked breaks his standing rule that the app never
                  removes anything he did not point at. So: one quiet line, and he taps. */}
              {drafts.length > 0 && !narrowed && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs text-zinc-400">
                  <span>{drafts.length} unfinished draft{drafts.length === 1 ? '' : 's'} — a build that stopped before the agent was made.</span>
                  <button
                    data-testid="clear-drafts"
                    disabled={clearingDrafts}
                    onClick={clearDrafts}
                    className="font-medium text-zinc-500 underline underline-offset-2 hover:text-rose-600 disabled:opacity-50 dark:hover:text-rose-400"
                  >{clearingDrafts ? 'Clearing…' : drafts.length === 1 ? 'Clear it' : 'Clear them'}</button>
                </div>
              )}
              </>
              )}
            </div>
          );
        })()}
      </section>

      {/* Multi-select move bar (BEA-1380) — floats while anything is ticked. */}
      {selected.size > 0 && (
        <div data-testid="bulk-bar" className="fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 sm:bottom-6">
          <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white py-1.5 pl-4 pr-1.5 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <span className="whitespace-nowrap font-medium">{selected.size} selected</span>
            <button onClick={() => setPickerFor({ kind: 'bulk' })} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"><FolderInput className="h-3.5 w-3.5" />Move to…</button>
              {/* PAUSE, RESUME AND DELETE IN BULK (BEA-1509). Moving to a folder was the only thing
                  you could do to several agents at once. Deliberately NOT "run" — running several
                  agents at once spends real credits and messages real people, and should stay a
                  decision you make one at a time. */}
              <button
                data-testid="bulk-pause"
                onClick={() => bulkEnabled(false)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-semibold hover:border-amber-400 hover:text-amber-700 dark:border-zinc-700 dark:hover:text-amber-300"
              >Pause</button>
              <button
                data-testid="bulk-resume"
                onClick={() => bulkEnabled(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-semibold hover:border-emerald-400 hover:text-emerald-700 dark:border-zinc-700 dark:hover:text-emerald-300"
              >Resume</button>
              <button
                data-testid="bulk-delete"
                onClick={bulkDelete}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:border-rose-400 dark:border-zinc-700"
              >Delete</button>
            <button onClick={() => setSelected(new Set())} aria-label="Clear selection" className="rounded-full p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}
      {pickerFor && folders !== null && (
        <FolderPickerSheet
          folders={folders}
          title={pickerFor.kind === 'bulk' ? `Move ${selected.size} agent${selected.size === 1 ? '' : 's'} to…` : `Move "${pickerFor.name}" to…`}
          onPick={(fid) => { const ids = pickerFor.kind === 'bulk' ? [...selected] : [pickerFor.id]; setPickerFor(null); moveToFolder(ids, fid); }}
          onCreate={createFolderReturning}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}
