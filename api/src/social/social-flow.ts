import { AgentPlan, KEEP_AS_FETCHED, PlanCreators, PlanSource, isDirectFetchAgent, planFromAgent, sourceKeyArg, sourceRepeated, wantsShaping } from './plan';

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

/** `KEEP_AS_FETCHED`, `isDirectFetchAgent`, `wantsShaping` live in `plan.ts` since BEA-1369 (the plan owns the vocabulary); re-exported so imports keep working. */
export { KEEP_AS_FETCHED, isDirectFetchAgent, wantsShaping };

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
 * A plain source's node: "Instagram · Popular Search × 5 pages — query: … — about 5 credits per run".
 * When several sources share one action (BEA-1374) the label carries the telling argument too —
 * "Instagram · Search Hashtag Posts #smarthomeindia × 3 pages" — so five hashtags read as five nodes.
 */
function sourceNode(src: PlanSource, nm: { service: string; action: string }, lastCost?: number, repeated = false) {
  const line = argsLine(src.args);
  const key = repeated ? sourceKeyArg(src) : '';
  const hashtag = src.args && src.args.hashtag !== undefined && String(src.args.hashtag) === key && !key.startsWith('#');
  const tag = key ? ` ${hashtag ? '#' : ''}${key}` : '';
  const pages = src.pages > 1 ? ` × ${src.pages} pages` : '';
  const per = lastCost !== undefined && lastCost !== null && Number.isFinite(Number(lastCost)) ? Number(lastCost) : null;
  const cost = per === null
    ? (src.pages > 1 ? `credits per page: not known yet (${src.pages} pages)` : 'credits per fetch: not known yet')
    : src.pages > 1 ? `about ${per * src.pages} credit${per * src.pages === 1 ? '' : 's'} per run (${src.pages} pages × ${per})` : creditsHint(per);
  const paging = src.pages > 1 ? ` — follows the vendor's cursor for up to ${src.pages} pages, de-duped by id, stops early on an empty or repeated page` : '';
  return {
    kind: 'tool', refId: src.actionId, label: `${nm.service} · ${nm.action}${tag}${pages}`,
    sub: [line, cost].filter(Boolean).join(' — '),
    args: src.pages > 1 ? { ...src.args, _pages: src.pages } : src.args,
    say: `Fetch ${nm.service} · ${nm.action}${line ? ` (${line})` : ''} directly through your Tools${paging} — ${cost}, no engine turn.`,
  };
}

/** A creators-first block's node: "Find creators → their posts". */
function creatorsNode(src: PlanCreators, nameOf: (id: string) => { service: string; action: string }, costs?: Record<string, number>) {
  const f = nameOf(src.find.actionId);
  const t = src.then.actionId ? nameOf(src.then.actionId) : { service: f.service, action: 'their posts' };
  const line = argsLine(src.find.args, 60);
  const days = src.then.keepDays ? ` · last ${src.then.keepDays} days` : '';
  const perF = Number.isFinite(Number(costs?.[src.find.actionId])) ? Number(costs![src.find.actionId]) : null;
  const perT = src.then.actionId && Number.isFinite(Number(costs?.[src.then.actionId])) ? Number(costs![src.then.actionId]) : null;
  const cost = perF !== null && perT !== null ? `about ${perF + src.find.take * perT} credits per run (1 + ${src.find.take} × ${perT})` : `about ${1 + src.find.take} credits per run (1 + ${src.find.take}), when each call is 1 credit`;
  const from = Object.entries(src.then.argsFrom).map(([p, fld]) => `${p} ← ${fld}`).join(', ');
  return {
    kind: 'tool', refId: src.find.actionId, label: `Find creators → their posts`,
    sub: `${f.action}${line ? ` (${line})` : ''} → first ${src.find.take} → ${t.action} each${days} — ${cost}`,
    args: { kind: 'creators', find: src.find, then: src.then },
    say: `Find creators with ${f.service} · ${f.action}${line ? ` (${line})` : ''}, take the first ${src.find.take}, then fetch ${t.action} for each one (${from || 'handle from the creator'})${src.then.keepDays ? `, keeping items from the last ${src.then.keepDays} days when they carry a date` : ''} — ${cost}; a creator that fails is said and skipped.`,
  };
}

/**
 * Build the picture. Returns the flow's name, question (the task in the owner's words) and the
 * React-Flow graph the canvas renders. Pure: same agent + same opts → same graph.
 */
export function buildSocialFlow(agent: any, opts: SocialFlowOpts = {}): { name: string; question: string; graph: { nodes: any[]; edges: any[]; drawnBy: 'social'; note: string } } {
  return buildPlanFlow(planFromAgent(agent), opts);
}

/**
 * The picture of a plan (BEA-1369) — `buildSocialFlow()` is `buildPlanFlow(planFromAgent(agent))`,
 * so the drawer and the runner read the SAME plan. A paged source says "× 8 pages"; a creators-first
 * block is one node, "Find creators → their posts".
 */
