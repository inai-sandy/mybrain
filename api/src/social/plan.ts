import { isServiceToolId } from '../tools/service-provider';
import { Threshold, itemKey, stableJson } from './diff';

/**
 * The plan JSON (BEA-1369, `specs/THINKING-BUILDER.md` §C) — the ONE description of what a Social
 * agent does per run. `planFromAgent(agent)` builds it, pure, from the fields the job already has;
 * `SocialAgentRunService.runPlan()` executes it and `buildSocialFlow()` draws it, so the runner and
 * the picture can never disagree, and the builder (BEA-1371) can plan in the same blocks.
 *
 * Blocks:
 *  - **source** — one action + pinned args + `pages` (1..11): the runner follows the vendor's
 *    cursor / page number, one `ToolCall` per page, de-dupes on the stable id, stops early on an
 *    empty or repeated page, and checks the credit ceiling before every page. Stored on the job as
 *    `toolArgs[svc id]._pages` — a plain number beside the args, no schema change.
 *  - **creators** — "find the creators, then their posts": a finder action once (`find`), the first
 *    N found (`take`, ≤ 50), then the per-creator action (`then`) once per creator, with the
 *    creator's field (`argsFrom`, e.g. `{ handle: 'username' }`) filling the argument; items older
 *    than `keepDays` are dropped when the items carry a date. Stored on the job as
 *    `toolArgs[<finder svc id>] = { kind:'creators', find:{…}, then:{…} }`.
 *  - merge · shape · watch · output · notify · schedule · ceiling — the blocks that already run.
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

export const MAX_PAGES = 11;
export const MAX_TAKE = 50;
export const DEFAULT_KEEP_DAYS = 30;

export type PlanSource = {
  kind: 'source';
  /** The `toolArgs` key — the `svc:` id. Also the node id's tail (`src:<id>`). */
  id: string;
  actionId: string;
  /** The exact arguments sent — `_pages` taken out. */
  args: Record<string, any>;
  pages: number;
};

export type PlanCreators = {
  kind: 'creators';
  /** The `toolArgs` key — the finder's `svc:` id. */
  id: string;
  find: { actionId: string; args: Record<string, any>; take: number };
  then: {
    actionId: string;
    /** `{ <param>: <field on the found creator> }` — e.g. `{ handle: 'username' }`. */
    argsFrom: Record<string, string>;
    /** Extra fixed arguments for the per-creator call (e.g. `trim: true`). */
    args?: Record<string, any>;
    /** Keep only items newer than this many days — when the items carry a date. Absent = keep all. */
    keepDays?: number;
  };
};

export type PlanBlock = PlanSource | PlanCreators;

export type AgentPlan = {
  agentId?: string;
  name: string;
  sources: PlanBlock[];
  /** true when >1 source: a plain union under a `source` column (`mergeTables()`). */
  merge: boolean;
  /** The shaping step — only when the task says more than "as fetched", and never on a Watch. */
  shape?: { prompt: string };
  watch?: { mode: 'watch' | 'alert'; threshold?: Threshold | null; condition?: string };
  output: { kind: 'sheet' | 'document'; sheetId?: string | null; append: boolean };
  notify: { whatsapp: boolean; telegram: boolean };
  schedule: { schedule: any; text: string } | null;
  /** The plain sentence about the daily credit ceiling — the runner checks it before every call. */
  ceilingNote: string;
  /** The task, in the owner's words. */
  prompt: string;
  mode: 'run' | 'watch' | 'alert';
};

export const CEILING_NOTE = 'The daily Social credit ceiling is checked before every call — a call that would pass it is not made and the job pauses itself.';

/** 1..11; anything else (missing, text, 0, 99) → 1 or the cap. */
export function clampPages(v: any): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGES);
}

/** 1..50 creators; missing → 10. */
export function clampTake(v: any): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(n, MAX_TAKE);
}

/** A positive number of days, or undefined (keep everything). */
export function keepDaysOf(v: any): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : undefined;
}

