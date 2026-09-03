import { useCallback, useEffect, useRef, useState } from 'react';
import { csvName, downloadCsv } from '../ui/csv';
import { DataTable } from '../ui/DataTable';
import { scheduleLine } from '../ui/nextRun';
import { agentKind, hasProgram } from '../ui/agentKind';
import { AgentKindBadge } from '../ui/AgentKindBadge';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Loader2, Play, Sparkles, FileText, CheckCircle2, RotateCcw, MessageSquare, Save, Check, X, Settings as GearIcon, Workflow, Clock, ListChecks, History as HistoryIcon } from 'lucide-react';
import { useGoBack } from '../ui/useGoBack';
import { ChatInput } from '../ui/ChatInput';
import { useToast } from '../ui/Toast';
import { Markdown } from '../ui/markdown';
import { DictateButton } from '../ui/DictateButton';
import { ToolPicker, useCatalog } from '../ui/ToolPicker';
import { Sheet } from '../ui/Sheet';
import { FlowPanel, EvalsPanel, RunsPanel } from './AgentJobPanels';
import { GrowTextarea } from '../ui/GrowTextarea';
import { SchedulePicker, schedText } from '../ui/SchedulePicker';
import { StatusBadge, timeAgo } from './Agents';
import { OutputDestPicker, ThresholdDraft, ToolArgsEditor, WatchModePicker, thresholdDraftOf, thresholdOfDraft } from '../ui/agentJobFields';
import { plainPreview } from '../ui/plainPreview';
import { AddSourcePanel } from './social/AddSourcePanel';
import { entryOf, sourceIdFor, sourcesOf, toolArgsOf, toolsOf } from '../ui/toolArgs';
import { creditsText, type PlanCost } from '../ui/PlanCard';
import { WorkerRow, workerSummary, type WorkerState } from './AgentWorkerRow';

type UiInput = { key: string; label: string; type: 'topic' | 'text' | 'url' | 'contact' | 'date' | 'choice'; placeholder?: string; options?: string[] };
type UiSpec = { headline: string; inputs: UiInput[]; view: 'report' | 'brief' | 'checklist' | 'plain'; runLabel: string };
type Mode = 'flow' | 'chat' | 'evals' | 'runs';

/**
 * ONE page per job (BEA-1169), four tabs: 💬 Chat · Flow · Checks · History.
 *
 * It used to be two pages — this one, plus a separate "workshop" you reached by scrolling to the
 * bottom and following a link. Everything about a job now lives here:
 *  • Chat   — change it in plain words, confirm-first (BEA-1065)
 *  • Flow   — its AI-designed run screen (BEA-1082) AND the picture of its steps; Run lives here
 *  • Checks — what a good result must contain, graded
 *  • History— every run with its grade
 * Settings (task, outcome, skills, schedule, tools, move, delete) is a sheet off the header gear,
 * so the four tabs stay about the work rather than the plumbing.
 */
/**
 * The one line under an agent's name (BEA-1505).
 *
 * A goal reads like a person talking, so its first sentence is nearly always preamble — "I will build
 * an agent that you run manually whenever you want." The sentence that says what the thing DOES is
 * the one after it, so a description that opens with preamble gives up its first sentence.
 */
/** The schedule column is JSON text; a broken one is simply no schedule, never a crash. */
/**
 * WHAT DELETING TAKES, AND WHAT IT DOES NOT (BEA-1508).
 *
 * His agents have written Google Sheets, Notion pages and documents. The old confirm said only
 * "saved documents are kept", which does not answer the question he would actually be asking: does
 * this remove the sheet I use every Monday? It does not — that lives in his own Google account and
 * nothing here can reach it — and saying so is the difference between a confident yes and a guess.
 */
export function deleteWarning(name: string, runCount: number, madeCount: number): string {
  const runs = `${runCount} run${runCount === 1 ? '' : 's'}`;
  const made =
    madeCount > 0
      ? `\n\nKEPT: the ${madeCount} thing${madeCount === 1 ? '' : 's'} it made. Sheets and Notion pages live in your own accounts and are not touched.`
      : '\n\nIt has not made anything yet.';
  return `Delete "${name}"?\n\nGONE: the agent, its goal, its program and its ${runs}.${made}`;
}

export function parseSchedule(raw: any): { every?: string; at?: string; dow?: number } | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const p = JSON.parse(String(raw));
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

export function subtitleOf(description?: string | null): string {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
  const preamble = /^(?:i\s+will\s+build|build\s+(?:a|an)\b|this\s+agent\b|the\s+agent\s+will\b)/i;
  const useful = sentences.find((x, i) => !(i === 0 && preamble.test(x))) || sentences[0] || text;
  return useful.replace(/^when\s+it\s+runs,?\s*/i, '').trim();
}

/**
 * WHAT AN AGENT HAS MADE (BEA-1507).
 *
 * His results scattered — a Google Sheet here, a Notion page there, a My Brain document somewhere
 * else — and no screen showed one agent's output over time. Every run already records what it wrote,
 * so this is derived rather than stored: it can never drift from the history it came from.
 *
 * A run that finished without writing anything is not a thing it made, and is left out.
 */
export type MadeItem = { id: string; title: string; href: string; icon: string; at: string };

/**
 * What KIND of thing an output is, in his words (BEA-1526).
 *
 * One rule: the list's "Kind" column, its filter and the CSV export all read this. The export used to
 * re-derive it from the icon inline, so a new output kind would have shown correctly on screen and
 * exported as "Document".
 */
/** What one agent has cost over time — the shape of `GET /api/agent/agents/:id/cost` (BEA-1526). */
export type AgentCost = {
  runs: number; runs30d: number; credits: number; credits30d: number;
  aiTokens: number; aiTokens30d: number; calls: number; firstRunAt: string | null;
};

/**
 * The cost lines, in his words (BEA-1526). Pure, so the wording is tested without a browser.
 *
 * Says "nothing yet" rather than "0 credits" when an agent has genuinely never spent: a run that used
 * only saved answers costs nothing, and that is worth saying plainly instead of looking like a bug.
 */
export function costLines(c: AgentCost | null): { all: string; recent: string; per: string } | null {
  if (!c || !c.runs) return null;
  const n = (x: number) => x.toLocaleString('en-IN');
  const tok = (x: number) => (x >= 1000 ? `${Math.round(x / 1000)}k` : String(x));
  const spent = c.credits > 0 || c.aiTokens > 0;
  const all = spent
    ? `${n(c.credits)} credit${c.credits === 1 ? '' : 's'} · ${tok(c.aiTokens)} AI tokens over ${n(c.runs)} run${c.runs === 1 ? '' : 's'}`
    : `nothing yet, over ${n(c.runs)} run${c.runs === 1 ? '' : 's'}`;
  const recent = c.runs30d
    ? `Last 30 days: ${n(c.credits30d)} credit${c.credits30d === 1 ? '' : 's'} · ${tok(c.aiTokens30d)} AI tokens over ${n(c.runs30d)} run${c.runs30d === 1 ? '' : 's'}`
    : 'Last 30 days: it has not run';
  const per = c.runs30d && c.credits30d
    ? `About ${Math.round((c.credits30d / c.runs30d) * 10) / 10} credits a run lately`
    : 'No credits spent lately';
  return { all, recent, per };
}

/** How close today is to the ceiling that can pause a job on its own (BEA-1526). */
export function ceilingLine(s: { spentToday?: number; ceiling?: number } | null): string | null {
  if (!s || typeof s.spentToday !== 'number') return null;
  const ceiling = Number(s.ceiling) || 0;
  if (!ceiling) return `${s.spentToday} credits spent today across all agents · no daily limit set`;
  const pct = Math.round((s.spentToday / ceiling) * 100);
  const close = pct >= 80 ? ' — close to the limit, a job can pause itself past it' : '';
  return `${s.spentToday} of ${ceiling} credits used today across all agents (${pct}%)${close}`;
}

/** A `MadeItem` with its kind materialised, which is what the shared table filters and sorts on. */
export type MadeRow = MadeItem & { kind: string };

/** Every kind an output can be — the filter's options, so it can never drift from `kindOfMade`. */
export const MADE_KINDS = ['Google Sheet', 'Notion page', 'Document'];

export function kindOfMade(m: MadeItem): string {
  if (m.icon === '\u{1F4CA}') return 'Google Sheet';
  if (m.icon === '\u{1F5D2}\uFE0F') return 'Notion page';
  return 'Document';
}

