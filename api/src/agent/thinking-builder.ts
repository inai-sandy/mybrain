import { isServiceToolId } from '../tools/service-provider';
import type { ToolKnowledge } from '../tools/tool-knowledge.service';
import { keywords, matchScore } from '../tools/tool-shortlist';
import {
  AgentPlan, KEEP_AS_FETCHED, MAX_PAGES, MAX_TAKE, PlanBlock, clampPages, clampTake, keepDaysOf, planActionIds, planFromAgent, plainArgs, sourceActionId, thresholdOf,
} from '../social/plan';
import { sourceIdFor } from '../social/tool-args';
import type { SampleView } from './builder-sample.service';

/**
 * The thinking builder's pure parts (BEA-1371, design: `specs/THINKING-BUILDER.md`) — everything
 * the two chat builders (`AgentAreasService.builderChat` / `jobBuilderChat`) share and that can be
 * tested as text:
 *
 *  - the **facts section**: know-how cards (BEA-1368) written out in full — params, fields with
 *    kinds, paging, cost, health, notes — most relevant to the conversation first, under a char
 *    budget. Never one-liners: the questions have to come from these facts, not from the model's
 *    general knowledge.
 *  - the **planning blocks** the model may use, with their cost rules (BEA-1369) — the vocabulary
 *    the plan JSON is written in.
 *  - the **design budget** (turns + tokens per conversation) — over it, the builder is told to
 *    propose the best plan it has instead of asking more.
 *  - the **plan validator**: the model's plan → a canonical `AgentPlan` (through `planFromAgent`
 *    over `planToAgentInput`, so a validated plan and the agent it creates can never disagree —
 *    that IS the round trip), or plain reasons why not, handed back to the model once.
 *  - `planToAgentInput(plan)` — the inverse of `planFromAgent`: the `createAgent` input for a plan.
 *  - the **health note** the reply carries when the plan leans on a source the card says is failing.
 */

// ---- the caps, in one place ----------------------------------------------------------------------

/** How much design one conversation may spend before the builder must propose what it has. */
export const DESIGN_BUDGET = { turns: 12, tokens: 400_000 } as const;
/**
 * The most one reply may be (output tokens). The first live turn was CUT OFF at 4,000 — a plan with
 * its arguments plus a few paragraphs of reply — and a cut-off JSON is a lost turn; an unused ceiling
 * costs nothing. `RULES_TEXT` still asks for a short reply.
 */
export const TURN_MAX_TOKENS = 8_000;
/** How long one design turn may wait — a Sonnet reply over 10k tokens of facts is not 60 s work. */
export const TURN_TIMEOUT_MS = 180_000;
/** Sample rounds per owner message: model asks → sampler → re-prompt, at most this many times. */
export const SAMPLE_LOOPS_PER_MESSAGE = 3;
/** Cards shown to the model — the shortlist cut to the most relevant; the lookup's own cap is 50. */
export const MAX_CARDS = 50;
/** The whole facts section stays under this many characters (≈ 15k tokens); one card under its share. */
export const FACTS_CHAR_BUDGET = 60_000;
export const CARD_CHAR_BUDGET = 1_800;
/** Beyond the cards, the model is shown an INDEX of the other shortlisted actions (id — name), at most this many. */
export const MAX_INDEX_LINES = 150;
/** Score added to an action whose service the owner NAMED ("instagram", "github") — the first live turn
 *  lost Instagram's own "user posts" to Google Sheets actions that matched "sheet" and "link". */
export const NAMED_SERVICE_BOOST = 8;

/** What the conversation remembers about its design spend. Missing = a fresh conversation. */
export type DesignCounter = { turns: number; tokens: number };

export function readDesignCounter(v: any): DesignCounter {
  const turns = Number(v?.design?.turns);
  const tokens = Number(v?.design?.tokens);
  return { turns: Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0, tokens: Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0 };
}

/** ≈ tokens of a text — the usual 4 chars per token; the model's own count is not handed back to us. */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text || '').length / 4);
}

export function overBudget(c: DesignCounter): boolean {
  return c.turns >= DESIGN_BUDGET.turns || c.tokens >= DESIGN_BUDGET.tokens;
}

