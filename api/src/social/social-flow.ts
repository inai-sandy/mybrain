import { isServiceToolId } from '../tools/service-provider';

/**
 * A Social agent's flow picture, drawn from its settings — no AI (BEA-1366).
 *
 * The owner asked for the flow to be shown for EVERY agent. For a direct-fetch job the steps are not
 * a guess to be planned: `SocialAgentRunService.run()` does exactly one thing per setting, so the
 * picture is BUILT from the same facts the runner reads — one node per source (the `svc:` id and its
 * pinned arguments), a merge when there is more than one, the shaping step only when the task says
 * more than "as fetched", the Watch/Alert step when the mode says so, the writer (Google Sheet new /
 * append · Documents), and WhatsApp / Telegram when on. Node ids are STABLE (`src:<svc id>`, `merge`,
 * `shape`, `watch`, `write`, `notify`) so a run's step log can badge them (`AgentRun.stepLog[].nodeId`).
 *
 * Kinds are the canvas's existing ones — nothing new to render: `question`, `tool`, `merge`,
 * `ask_ai` (the shaping model call), `filter` (Watch), `if` (Alert), `output`. Every node carries
 * `say` — its plain-English line for "How it runs" — so the description never guesses from a kind.
 * The flow is saved LOCKED and `drawnBy:'social'`: the runner never executes this graph, and an
 * edit here would silently fork from what actually runs.
 */

/** The task text the builder pre-fills. Anything else means "shape the rows as I say". */
export const KEEP_AS_FETCHED = 'Keep every result as fetched.';

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Is this job a direct fetch? Every tool is a `svc:` id AND each has pinned arguments. A job with
 * a bare `svc:` id and no arguments is not one — the engine cannot call it either, but that is
 * the toolbox's problem to say, not ours to guess at.
 */
export function isDirectFetchAgent(agent: any): boolean {
  const tools: string[] = Array.isArray(agent?.tools) ? agent.tools : [];
  const args = agent?.toolArgs && typeof agent.toolArgs === 'object' ? agent.toolArgs : null;
  return tools.length > 0 && !!args && tools.every((t) => isServiceToolId(t) && args[t] && typeof args[t] === 'object');
}

/** Does the task text ask for anything beyond the rows as fetched? */
export function wantsShaping(prompt?: string | null): boolean {
  const p = norm(prompt || '');
  return !!p && p.replace(/[.!]$/, '') !== norm(KEEP_AS_FETCHED).replace(/[.!]$/, '');
}

export type SocialFlowNames = Record<string, { service?: string; action?: string }>;
export type SocialFlowOpts = {
  /** Plain names per `svc:` id (from the catalog). Missing → derived from the id. */
  names?: SocialFlowNames;
  /** Last known credits per `svc:` id (from `ToolCall.credits`). Missing → "credits: not known yet". */
  costs?: Record<string, number>;
};

export const SOCIAL_FLOW_NOTE = 'Drawn from this job’s settings — change them in Settings and the picture follows.';

const CX = 320;
const COL = 240;
const ROW = 120;

