import { isServiceToolId } from '../tools/service-provider';
import { cursorParamFor } from '../tools/tool-lesson';
import { Threshold, itemKey, stableJson } from './diff';
import { ToolArgsEntry, ToolArgsMap, actionIdsOf, entryActionId, isCreatorsEntry, legacyValueOf, normaliseToolArgs } from './tool-args';

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
 *    `toolArgs[<source id>] = { actionId, args, _pages }` (BEA-1374 — several sources may share one
 *    action; `tool-args.ts` reads the older `toolArgs[svc id] = args` shape too).
 *  - **creators** — "find the creators, then their posts": a finder action once (`find`), the first
 *    N found (`take`, ≤ 50), then the per-creator action (`then`) once per creator, with the
 *    creator's field (`argsFrom`, e.g. `{ handle: 'username' }`) filling the argument; items older
 *    than `keepDays` are dropped when the items carry a date. Stored on the job as
 *    `toolArgs[<source id>] = { kind:'creators', find:{…}, then:{…} }`.
 *  - merge · shape · watch · output · notify · schedule · ceiling — the blocks that already run.
 */

/** The task text the builder pre-fills. Anything else means "shape the rows as I say". */
export const KEEP_AS_FETCHED = 'Keep every result as fetched.';

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Is this job a direct fetch? Every tool is a `svc:` id AND each has at least one source with pinned
 * arguments (BEA-1374: sources are keyed by source id — `normaliseToolArgs` — and several may share
 * one action). A job with a bare `svc:` id and no source is not one — the engine cannot call it
 * either, but that is the toolbox's problem to say, not ours to guess at.
 */
export function isDirectFetchAgent(agent: any): boolean {
  const tools: string[] = Array.isArray(agent?.tools) ? agent.tools : [];
  const map = normaliseToolArgs(agent?.toolArgs);
  if (!tools.length || !Object.keys(map).length) return false;
  // Every action the sources call — a source's own action, a creators block's finder AND its per-creator action.
  const covered = new Set<string>(actionIdsOf(map));
  return tools.every((t) => isServiceToolId(t) && covered.has(t));
}

/** Does the task text ask for anything beyond the rows as fetched? */
export function wantsShaping(prompt?: string | null): boolean {
  const p = norm(prompt || '');
  return !!p && p.replace(/[.!]$/, '') !== norm(KEEP_AS_FETCHED).replace(/[.!]$/, '');
}

export const MAX_PAGES = 11;

/**
 * `pages: ALL_PAGES` — keep asking for the next page until the source runs out (BEA-1407).
 *
 * The 11-page cap is a sensible default for a digest, and a wall for "read ALL my emails since
 * yesterday". The owner asked for exactly that and there was no way to say it: the plan had a
 * number, and a number is a guess about how much of his life fits on a page.
 *
 * "Until it runs out" is still bounded — by the source itself (no next cursor, an empty page, a
 * repeated page all stop the loop), by `MAX_PAGES_ALL` as a runaway backstop, and by the daily
 * credit ceiling, which is checked BEFORE every single page.
 */
export const ALL_PAGES = -1;

/** The runaway backstop for `ALL_PAGES`. Never reached by a real source; reached, it is said out loud. */
export const MAX_PAGES_ALL = 200;
export const MAX_TAKE = 50;
export const DEFAULT_KEEP_DAYS = 30;

export type PlanSource = {
  kind: 'source';
  /** The `toolArgs` key — the SOURCE id (the `svc:` id, or `<svc id>#2`… when several sources share one action, BEA-1374). Also the node id's tail (`src:<id>`). */
  id: string;
  actionId: string;
  /** The exact arguments sent — `_pages` taken out. */
  args: Record<string, any>;
  pages: number;
};