/** The plain sentence the model is told when the budget is spent. */
export function budgetLine(c: DesignCounter): string {
  if (!overBudget(c)) return `Design budget: turn ${c.turns + 1} of ${DESIGN_BUDGET.turns}, about ${c.tokens.toLocaleString('en-US')} of ${DESIGN_BUDGET.tokens.toLocaleString('en-US')} tokens used.`;
  return `DESIGN BUDGET SPENT (${Math.min(c.turns, DESIGN_BUDGET.turns)} of ${DESIGN_BUDGET.turns} turns · about ${c.tokens.toLocaleString('en-US')} of ${DESIGN_BUDGET.tokens.toLocaleString('en-US')} tokens). Do NOT ask another question and do NOT ask for a sample. Propose the best plan you have from what you know, say which choices you made for the owner and why, and give the "plan" field now.`;
}

// ---- the facts section: cards, in full, most relevant first ----------------------------------------

const fmt = (n: number) => Number(n).toLocaleString('en-US');

/** One know-how card as compact prompt text — every part of the card, in the card's own words. */
export function cardText(card: ToolKnowledge, budget = CARD_CHAR_BUDGET): string {
  const lines: string[] = [];
  const health = card.health || ({} as any);
  const healthWord = !health.known ? 'no verdict' : health.ok ? 'working' : 'FAILING';
  lines.push(`### ${card.actionId} — ${card.name}${card.retired ? ' (retired by the vendor)' : ''}`);
  if (card.description) lines.push(`what: ${oneLine(card.description, 220)}`);
  const params = (card.params || []).slice(0, 14).map((p) => {
    const bits = [p.required ? `${p.name}*` : p.name];
    if (p.type) bits.push(`(${p.type}${p.enum && p.enum.length ? `: ${p.enum.slice(0, 6).join('|')}${p.enum.length > 6 ? '|…' : ''}` : ''})`);
    if (p.description) bits.push(`— ${oneLine(p.description, 70)}`);
    return bits.join(' ');
  });
  lines.push(`params: ${params.length ? params.join(' · ') : 'none'}${(card.params || []).length > 14 ? ` · +${card.params.length - 14} more` : ''}`);
  const fields = (card.fields || []).filter((f) => f.kind !== 'object' && f.kind !== 'list').slice(0, 30);
  const fieldText = fields.map((f) => `${f.path} (${f.kind}${f.seen ? '' : ', spec only'})`).join(', ');
  lines.push(`fields: ${fieldText || card.responseNote || 'not known yet'}${(card.fields || []).length > 30 ? ', …' : ''}`);
  lines.push(`has a date field: ${card.hasDateField ? 'yes' : 'NO'}`);
  const pg = card.paging || ({ how: 'none' } as any);
  const paging = pg.how === 'none' ? 'does not page (one call = one page)' : `${pg.how === 'cursor' ? 'cursor' : 'page number'}${pg.field ? ` via "${pg.field}"` : ''}${pg.pageSize ? ` · ~${pg.pageSize} per page` : ''}${pg.cap ? ` · at most ${pg.cap} pages` : ''}`;
  lines.push(`paging: ${paging}`);
  const c = card.cost || ({ source: 'unknown' } as any);
  const cost = c.free ? 'free (no credits)' : c.credits ? `${fmt(c.credits.typical)} credit${c.credits.typical === 1 ? '' : 's'} per call typical (${fmt(c.credits.min)}–${fmt(c.credits.max)})` : c.note ? oneLine(c.note, 100) : 'unknown — assume 1 credit per call';
  lines.push(`cost: ${cost}${c.credits && c.note ? ` — ${oneLine(c.note, 80)}` : ''}`);
  lines.push(`health: ${healthWord}${health.note ? ` — ${oneLine(health.note, 240)}` : ''}`);
  for (const n of (card.notes || []).slice(0, 8)) lines.push(`note: ${oneLine(n, 240)}`);
  const text = lines.join('\n');
  return text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
}

/**
 * The cards the model reads, most relevant to the conversation first, under the char budget. Ranked
 * by the shortlist's own keyword score (name hits count for three), unhealthy cards not demoted —
 * a broken source the owner asked about is exactly the fact he needs.
 */