/** Is this `toolArgs` value a creators-first source? */
export function isCreatorsArgs(args: any): boolean {
  return !!args && typeof args === 'object' && args.kind === 'creators' && !!args.find && typeof args.find === 'object' && !!args.then && typeof args.then === 'object';
}

/** The pinned arguments a source sends — the planning keys (`_pages`) taken out. */
export function plainArgs(args: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!args || typeof args !== 'object') return out;
  for (const [k, v] of Object.entries(args)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/** One `toolArgs` entry → its plan block. Exported so the UI-facing code and the tests share it. */
export function blockOf(id: string, raw: any): PlanBlock {
  if (isCreatorsArgs(raw)) {
    const find = raw.find || {};
    const then = raw.then || {};
    const argsFrom: Record<string, string> = {};
    for (const [k, v] of Object.entries(then.argsFrom && typeof then.argsFrom === 'object' ? then.argsFrom : {})) if (typeof v === 'string' && v.trim()) argsFrom[k] = v.trim();
    const block: PlanCreators = {
      kind: 'creators',
      id,
      find: { actionId: String(find.actionId || id), args: plainArgs(find.args), take: clampTake(find.take) },
      then: { actionId: String(then.actionId || ''), argsFrom },
    };
    const extra = plainArgs(then.args);
    if (Object.keys(extra).length) block.then.args = extra;
    const days = keepDaysOf(then.keepDays);
    if (days !== undefined) block.then.keepDays = days;
    return block;
  }
  return { kind: 'source', id, actionId: id, args: plainArgs(raw), pages: clampPages(raw?._pages) };
}

/**
 * The plan of a job as it is saved today. Pure: same agent → same plan. Order = `Agent.tools`
 * order (the order the sources are fetched and merged), a `toolArgs` key the tools list forgot is
 * still a source (the UI's remove/add keep both in step, but data wins over a stale list).
 */
export function planFromAgent(agent: any): AgentPlan {
  const tools: string[] = Array.isArray(agent?.tools) ? agent.tools.filter((t: any) => typeof t === 'string') : [];
  const args: Record<string, any> = agent?.toolArgs && typeof agent.toolArgs === 'object' ? agent.toolArgs : {};
  const ids = [...tools.filter((t) => t in args), ...Object.keys(args).filter((k) => !tools.includes(k))];
  const sources = ids.map((id) => blockOf(id, args[id]));
  const mode: 'run' | 'watch' | 'alert' = agent?.mode === 'watch' ? 'watch' : agent?.mode === 'alert' ? 'alert' : 'run';
  const prompt = String(agent?.prompt || '').trim();
  const dest = String(agent?.outputDest || 'document') === 'sheet' ? 'sheet' : 'document';
  const sheetId = agent?.sheetId ? String(agent.sheetId) : null;
  const plan: AgentPlan = {
    name: String(agent?.name || 'Social agent').trim(),
    sources,
    merge: sources.length > 1,
    output: { kind: dest, sheetId, append: dest === 'sheet' && !!sheetId },
    notify: { whatsapp: !!agent?.notifyWhatsApp, telegram: mode === 'alert' },
    schedule: agent?.schedule ? { schedule: agent.schedule, text: String(agent.scheduleText || '') } : null,
    ceilingNote: CEILING_NOTE,
    prompt: prompt || KEEP_AS_FETCHED,
    mode,
  };
  if (agent?.id) plan.agentId = String(agent.id);
  if (mode === 'run' && wantsShaping(prompt)) plan.shape = { prompt };
  if (mode !== 'run') {
    plan.watch = { mode };
    const th = thresholdOf(agent?.threshold);
    if (th) plan.watch.threshold = th;
    const cond = String(agent?.alertCondition || '').trim();
    if (cond) plan.watch.condition = cond;
  }
  return plan;
}

/** Every `svc:` id a plan calls (sources, finders, per-creator actions) — for names, costs, cards. */
export function planActionIds(plan: AgentPlan): string[] {
  const out: string[] = [];
  for (const s of plan.sources) {
    if (s.kind === 'source') out.push(s.actionId);
    else { out.push(s.find.actionId); if (s.then.actionId) out.push(s.then.actionId); }
  }
  return [...new Set(out.filter(Boolean))];
}

// ---- cost ------------------------------------------------------------------------------------

/** What the estimate reads off a know-how card (BEA-1368) — only the two facts it needs. */
export type CostKnowledge = { cost?: { credits?: { typical?: number } }; paging?: { pageSize?: number } };

export type PlanCost = { credits: number; aiTokens: number; items: number; how: string };

/** Tokens the shaping model reads per item — a flattened post with a capped caption, measured on real runs. */
export const TOKENS_PER_ITEM = 300;
/** Items a page usually holds when the card does not say — 12 is what the searches here answer. */
export const DEFAULT_PAGE_SIZE = 12;

const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, w: string) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;