export type PlanCreators = {
  kind: 'creators';
  /** The `toolArgs` key — the SOURCE id (the finder's `svc:` id, or `<svc id>#2`…). */
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
  // "all" / ALL_PAGES — until the source runs out. Written as a word by a person, as -1 by the code.
  if (typeof v === 'string' && v.trim().toLowerCase() === 'all') return ALL_PAGES;
  const n = Math.floor(Number(v));
  if (n === ALL_PAGES) return ALL_PAGES;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGES);
}

/** How many pages this source will really ask for, at most. */
export function pageCeiling(pages: number): number {
  return pages === ALL_PAGES ? MAX_PAGES_ALL : pages;
}

/** "3 pages" · "every page there is" — for a step, a plan card or a build brief. */
export function pagesText(pages: number): string {
  if (pages === ALL_PAGES) return 'every page there is';
  return `${pages} page${pages === 1 ? '' : 's'}`;
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

/**
 * One `toolArgs` entry → its plan block. `raw` is the per-source VALUE in either shape: the old one
 * (`args` with `_pages` beside them, or a creators block — then the action id is `id`), or the new
 * `{ actionId, args, _pages }` (BEA-1374). Exported so the UI-facing code and the tests share it.
 */
export function blockOf(id: string, raw: any): PlanBlock {
  if (!isCreatorsArgs(raw) && raw && typeof raw === 'object' && typeof raw.actionId === 'string' && isServiceToolId(raw.actionId) && (raw.args === undefined || (raw.args && typeof raw.args === 'object'))) {
    const pages = raw._pages !== undefined ? raw._pages : raw.args?._pages;
    return { kind: 'source', id, actionId: raw.actionId, args: plainArgs(raw.args), pages: clampPages(pages) };
  }
  if (isCreatorsArgs(raw)) {
    const find = raw.find || {};
    const then = raw.then || {};
    const argsFrom: Record<string, string> = {};
    for (const [k, v] of Object.entries(then.argsFrom && typeof then.argsFrom === 'object' ? then.argsFrom : {})) if (typeof v === 'string' && v.trim()) argsFrom[k] = v.trim();
    const block: PlanCreators = {
      kind: 'creators',
      id,
      find: { actionId: String(find.actionId || id.replace(/#\d+$/, '')), args: plainArgs(find.args), take: clampTake(find.take) },
      then: { actionId: String(then.actionId || ''), argsFrom },
    };
    const extra = plainArgs(then.args);
    if (Object.keys(extra).length) block.then.args = extra;
    const days = keepDaysOf(then.keepDays);
    if (days !== undefined) block.then.keepDays = days;
    return block;
  }
  return { kind: 'source', id, actionId: id.replace(/#\d+$/, ''), args: plainArgs(raw), pages: clampPages(raw?._pages) };
}

/**
 * The sources of a job, in the order they run: `Agent.tools` order by ACTION (the order the sources
 * are fetched and merged — unchanged for every job saved before BEA-1374, where one action was one
 * source), several sources on one action in the order they were stored, and a source whose action
 * the tools list forgot still runs (data wins over a stale list). Reads either storage shape.
 */
export function sourcesOfAgent(agent: any): PlanBlock[] {
  const tools: string[] = Array.isArray(agent?.tools) ? agent.tools.filter((t: any) => typeof t === 'string') : [];
  const map: ToolArgsMap = normaliseToolArgs(agent?.toolArgs);
  const entries = Object.entries(map).map(([id, e], i) => ({ id, e, i, at: tools.indexOf(entryActionId(e)) }));
  entries.sort((a, b) => (a.at === -1 ? tools.length : a.at) - (b.at === -1 ? tools.length : b.at) || a.i - b.i);
  return entries.map(({ id, e }) => blockOfEntry(id, e));
}

/** A new-shape entry → its block (the creators block is the same in both shapes). */
export function blockOfEntry(id: string, e: ToolArgsEntry): PlanBlock {
  return isCreatorsEntry(e) ? blockOf(id, e) : blockOf(id, legacyValueOf(e));
}

/**
 * The plan of a job as it is saved today. Pure: same agent → same plan.
 */
export function planFromAgent(agent: any): AgentPlan {
  const sources = sourcesOfAgent(agent);
  const mode: 'run' | 'watch' | 'alert' = agent?.mode === 'watch' ? 'watch' : agent?.mode === 'alert' ? 'alert' : 'run';
  const prompt = String(agent?.prompt || '').trim();
  const dest = String(agent?.outputDest || 'document') === 'sheet' ? 'sheet' : 'document';
  const sheetId = agent?.sheetId ? String(agent.sheetId) : null;
  const plan: AgentPlan = {
    name: String(agent?.name || 'Social agent').trim(),
    sources,
    merge: sources.length > 1,
    // Append (BEA-1374): to the sheet the owner named, or "keep adding" to ONE sheet the first run
    // creates (`Agent.sheetAppend`) — the runner remembers its id on the job after that first run.
    output: { kind: dest, sheetId, append: dest === 'sheet' && (!!sheetId || !!agent?.sheetAppend) },
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

/** The action a source block calls first — the action itself, or a creators block's finder. */
export function sourceActionId(s: PlanBlock): string {
  return s.kind === 'source' ? s.actionId : s.find.actionId;
}

/** Argument names that tell one source from another on the same action, most telling first. */
const TELLING_ARGS = ['hashtag', 'query', 'q', 'keyword', 'keywords', 'search', 'term', 'handle', 'username', 'user_id', 'url', 'id', 'name'];

/** The one argument value that says what THIS source is about ("smarthomeindia") — for labels; '' when it has none. */
export function sourceKeyArg(s: PlanBlock): string {
  const args = s.kind === 'source' ? s.args : s.find.args;
  const pick = (k: string) => { const v = args?.[k]; return v === undefined || v === null || v === '' ? '' : Array.isArray(v) ? v.join(', ') : String(v); };
  for (const k of TELLING_ARGS) { const v = pick(k); if (v) return v.slice(0, 60); }
  for (const k of Object.keys(args || {})) { const v = pick(k); if (v && typeof args[k] !== 'object') return v.slice(0, 60); }
  return '';
}

/** Do other sources in the plan call the same action as this one (BEA-1374)? */
export function sourceRepeated(s: PlanBlock, all: PlanBlock[]): boolean {
  const id = sourceActionId(s);
  return (all || []).filter((x) => sourceActionId(x) === id).length > 1;
}

/**
 * The name a source goes by in the merged table's `source` column: `instagram.search_hashtag`, and
 * when several sources share the action, ` · <its telling argument>` — so five hashtags read as five
 * sources. A job with one source per action reads exactly as it did before BEA-1374.
 */
export function sourceLabel(s: PlanBlock, all: PlanBlock[]): string {
  const base = sourceActionId(s).replace(/^svc:/, '');
  if (!sourceRepeated(s, all)) return base;
  const key = sourceKeyArg(s);
  return key ? `${base} · ${key}` : `${base} · ${s.id.replace(/^.*#/, '#')}`;
}

/** ` (smarthomeindia)` for a step label when the action repeats, else ''. */
export function sourceHint(s: PlanBlock, all: PlanBlock[]): string {
  if (!sourceRepeated(s, all)) return '';
  const key = sourceKeyArg(s);
  return key ? ` (${key})` : ` (${s.id.replace(/^.*#/, '#')})`;
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

/**
 * What the estimate reads off a know-how card (BEA-1368): cost + paging for the arithmetic, and (BEA-1375)
 * the card's health + name so the estimate can also say what the run costs TODAY, while a source is down.
 */
export type CostKnowledge = {
  name?: string;
  cost?: { free?: boolean; credits?: { typical?: number } };
  paging?: { pageSize?: number };
  health?: { known?: boolean; ok?: boolean; note?: string; lastError?: string };
};

/** A card that says FAILING right now: health known and not ok. Missing card / no verdict = it may well answer. */
export function isFailing(k: CostKnowledge | undefined): boolean {
  return !!(k && k.health && k.health.known && k.health.ok === false);
}

/** Every action a block calls (a creators block calls its finder and its per-creator action). */
export function blockActionIds(b: PlanBlock): string[] {
  return b.kind === 'source' ? [b.actionId] : [b.find.actionId, b.then.actionId].filter(Boolean);
}

/**
 * Can this block produce rows TODAY? Only when none of the actions it calls is failing at the vendor
 * (a creators block on a working finder but a failing per-creator action gives creators and no posts).
 */
export function blockCanProduceToday(b: PlanBlock, knowledge: Record<string, CostKnowledge> = {}): boolean {
  return blockActionIds(b).every((id) => !isFailing(knowledge[id]));
}

/**
 * Does the plan have at least one source that can produce rows today? A plan of only failing sources
 * gives an empty sheet however many pages it asks for — the builder must not show one (BEA-1375).
 */
export function planHasHealthySource(plan: AgentPlan, knowledge: Record<string, CostKnowledge> = {}): boolean {
  return plan.sources.some((s) => blockCanProduceToday(s, knowledge));
}

/** The plan's failing actions, one entry per action id, with the card's own note — for the card and the reply. */
export function failingActions(plan: AgentPlan, knowledge: Record<string, CostKnowledge> = {}): { actionId: string; name: string; note: string }[] {
  return planActionIds(plan)
    .filter((id) => isFailing(knowledge[id]))
    .map((id) => { const k = knowledge[id]!; return { actionId: id, name: k.name || shortName(id), note: oneLineNote(k.health?.note || k.health?.lastError || 'every recent call failed') }; });
}

export type PlanCost = {
  credits: number;
  aiTokens: number;
  items: number;
  how: string;
  /** ≈ ₹ the AI shaping costs per run — `aiTokens` × `RUPEES_PER_1K_AI_TOKENS`, 0 when nothing is shaped (BEA-1372). */
  aiRupees: number;
  /**
   * ≈ credits the run costs TODAY — the healthy sources only (BEA-1375). A source whose card says FAILING answers
   * empty and is not counted; equal to `credits` when everything is working. The live trap: ≈19 shown, 11 charged.
   */
  nowCredits: number;
  /** Sources whose know-how card says FAILING right now — the plan card marks them "kept so it fills in later" (BEA-1372). */
  unhealthy?: { actionId: string; name: string; note: string }[];
};

/** Tokens the shaping model reads per item — a flattened post with a capped caption, measured on real runs. */
export const TOKENS_PER_ITEM = 300;
/**
 * ≈ ₹ per 1,000 AI tokens for the shaping step (Sonnet through OpenRouter, mostly input tokens; ≈ $3.5 per
 * million at ≈ ₹85 to the dollar). A stated rate the owner can read in `how` — never a hidden guess.
 */
export const RUPEES_PER_1K_AI_TOKENS = 0.3;
/** ₹ rounded the way the card shows them: under ₹1 to one decimal, else whole rupees. */
export function rupees(aiTokens: number): number {
  const r = (Math.max(0, Number(aiTokens) || 0) / 1000) * RUPEES_PER_1K_AI_TOKENS;
  return r === 0 ? 0 : r < 1 ? Math.round(r * 10) / 10 : Math.round(r);
}
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
  let nowCredits = 0;
  let items = 0;
  const parts: string[] = [];
  // A card that says FREE (a Composio action on the owner's own account) costs 0 — the builder shows this number, so "≈ 1 credit"
  // for a GitHub read would be a lie (BEA-1371); else the card's typical credits, else 1.
  const perCall = (id: string) => { const k = knowledge[id]?.cost; if (k?.free) return 0; const n = Number(k?.credits?.typical); return Number.isFinite(n) && n > 0 ? n : 1; };
  const perPage = (id: string) => { const n = Number(knowledge[id]?.paging?.pageSize); return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_SIZE; };
  for (const s of plan.sources) {
    if (s.kind === 'source') {
      const c = perCall(s.actionId);
      // "Every page there is" has no number until it runs (BEA-1407). Costing it at a made-up
      // number would be a guess dressed as an estimate, so it is costed at the ordinary cap and
      // SAID to be a floor — the daily ceiling is what really bounds it, before every page.
      const pages = s.pages === ALL_PAGES ? MAX_PAGES : s.pages;
      const cost = pages * c;
      credits += cost;
      // Today: a failing source answers empty (not_found is not charged) — nothing to count.
      if (!isFailing(knowledge[s.actionId])) nowCredits += cost;
      items += pages * perPage(s.actionId);
      parts.push(
        s.pages === ALL_PAGES
          ? `${shortName(s.actionId)}: every page there is — at least ${plural(pages, 'page')} × ${plural(c, 'credit')} = ${fmt(cost)} or more, until the source runs out or the daily ceiling stops it`
          : `${shortName(s.actionId)}: ${plural(s.pages, 'page')} × ${plural(c, 'credit')} = ${fmt(cost)}`,
      );
    } else {
      const f = perCall(s.find.actionId);
      const t = perCall(s.then.actionId);
      const cost = f + s.find.take * t;
      credits += cost;
      // Today: a failing finder finds no one (no per-creator calls); a working finder + failing per-creator action = the finder only.
      if (!isFailing(knowledge[s.find.actionId])) nowCredits += isFailing(knowledge[s.then.actionId]) ? f : cost;
      items += s.find.take * perPage(s.then.actionId);
      parts.push(`${shortName(s.find.actionId)} once (${fmt(f)}) + ${plural(s.find.take, 'creator')} × ${plural(t, 'credit')} = ${fmt(cost)}`);
    }
  }
  const aiTokens = plan.shape ? items * TOKENS_PER_ITEM : 0;
  const aiRupees = rupees(aiTokens);
  const unhealthy = failingActions(plan, knowledge);
  let how = parts.length ? `${parts.join(' · ')} → ≈ ${plural(credits, 'credit')} per run` : 'No sources yet.';
  if (unhealthy.length && nowCredits !== credits) how += ` (≈ ${plural(nowCredits, 'credit')} today while ${downText(unhealthy.map((u) => u.name))} — a failing call answers empty and is not charged)`;
  if (plan.shape) how += `; shaping ≈ ${plural(items, 'item')} × ${TOKENS_PER_ITEM} tokens ≈ ${fmt(aiTokens)} AI tokens ≈ ₹${aiRupees} (at ₹${RUPEES_PER_1K_AI_TOKENS} per 1k tokens, Sonnet)`;
  else if (plan.watch) how += '; no AI shaping on a Watch/Alert';
  else how += '; no AI shaping — rows as fetched';
  how += '. Sheet writes are not Social credits.';
  const out: PlanCost = { credits, aiTokens, items, how, aiRupees, nowCredits };
  if (unhealthy.length) out.unhealthy = unhealthy;
  return out;
}

/** "Search Hashtag Posts is down" / "X and Y are down" — the clause the cost line and the card share. */
export function downText(names: string[]): string {
  const list = names.filter(Boolean);
  if (!list.length) return '';
  const who = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${who} ${list.length === 1 ? 'is' : 'are'} down`;
}

/**
 * The credits part of a cost line: "≈ 19 credits" — or, while a source is down, "≈ 19 credits (≈ 11 while Search
 * Hashtag Posts is down)" (BEA-1375). The web card's `creditsText` mirrors this — keep them in step.
 */
export function creditsText(cost: Pick<PlanCost, 'credits' | 'nowCredits' | 'unhealthy'>): string {
  const base = `≈ ${plural(cost.credits, 'credit')}`;
  const now = Number(cost.nowCredits);
  const down = (cost.unhealthy || []).map((u) => u.name);
  if (!down.length || !Number.isFinite(now) || now === cost.credits) return base;
  return `${base} (≈ ${fmt(now)} while ${downText(down)})`;
}

/**
 * The whole cost line, in the words the plan card uses: "≈ 19 credits (≈ 11 while X is down) · ≈ 65k AI tokens ≈ ₹19
 * per run" or "≈ 5 credits per run · no AI cost". The builder writes it under its reply so the reply and the card can
 * never disagree — the numbers are the server's, never the model's (BEA-1375).
 */
export function costLineText(cost: PlanCost): string {
  const credits = creditsText(cost);
  if (!(cost.aiTokens > 0)) return `${credits} per run · no AI cost`;
  const k = cost.aiTokens >= 1000 ? `${Math.round(cost.aiTokens / 1000)}k` : String(cost.aiTokens);
  return `${credits} · ≈ ${k} AI tokens ≈ ₹${cost.aiRupees} per run`;
}

const oneLineNote = (v: any) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > 160 ? `${t.slice(0, 159)}…` : t; };

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
export function nextCursorOf(data: any, preferredKey?: string | null): { key: string; value: any } | null {
  if (!data || typeof data !== 'object') return null;
  // THE CARD'S OWN FIELD FIRST (BEA-1497).
  //
  // The list below is a guess at what vendors call their cursor, and it will always be incomplete —
  // it did not know Reddit calls it `after`, so a run asking for 100 posts fetched page 1, found no
  // cursor it recognised, and stopped at 19. The answer had `after: "t3_1vwwa3b"` in it the whole
  // time, and the action's own know-how card said "paging: cursor via after" in plain words.
  //
  // When the card names the field, believe the card. The list is only for actions we know nothing
  // about, and every new vendor makes it more wrong.
  const named = String(preferredKey || '').trim();
  if (named) {
    const v = (data as any)[named];
    if (v !== undefined && v !== null && v !== '' && v !== false) return { key: named, value: v };
  }
  for (const k of ['cursor', 'next_cursor', 'nextCursor', 'after', 'next_max_id', 'end_cursor', 'endCursor', 'next_page_token', 'nextPageToken', 'max_cursor', 'next_page_id', 'continuation']) {
    const v = (data as any)[k];
    // A cursor is a SCALAR you hand back in the next request. An object or an array under one of
    // these names is a page of results that happens to share the word — sending it as a cursor
    // would be nonsense (BEA-1574, found by the test for the shape rule below).
    if (v !== undefined && v !== null && v !== '' && v !== false && typeof v !== 'object') return { key: k, value: v };
  }
  /**
   * THEN BY SHAPE, because the list will always be incomplete (BEA-1574).
   *
   * The comment above already says this, and it happened again on the next vendor. His YouTube
   * agent asked for "as many videos as possible", fetched ONE page of 20 and reported *"this
   * endpoint does not page"* — while the very same answer carried `continuationToken`. The list has
   * `continuation`, and `nextPageToken`, and neither matches `continuationToken`.
   *
   * Naming every vendor's spelling is a race nobody wins, so anything that reads like a
   * next-page handle and holds a usable scalar counts. Keys are checked in the answer's own order,
   * after every exact name above, so a vendor that carries two never changes meaning.
   */
  const SHAPE = /^(next[_-]?)?(cursor|continuation|page)([_-]?(token|id|cursor|key))?$|^continuation[_-]?token$|^next[_-]?(token|id|key)$/i;
  for (const k of Object.keys(data as any)) {
    if (!SHAPE.test(k)) continue;
    const v = (data as any)[k];
    // A cursor is a scalar you can hand back. An object or an array is a page of results, not a handle.
    if (v === undefined || v === null || v === '' || v === false || typeof v === 'object') continue;
    return { key: k, value: v };
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
    // One mapping, in one place (BEA-1415): the guessed cursor and the LEARNED one must never
    // disagree about which argument a cursor goes back in.
    return { param: cursorParamFor(c.key), how: 'cursor' };
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