export function factsSection(cards: ToolKnowledge[], convo: string, budget = FACTS_CHAR_BUDGET): string {
  if (!cards.length) return '(no connected outside-service actions match this conversation yet — say so if the ask needs one)';
  const words = keywords(convo);
  const ranked = cards
    .map((c, i) => ({ c, i, s: matchScore({ id: c.actionId, name: c.name, description: [c.description, ...(c.notes || [])].join(' ') }, words) + (namedService(c.actionId, words) ? NAMED_SERVICE_BOOST : 0) }))
    .sort((a, b) => b.s - a.s || Number(!!a.c.retired) - Number(!!b.c.retired) || a.i - b.i)
    .map((x) => x.c);
  const out: string[] = [];
  let used = 0;
  let left = 0;
  for (const c of ranked) {
    const t = cardText(c);
    if (used + t.length + 2 > budget) { left++; continue; }
    out.push(t);
    used += t.length + 2;
  }
  if (left) out.push(`(${left} more action${left === 1 ? '' : 's'} left out for space — they are in the index below; sample one to learn its facts)`);
  return out.join('\n\n');
}

/** How many of ONE service's actions may be cards — so Google Sheets' 36 cannot crowd Instagram's 19 out. */
export const CARDS_PER_SERVICE = 20;

/** Did the owner name this action's service? `svc:instagram.x` + the word "instagram" → yes (exact slug only —
 *  "sheet" must not light up every googlesheets action; the Sheet is the plan's output block, not a source). */
export function namedService(id: string, words: string[]): boolean {
  const slug = String(id || '').replace(/^svc:/, '').split('.')[0];
  return !!slug && words.some((w) => w === slug || `${w}s` === slug);
}

/** Rank the shortlisted service ids for a card lookup — keyword score + a boost for a NAMED service, cut to `max`. */
export function rankServiceIds(tools: { id: string; name?: string; description?: string; retired?: boolean }[], convo: string): string[] {
  const words = keywords(convo);
  return (tools || [])
    .filter((t) => isServiceToolId(t.id))
    .map((t, i) => ({ t, i, s: matchScore({ id: t.id, name: t.name || '', description: t.description }, words) + (namedService(t.id, words) ? NAMED_SERVICE_BOOST : 0) }))
    .sort((a, b) => Number(!!a.t.retired) - Number(!!b.t.retired) || b.s - a.s || Number(!!(b.t as any).important) - Number(!!(a.t as any).important) || a.i - b.i)
    .map((x) => x.t.id);
}

export function pickCardIds(tools: { id: string; name?: string; description?: string; retired?: boolean }[], convo: string, max = MAX_CARDS, perService = CARDS_PER_SERVICE): string[] {
  const out: string[] = [];
  const per = new Map<string, number>();
  for (const id of rankServiceIds(tools, convo)) {
    if (out.length >= max) break;
    const slug = id.replace(/^svc:/, '').split('.')[0];
    const n = per.get(slug) || 0;
    if (n >= perService) continue;
    per.set(slug, n + 1);
    out.push(id);
  }
  return out;
}

/**
 * The index of the shortlisted actions that got no card — id and name only — so the model knows they
 * EXIST (it may sample one to learn its facts, or use it in a plan); ranked like the cards.
 */
export function indexSection(tools: { id: string; name?: string; retired?: boolean }[], convo: string, cardIds: string[], max = MAX_INDEX_LINES): string {
  const carded = new Set(cardIds);
  const byId = new Map((tools || []).map((t) => [t.id, t]));
  const rest = rankServiceIds(tools, convo).filter((id) => !carded.has(id));
  if (!rest.length) return '';
  const lines = rest.slice(0, max).map((id) => { const t = byId.get(id); return `- ${id} — ${t?.name || ''}${t?.retired ? ' (retired)' : ''}`; });
  if (rest.length > max) lines.push(`(+${rest.length - max} more)`);
  return lines.join('\n');
}

// ---- the planning blocks --------------------------------------------------------------------------