export function buildPlanFlow(plan: AgentPlan, opts: SocialFlowOpts = {}): { name: string; question: string; graph: { nodes: any[]; edges: any[]; drawnBy: 'social'; note: string } } {
  const sources = plan.sources;
  const mode = plan.mode;
  const sheet = plan.output.kind === 'sheet';
  const append = plan.output.append;
  const shaping = !!plan.shape;
  const whatsapp = plan.notify.whatsapp;
  const prompt = plan.prompt === KEEP_AS_FETCHED ? '' : String(plan.prompt || '').trim();
  const name = plan.name || 'Social agent';
  const sheetId = plan.output.sheetId || '';

  const nodes: any[] = [];
  const edges: any[] = [];
  const edge = (a: string, b: string) => edges.push({ id: `e_${a}_${b}`, source: a, target: b, animated: true });
  const nameOf = (id: string) => ({ ...namesFromId(id), ...(opts.names?.[id] || {}) });

  // ---- the question: what this job is, in one line -------------------------------------------
  const srcNames = sources.map((s) => nameOf(s.kind === 'source' ? s.actionId : s.find.actionId).service);
  const platforms = Array.from(new Set(srcNames));
  const summary = [
    `${sources.length} ${platforms.join(' + ') || 'Social'} source${sources.length === 1 ? '' : 's'}`,
    mode === 'watch' ? 'only what changed' : mode === 'alert' ? 'alert when it happens' : shaping ? 'rows shaped your way' : 'rows as fetched',
    sheet ? (append ? (sheetId ? 'appended to your Google Sheet' : 'kept adding to one Google Sheet') : 'a new Google Sheet each run') : 'saved to Documents',
    whatsapp ? 'link on WhatsApp' : '',
  ].filter(Boolean).join(' → ');
  nodes.push({ id: 'question', type: 'box', position: { x: CX, y: 0 }, data: { kind: 'question', label: name, sub: summary, say: prompt || KEEP_AS_FETCHED } });

  // ---- one node per source ----------------------------------------------------------------------
  const startX = sources.length > 1 ? CX - ((sources.length - 1) * COL) / 2 : CX;
  const srcIds: string[] = [];
  sources.forEach((src, i) => {
    const nid = `src:${src.id}`;
    const position = { x: startX + i * COL, y: ROW };
    if (src.kind === 'creators') {
      nodes.push({ id: nid, type: 'box', position, data: creatorsNode(src, nameOf, opts.costs) });
    } else {
      nodes.push({ id: nid, type: 'box', position, data: sourceNode(src, nameOf(src.actionId), opts.costs?.[src.actionId], sourceRepeated(src, sources)) });
    }
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
  // The merge is a union (`mergeTables()`): every row from every source under a "source" column,
  // de-duped on the item id when the rows carry one (BEA-1374 — five hashtag searches that found
  // the same post give one row). Anything more (a filter, columns) is the shaping step's job.
  if (sources.length > 1) {
    chain({ id: 'merge', data: { kind: 'merge', mode: 'raw', modeText: 'Union', label: 'Merge the sources', sub: `One table with a "source" column — every row from every source, a post found by two searches once (de-duped on its id)${shaping ? '; the shaping step below applies your task to it' : ''}`, say: `Merge the ${sources.length} sources into one table under a "source" column — every row from every source, de-duped on the item id${shaping ? '' : ', as fetched'}.` } });
  }

  // ---- shaping — only when the task says more than "as fetched" (mode run only) ------------------
  if (shaping) {
    chain({ id: 'shape', data: { kind: 'ask_ai', label: 'Shape the rows', sub: `Sonnet · Social rows model — ${prompt.slice(0, 110)}${prompt.length > 110 ? '…' : ''}`, say: `Shape the rows the way the task says (Sonnet · "Social rows model" in Settings): "${prompt.slice(0, 240)}${prompt.length > 240 ? '…' : ''}"` } });
  }

  // ---- watch / alert -------------------------------------------------------------------------------
  if (mode === 'watch') {
    chain({ id: 'watch', data: { kind: 'filter', label: 'Only what changed', sub: 'Compared with what it saw last time — new items, numbers that moved. First run stores the baseline.', say: 'Compare with what it saw last time and keep only what changed (new items by id, numbers that moved); the first run only stores the baseline.' } });
  } else if (mode === 'alert') {
    const th = thresholdText(plan.watch?.threshold);
    const cond = String(plan.watch?.condition || '').trim();
    const when = [th ? `when ${th}` : '', cond ? `when “${cond.slice(0, 90)}${cond.length > 90 ? '…' : ''}”` : ''].filter(Boolean).join(' or ') || 'on any change';
    chain({ id: 'watch', data: { kind: 'if', label: 'Alert ' + when, sub: 'Compared with last time; a number that stays over the line alerts once' + (cond ? ' · the condition is judged by one model call over the change' : ''), say: `Compare with last time and alert ${when} (a number that stays over the line alerts once${cond ? '; the plain-English condition is judged by one model call over the change only' : ''}).` } });
  }

  // ---- the writer ----------------------------------------------------------------------------------
  if (sheet && append && sheetId) {
    chain({ id: 'write', data: { kind: 'tool', refId: 'svc:googlesheets.batch_update', label: 'Google Sheet — append to yours', sub: `Rows go under your sheet's own columns · ${sheetId.slice(0, 18)}… · rows already there (by id) are skipped`, say: 'Read your Google Sheet’s columns and row count, then append the rows under its own columns — a row whose id the sheet already has is not added again.' } });
  } else if (sheet && append) {
    // "Keep adding" (BEA-1374): ONE sheet, made on the first run and remembered on the job; every later run appends, de-duped on the sheet's key column.
    chain({ id: 'write', data: { kind: 'tool', refId: 'svc:googlesheets.batch_update', label: 'Google Sheet — one sheet, kept adding to', sub: `Made on the first run (titled "${name}"), then every run appends · rows already there (by id) are skipped`, say: `Create one Google Sheet titled "${name}" on the first run and remember it on the job; every later run appends the rows under its columns, skipping any row whose id the sheet already has.` } });
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