/**
 * ≈ what one run costs: credits (pages × credits per page from the card when it says, else 1;
 * creators-first = the finder + one call per creator) and AI tokens (items × ~300 when the rows are
 * shaped). `how` explains the arithmetic in plain words. Derived, never guessed: every number's
 * source is the card, the plan, or a stated default.
 */
export function estimatePlanCost(plan: AgentPlan, knowledge: Record<string, CostKnowledge> = {}): PlanCost {
  let credits = 0;
  let items = 0;
  const parts: string[] = [];
  const perCall = (id: string) => { const n = Number(knowledge[id]?.cost?.credits?.typical); return Number.isFinite(n) && n > 0 ? n : 1; };
  const perPage = (id: string) => { const n = Number(knowledge[id]?.paging?.pageSize); return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_SIZE; };
  for (const s of plan.sources) {
    if (s.kind === 'source') {
      const c = perCall(s.actionId);
      const cost = s.pages * c;
      credits += cost;
      items += s.pages * perPage(s.actionId);
      parts.push(`${shortName(s.actionId)}: ${plural(s.pages, 'page')} × ${plural(c, 'credit')} = ${fmt(cost)}`);
    } else {
      const f = perCall(s.find.actionId);
      const t = perCall(s.then.actionId);
      const cost = f + s.find.take * t;
      credits += cost;
      items += s.find.take * perPage(s.then.actionId);
      parts.push(`${shortName(s.find.actionId)} once (${fmt(f)}) + ${plural(s.find.take, 'creator')} × ${plural(t, 'credit')} = ${fmt(cost)}`);
    }
  }
  const aiTokens = plan.shape ? items * TOKENS_PER_ITEM : 0;
  let how = parts.length ? `${parts.join(' · ')} → ≈ ${plural(credits, 'credit')} per run` : 'No sources yet.';
  if (plan.shape) how += `; shaping ≈ ${plural(items, 'item')} × ${TOKENS_PER_ITEM} tokens ≈ ${fmt(aiTokens)} AI tokens`;
  else if (plan.watch) how += '; no AI shaping on a Watch/Alert';
  how += '. Sheet writes are not Social credits.';
  return { credits, aiTokens, items, how };
}