/** The blocks a plan may use, with their cost rules — the vocabulary of the `plan` JSON. */
export const BLOCKS_TEXT = `PLANNING BLOCKS you may use (each one already runs; the cost rules are how ≈ credits are counted):
- source: ONE outside-service action + its exact arguments + "pages" (1..${MAX_PAGES}, default 1). The runner follows the vendor's cursor/page number, one call per page, de-dupes items on their id, stops early on an empty page. Cost = pages × the card's credits per call. Items ≈ pages × the card's per-page count (12 when unknown). An action whose card says "does not page" costs one call however many pages you ask.
- creators: "find the creators, then their posts" — a finder action once (find: actionId, args, take ≤ ${MAX_TAKE} creators), then a per-creator action once per creator (then: actionId, argsFrom = { <its argument>: <a field on the found creator>, e.g. { "handle": "username" } }, optional fixed extra args, optional keepDays = keep only items newer than N days WHEN the items carry a date, else everything is kept and the run says so). Cost = 1 finder call + take × the per-creator call's credits.
- Use a creators block beside the searches when the ask wants volume ("all", "everything") or a search is failing or thin today: a profile/creator search finds the accounts, their own posts are dated and always answer.
- Several sources may use the SAME action with different arguments — five hashtags = five "source" blocks on search_hashtag, five profile-search queries = five blocks on the same search action (each with its own pages). When the owner names several hashtags, terms or queries, plan one source per term on the action that fits, never a substitute action to get around it. Sources are keyed by their own id, not by the action.
- merge: automatic when there is more than one source — a plain union under a "source" column (no de-dupe by itself).
- shape: the "task" text. Exactly "${KEEP_AS_FETCHED}" = rows as fetched, no AI. Anything else = a Sonnet step reads every item and does what the task says (named columns, a keep rule like "only posts about smart home in India", de-dupe). Cost ≈ items × 300 AI tokens. Never on a watch/alert.
- watch: mode "watch" — the runner remembers last time and reports only what is new/changed (lists by stable id, numbers by movement); first run is the baseline. Use it for "tell me when …". mode "alert" = a watch plus a judged condition ("alertCondition" in plain words and/or "threshold" { field?, dir: above|below, value }) → Telegram + WhatsApp when true.
- output: { kind: "sheet" | "document" (the Documents library), sheetId: null or the owner's own sheet, append: true|false }. append:true = ONE sheet: created on the first run (or the owner's sheetId), then every run appends under its columns and skips rows already there (de-duped on the sheet's key column — id, shortcode, url); append:false = a new sheet per run.
- notify: { whatsapp: true|false } — the link/summary to the owner's WhatsApp when the run finishes. An alert also pushes Telegram.
- schedule: null (only when the owner presses Run) or {"every":"day","at":"HH:MM"} / {"every":"weekday","at":"HH:MM"} / {"every":"week","dow":0-6,"at":"HH:MM"} / {"every":"hour","minute":0}, plus "scheduleText" in plain words.
- The daily Social credit ceiling is checked before every call by the runner — you do not plan for it.`;

/** The `sample` tool, explained. */
export const SAMPLE_TEXT = `LOOK FOR YOURSELF — the "sample" tool: when a real answer settles something better than a question would (does it return dates? how many per page? does it work today?), reply with ONLY {"sample": {"actionId": "<exact id from the facts>", "args": {...}}} and nothing else. The server runs it (reads only, at most 3 samples and 5 credits per conversation, at most ${SAMPLE_LOOPS_PER_MESSAGE} per owner message) and shows you the compact result; then answer. Every sample is shown to the owner as a line in the chat.`;