export function madeFromRuns(runs: any[] | null): MadeItem[] {
  return (runs || [])
    .filter((r: any) => r && (r.outputUrl || r.outputDocId))
    .map((r: any) => {
      const url = String(r.outputUrl || '');
      const sheet = url.includes('docs.google.com/spreadsheets');
      const notion = url.includes('notion.');
      return {
        id: String(r.id),
        title: String(r.resultText || r.title || 'Result').replace(/\s+/g, ' ').slice(0, 90),
        href: url || `/documents/${r.outputDocId}`,
        icon: sheet ? '\u{1F4CA}' : notion ? '\u{1F5D2}\uFE0F' : '\u{1F4C4}',
        at: String(r.endedAt || r.startedAt || ''),
      };
    })
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function AgentApp() {
  const { id } = useParams();
  const nav = useNavigate();
  const goBack = useGoBack('/agent');
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [a, setA] = useState<any>(null);
  const [spec, setSpec] = useState<UiSpec | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [liveRun, setLiveRun] = useState<any>(null);
  const [runs, setRuns] = useState<any[] | null>(null);
  // HIS zone (BEA-1508) — so the schedule line can say when it next runs, and whose clock that is.
  const [tz, setTz] = useState('Asia/Kolkata');
  useEffect(() => {
    let alive = true;
    fetch('/api/agent/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.timezone) setTz(String(d.timezone)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const [redesigning, setRedesigning] = useState(false);
  const [flow, setFlow] = useState<any>(null);
  const [pickingTools, setPickingTools] = useState(false); // this job's own toolbox (BEA-1168)
  const [addingSource, setAddingSource] = useState(false); // another Social source on a direct-fetch job (BEA-1359)
  const [planCost, setPlanCost] = useState<PlanCost | null>(null); // ≈ what one run costs (BEA-1369); today's figure while a source is down (BEA-1375)
  const [contractWords, setContractWords] = useState<string[] | null>(null); // what "it worked" means, in plain words (BEA-1391)
  const [worker, setWorker] = useState<WorkerState | null>(null); // the job's worker + the dispatch switch (BEA-1394)
  const catalog = useCatalog();
  const toolNames: Record<string, string> = Object.fromEntries((catalog?.tools || []).map((t: any) => [t.id, t.name]));
  const [allSkills, setAllSkills] = useState<any[] | null>(null);
  const [histQ, setHistQ] = useState(''); // dated-history search + filter (BEA-1099)
  const [histFilter, setHistFilter] = useState<'all' | 'done' | 'failed'>('all');
  const [areas, setAreas] = useState<any[] | null>(null); // for move-to-agent
  const [runModels, setRunModels] = useState<{ value: string; label: string }[] | null>(null); // per-job engine model (BEA-1106)
  const [moveTo, setMoveTo] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The tab lives in the URL so Back and refresh land where you were (BEA-1169). `run` and
  // `settings` are the old names — kept so existing links and bookmarks still work.
  const raw = (params.get('mode') || params.get('tab') || '').toLowerCase();
  const initialMode = (raw === 'run' ? 'flow' : raw === 'settings' ? 'flow' : raw) as Mode;
  const [mode, setModeState] = useState<Mode>((['flow', 'chat', 'evals', 'runs'] as string[]).includes(initialMode) ? initialMode : 'flow');
  const [settingsOpen, setSettingsOpen] = useState(raw === 'settings');
  // Just created by the builder (BEA-1372: `?created=1`) — offer "Run now" once; the flag is dropped either way.
  const [justCreated, setJustCreated] = useState(params.get('created') === '1');
  function dropCreated() { setJustCreated(false); if (params.get('created')) { const p = new URLSearchParams(params); p.delete('created'); setParams(p, { replace: true }); } }
  function setMode(m: Mode) { setModeState(m); const p = new URLSearchParams(params); p.delete('tab'); if (m === 'flow') p.delete('mode'); else p.set('mode', m); setParams(p, { replace: true }); }

  async function load() {
    const d = await fetch(`/api/agent/agents/${id}`).then((r) => r.json()).catch(() => null);
    if (!d?.id) { setA(null); return; }
    setA(d);
    if (Array.isArray(d.chatLog)) setChatLog(d.chatLog); // the persisted conversation (BEA-1097)
    if (!dirtyRef.current) { setTask(d.prompt || ''); setRubric(d.rubric || ''); }
    if (d.ui) setSpec(d.ui);
    else {
      const s = await fetch(`/api/agent/agents/${id}/ui/generate`, { method: 'POST' }).then((r) => r.json()).catch(() => null);
      if (s?.view) setSpec(s);
      else setSpec({ headline: `Run ${d.name}`, inputs: [], view: 'report', runLabel: 'Run →' });
    }
    loadRuns();
    return d;
  }
  async function loadRuns() {
    const rs = await fetch(`/api/agent/runs?agentId=${id}&limit=300`).then((r) => r.json()).catch(() => []);
    const list = Array.isArray(rs) ? rs : [];
    setRuns(list);
    const live = list.find((r: any) => r.status === 'running' || r.status === 'awaiting_input' || r.status === 'paused');
    setLiveRun(live || null);
    if (live && !pollRef.current) pollRef.current = setInterval(loadRuns, 4000);
    if (!live && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }
  function loadFlow() { fetch(`/api/flows?agentId=${id}`).then((r) => r.json()).then((d) => setFlow((d.flows || [])[0] || null)).catch(() => undefined); }
  // ≈ credits per run for a direct-fetch (Social) job — from the plan + the know-how cards (BEA-1369). Re-read whenever the sources change.
  const isDirectFetch = !!(a?.toolArgs && typeof a.toolArgs === 'object' && Object.keys(a.toolArgs).length);
  const toolArgsKey = isDirectFetch ? JSON.stringify(a.toolArgs) : '';
  // The job's worker, its switch and the road the next run takes (BEA-1394). Owned here so the
  // CLOSED accordion row can say it in one line too; the row itself re-reads while a build runs.
  const loadWorker = useCallback(async () => {
    const d = await fetch(`/api/agent/agents/${id}/worker`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d?.agentId) setWorker(d);
    return d;
  }, [id]);
  useEffect(() => { if (isDirectFetch) loadWorker(); else setWorker(null); }, [isDirectFetch, loadWorker]);
  useEffect(() => {
    if (!isDirectFetch) { setPlanCost(null); setContractWords(null); return; }
    let live = true;
    fetch(`/api/social/plan/${id}`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!live) return;
      setPlanCost(d?.cost && Number.isFinite(Number(d.cost.credits)) ? d.cost : null);
      setContractWords(Array.isArray(d?.contractWords) && d.contractWords.length ? d.contractWords : null);
    }).catch(() => { if (live) { setPlanCost(null); setContractWords(null); } });
    return () => { live = false; };
    /* eslint-disable-next-line */
  }, [id, toolArgsKey]);
  useEffect(() => {
    load(); loadFlow();
    fetch('/api/skills').then((r) => r.json()).then((d) => setAllSkills(d.skills || [])).catch(() => setAllSkills([]));
    return () => { if (pollRef.current) clearInterval(pollRef.current); }; /* eslint-disable-next-line */
  }, [id]);

  async function run() {
    if (running) return;
    const missing = (spec?.inputs || []).filter((i) => i.type !== 'date' && !vals[i.key]?.trim());
    if (missing.length) { toast('error', `Fill in: ${missing.map((m) => m.label).join(', ')}`); return; }
    setRunning(true);
    try {
      const input = (spec?.inputs || []).map((i) => `${i.label}: ${vals[i.key] || ''}`).join('\n');
      const r = await fetch(`/api/agent/agents/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not start');
      toast('success', 'Started — watch it work below');
      loadRuns();
    } catch (e: any) { toast('error', e?.message || 'Could not start'); }
    setRunning(false);
  }

  async function redesign() {
    setRedesigning(true);
    try {
      const s = await fetch(`/api/agent/agents/${id}/ui/generate`, { method: 'POST' }).then((r) => r.json());
      if (s?.view) { setSpec(s); toast('success', 'Screen redesigned'); }
    } catch { toast('error', 'Could not redesign'); }
    setRedesigning(false);
  }

  // ---- shared patch + Settings editing ----
  // The Settings sheet is an accordion of summary rows (BEA-1381, specs/mockups/agent-settings.html):
  // one row open at a time, every CLOSED row saying its current values in one line. Drafted fields
  // (task/rubric, source args, watch mode) save together from the sticky "Save changes" bar — the
  // exact PATCH bodies the old per-section Save buttons sent, combined. Everything else still saves
  // the moment it changes, as before.
  const dirtyRef = useRef(false);
  const [task, setTask] = useState('');
  const [rubric, setRubric] = useState('');
  const [cfgDirty, setCfgDirty] = useState(false); // task/rubric drafts differ from the saved agent
  const [sourcesDirty, setSourcesDirty] = useState(false); // a source's args/pages were edited and not yet saved
  const [openRow, setOpenRow] = useState('what'); // the one open accordion row
  // What this agent has cost over time, and how close today is to the ceiling that can pause it
  // (BEA-1526). Both are lazy — fetched when he opens the row, not on every page load — because the
  // rollup walks the job's whole ToolCall ledger.
  const [cost, setCost] = useState<AgentCost | null>(null);
  const [spend, setSpend] = useState<{ spentToday?: number; ceiling?: number; balance?: number } | null>(null);
  useEffect(() => {
    // Loaded with the page, NOT when the row is opened (BEA-1536). The settings design
    // (specs/mockups/agent-settings.html) is built on one rule: "every closed row shows its current
    // setting … so you rarely need to open them." A lazy fetch made this the only row that could not,
    // and it read "Open to work it out" — the one row demanding a tap to tell you anything.
    let live = true;
    fetch(`/api/agent/agents/${id}/cost`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d) setCost(d); }).catch(() => undefined);
    fetch('/api/social/spend').then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d) setSpend(d); }).catch(() => undefined);
    return () => { live = false; };
  }, [id]);
  const [savingAll, setSavingAll] = useState(false);
  function toggleRow(k: string) { setOpenRow((p) => (p === k ? '' : k)); }
  function markCfgDirty() { dirtyRef.current = true; setCfgDirty(true); }
  // Watch / Alert (BEA-1358): the job's mode + condition + threshold, edited here like on the builder.
  const [modeDraft, setModeDraft] = useState<{ mode: string; condition: string; threshold: ThresholdDraft } | null>(null);
  const [watchRows, setWatchRows] = useState<{ actionId: string; args: any; lastAt: string; alertState: string | null; lastAlertedAt: string | null }[] | null>(null);
  useEffect(() => {
    if (!a) return;
    setModeDraft({ mode: a.mode || 'run', condition: a.alertCondition || '', threshold: thresholdDraftOf(a.threshold) });
    if (a.mode === 'watch' || a.mode === 'alert') fetch(`/api/social/watch/${id}`).then((r) => r.json()).then((d) => setWatchRows(Array.isArray(d?.rows) ? d.rows : [])).catch(() => setWatchRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id, a?.mode, a?.alertCondition, JSON.stringify(a?.threshold || null)]);
  // The watch/alert draft counts as dirty when it differs from what the agent has saved. Threshold
  // is compared through the same normaliser both sides, so "10000" vs 10000 is not a difference.
  const modeDirty = !!modeDraft && !!a && (
    modeDraft.mode !== (a.mode || 'run')
    || (modeDraft.mode === 'alert' && (
      (modeDraft.condition.trim() || '') !== String(a.alertCondition || '')
      || JSON.stringify(thresholdOfDraft(modeDraft.threshold)) !== JSON.stringify(thresholdOfDraft(thresholdDraftOf(a.threshold)))
    ))
  );
  const dirty = cfgDirty || sourcesDirty || modeDirty;
  // The sticky bar's save: ONE patch carrying exactly what the old per-section Save buttons sent,
  // for the sections that actually changed. Nothing else rides along.
  async function saveAll() {
    if (!dirty || savingAll) return;
    setSavingAll(true);
    const body: any = {};
    if (cfgDirty) { body.prompt = task; body.rubric = rubric; }
    if (sourcesDirty) body.toolArgs = a.toolArgs;
    if (modeDirty && modeDraft) {
      body.mode = modeDraft.mode;
      body.alertCondition = modeDraft.mode === 'alert' ? modeDraft.condition.trim() || null : null;
      body.threshold = modeDraft.mode === 'alert' ? thresholdOfDraft(modeDraft.threshold) : null;
    }
    const d = await patch(body);
    if (d) { dirtyRef.current = false; setCfgDirty(false); setSourcesDirty(false); toast('success', 'Saved'); }
    setSavingAll(false);
  }
  async function forgetWatch() {
    if (!confirm('Forget what this job saw? The next run stores a fresh baseline and reports nothing as new.')) return;
    const r = await fetch(`/api/social/watch/${id}`, { method: 'DELETE' });
    if (r.ok) { setWatchRows([]); toast('success', 'Forgotten — the next run starts watching from then'); } else toast('error', 'Could not do that');
  }
  async function patch(body: any) {
    const r = await fetch(`/api/agent/agents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // Every save may re-draw the picture on the server (BEA-1366: a Social job's from its settings,
    // any other job's task change re-plans in the background) — pick up the new state right away.
    if (r.ok) { const d = await r.json(); setA(d); loadFlow(); return d; }
    toast('error', 'Could not save'); return null;
  }

  // ---- Chat (BEA-1065): message → proposal → apply on confirm ----
  const [chatMsg, setChatMsg] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLog, setChatLog] = useState<{ who: 'you' | 'ai'; text: string }[]>([]);
  const [proposal, setProposal] = useState<any>(null);
  async function sendChat() {
    const msg = chatMsg.trim();
    if (!msg || chatBusy) return;
    setChatBusy(true); setProposal(null);
    setChatLog((p) => [...p, { who: 'you', text: msg }]); setChatMsg('');
    try {
      const r = await fetch(`/api/agent/agents/${id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not do that');
      setChatLog((p) => [...p, { who: 'ai', text: d.note || 'Done.' }]);
      if (d.patch && Object.keys(d.patch).length) setProposal(d);
    } catch (e: any) { setChatLog((p) => [...p, { who: 'ai', text: e.message || 'Something went wrong — try again.' }]); }
    setChatBusy(false);
  }
  async function applyProposal() {
    if (!proposal || chatBusy) return;
    setChatBusy(true);
    try {
      const d = await patch(proposal.patch);
      if (!d) throw new Error();
      dirtyRef.current = false; setTask(d.prompt || ''); setRubric(d.rubric || '');
      // A task change re-draws the flow on the server (BEA-1366) — the Flow tab shows "re-drawing…" and polls.
      if (proposal.patch.prompt) { loadFlow(); toast('success', 'Changed — the flow is being re-drawn to match'); }
      else { toast('success', 'Changed'); }
      setSpec(null); load(); // the run screen may need to re-fit; reload spec
      setChatLog((p) => [...p, { who: 'ai', text: 'Applied ✓' }]);
      fetch(`/api/agent/agents/${id}/chat-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Applied ✓' }) }).catch(() => undefined);
      setProposal(null);
    } catch { toast('error', 'Could not apply the change'); }
    setChatBusy(false);
  }
  async function clearChatLog() {
    await fetch(`/api/agent/agents/${id}/chat-log`, { method: 'DELETE' }).catch(() => undefined);
    setChatLog([]); setProposal(null);
    toast('success', 'Chat cleared');
  }

  if (a === null) return <div className="p-6 text-sm text-zinc-500">This agent doesn't exist any more. <button onClick={() => nav('/agent')} className="text-emerald-600 hover:underline">Back to Agents</button></div>;
  if (!a || !spec) return <div className="space-y-3"><div className="h-16 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /><div className="h-40 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /></div>;

  const latest = (runs || []).find((r: any) => r.status === 'done' && r.resultText);
  // Everything this agent has produced, newest first (BEA-1507) — read off the runs, which already
  // record what each one wrote. A run that finished without writing anything is not a thing it made.
  const made = madeFromRuns(runs);
  // The shared table sorts and filters on plain fields, so the kind is materialised onto each row
  // rather than computed inside a renderer the table cannot see (BEA-1526).
  const madeRows: MadeRow[] = made.map((m) => ({ ...m, kind: kindOfMade(m) }));
  const color = a.color || '#818cf8';
  const inp = 'w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900';
  const cfgInp = 'w-full resize-none rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';

  // ONLY THE TABS THAT MEAN SOMETHING FOR THIS AGENT (BEA-1505).
  //
  // A tools agent runs a compiled program: it has no flow picture on purpose (BEA-1470) and no
  // evals. Showing both anyway is half of why the screen reads as confusing — the Flow tab even
  // opens on "No picture of the steps yet · Draw the flow", inviting him to make something that will
  // never be used, for an agent that was working perfectly.
  // ONLY WHAT MEANS SOMETHING FOR THIS AGENT (BEA-1505).
  //
  // The 'flow' mode is the MAIN screen — the run button, the latest result, the history — so it stays
  // for both kinds. What changes is its name and what it contains: a tools agent runs a compiled
  // program and has no flow picture on purpose (BEA-1470), so calling its main screen "Flow" and
  // offering "Draw the flow" invites him to make something that will never be used. It is "Run" for
  // a tools agent, and Checks (evals) is dropped entirely — that is an engine-road idea.
  const MODES: { k: Mode; label: string; icon: any }[] = [
    { k: 'chat', label: 'Chat', icon: MessageSquare },
    { k: 'flow', label: hasProgram(a) ? 'Run' : 'Flow', icon: Workflow },
    ...(hasProgram(a) ? [] : [{ k: 'evals' as Mode, label: 'Checks', icon: ListChecks }]),
    { k: 'runs', label: 'Runs', icon: HistoryIcon },
  ];

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Agents</button>
        {/* The folder this agent's card sits in (BEA-1380) — tap goes to that folder on the home. */}
        {a.folder && (<>
          <span className="text-sm text-zinc-300 dark:text-zinc-600">/</span>
          <button onClick={() => nav(`/agent?folder=${encodeURIComponent(a.folder.id)}`)} data-testid="folder-crumb" className="inline-flex min-w-0 items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            <span aria-hidden>📁</span><span className="truncate">{a.folder.name}</span>
          </button>
        </>)}
      </div>

      <header className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl" style={{ background: color + '22' }}>{a.icon || '🤖'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-bold">{a.name}</h1>
            <AgentKindBadge agent={a} />
            {/* THE SWITCH (BEA-1603). There was no on/off control anywhere on this page — a goal-built
                agent is born off, and when its first run failed nothing ever asked "keep it?", so it
                sat off for ever while the line below still said "next: today 23:00". The same toggle
                the Settings sheet uses for WhatsApp; saves the moment it changes. */}
            <label data-testid="agent-switch" className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <input type="checkbox" checked={!!a.enabled} aria-label={a.enabled ? 'On — switch it off' : 'Off — switch it on'}
                onChange={async (e) => { const on = e.target.checked; const d = await patch({ enabled: on }); if (d) toast('success', on ? 'Switched on' : 'Switched off'); }}
                className="h-5 w-9 accent-emerald-600" />
              <span>{a.enabled ? 'On' : 'Off'}</span>
            </label>
          </div>
          {/* WHAT IT DOES AND WHEN, not Codex's opening sentence (BEA-1505). A goal-built agent's
              description IS the whole goal, and Codex writes goals like a person talking — so this
              line read "I will build an agent that you run manually whenever you want. When it
              runs…" and told him nothing. The schedule is the more useful fact when there is one;
              the whole goal is one tap away under "What it does". */}
          {/* An agent that is off says so, instead of "next: today 23:00" about a run that will never
              come (BEA-1603). The schedule is still named — it is what WOULD happen — so the line
              tells him both facts at once. */}
          {a.enabled ? (
            <p className="truncate text-sm text-zinc-500" title={a.description || undefined}>
              {scheduleLine(a.scheduleText, parseSchedule(a.schedule), tz) || subtitleOf(a.description) || 'Your agent'}
            </p>
          ) : (
            <p className="truncate text-sm text-zinc-500" data-testid="off-line" title={offLine(a.scheduleText)}>{offLine(a.scheduleText)}</p>
          )}
          {planCost && (
            <p className="truncate text-xs text-zinc-400" data-testid="plan-cost" title={planCost.how}>{creditsText(planCost)} per run{planCost.aiTokens > 0 ? ` · ≈ ${planCost.aiTokens >= 1000 ? `${Math.round(planCost.aiTokens / 1000)}k` : planCost.aiTokens} AI tokens for shaping` : ''}</p>
          )}
        </div>
        <button onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings" className="shrink-0 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><GearIcon className="h-5 w-5" /></button>
      </header>

      {justCreated && (
        <div role="status" data-testid="created-banner" className="flex flex-col gap-2 rounded-2xl border border-emerald-300/60 bg-emerald-50/70 p-3 text-sm dark:border-emerald-500/30 dark:bg-emerald-500/10 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-emerald-900 dark:text-emerald-100"><b>Created.</b> The flow below is what it will do. Run it now to see the first result?</div>
          <div className="flex shrink-0 gap-2">
            <button onClick={dropCreated} className="rounded-lg px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-500/10">Later</button>
            <button onClick={() => { dropCreated(); run(); }} disabled={running} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50" data-testid="created-run-now"><Play className="h-3.5 w-3.5" />Run now</button>
          </div>
        </div>
      )}

      {/* The job switched itself off (BEA-1358: the daily Social credit ceiling) — say why, offer the way back. */}
      {!a.enabled && a.pausedReason && (
        <div role="alert" data-testid="paused-banner" className="flex flex-col gap-2 rounded-2xl border border-amber-300/60 bg-amber-50/70 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-amber-800 dark:text-amber-200"><b>Paused itself.</b> {a.pausedReason}</div>
          <div className="flex shrink-0 gap-2">
            <button onClick={() => nav('/settings/agents#sa-social')} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-200 dark:hover:bg-amber-500/10">Change the ceiling</button>
            <button onClick={async () => { const d = await patch({ enabled: true }); if (d) toast('success', 'Switched back on'); }} className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500">Switch back on</button>
          </div>
        </div>
      )}

      {/* labelled mode switch — no naked icons, nothing hidden */}
      <div className="flex gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
        {MODES.map((m) => {
          const on = mode === m.k;
          const Icon = m.icon;
          return (
            <button key={m.k} onClick={() => setMode(m.k)}
              className={'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-2 text-sm font-semibold transition-colors sm:gap-1.5 sm:px-3 sm:text-sm ' + (on ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
              <Icon className="h-4 w-4 shrink-0" style={on && m.k === 'flow' ? { color } : undefined} /><span className="truncate">{m.label}</span>
            </button>
          );
        })}
      </div>

      {/* ============ FLOW — what it does, and running it ============ */}
      {mode === 'flow' && (<>
        <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" style={{ borderTop: `3px solid ${color}` }}>
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-base font-semibold">{spec.headline}</h2>
            <button onClick={redesign} disabled={redesigning} title="Redesign this screen" className="inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">{redesigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}<span className="hidden sm:inline">Redesign</span></button>
          </div>
          {spec.inputs.map((i) => (
            <div key={i.key}>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">{i.label}</label>
              {i.type === 'topic' ? (
                <div className="relative">
                  <GrowTextarea value={vals[i.key] || ''} onChange={(e) => setVals((p) => ({ ...p, [i.key]: e.target.value }))} placeholder={i.placeholder || 'Type it in your own words…'} className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 pr-11 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900" minHeight={64} maxHeight={200} />
                  <DictateButton onText={(t) => setVals((p) => ({ ...p, [i.key]: ((p[i.key] || '') + ' ' + t).trim() }))} className="absolute right-2 top-2" />
                </div>
              ) : i.type === 'choice' && i.options?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {i.options.map((o) => (
                    <button key={o} onClick={() => setVals((p) => ({ ...p, [i.key]: o }))} className={'rounded-full border px-3 py-1.5 text-sm transition-colors ' + (vals[i.key] === o ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300')}>{o}</button>
                  ))}
                </div>
              ) : (
                <input type={i.type === 'date' ? 'date' : i.type === 'url' ? 'url' : 'text'} value={vals[i.key] || ''} onChange={(e) => setVals((p) => ({ ...p, [i.key]: e.target.value }))} placeholder={i.placeholder || (i.type === 'contact' ? 'Who? e.g. Jayanth' : '')} className={inp} />
              )}
            </div>
          ))}
          {liveRun ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-500/25 dark:bg-blue-500/5">
              <button onClick={() => nav(`/agent/runs/${liveRun.id}`)} className="flex w-full items-center gap-2 text-left">
                <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" /></span>
                <span className="text-sm font-medium">{liveRun.status === 'running' ? 'Working…' : 'Waiting for your answer'}</span>
                <span className="ml-auto text-xs text-zinc-400">watch →</span>
              </button>
              {(liveRun.stepLog || []).filter((s: any) => s.kind !== 'log').slice(-2).map((s: any, i: number) => (
                <div key={i} className="mt-1 truncate pl-5 text-xs text-zinc-500">{s.label}</div>
              ))}
            </div>
          ) : (
            <button onClick={run} disabled={running} className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-5 py-3 text-sm font-semibold text-white transition-transform hover:brightness-110 active:scale-[.99] disabled:opacity-50" style={{ background: color }}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{spec.runLabel || 'Run →'}
            </button>
          )}
        </section>

        {/* The picture of the steps — right under the run screen, so the flow is the first thing seen (BEA-1366). */}
        {/* A tools agent has no flow picture by design, so the empty "Draw the flow" panel is not
            shown to it — it was offering to build something that would never run (BEA-1505). */}
        {!hasProgram(a) && <FlowPanel id={id!} flow={flow} onChanged={loadFlow} goChat={() => setMode('chat')} lastRun={runs?.[0]} />}

        {latest && (
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />Latest result · {timeAgo(latest.endedAt || latest.startedAt)}
              {latest.grade?.verdict && <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">{latest.grade.verdict} · {latest.grade.score}</span>}
              {latest.outputDocId && (
              <span className="ml-auto flex items-center gap-2.5">
                <button onClick={async () => { const r = await fetch(`/api/documents/${latest.outputDocId}/add-to-brain`, { method: 'POST' }); const d = await r.json().catch(() => ({})); if (r.ok) toast('success', d.already ? 'Already in your brain' : 'Added — it will appear in your brain within a few minutes'); else toast('error', 'Could not add'); }} className="inline-flex items-center gap-1 text-violet-600 hover:underline dark:text-violet-400">🧠 Add to my Brain</button>
                <button onClick={() => nav(`/documents/${latest.outputDocId}`)} className="inline-flex items-center gap-1 text-emerald-600 hover:underline"><FileText className="h-3.5 w-3.5" />document</button>
              </span>
            )}
            </div>
            {spec.view === 'brief' ? (
              <div>
                <div className="text-lg font-semibold leading-snug">{plainPreview((latest.resultText || '').split('\n')[0], 200)}</div>
                <Markdown className="mt-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{(latest.resultText || '').split('\n').slice(1).join('\n')}</Markdown>
              </div>
            ) : spec.view === 'checklist' ? (
              <ul className="space-y-1.5">
                {(latest.resultText || '').split('\n').map((l: string) => l.replace(/^[-*•\s]+/, '')).filter(Boolean).slice(0, 20).map((l: string, i: number) => (
                  // `min-w-0 break-words` (BEA-1529): these lines carry whatever a run reported —
                  // sheet URLs, markdown table rows — and a long unbroken URL will not wrap. Inside a
                  // flex row it then pushed the line to 684px in a 324px column at 390, clipped with
                  // no way to read the rest. The page never scrolled sideways, so nothing flagged it.
                  <li key={i} className="flex items-start gap-2 text-sm"><span className="mt-0.5 shrink-0 text-emerald-500">✓</span><span className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{l}</span></li>
                ))}
              </ul>
            ) : spec.view === 'plain' ? (
              <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{latest.resultText}</p>
            ) : (
              <Markdown className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{latest.resultText}</Markdown>
            )}
          </section>
        )}

        {/* Dated history (BEA-1099): every entry this job produced, newest first, honest about failures. */}
        {(runs || []).length > 0 && (() => {
          const all = runs || [];
          const filtered = all
            .filter((r: any) => histFilter === 'all' || (histFilter === 'done' ? r.status === 'done' : r.status === 'failed'))
            .filter((r: any) => !histQ || ((r.title || '') + ' ' + (r.resultText || '')).toLowerCase().includes(histQ.toLowerCase()));
          const fmtDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
          return (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">History · {filtered.length}</h3>
                {all.length > 3 && (
                  <div className="flex gap-1">
                    {(['all', 'done', 'failed'] as const).map((f) => (
                      <button key={f} onClick={() => setHistFilter(f)} className={'rounded-full border px-2 py-0.5 text-xs font-medium ' + (histFilter === f ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-zinc-200 text-zinc-400 dark:border-zinc-700')}>{f === 'all' ? 'All' : f === 'done' ? 'Done' : 'Failed'}</button>
                    ))}
                  </div>
                )}
              </div>
              {all.length > 5 && (
                <input value={histQ} onChange={(e) => setHistQ(e.target.value)} placeholder="Search this job's history…" className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700" />
              )}
              {filtered.slice(0, 30).map((r: any) => (
                <div key={r.id} className="group flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                  <button onClick={() => nav(`/agent/runs/${r.id}`)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                    <span className="w-[4.6rem] shrink-0 text-xs font-bold uppercase tracking-wide" style={{ color }}>{fmtDay(r.endedAt || r.startedAt)}</span>
                    <span className="min-w-0 flex-1 truncate">{r.status === 'failed' ? <span className="text-rose-600 dark:text-rose-400">Failed{(r.errorWords || r.error) ? ` — ${String(r.errorWords || r.error).slice(0, 50)}` : ''}</span> : (plainPreview(r.resultText, 140) || r.title || a.name)}</span>
                  </button>
                  {(r.status === 'failed' || r.status === 'done') && (
                    <button onClick={() => fetch(`/api/agent/runs/${r.id}/replay`, { method: 'POST' }).then(() => { toast('success', r.status === 'failed' ? 'Retrying…' : 'Running it again…'); loadRuns(); })} title={r.status === 'failed' ? 'Retry' : 'Run again'} className={'shrink-0 rounded-lg p-1 ' + (r.status === 'failed' ? 'text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10' : 'text-zinc-300 hover:text-emerald-600 group-hover:text-zinc-400')}><RotateCcw className="h-3.5 w-3.5" /></button>
                  )}
                  <StatusBadge status={r.status} />
                </div>
              ))}
              {filtered.length === 0 && <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">Nothing matches.</p>}
            </section>
          );
        })()}
      </>)}

      {/* ===================== CHECKS ===================== */}
      {mode === 'evals' && <EvalsPanel id={id!} a={a} flow={flow} patch={patch} reload={load} />}

      {/* ===================== HISTORY ===================== */}
      {mode === 'runs' && <RunsPanel id={id!} flow={flow} />}

      {/* ===================== CHAT ===================== */}
      {mode === 'chat' && (
        <section className="space-y-3 rounded-2xl border border-violet-200 bg-white p-4 dark:border-violet-500/30 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4 text-violet-500" />Change it by chatting</h2>
            {chatLog.length > 0 && <button onClick={clearChatLog} className="text-xs text-zinc-400 hover:text-rose-500">Clear chat</button>}
          </div>
          {chatLog.length === 0 && <p className="text-xs text-zinc-400">Say the change in your own words — “add a step that messages Mom”, “run it every morning at 7”, “stop asking me before saving”. Or just ask it a question. You'll see what would change before it sticks.</p>}
          {chatLog.length > 0 && (
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {chatLog.map((m, i) => (
                <div key={i} className={'flex ' + (m.who === 'you' ? 'justify-end' : 'justify-start')}>
                  <div className={'max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ' + (m.who === 'you' ? 'bg-violet-600 text-white' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200')}>{m.text}</div>
                </div>
              ))}
            </div>
          )}
          {proposal && (
            <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-500/30 dark:bg-violet-500/10">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Here's what would change</p>
              <ul className="mt-1.5 space-y-1">
                {(proposal.changes || []).map((c: string, i: number) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm text-zinc-700 dark:text-zinc-200"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />{c}</li>
                ))}
                {(proposal.changes || []).length === 0 && <li className="text-sm text-zinc-600 dark:text-zinc-300">A small update to this agent.</li>}
              </ul>
              {proposal.patch?.prompt && <p className="mt-1.5 text-xs text-violet-600 dark:text-violet-300">The flow will be re-drawn to match.</p>}
              <div className="mt-2 flex gap-2">
                <button onClick={applyProposal} disabled={chatBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">{chatBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Apply change</button>
                <button onClick={() => { setProposal(null); setChatLog((p) => [...p, { who: 'ai', text: 'Okay, left as it was.' }]); fetch(`/api/agent/agents/${id}/chat-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Okay, left as it was.' }) }).catch(() => undefined); }} disabled={chatBusy} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Not this</button>
              </div>
            </div>
          )}
          <ChatInput value={chatMsg} onChange={setChatMsg} onSend={sendChat} busy={chatBusy} accent="violet" placeholder="Tell it what to change…" />
        </section>
      )}

      {/* ===================== SETTINGS ===================== */}
      {/* An accordion of summary rows (BEA-1381, approved mockup at specs/mockups/agent-settings.html):
          one row open at a time, every closed row saying its current values in one line, Delete apart
          in red, and a sticky Save that appears when a drafted field has changed. Pure reorganisation —
          every control and its wiring is the one that lived in the old thirteen-block scroll. */}
      {settingsOpen && (
        <Sheet onClose={() => setSettingsOpen(false)} size="full">{(closeSheet) => (
          <div className="max-h-[86vh] overflow-y-auto p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Settings</h2>
              <button onClick={closeSheet} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="h-5 w-5" /></button>
            </div>
            <p className="mb-3 mt-0.5 text-xs text-zinc-400">Everything about this job. Closed rows show what's set, so you rarely need to open them.</p>
            <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2">

              {/* 1 · What it does 🎯 — goal (BEA-1378) + task + good-result */}
              <SettingsRow k="what" icon="🎯" title="What it does" full
                summary={whatSummary(a) + (cfgDirty ? UNSAVED : '')}
                open={openRow === 'what'} onToggle={toggleRow}>
                {/* THE GOAL, REACHABLE FROM THE AGENT IT BUILT (BEA-1504).
                   The goal IS a tools agent — it is what Codex compiles. It lived on a page keyed to
                   the chat area with no link from the agent, so reading or correcting it meant going
                   the long way round, and most of the time he did not know it was there at all. */}
              {hasProgram(a) && a.areaId && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 dark:border-emerald-500/20 dark:bg-emerald-500/5">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">This agent is built from a goal you approved.</span>
                  <button
                    data-testid="open-goal"
                    onClick={() => nav(`/agent/ar/${a.areaId}/brief`)}
                    className="shrink-0 rounded-lg border border-emerald-300 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                  >Read or change it</button>
                </div>
              )}
              {goalOf(a.description) && (
                  <div>
                    <span className="block text-xs font-medium text-zinc-500">For (the goal)</span>
                    <p className="mt-1 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-300" data-testid="goal-line">{goalOf(a.description)}</p>
                  </div>
                )}
                <label className="block text-xs font-medium text-zinc-500">The task it runs each time
                  <div className="relative mt-1">
                    <textarea value={task} onChange={(e) => { markCfgDirty(); setTask(e.target.value); }} rows={3} className={cfgInp + ' pr-11'} />
                    <DictateButton onText={(t) => { markCfgDirty(); setTask((p) => (p ? p + ' ' : '') + t); }} className="absolute right-2 top-2" />
                  </div>
                </label>
                <label className="block text-xs font-medium text-zinc-500">A good result — what does a good run look like? (each run is graded against this)
                  <div className="relative mt-1">
                    <textarea value={rubric} onChange={(e) => { markCfgDirty(); setRubric(e.target.value); }} rows={3} placeholder="e.g. Has 3 bullets. Each is one short sentence. Mentions a source." className={cfgInp + ' pr-11'} />
                    <DictateButton onText={(t) => { markCfgDirty(); setRubric((p) => (p ? p + ' ' : '') + t); }} className="absolute right-2 top-2" />
                  </div>
                </label>
                <p className="text-xs text-zinc-400">Tip: you can also change all of this by talking to it — try the <button onClick={() => setMode('chat')} className="text-violet-600 hover:underline dark:text-violet-400">💬 Chat</button> tab.</p>
              </SettingsRow>

              {/* 2 · Sources 📥 — direct-fetch jobs only (BEA-1357/1374): the "What it fetches" editors */}
              {isDirectFetch && (
                <SettingsRow k="sources" icon="📥" title="Sources" full
                  summary={sourcesSummary(sourcesOf(a.toolArgs).length, planCost) + (sourcesDirty ? UNSAVED : '')}
                  open={openRow === 'sources'} onToggle={toggleRow}>
                  {/* A down source, said inside the row (BEA-1375: the server's own health verdicts). */}
                  {(planCost?.unhealthy || []).map((u) => (
                    <p key={u.actionId} data-testid="source-unhealthy" className="text-xs font-medium text-amber-600 dark:text-amber-400">⚠ {u.name} is down at the vendor right now — kept so it fills in later.</p>
                  ))}
                  {/* Sources are keyed by their own id (BEA-1374): several may share one action, each with its own arguments and pages. */}
                  {sourcesOf(a.toolArgs).map((src) => (
                    <ToolArgsEditor key={src.id} tool={src.actionId} args={src.value} toolName={toolNames[src.actionId]} onChange={(next) => { setSourcesDirty(true); setA((p: any) => ({ ...p, toolArgs: { ...p.toolArgs, [src.id]: entryOf(src.actionId, next) } })); }}
                      onRemove={Object.keys(a.toolArgs).length > 1 ? async () => {
                        if (!window.confirm(`Remove ${toolNames[src.actionId] || src.actionId} from this job? The next run will not fetch it.`)) return;
                        const rest = sourcesOf(a.toolArgs).filter((x) => x.id !== src.id);
                        const d = await patch({ tools: toolsOf(rest), toolArgs: toolArgsOf(rest) });
                        if (d) { setSourcesDirty(false); toast('success', 'Source removed'); }
                      } : undefined} />
                  ))}
                  {!addingSource && <button type="button" onClick={() => setAddingSource(true)} className="self-start text-xs font-medium text-pink-700 hover:underline dark:text-pink-300">+ Add another source</button>}
                  {/* Another source (BEA-1359): the same platform/endpoint/form as the Social page; saved at once with its arguments pinned. */}
                  {addingSource && (
                    <AddSourcePanel defaultPlatform={String(sourcesOf(a.toolArgs)[0]?.actionId || '').replace(/^svc:/, '').split('.')[0]} taken={sourcesOf(a.toolArgs).map((x) => x.actionId)}
                      onAdd={async (x) => { const rows = [...sourcesOf(a.toolArgs), { id: sourceIdFor(x.tool, Object.keys(a.toolArgs)), actionId: x.tool, value: x.args }]; const d = await patch({ tools: toolsOf(rows), toolArgs: toolArgsOf(rows) }); if (d) { setSourcesDirty(false); toast('success', `Added ${x.label || x.tool}`); setAddingSource(false); } }}
                      onCancel={() => setAddingSource(false)} />
                  )}
                  <p className="text-xs text-zinc-400">Fetched directly through your Tools — no engine turn, and every call is logged with its credits.{Object.keys(a.toolArgs).length > 1 ? ' Several sources are fetched one after the other and merged into one table.' : ''}{planCost ? ` ${planCost.how}` : ''}</p>
                </SettingsRow>
              )}

              {/* 3 · Result & alerts 📤 — where it goes (BEA-1357) + WhatsApp (BEA-1102) */}
              <SettingsRow k="result" icon="📤" title="Result & alerts"
                summary={resultSummary(a)}
                open={openRow === 'result'} onToggle={toggleRow}>
                <OutputDestPicker
                  dest={a.outputDest || 'document'}
                  sheetId={a.sheetId || ''}
                  sheetAppend={!!a.sheetAppend}
                  onCommitSheetAppend={async (on) => { const d = await patch({ sheetAppend: on }); if (d) toast('success', on ? 'One sheet — made on the first run, then every run adds to it' : 'A new sheet every run'); }}
                  onChange={async (v) => {
                    const changedDest = v.outputDest !== (a.outputDest || 'document');
                    setA((p: any) => ({ ...p, outputDest: v.outputDest, sheetId: v.sheetId, sheetAppend: v.sheetAppend }));
                    // The select saves at once; the sheet id saves when the owner leaves the field.
                    if (changedDest) { const d = await patch({ outputDest: v.outputDest }); if (d) toast('success', v.outputDest === 'sheet' ? 'Results go to a Google Sheet' : 'Results go to Documents'); }
                  }}
                  onCommitSheetId={async (id) => { const d = await patch({ sheetId: id || null }); if (d) toast('success', id ? 'Every run appends to that sheet' : 'A new sheet every run'); }}
                />
                <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <span>
                    <span className="block text-sm font-semibold">Send to WhatsApp when it finishes</span>
                    <span className="block text-xs text-zinc-400">One message per finish: name + headline + a private link. Needs your number in Settings → Agent Engine.</span>
                  </span>
                  <input type="checkbox" checked={!!a.notifyWhatsApp} onChange={async (e) => { const d = await patch({ notifyWhatsApp: e.target.checked }); if (d) toast('success', e.target.checked ? 'It will WhatsApp you when it finishes' : 'WhatsApp off for this job'); }} className="h-5 w-9 accent-emerald-600" />
                </label>
              </SettingsRow>

              {/* 3b · What counts as a good run ✅ — the contract in plain words (BEA-1391) */}
              {isDirectFetch && contractWords && (
                <SettingsRow k="contract" icon="✅" title="What counts as a good run"
                  summary={contractSummary(contractWords)}
                  open={openRow === 'contract'} onToggle={toggleRow}>
                  <ul className="space-y-1.5" data-testid="contract-words">
                    {contractWords.map((line, i) => (
                      <li key={i} className="flex gap-2 text-sm text-zinc-600 dark:text-zinc-300"><span className="text-emerald-600 dark:text-emerald-400">✓</span><span>{line}</span></li>
                    ))}
                  </ul>
                  <p className="text-xs text-zinc-400">Checked before anything is written. A run that does not pass fails out loud and writes nothing — no half-empty sheet, no "done" with no rows. These checks come from the plan above, so changing the sources or the task changes them too.</p>
                </SettingsRow>
              )}

              {/* 3c · Worker 🛠 — the compiled version, its tests, staleness, repairs, and the switch
                   that decides which road a run takes (BEA-1394). Direct-fetch jobs only: an engine
                   job has no plan to compile, and the row says so rather than offering a dead button. */}
              {/* THE PROGRAM PANEL, FOR EVERY TOOLS AGENT (BEA-1504).
                   It used to be `isDirectFetch` — "has pinned tool arguments" — which only a Social
                   agent has. So the panel holding the version, the checks, Rebuild and the road the
                   next run takes was hidden on exactly the agents that have a program: his goal-built
                   ones. For three days the only way to rebuild them was a terminal. */}
              {/* WHAT IT HAS MADE (BEA-1507).
                  An agent's results scattered: some are documents in My Brain, some are Google
                  Sheets, some are Notion pages, and there was no one place to see what a single agent
                  has produced over time. Built from the runs themselves — every run already records
                  what it wrote — so this needs no new table and can never disagree with the history. */}
              {made.length > 0 && (
                <SettingsRow k="made" icon="📄" title="What it has made"
                  summary={`${made.length} thing${made.length === 1 ? '' : 's'} · newest ${timeAgo(made[0].at)}`}
                  open={openRow === 'made'} onToggle={toggleRow}>
                  {/* THE LIST STANDARD, HERE TOO (BEA-1526) — search, filter by kind, sort, count and
                      pages, on the shared table rather than a hand-capped <ul> with a "Show all"
                      toggle. `cardsOnly` keeps the row look it already had, so nothing moved on
                      screen; what changed is that this list now behaves like every other one. */}
                  <div data-testid="made-list">
                    <DataTable<MadeRow>
                      columns={[
                        { key: 'title', label: 'What', sortable: true },
                        { key: 'kind', label: 'Kind', sortable: true },
                        { key: 'at', label: 'When', sortable: true },
                      ]}
                      rows={madeRows}
                      searchable
                      filters={[{ key: 'kind', label: 'Kind', options: MADE_KINDS.map((k) => ({ value: k, label: k })) }]}
                      sortOptions={[
                        { label: 'Newest', key: 'at', dir: -1 },
                        { label: 'Oldest', key: 'at', dir: 1 },
                        { label: 'By name', key: 'title', dir: 1 },
                      ]}
                      defaultSort={{ key: 'at', dir: -1 }}
                      pageSize={8}
                      cardsOnly
                      gridClassName="space-y-1.5"
                      emptyText="Nothing matches that."
                      renderCard={(m) => (
                        <a
                          href={m.href}
                          target={m.href.startsWith('http') ? '_blank' : undefined}
                          rel="noreferrer"
                          className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:border-emerald-400 dark:border-zinc-800"
                        >
                          <span aria-hidden>{m.icon}</span>
                          <span className="min-w-0 flex-1 truncate">{m.title}</span>
                          <span className="shrink-0 text-xs text-zinc-400">{timeAgo(m.at)}</span>
                        </a>
                      )}
                    />
                  </div>
                  {/* EXPORT (BEA-1509) — his CRUD standard asks for it and nothing had it. */}
                  <button
                    type="button"
                    data-testid="export-made"
                    onClick={() => downloadCsv(csvName(`${a.name} outputs`), ['What', 'Kind', 'Link', 'When'], made.map((m) => [m.title, kindOfMade(m), m.href, m.at]))}
                    className="mt-2 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:border-emerald-400 hover:text-emerald-700 dark:border-zinc-700 dark:text-zinc-300"
                  >Export CSV</button>
                </SettingsRow>
              )}

              {/* WHAT IT COSTS (BEA-1526) — one run's cost has been on the run screen since BEA-1394,
                  but an agent's cost OVER TIME was nowhere, and neither was how close today is to the
                  ceiling that can pause a job on its own. */}
              <SettingsRow k="cost" icon="💰" title="What it costs"
                summary={costLines(cost)?.all || (cost ? 'It has not run yet, so it has not cost anything' : 'Adding it up…')}
                open={openRow === 'cost'} onToggle={toggleRow}>
                <div className="space-y-1.5 text-sm text-zinc-600 dark:text-zinc-300" data-testid="cost-panel">
                  {!cost && <div className="text-zinc-400">Adding it up…</div>}
                  {cost && !cost.runs && <div className="text-zinc-400">It has not run yet, so it has not cost anything.</div>}
                  {cost && !!cost.runs && (
                    <>
                      <div data-testid="cost-all">{costLines(cost)!.all}</div>
                      <div className="text-sm text-zinc-500">{costLines(cost)!.recent}</div>
                      <div className="text-sm text-zinc-500">{costLines(cost)!.per}</div>
                      {cost.calls > 0 && <div className="text-xs text-zinc-400">{cost.calls.toLocaleString('en-IN')} calls to outside services</div>}
                    </>
                  )}
                  {ceilingLine(spend) && (
                    <div className="mt-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800" data-testid="ceiling-line">
                      {ceilingLine(spend)}
                    </div>
                  )}
                </div>
              </SettingsRow>

              {hasProgram(a) && (
                <SettingsRow k="worker" icon="🛠" title="The program"
                  summary={workerSummary(worker)}
                  open={openRow === 'worker'} onToggle={toggleRow}>
                  <WorkerRow agentId={String(id)} worker={worker} contractWords={contractWords} reload={loadWorker} toast={toast} />
                </SettingsRow>
              )}

              {/* 4 · Schedule ⏰ */}
              <SettingsRow k="schedule" icon="⏰" title="Schedule"
                summary={scheduleSummary(a)}
                open={openRow === 'schedule'} onToggle={toggleRow}>
                <SchedulePicker value={a?.schedule || null} onChange={async (s) => { const wasOff = !a?.enabled; setA((p: any) => ({ ...p, schedule: s, scheduleText: schedText(s) })); const d = await patch({ schedule: s, scheduleText: schedText(s) }); if (d) toast('success', scheduleSavedToast(schedText(s), wasOff, !!d.enabled)); }} />
              </SettingsRow>

              {/* 5 · Watch & alerts 👁 — direct-fetch jobs only (BEA-1358): the same picker as the builder */}
              {isDirectFetch && modeDraft && (
                <SettingsRow k="watch" icon="👁" title="Watch & alerts"
                  summary={watchSummary(a, watchRows) + (modeDirty ? UNSAVED : '')}
                  open={openRow === 'watch'} onToggle={toggleRow}>
                  <WatchModePicker mode={modeDraft.mode} condition={modeDraft.condition} threshold={modeDraft.threshold} onChange={setModeDraft} />
                  {(a.mode === 'watch' || a.mode === 'alert') && watchRows && watchRows.length > 0 && (
                    <button onClick={forgetWatch} className="self-start rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300">Forget what it saw</button>
                  )}
                  {(a.mode === 'watch' || a.mode === 'alert') && (
                    <p className="text-xs text-zinc-400" data-testid="watch-since">
                      {watchRows === null ? 'Checking what it last saw…' : watchRows.length === 0 ? 'No baseline yet — the first run stores one and reports nothing as new.' : `Watching since ${new Date(watchRows[watchRows.length - 1].lastAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · last checked ${new Date(watchRows[0].lastAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${watchRows[0].lastAlertedAt ? ` · last alert ${new Date(watchRows[0].lastAlertedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`}
                    </p>
                  )}
                </SettingsRow>
              )}

              {/* 6 · Skills & tools 🧰 — skills chips + the job's own toolbox (BEA-1168) */}
              <SettingsRow k="tools" icon="🧰" title="Skills & tools"
                summary={toolsSummary(a)}
                open={openRow === 'tools'} onToggle={toggleRow}>
                <div>
                  <h3 className="text-sm font-semibold">Skills it uses</h3>
                  {allSkills === null ? (
                    <div className="mt-1.5 h-8 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                  ) : allSkills.length === 0 ? (
                    <p className="mt-1 text-xs text-zinc-500">No skills installed yet — add some on the <button onClick={() => nav('/skills')} className="text-emerald-600 hover:underline">Skills</button> page.</p>
                  ) : (
                    <>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {allSkills.map((sk: any) => {
                          const on = (a?.skills || []).includes(sk.id);
                          return (
                            <button key={sk.id} title={sk.description || sk.title}
                              onClick={async () => { const next = on ? (a.skills || []).filter((x: string) => x !== sk.id) : [...(a.skills || []), sk.id]; await patch({ skills: next }); toast('success', on ? `Removed ${sk.title}` : `Attached ${sk.title}`); }}
                              className={'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' + (on ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-zinc-200 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700')}>
                              {on ? '✓ ' : ''}{sk.title}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-1 text-xs text-zinc-400">Attached skills ride along on every run (up to 3 are used).</p>
                    </>
                  )}
                </div>
                {/* The tools THIS job may use (BEA-1168). Empty = it follows the agent's toolbox. */}
                <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Tools this job can use</h3>
                    <button onClick={() => setPickingTools(true)} className="text-xs font-medium text-emerald-600 hover:underline">Choose</button>
                  </div>
                  {(a.tools || []).length === 0 ? (
                    <p className="mt-1 text-xs text-zinc-400">Following the agent's toolbox. Choose here to give this job its own, narrower set.</p>
                  ) : (
                    <>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {(a.tools || []).map((id: string) => (
                          <span key={id} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{toolNames[id] || id}</span>
                        ))}
                      </div>
                      <button onClick={async () => { const d = await patch({ tools: [] }); if (d) toast('success', "Back to the agent's toolbox"); }} className="mt-1.5 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Clear — follow the agent's toolbox again</button>
                    </>
                  )}
                  <p className="mt-1 text-xs text-zinc-400">A run only gets what is listed here. Anything else is refused.</p>
                </div>
                {pickingTools && (
                  <ToolPicker
                    value={a.tools || []}
                    onSave={async (ids) => { const d = await patch({ tools: ids }); if (d) toast('success', ids.length ? `${ids.length} tool${ids.length === 1 ? '' : 's'} for this job` : "Following the agent's toolbox"); }}
                    onClose={() => setPickingTools(false)}
                    title={`Tools for ${a.name}`}
                    subtitle="This job can only use what you tick here."
                  />
                )}
              </SettingsRow>

              {/* 7 · Advanced ⚙️ — model (BEA-1106), history retention + move (BEA-1099) */}
              <SettingsRow k="advanced" icon="⚙️" title="Advanced"
                summary={advancedSummary(a)}
                open={openRow === 'advanced'} onToggle={toggleRow}>
                <div>
                  <h3 className="text-sm font-semibold">Model for this job</h3>
                  {runModels === null ? (
                    <button onClick={() => fetch('/api/agent/models').then((r) => r.json()).then((d) => setRunModels(Array.isArray(d) ? d : []))} className="mt-1.5 text-xs text-emerald-600 hover:underline">{a.engine?.model ? `Using ${a.engine.model} — change…` : 'Using the engine default — change…'}</button>
                  ) : (
                    <select value={a.engine?.model || ''} onChange={async (e) => { const v = e.target.value; const d = await patch({ engine: v ? { provider: 'codex', model: v } : null }); if (d) toast('success', v ? `This job runs on ${v}` : 'Back to the engine default'); }} className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900">
                      {runModels.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  )}
                  <p className="mt-1 text-xs text-zinc-400">Overrides the global agent model for this job's runs only.</p>
                </div>
                <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <h3 className="text-sm font-semibold">Keep history for</h3>
                  <select value={a.keepDays == null ? '' : String(a.keepDays)} onChange={async (e) => { const v = e.target.value; const d = await patch({ keepDays: v === '' ? null : Number(v) }); if (d) toast('success', v === '' ? 'History kept forever' : `Old entries clear after ${v} days`); }} className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900">
                    <option value="">Forever (good for research)</option>
                    <option value="30">30 days (good for daily news)</option>
                    <option value="90">90 days</option>
                    <option value="365">1 year</option>
                  </select>
                  <p className="mt-1 text-xs text-zinc-400">Only finished entries are cleared. Saved documents are never touched.</p>
                </div>
                <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <h3 className="text-sm font-semibold">Move to another agent</h3>
                  {areas === null ? (
                    <button onClick={() => fetch('/api/agent/areas').then((r) => r.json()).then((d) => setAreas(Array.isArray(d) ? d.filter((x: any) => x.id !== a.areaId) : []))} className="mt-1.5 text-xs text-emerald-600 hover:underline">Choose an agent…</button>
                  ) : (
                    <div className="mt-1.5 flex gap-2">
                      <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900">
                        <option value="">Pick where this job goes…</option>
                        {areas.map((ar: any) => <option key={ar.id} value={ar.id}>{ar.icon ? ar.icon + ' ' : ''}{ar.name}</option>)}
                      </select>
                      <button disabled={!moveTo} onClick={async () => {
                        const r = await fetch(`/api/agent/agents/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ areaId: moveTo }) });
                        if (r.ok) { toast('success', 'Moved'); setAreas(null); setMoveTo(''); load(); } else toast('error', 'Could not move');
                      }} className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900">Move</button>
                    </div>
                  )}
                  <p className="mt-1 text-xs text-zinc-400">All its history and settings travel with it.</p>
                </div>
              </SettingsRow>

              {/* 8 · Delete 🗑 — the danger row, apart in red (BEA-1109) */}
              <SettingsRow k="delete" icon="🗑" title="Delete this job" danger
                summary={`${(runs || []).length} run${(runs || []).length === 1 ? '' : 's'} go with it · everything it made is kept`}
                open={openRow === 'delete'} onToggle={toggleRow}>
                <button onClick={async () => {
                  if (!window.confirm(`Delete "${a.name}" and its run history? Saved documents are kept.`)) return;
                  const r = await fetch(`/api/agent/agents/${id}`, { method: 'DELETE' });
                  if (r.ok) { toast('success', 'Job deleted'); nav(a.areaId ? `/agent/ar/${a.areaId}` : '/agent'); }
                  else toast('error', 'Could not delete');
                }} className="self-start rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:hover:bg-rose-500/10">Delete job</button>
              </SettingsRow>
            </div>

            {/* Sticky Save — appears only when a drafted field changed; one patch, the same bodies the old buttons sent. */}
            {dirty && (
              <div className="sticky bottom-0 mt-1 bg-gradient-to-t from-white via-white/90 to-transparent pb-1 pt-5 dark:from-zinc-900 dark:via-zinc-900/90" data-testid="settings-save-bar">
                <button onClick={saveAll} disabled={savingAll} className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                  {savingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save changes
                </button>
              </div>
            )}

            {/* No links out any more — Flow, Checks and History are tabs on this page (BEA-1169). */}
          </div>
        )}</Sheet>
      )}
    </div>
  );
}

/* ============ The Settings accordion (BEA-1381) ============ */

/** Appended to a closed row's summary while its drafts differ from the saved agent — the summary
 *  itself always states what is SAVED, never an edit that would vanish on a reload. */
export const UNSAVED = ' · unsaved changes';

/**
 * One accordion row: a summary line when closed, its controls when open. A real <details> element —
 * closed rows keep their children in the DOM (drafts survive open/close, and the existing tests can
 * still reach every control) — but toggling is CONTROLLED: the summary click is prevented and the
 * parent decides which single row is open.
 */
function SettingsRow({ k, icon, title, summary, open, onToggle, danger, full, children }: {
  k: string; icon: string; title: string; summary: string;
  open: boolean; onToggle: (k: string) => void;
  /** Red title + rose icon chip — the Delete row. */
  danger?: boolean;
  /** Spans both columns on the laptop grid (rows 1–2 in the mockup). */
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} data-testid={`srow-${k}`} className={'overflow-hidden rounded-2xl border bg-white dark:bg-zinc-900 ' + (danger ? 'border-rose-200 dark:border-rose-500/30' : 'border-zinc-200 dark:border-zinc-800') + (full ? ' lg:col-span-2' : '')}>
      <summary onClick={(e) => { e.preventDefault(); onToggle(k); }} className="flex cursor-pointer select-none list-none items-center gap-2.5 rounded-2xl px-3.5 py-3 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className={'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm ' + (danger ? 'bg-rose-50 dark:bg-rose-500/10' : 'bg-emerald-50 dark:bg-emerald-500/10')}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={'block text-sm font-semibold ' + (danger ? 'text-rose-600 dark:text-rose-400' : '')}>{title}</span>
          <span data-testid={`srow-${k}-summary`} className="block truncate text-xs text-zinc-400">{summary}</span>
        </span>
        <ChevronRight className={'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform motion-reduce:transition-none ' + (open ? 'rotate-90' : '')} />
      </summary>
      <div className="flex flex-col gap-3 border-t border-zinc-100 p-3.5 dark:border-zinc-800">{children}</div>
    </details>
  );
}

/** BEA-1378: the builder's goal rides at the front of the description as "For: <goal>" or "For: <goal> — <rest>". */
export function goalOf(description?: string | null): string {
  const m = String(description || '').match(/^For:\s*(.+)$/);
  return m ? m[1].split(' — ')[0].trim() : '';
}

/** "For: <goal> · graded each run" — the goal when there is one, else the task's first words. */
export function whatSummary(a: any): string {
  const goal = goalOf(a?.description);
  const head = goal ? `For: ${goal}` : plainPreview(a?.prompt, 60) || 'What this job does each run';
  return head + (String(a?.rubric || '').trim() ? ' · graded each run' : '');
}

/** "<n> sources · ≈<credits> credits + ₹<ai> AI per run" — cost from GET /api/social/plan/:id. */
export function sourcesSummary(n: number, cost: PlanCost | null): string {
  const base = `${n} source${n === 1 ? '' : 's'}`;
  if (!cost) return base;
  const ai = typeof cost.aiRupees === 'number' && cost.aiRupees > 0 ? ` + ₹${cost.aiRupees} AI` : '';
  return `${base} · ${creditsText(cost)}${ai} per run`;
}

/** "N checks before it writes anything" — the contract's own line count (BEA-1391). */
export function contractSummary(words: string[] | null): string {
  const n = (words || []).length;
  return n ? `${n} check${n === 1 ? '' : 's'} before it writes anything` : 'Nothing is checked yet';
}

export function resultSummary(a: any): string {
  const dest = (a?.outputDest || 'document') === 'sheet'
    ? (a?.sheetId ? 'Appends to your Google Sheet' : a?.sheetAppend ? 'One Google Sheet, kept adding to' : 'New Google Sheet each run')
    : a?.outputDest === 'telegram' ? 'Sent to Telegram'
    : a?.outputDest === 'task' ? 'Becomes a task'
    : 'Saved to Documents';
  return `${dest} · WhatsApp ${a?.notifyWhatsApp ? 'on' : 'off'}`;
}

/**
 * The line under the name when the agent is off (BEA-1603). Says plainly that it will not run by
 * itself, and names the schedule it WOULD keep — so "Off" never hides the fact that a time is set.
 */
export function offLine(scheduleText: string | null | undefined): string {
  const words = String(scheduleText || '').trim();
  if (!words) return 'Off — it will not run on its own.';
  return `Off — it will not run on its own. Would run ${words.charAt(0).toLowerCase()}${words.slice(1)}.`;
}

/**
 * What the toast says after a schedule is saved (BEA-1603). The server switches an off agent on when
 * a schedule is saved (unless the system paused it), and the toast must say so — a quiet flip of the
 * switch is how he ends up not trusting the screen.
 */
export function scheduleSavedToast(words: string, wasOff: boolean, nowOn: boolean): string {
  if (!words) return 'Saved — manual only';
  if (wasOff && nowOn) return `Saved and switched on — ${words}`;
  return `Saved — ${words}`;
}

export function scheduleSummary(a: any): string {
  return schedText(a?.schedule) || 'Only when you press Run';
}

/** "Fetch every time (not watching)" / "Watching — baseline 18 Aug" / "Alert when …". */
export function watchSummary(a: any, watchRows: { lastAt: string }[] | null): string {
  const mode = a?.mode || 'run';
  if (mode === 'run') return 'Fetch every time (not watching)';
  const since = watchRows === null ? '' : watchRows.length === 0 ? ' — no baseline yet' : ` — baseline ${new Date(watchRows[watchRows.length - 1].lastAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
  if (mode === 'alert') {
    const t = a?.threshold;
    const what = String(a?.alertCondition || '').trim() || (t && t.value !== undefined && t.value !== null ? `${t.field || 'the main number'} goes ${t.dir} ${t.value}` : 'anything changes');
    return `Alert when ${what}${since}`;
  }
  return `Watching for changes${since}`;
}

/** "Toolbox: N picked · M skills" — or the honest words when nothing is picked. */
export function toolsSummary(a: any): string {
  const n = (a?.tools || []).length;
  const m = (a?.skills || []).length;
  return `${n ? `Toolbox: ${n} picked` : "Toolbox: the agent's"} · ${m ? `${m} skill${m === 1 ? '' : 's'}` : 'no skills'}`;
}

export function advancedSummary(a: any): string {
  return `Model: ${a?.engine?.model || 'default'} · history ${a?.keepDays == null ? 'kept forever' : `${a.keepDays} days`}`;
}