/** `svc:instagram.search_popular` → "Instagram search popular" — for the cost sentence. */
export function shortName(id: string): string {
  const bare = String(id || '').replace(/^svc:/, '');
  const dot = bare.indexOf('.');
  const service = dot > 0 ? bare.slice(0, dot) : bare;
  const action = dot > 0 ? bare.slice(dot + 1) : '';
  const cap = (s: string) => s.replace(/[_-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
  return `${cap(service)}${action ? ` ${action.replace(/[_-]+/g, ' ')}` : ''}`;
}

// ---- helpers the runner needs for pages / creators (pure, tested here) --------------------------

/** `Agent.threshold` as stored (JSON text) or as shaped (object) → a Threshold, or null when there is none. */
export function thresholdOf(raw: any): Threshold | null {
  let t: any = raw;
  if (typeof raw === 'string') { try { t = JSON.parse(raw); } catch { t = null; } }
  if (!t || typeof t !== 'object') return null;
  const value = Number(t.value);
  if (!Number.isFinite(value)) return null;
  return { field: t.field ? String(t.field).trim() || undefined : undefined, dir: t.dir === 'below' ? 'below' : 'above', value };
}

/** The next cursor out of an answer, wherever the vendor put it (the Social page's rule, BEA-1356). */
export function nextCursorOf(data: any): { key: string; value: any } | null {
  if (!data || typeof data !== 'object') return null;
  for (const k of ['cursor', 'next_cursor', 'nextCursor', 'next_max_id', 'end_cursor', 'endCursor', 'next_page_token', 'nextPageToken', 'max_cursor', 'next_page_id']) {
    const v = (data as any)[k];
    if (v !== undefined && v !== null && v !== '' && v !== false) return { key: k, value: v };
  }
  return null;
}

/**
 * Which argument pages this action, and how — from the know-how card's `paging` when it speaks,
 * else from what the answer carries (`cursor` → `cursor`, `next_max_id` → `next_max_id`), else a
 * `page` number the pinned args already use. Null = this action does not page.
 */
export function pagingOf(paging: { how?: string; field?: string } | null | undefined, args: Record<string, any>, firstAnswer: any): { param: string; how: 'cursor' | 'page' } | null {
  if (paging && paging.field && (paging.how === 'cursor' || paging.how === 'page')) return { param: paging.field, how: paging.how };
  const c = nextCursorOf(firstAnswer);
  if (c) {
    const param = /max_id/.test(c.key) ? 'next_max_id' : /token/.test(c.key) ? 'page_token' : /page_id/.test(c.key) ? 'next_page_id' : 'cursor';
    return { param, how: 'cursor' };
  }
  if (args && Number.isFinite(Number(args.page))) return { param: 'page', how: 'page' };
  return null;
}

/** A stable key for de-duping items across pages / creators: the id field, else the whole item. */
export function dedupeKey(item: any): string {
  const k = itemKey(item);
  return k ? `${k.field}=${k.key}` : `json:${stableJson(item)}`;
}

/** Fields that hold "when it was posted", tried in this order when a card names none. */
export const DATE_FIELDS = ['taken_at', 'taken_at_timestamp', 'created_at', 'created_time', 'createTime', 'create_time', 'timestamp', 'published_at', 'publishedAt', 'publish_time', 'date', 'posted_at', 'upload_date', 'time'];

/** The date of one item as epoch ms — seconds, ms or an ISO string; null when it has none. */
export function itemDate(item: any, field: string): number | null {
  const v = item && typeof item === 'object' ? item[field] : undefined;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === 'string') {
    if (/^\d{9,13}$/.test(v)) return itemDate({ x: Number(v) }, 'x');
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Which field says when an item was posted: the card's date fields inside the list (`items[].taken_at`
 * → `taken_at`) that the items really carry, else the usual names. Null = these items have no date.
 */
export function dateFieldOf(items: any[], cardFields?: { path: string; kind: string }[] | null): string | null {
  const sample = (items || []).filter((x) => x && typeof x === 'object').slice(0, 20);
  if (!sample.length) return null;
  const has = (f: string) => sample.some((it) => itemDate(it, f) !== null);
  const fromCard = (cardFields || []).filter((f) => f.kind === 'date' && /\[\]\.[^.]+$/.test(f.path)).map((f) => f.path.split('.').pop()!);
  for (const f of [...fromCard, ...DATE_FIELDS]) if (has(f)) return f;
  return null;
}

/** The creator's value for a `then` argument — flat field first, then one level down (`owner.username`). */
export function creatorField(creator: any, field: string): any {
  if (!creator || typeof creator !== 'object') return undefined;
  if (creator[field] !== undefined && creator[field] !== null && creator[field] !== '') return creator[field];
  const dot = field.indexOf('.');
  if (dot > 0) { const inner = creator[field.slice(0, dot)]; return inner && typeof inner === 'object' ? inner[field.slice(dot + 1)] : undefined; }
  for (const v of Object.values(creator)) if (v && typeof v === 'object' && !Array.isArray(v) && (v as any)[field] !== undefined && (v as any)[field] !== null && (v as any)[field] !== '') return (v as any)[field];
  return undefined;
}