/** The rules, in plain words — the owner's principles, made instructions. */
export const RULES_TEXT = `RULES:
- Questions come from what THIS ask leaves open AFTER you read the facts above — never a fixed list. Two different asks must get different questions. Ask ONE thing at a time, in plain words, and always say the default you would take if the owner does not care.
- Facts before questions: read the cards; when a sample answers it, sample instead of asking.
- A first message is almost never complete. Before you propose a plan, the owner must have settled the ONE thing that most changes the result — what "all" or "everything" means in volume, which sources, dated-only or undated too, what counts as X, which repos/accounts/terms. Only an ask that is already fully specified gets a plan on the first turn. When a plan is ready, say so and STOP asking.
- When a fact would silently change what the owner gets — a source whose items carry NO date for a "last N days" ask, a filter that does not exist, a search that is empty today — do not decide it quietly: say it, and ask or state your choice with the default.
- Never invent a field, a filter, an argument or an action the cards do not list. If the cards say something cannot be done (no location filter, no dates), say so plainly and offer the nearest real thing.
- If a card's health says FAILING or "answered not_found for every call", you MUST say so in your reply, and say how the plan copes (keep it so it fills in when the vendor repairs it, and add another source — for example a creators block — for volume today).
- When the owner says keep adding / add to the list / accumulate / grow the list / build up over time (or any wording that means one list that grows run after run), the output MUST be append:true on ONE sheet — never a new sheet per run. New profiles/posts land under the same columns; rows already in the sheet are skipped — so when the task names columns, keep an id, shortcode, link or username column, or nothing can be told apart from what is already there.
- Plan the flow yourself from the blocks — do not ask the owner to design it.
- Before the owner presses Create, your reply shows the plan in words: what it fetches (sources × pages, creators), what it keeps, columns, where it goes, when it runs, who is told, and ≈ credits + ≈ AI tokens per run (the server recomputes the cost from the cards; state your arithmetic).
- Never say the agent was created — the owner presses Create. Plain, everyday English. Short sentences. Keep "reply" under 200 words — detail belongs in the plan JSON, not in prose.`;

/** The `plan` JSON the model writes — the shape it is asked for. */
export const PLAN_SHAPE_TEXT = `"plan": null while something important is still open, else the COMPLETE plan:
 {
  "name": "<short job name in the owner's words>",
  "sources": [
    {"kind":"source","actionId":"<exact svc: id>","args":{<exact arguments>},"pages":1..${MAX_PAGES}},
    {"kind":"creators","find":{"actionId":"<svc id>","args":{...},"take":N},"then":{"actionId":"<svc id>","argsFrom":{"<arg>":"<creator field>"},"args":{},"keepDays":30}}
  ],
  "task": "<exactly '${KEEP_AS_FETCHED}' or what to keep and which columns, in plain words>",
  "mode": "run|watch|alert", "alertCondition": "<plain words, alert only>", "threshold": {"field":"<number field>","dir":"above|below","value":N},
  "output": {"kind":"sheet|document","sheetId":null,"append":true|false},
  "notify": {"whatsapp":true|false},
  "schedule": null or {...}, "scheduleText": "<plain sentence or null>"
 },
 "cost": {"credits": N, "aiTokens": N}   (your own arithmetic; the server checks it)`;

// ---- parsing what the model said -----------------------------------------------------------------