const titleCase = (s: string) => String(s || '').replace(/[_-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());

/** `svc:instagram.search_hashtag` → { service: 'Instagram', action: 'Search hashtag' } */
export function namesFromId(id: string): { service: string; action: string } {
  const bare = String(id || '').replace(/^svc:/, '');
  const dot = bare.indexOf('.');
  const service = dot > 0 ? bare.slice(0, dot) : bare;
  const action = dot > 0 ? bare.slice(dot + 1) : '';
  return { service: titleCase(service), action: titleCase(action.replace(/\d+$/, '')) };
}

/** `{hashtag:'smarthomeindia', date_posted:'last-month'}` → `hashtag: smarthomeindia · date posted: last-month` */
export function argsLine(args: any, max = 90): string {
  if (!args || typeof args !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k.replace(/_/g, ' ')}: ${val.length > 40 ? val.slice(0, 37) + '…' : val}`);
  }
  const s = parts.join(' · ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function creditsHint(n?: number): string {
  if (n === undefined || n === null || !Number.isFinite(Number(n))) return 'credits per fetch: not known yet';
  const c = Number(n);
  return `about ${c} credit${c === 1 ? '' : 's'} per fetch`;
}

function thresholdText(t: any): string {
  let th: any = t;
  if (typeof t === 'string') { try { th = JSON.parse(t); } catch { th = null; } }
  if (!th || typeof th !== 'object' || !Number.isFinite(Number(th.value))) return '';
  const field = th.field ? String(th.field).replace(/_/g, ' ') : 'the main number';
  return `${field} ${th.dir === 'below' ? 'falls below' : 'goes above'} ${Number(th.value).toLocaleString('en-US')}`;
}

/**
 * Build the picture. Returns the flow's name, question (the task in the owner's words) and the
 * React-Flow graph the canvas renders. Pure: same agent + same opts → same graph.
 */
export function buildSocialFlow(agent: any, opts: SocialFlowOpts = {}): { name: string; question: string; graph: { nodes: any[]; edges: any[]; drawnBy: 'social'; note: string } } {
  const tools: string[] = Array.isArray(agent?.tools) ? agent.tools : [];
  const args: Record<string, any> = agent?.toolArgs && typeof agent.toolArgs === 'object' ? agent.toolArgs : {};
  const mode = ['watch', 'alert'].includes(String(agent?.mode)) ? String(agent.mode) : 'run';
  const dest = String(agent?.outputDest || 'document');
  const sheet = dest === 'sheet';
  const append = sheet && !!agent?.sheetId;
  const shaping = mode === 'run' && wantsShaping(agent?.prompt);
  const whatsapp = !!agent?.notifyWhatsApp;
  const prompt = String(agent?.prompt || '').trim();
  const name = String(agent?.name || 'Social agent').trim();

  const nodes: any[] = [];
  const edges: any[] = [];
  const edge = (a: string, b: string) => edges.push({ id: `e_${a}_${b}`, source: a, target: b, animated: true });

  // ---- the question: what this job is, in one line -------------------------------------------
  const srcNames = tools.map((id) => opts.names?.[id]?.service || namesFromId(id).service);
  const platforms = Array.from(new Set(srcNames));
  const summary = [
    `${tools.length} ${platforms.join(' + ') || 'Social'} source${tools.length === 1 ? '' : 's'}`,
    mode === 'watch' ? 'only what changed' : mode === 'alert' ? 'alert when it happens' : shaping ? 'rows shaped your way' : 'rows as fetched',
    sheet ? (append ? 'appended to your Google Sheet' : 'a new Google Sheet each run') : 'saved to Documents',
    whatsapp ? 'link on WhatsApp' : '',
  ].filter(Boolean).join(' → ');
  nodes.push({ id: 'question', type: 'box', position: { x: CX, y: 0 }, data: { kind: 'question', label: name, sub: summary, say: prompt || KEEP_AS_FETCHED } });

  // ---- one node per source ----------------------------------------------------------------------
  const startX = tools.length > 1 ? CX - ((tools.length - 1) * COL) / 2 : CX;
  const srcIds: string[] = [];
  tools.forEach((id, i) => {
    const nm = { ...namesFromId(id), ...(opts.names?.[id] || {}) };
    const nid = `src:${id}`;
    const line = argsLine(args[id]);
    const cost = creditsHint(opts.costs?.[id]);
    nodes.push({
      id: nid, type: 'box', position: { x: startX + i * COL, y: ROW },
      data: {
        kind: 'tool', refId: id, label: `${nm.service} · ${nm.action}`,
        sub: [line, cost].filter(Boolean).join(' — '),
        args: args[id] || {},
        say: `Fetch ${nm.service} · ${nm.action}${line ? ` (${line})` : ''} directly through your Tools — ${cost}, no engine turn.`,
      },
    });
    edge('question', nid);
    srcIds.push(nid);
  });

  let y = ROW * 2;
  let prev: string[] = srcIds;
  const chain = (node: any) => {
    node.type = 'box';
    node.position = { x: CX, y };
    nodes.push(node);
    prev.forEach((p) => edge(p, node.id));
    prev = [node.id];
    y += ROW;
  };

  // ---- merge when there is more than one source ------------------------------------------------
  // The merge is a plain union (`mergeTables()`): every row from every source under a "source"
  // column. It does NOT de-duplicate — only the shaping step does, and only when the task says so.
  if (tools.length > 1) {
    chain({ id: 'merge', data: { kind: 'merge', mode: 'raw', modeText: 'Union', label: 'Merge the sources', sub: `One table with a "source" column — every row from every source${shaping ? '; the shaping step below applies your task to it' : ' (a post found by two searches appears twice)'}`, say: `Merge the ${tools.length} sources into one table under a "source" column — every row from every source${shaping ? '' : ', as fetched'}.` } });
  }

  // ---- shaping — only when the task says more than "as fetched" (mode run only) ------------------
  if (shaping) {
    chain({ id: 'shape', data: { kind: 'ask_ai', label: 'Shape the rows', sub: `Sonnet · Social rows model — ${prompt.slice(0, 110)}${prompt.length > 110 ? '…' : ''}`, say: `Shape the rows the way the task says (Sonnet · "Social rows model" in Settings): "${prompt.slice(0, 240)}${prompt.length > 240 ? '…' : ''}"` } });
  }

  // ---- watch / alert -------------------------------------------------------------------------------
  if (mode === 'watch') {
    chain({ id: 'watch', data: { kind: 'filter', label: 'Only what changed', sub: 'Compared with what it saw last time — new items, numbers that moved. First run stores the baseline.', say: 'Compare with what it saw last time and keep only what changed (new items by id, numbers that moved); the first run only stores the baseline.' } });
  } else if (mode === 'alert') {
    const th = thresholdText(agent?.threshold);
    const cond = String(agent?.alertCondition || '').trim();
    const when = [th ? `when ${th}` : '', cond ? `when “${cond.slice(0, 90)}${cond.length > 90 ? '…' : ''}”` : ''].filter(Boolean).join(' or ') || 'on any change';
    chain({ id: 'watch', data: { kind: 'if', label: 'Alert ' + when, sub: 'Compared with last time; a number that stays over the line alerts once' + (cond ? ' · the condition is judged by one model call over the change' : ''), say: `Compare with last time and alert ${when} (a number that stays over the line alerts once${cond ? '; the plain-English condition is judged by one model call over the change only' : ''}).` } });
  }

  // ---- the writer ----------------------------------------------------------------------------------
  if (sheet && append) {
    chain({ id: 'write', data: { kind: 'tool', refId: 'svc:googlesheets.batch_update', label: 'Google Sheet — append to yours', sub: `Rows go under your sheet's own columns · ${String(agent.sheetId).slice(0, 18)}…`, say: 'Read your Google Sheet’s columns and row count, then append the rows under its own columns.' } });
  } else if (sheet) {
    chain({ id: 'write', data: { kind: 'tool', refId: 'svc:googlesheets.create_google_sheet1', label: 'Google Sheet — new each run', sub: `Titled "${name} — <date>", header + rows at A1`, say: `Create a new Google Sheet titled "${name} — <date>" and write the header and rows at A1.` } });
  } else {
    chain({ id: 'write', data: { kind: 'tool', refId: 'save_document', label: 'Save to Documents', sub: mode === 'run' ? 'A markdown table in your Documents library' : 'Only what changed, as a document', say: mode === 'run' ? 'Save the rows as a document in your Documents library.' : 'Save what changed as a document in your Documents library.' } });
  }

  // ---- WhatsApp / Telegram -----------------------------------------------------------------------
  // A fired Alert goes out on Telegram AND WhatsApp regardless of the WhatsApp toggle (the runner's
  // `watch()` tries both and fails the run when neither reaches the owner) — the picture says the same.
  if (mode === 'alert') {
    chain({ id: 'notify', data: { kind: 'tool', refId: 'telegram', label: 'Telegram + WhatsApp', sub: 'When the alert fires; a fired alert that reaches nobody fails the run', say: 'Send the alert on Telegram and WhatsApp — a fired alert that reaches nobody fails the run.' } });
  } else if (whatsapp) {
    chain({ id: 'notify', data: { kind: 'tool', refId: 'whatsapp', label: 'WhatsApp — send the link', sub: sheet ? 'The sheet link, to your number in Settings' : 'The result, to your number in Settings', say: `Send ${sheet ? 'the sheet link' : 'the result'} to your WhatsApp number from Settings.` } });
  }

  chain({ id: 'end', data: { kind: 'output', label: 'Done', sub: mode === 'watch' ? 'Nothing changed → the run says so and writes nothing' : 'Every step is on the run’s log with its credits' } });

  return { name: `${name} — how it runs`, question: prompt || KEEP_AS_FETCHED, graph: { nodes, edges, drawnBy: 'social', note: SOCIAL_FLOW_NOTE } };
}