/** The first JSON object in a reply — the model is asked for only JSON, but fences and prose happen. */
export function parseBuilderJson(text: string | null | undefined): any | null {
  const s = String(text || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  // A cut-off reply: from the first brace to the end, closing what is open — so a long plan is not
  // lost to one missing brace (a string cut mid-way still fails, and that is right).
  const start = s.indexOf('{');
  if (start < 0) return null;
  let t = s.slice(start).replace(/,\s*$/, '');
  for (let i = 0; i < 6; i++) {
    t += t.match(/\[[^\]]*$/) ? ']' : '}';
    try { return JSON.parse(t); } catch { /* keep closing */ }
  }
  // Cut inside a string: at least the reply survives, so the owner reads words, not "I couldn't work that out".
  const r = s.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (r && r[1]) { try { return { reply: JSON.parse(`"${r[1]}"`), cutOff: true }; } catch { return { reply: r[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'), cutOff: true }; } }
  return null;
}

/** A sample request in the model's reply, or null. */
export function sampleRequestOf(g: any): { actionId: string; args: Record<string, any> } | null {
  const s = g?.sample;
  if (!s || typeof s !== 'object' || !s.actionId) return null;
  return { actionId: String(s.actionId).trim(), args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {} };
}

/** The compact sample view, as the model reads it back. */
export function sampleViewText(v: SampleView): string {
  const bits: string[] = [];
  bits.push(`SAMPLE RESULT for ${v.actionId} (${v.name})${Object.keys(v.args || {}).length ? ` args ${JSON.stringify(v.args).slice(0, 300)}` : ''}:`);
  if (v.refused) bits.push(`refused — ${v.error || 'not allowed'}`);
  else if (!v.ok) bits.push(`failed — ${v.error || 'the call failed'}${v.notFound ? ' (the vendor answered not_found)' : ''} · ${v.credits} credits`);
  else {
    bits.push(`${v.count} item${v.count === 1 ? '' : 's'}${v.listKey ? ` under "${v.listKey}"` : ''} · ${v.credits} credit${v.credits === 1 ? '' : 's'} · ${v.ms} ms`);
    bits.push(`fields: ${v.fields.map((f) => `${f.path} (${f.kind})`).join(', ') || 'none'}`);
    bits.push(`has a date field: ${v.hasDate ? 'yes' : 'NO'}`);
    if (v.items.length) bits.push(`first items: ${JSON.stringify(v.items).slice(0, 2_400)}`);
  }
  bits.push(`sample budget: ${v.budget.used} of ${v.budget.calls} calls · ${v.budget.credits} of ${v.budget.maxCredits} credits used`);
  return bits.join('\n');
}

// ---- the plan: validate, and turn into an agent ---------------------------------------------------

export type PlanCheck = { plan?: AgentPlan; errors: string[] };

/**
 * The model's plan → a canonical `AgentPlan`, or the plain reasons it is not one (handed back to the
 * model once). `allowedIds` = the action ids the model was shown; an id outside them is "invented".
 * Canonical means: built by `planFromAgent(planToAgentInput(...))` — the same reader the runner and
 * the flow picture use — so what the builder shows IS what Create makes.
 */
export function validatePlan(raw: any, allowedIds?: Set<string> | string[]): PlanCheck {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { errors: ['plan must be an object'] };
  const allowed = allowedIds ? new Set(Array.isArray(allowedIds) ? allowedIds : [...allowedIds]) : null;
  const name = String(raw.name || '').trim();
  if (!name) errors.push('plan.name is missing');
  const sources: any[] = Array.isArray(raw.sources) ? raw.sources : [];
  if (!sources.length) errors.push('plan.sources must have at least one source');
  const checkId = (id: any, where: string): string | null => {
    const s = String(id || '').trim();
    if (!isServiceToolId(s)) { errors.push(`${where}: "${s || '(empty)'}" is not an outside-service action id (svc:<service>.<action>)`); return null; }
    if (allowed && allowed.size && !allowed.has(s)) { errors.push(`${where}: "${s}" is not one of the actions you were shown — use only ids from the facts`); return null; }
    return s;
  };
  const objOr = (v: any, where: string): Record<string, any> => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${where} must be an object`); return {}; }
    return v;
  };
  // Sources are keyed by SOURCE id (BEA-1374): the action id for the first source on an action, then
  // `#2`, `#3`… — so five hashtags on one action are five sources, each with its own id.
  const taken: string[] = [];
  const idFor = (actionId: string) => { const id = sourceIdFor(actionId, taken); taken.push(id); return id; };
  const blocks: PlanBlock[] = [];
  sources.forEach((s, i) => {
    const where = `sources[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${where} must be an object`); return; }
    if (s.kind === 'creators') {
      const findId = checkId(s.find?.actionId, `${where}.find.actionId`);
      const thenId = checkId(s.then?.actionId, `${where}.then.actionId`);
      const argsFrom = objOr(s.then?.argsFrom, `${where}.then.argsFrom`);
      const from: Record<string, string> = {};
      for (const [k, v] of Object.entries(argsFrom)) if (typeof v === 'string' && v.trim()) from[k] = v.trim();
      if (!Object.keys(from).length) errors.push(`${where}.then.argsFrom must map one argument to a creator field, e.g. {"handle":"username"}`);
      if (!findId || !thenId) return;
      const block: any = { kind: 'creators', id: idFor(findId), find: { actionId: findId, args: plainArgs(objOr(s.find?.args, `${where}.find.args`)), take: clampTake(s.find?.take) }, then: { actionId: thenId, argsFrom: from } };
      const extra = plainArgs(objOr(s.then?.args, `${where}.then.args`));
      if (Object.keys(extra).length) block.then.args = extra;
      const days = keepDaysOf(s.then?.keepDays);
      if (days !== undefined) block.then.keepDays = days;
      blocks.push(block);
      return;
    }
    if (s.kind !== undefined && s.kind !== 'source') errors.push(`${where}.kind must be "source" or "creators"`);
    const id = checkId(s.actionId, `${where}.actionId`);
    if (!id) return;
    blocks.push({ kind: 'source', id: idFor(id), actionId: id, args: plainArgs(objOr(s.args, `${where}.args`)), pages: clampPages(s.pages) });
  });
  const mode = raw.mode === 'watch' ? 'watch' : raw.mode === 'alert' ? 'alert' : raw.mode === undefined || raw.mode === null || raw.mode === 'run' ? 'run' : null;
  if (!mode) errors.push('plan.mode must be run, watch or alert');
  const outKind = raw.output?.kind ?? raw.output;
  const dest = outKind === 'sheet' || outKind === 'document' ? outKind : outKind === undefined || outKind === null ? 'document' : null;
  if (!dest) errors.push('plan.output.kind must be sheet or document');
  if (raw.schedule !== undefined && raw.schedule !== null && !scheduleOk(raw.schedule)) errors.push('plan.schedule must be null or one of {"every":"day"|"weekday","at":"HH:MM"} / {"every":"week","dow":0-6,"at":"HH:MM"} / {"every":"hour","minute":0-59}');
  if (errors.length) return { errors };

  const draft: AgentPlan = {
    name: name.slice(0, 120),
    sources: blocks,
    merge: blocks.length > 1,
    // append (BEA-1374): the owner's sheet, or "keep adding" to one sheet the first run creates.
    output: { kind: dest as any, sheetId: raw.output?.sheetId ? String(raw.output.sheetId) : null, append: dest === 'sheet' && (!!raw.output?.sheetId || !!raw.output?.append) },
    notify: { whatsapp: !!(raw.notify?.whatsapp ?? raw.notifyWhatsApp), telegram: mode === 'alert' },
    schedule: raw.schedule ? { schedule: raw.schedule, text: String(raw.scheduleText || raw.schedule?.text || '') } : null,
    ceilingNote: '',
    prompt: String(raw.task ?? raw.prompt ?? '').trim() || KEEP_AS_FETCHED,
    mode: mode as any,
  };
  if (mode !== 'run') {
    draft.watch = { mode: mode as any };
    const th = thresholdOf(raw.threshold);
    if (th) draft.watch.threshold = th;
    const cond = String(raw.alertCondition || raw.condition || '').trim();
    if (cond) draft.watch.condition = cond;
  }
  // Canonical: through the same reader the runner and the picture use.
  return { plan: planFromAgent(planToAgentInput(draft)), errors: [] };
}

export type PlanAgentInput = {
  name: string; prompt: string; tools: string[]; toolArgs: Record<string, any>; mode: 'run' | 'watch' | 'alert';
  outputDest: 'sheet' | 'document'; sheetId: string | null; sheetAppend: boolean; notifyWhatsApp: boolean;
  schedule?: any; scheduleText?: string; alertCondition?: string | null; threshold?: any; category?: string; origin: 'social';
};

/**
 * `planFromAgent`'s inverse — the `createAgent` input a plan becomes. `isSocial(id)` says whether an
 * action comes from the social provider (category "Social" when every source does); unknown → no category.
 */
export function planToAgentInput(plan: AgentPlan, isSocial?: (id: string) => boolean): PlanAgentInput {
  const tools: string[] = [];
  // The new storage shape (BEA-1374): keyed by SOURCE id, each entry naming its action.
  const toolArgs: Record<string, any> = {};
  for (const s of plan.sources) {
    const actionId = sourceActionId(s);
    if (!tools.includes(actionId)) tools.push(actionId);
    if (s.kind === 'source') toolArgs[s.id] = { actionId: s.actionId, args: { ...plainArgs(s.args) }, ...(s.pages > 1 ? { _pages: s.pages } : {}) };
    else {
      const then: any = { actionId: s.then.actionId, argsFrom: { ...s.then.argsFrom } };
      if (s.then.args && Object.keys(s.then.args).length) then.args = { ...s.then.args };
      if (s.then.keepDays !== undefined) then.keepDays = s.then.keepDays;
      toolArgs[s.id] = { kind: 'creators', find: { actionId: s.find.actionId, args: { ...plainArgs(s.find.args) }, take: s.find.take }, then };
    }
  }
  const out: PlanAgentInput = {
    name: plan.name,
    prompt: plan.prompt || KEEP_AS_FETCHED,
    tools,
    toolArgs,
    mode: plan.mode,
    outputDest: plan.output.kind,
    sheetId: plan.output.kind === 'sheet' && plan.output.sheetId ? plan.output.sheetId : null,
    sheetAppend: plan.output.kind === 'sheet' && !!plan.output.append && !plan.output.sheetId,
    notifyWhatsApp: !!plan.notify.whatsapp,
    origin: 'social',
  };
  if (plan.schedule?.schedule) { out.schedule = plan.schedule.schedule; out.scheduleText = plan.schedule.text || undefined; }
  if (plan.watch?.condition) out.alertCondition = plan.watch.condition;
  if (plan.watch?.threshold) out.threshold = plan.watch.threshold;
  const ids = planActionIds(plan);
  if (isSocial && ids.length && ids.every((id) => isSocial(id))) out.category = 'Social';
  return out;
}

/** The four schedule shapes the scheduler fires — anything else would be stored and never run. */
export function scheduleOk(sch: any): boolean {
  if (!sch || typeof sch !== 'object' || Array.isArray(sch)) return false;
  const hhmm = (v: any) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (sch.every === 'day' || sch.every === 'weekday') return hhmm(sch.at);
  if (sch.every === 'week') { const d = Number(sch.dow); return hhmm(sch.at) && Number.isInteger(d) && d >= 0 && d <= 6; }
  if (sch.every === 'hour') { const m = sch.minute === undefined ? 0 : Number(sch.minute); return Number.isInteger(m) && m >= 0 && m <= 59; }
  return false;
}

// ---- honesty: an unhealthy source is said ---------------------------------------------------------

/** Words a reply uses when it already talks about a source's health — then no second note is added. */
const HEALTH_WORDS = /\b(down|failing|failed|fails|not answering|not_found|no posts found|outage|repair|broken|unhealthy|health|empty answers|working again|back up|out right now)\b/i;

/**
 * The plan's sources whose card says FAILING (health known and not ok). Returns the plain note the reply
 * must carry, or '' when nothing is failing or the reply already says so.
 */
export function healthNote(plan: AgentPlan | null | undefined, cards: Record<string, ToolKnowledge | undefined>, reply: string): string {
  if (!plan) return '';
  const bad = planActionIds(plan).map((id) => cards[id]).filter((c) => c && c.health && c.health.known && c.health.ok === false) as ToolKnowledge[];
  if (!bad.length) return '';
  if (HEALTH_WORDS.test(String(reply || ''))) return '';
  const parts = bad.map((c) => `${c.name} is failing at the vendor right now (${oneLine(c.health.note || c.health.lastError || 'every recent call failed', 160)})`);
  return `Note: ${parts.join('; ')}. The plan keeps ${bad.length === 1 ? 'it' : 'them'} so ${bad.length === 1 ? 'it fills' : 'they fill'} in when the vendor repairs it — until then the other sources carry the run.`;
}

// ---- small helpers --------------------------------------------------------------------------------

/** Fill `{{key}}` slots; a slot the template does not have is appended as its own section, so an owner's
 *  older Settings override of the prompt still gets the facts, the blocks and the rules. */
export function fillTemplate(tpl: string, vars: Record<string, { text: string; label: string }>): string {
  let out = String(tpl || '');
  const missing: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    const slot = `{{${k}}}`;
    if (out.includes(slot)) out = out.split(slot).join(v.text);
    else if (v.text) missing.push(`${v.label}:\n${v.text}`);
  }
  return missing.length ? `${out}\n\n${missing.join('\n\n')}` : out;
}

export function oneLine(s: any, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
