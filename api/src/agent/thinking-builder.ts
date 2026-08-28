import { isServiceToolId } from '../tools/service-provider';
import type { ToolKnowledge } from '../tools/tool-knowledge.service';
import { keywords, matchScore } from '../tools/tool-shortlist';
import {
  AgentPlan, KEEP_AS_FETCHED, MAX_PAGES, MAX_TAKE, PlanBlock, PlanCost, clampPages, clampTake, costLineText, failingActions, keepDaysOf, planActionIds, planFromAgent, planHasHealthySource, plainArgs, sourceActionId, thresholdOf,
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
/** Model calls per owner message, all in: the first answer + the sample rounds + one fix round each for an
 *  invalid plan, a plan with no healthy source, an unsampled finder (BEA-1375), and an expensive plan with
 *  no goal established (BEA-1378). Over it, what we have is shown. */
export const MAX_ASKS_PER_MESSAGE = SAMPLE_LOOPS_PER_MESSAGE + 5;
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
  // Twelve, not eight (BEA-1476). A card with a lot of learned lessons was silently losing its
  // hand-written traps off the end — and the one it lost was the one that explained a failure two
  // builds in a row died on.
  for (const n of (card.notes || []).slice(0, 12)) lines.push(`note: ${oneLine(n, 240)}`);
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
- Before planning ANYTHING, understand what the result is FOR: what will the owner do with it, and what does a good result let them do next? If the ask does not say, ask that FIRST — ONE plain question with an example answer ("What will you use this for? For example: to learn how these accounts get reach, or to build a list to contact"). Never plan on the literal words alone while the purpose is unknown. And never re-ask a goal already stated — when the first message or an earlier turn says what it is for, use it; the interview is for what is missing, never a form.
- The goal decides the SHAPE of the result: the unit (posts vs profiles vs companies vs a written report vs a watch/alert), the columns and the cadence come from the GOAL, not from the literal noun in the ask — and you choose sources for that shape. "All the smart home profiles" with the goal "understand how they post to get reach" needs POSTS (with play counts, which ones outperform), not a profile list.
- When the literal ask and the goal point at DIFFERENT shapes, say so before planning and propose the goal's shape ("you asked for profiles, but for 'how do they get reach' the thing to study is their posts and which ones outperform — shall I plan that instead?"). The owner may still insist on the literal ask — then build exactly that.
- Whenever the owner has said what the result is for, repeat it in the "goal" JSON field (their words, short) in EVERY answer — it is remembered and shown on the plan.
- Questions come from what THIS ask leaves open AFTER you read the facts above — never a fixed list. Two different asks must get different questions. Ask ONE thing at a time, in plain words, and always say the default you would take if the owner does not care.
- Facts before questions: read the cards; when a sample answers it, sample instead of asking. A card whose health says FAILING today IS the answer — do not spend a sample checking it again (the first live run did, three times, and had none left for the finder). Samples are for what the cards leave open — are a finder's accounts real? do the items carry dates? — and you have only 3 per conversation, so keep one for the finder of any creators block you may plan.
- A first message is almost never complete. Before you propose a plan, the owner must have settled the ONE thing that most changes the result — what "all" or "everything" means in volume, which sources, dated-only or undated too, what counts as X, which repos/accounts/terms. Only an ask that is already fully specified gets a plan on the first turn. When a plan is ready, say so and STOP asking.
- When a fact would silently change what the owner gets — a source whose items carry NO date for a "last N days" ask, a filter that does not exist, a search that is empty today — do not decide it quietly: say it, and ask or state your choice with the default.
- Never invent a field, a filter, an argument or an action the cards do not list. If the cards say something cannot be done (no location filter, no dates), say so plainly and offer the nearest real thing.
- If a card's health says FAILING or "answered not_found for every call", you MUST say so in your reply, and say how the plan copes (keep it so it fills in when the vendor repairs it, and add another source — for example a creators block — for volume today).
- A plan needs at least one HEALTHY source — one that can produce rows TODAY (its card says working or has no verdict). If every source you want is failing, say so plainly and put a working fallback in the plan (a creators block on a working finder, a working search) BEFORE you show any plan; a plan of only failing sources is not shown to the owner — an empty sheet today is not a plan.
- Before a creators-first block, SAMPLE the finder once (or use the sample the owner already made) and judge the accounts real from what came back — followers, posts, names that fit the topic. Look-alike handles with 0–20 followers and no recent posts are not creators. If they do not look real, try another finder (Popular Search owners, Instagram's own user search) and say what you tried and what you saw.
- "When it runs" and "where the rows go" are OPEN until the owner has said them, or has accepted your default in so many words. Settle both before the plan — ask ONE plain question with the default ("Run it once now, or on a schedule — every Monday 8am, say? And a new Google Sheet each run, or one sheet kept adding to?"). Never write "runs once now" or "a new sheet" into a plan as if it were agreed.
- Cost numbers are the SERVER's, never yours: after you answer, it counts ≈ credits and ≈ AI tokens from the cards — today's figure too, while a source is down — and writes the cost line under your reply and on the plan card. Do not put your own ≈ credit or ≈ token figures in the reply; when a "server cost" for your last plan is given below, quote THAT when you must repeat a number.
- When the owner says keep adding / add to the list / accumulate / grow the list / build up over time (or any wording that means one list that grows run after run), the output MUST be append:true on ONE sheet — never a new sheet per run. New profiles/posts land under the same columns; rows already in the sheet are skipped — so when the task names columns, keep an id, shortcode, link or username column, or nothing can be told apart from what is already there.
- Some asks are a ONE-OFF ACTION, not an agent: create a WhatsApp template, send one message, make one sheet, file one issue. You design things that RUN AGAIN — on a schedule, or when something happens — and you cannot run a one-off write from this chat, because a sample only ever reads. So say it plainly in one line ("creating the template is a one-off, not something to schedule"), say where it IS done (Chat runs these same tools and asks you to confirm anything that cannot be undone, or the Tools page), offer to write out exactly what you would create so it can be pasted, and offer the agent version if the thing should happen every time. Never shrug at a one-off, and never say a tool does not exist when the facts above list it — say what you can and cannot do with it from here.
- CHOOSE THE TOOLS YOURSELF. Never ask the owner which connected tool, service or action to use — he does not know the ids, and every action you are shown is already connected and usable. The facts above give you names, arguments and a health verdict; where two could do the job, take the one that has actually worked (the cards say so) and name your choice in the reply in plain words ("searching Reddit, writing a new Google Sheet, messaging you on WhatsApp"). Ask about the JOB — what counts, how much, when, where it goes — never about the plumbing. If truly nothing connected can do a part of it, say that plainly instead of asking him to pick.
- Plan the flow yourself from the blocks — do not ask the owner to design it.
- Before the owner presses Create, your reply shows the plan in words: what it fetches (sources × pages, creators), what it keeps, columns, where it goes, when it runs, who is told (the cost line comes from the server, under your reply — put your arithmetic in the "cost" JSON field only).
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
    // A brace we had to close ourselves means the model stopped mid-way, even when what is left
    // parses — `cutOff` marks it so the turn is CLASSIFIED as cut off and says so in the log,
    // instead of passing for a healthy answer with half a plan in it (BEA-1402).
    try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? { ...v, cutOff: true } : v; } catch { /* keep closing */ }
  }
  // Cut inside a string: at least the reply survives, so the owner reads words, not "I couldn't work that out".
  const r = s.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (r && r[1]) { try { return { reply: JSON.parse(`"${r[1]}"`), cutOff: true }; } catch { return { reply: r[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'), cutOff: true }; } }
  return null;
}

// ---- when a turn cannot be read, SAY WHICH of the four things happened (BEA-1402) ------------------
//
// The incident: the owner asked the builder about WhatsApp templates, a sample ran fine ("25
// templates · 0 credits"), and the turn answered "I couldn't work that out — try saying it another
// way." Twice. The usage log shows why — both failing turns came back with EXACTLY 8,000 completion
// tokens (`TURN_MAX_TOKENS`), while the turns either side used 726 and 4,352. The model ran past its
// output ceiling, the answer stopped mid-way, `parseBuilderJson` could salvage nothing, and every
// road out of that fell into one shrug that named nothing. Four different things can go wrong with
// one model answer, and the owner is owed the right one.

/**
 * What went wrong with ONE model answer:
 *  - `none`       a usable answer.
 *  - `no-answer`  the AI service gave nothing back (an error, a timeout, an empty body).
 *  - `cut-off`    it started answering and stopped mid-way — the output ceiling.
 *  - `unreadable` text came back, but not in the shape we asked for.
 */
export type TurnTrouble = 'none' | 'no-answer' | 'cut-off' | 'unreadable';

/** One model answer, read: what we could parse, what went wrong, and its plain words if it wrote any. */
export type TurnRead = { g: any | null; trouble: TurnTrouble; prose: string };

/** How much of a shape-less answer may be shown to the owner as the reply. */
export const PROSE_REPLY_CHARS = 1_200;
/** Shorter than this is not an answer worth showing — the owner gets the honest sentence instead. */
export const PROSE_REPLY_MIN = 40;

/** The answer, classified — the one place a turn decides what it is looking at. */
export function readTurn(text: string | null | undefined): TurnRead {
  const s = String(text ?? '');
  if (!s.trim()) return { g: null, trouble: 'no-answer', prose: '' };
  const g = parseBuilderJson(s);
  const prose = proseOf(s);
  if (!g) return { g: null, trouble: looksCutOff(s) ? 'cut-off' : 'unreadable', prose };
  // `parseBuilderJson` marks the reply it rescued out of a half-written answer.
  if (g.cutOff) return { g, trouble: 'cut-off', prose };
  return { g, trouble: 'none', prose };
}

/**
 * Did this answer stop mid-way? True when a JSON object was opened and never closed — a brace still
 * open at the end, or the text ending inside a string. Prose with no JSON in it is not "cut off",
 * it is the wrong shape, and the owner is told a different thing.
 */
export function looksCutOff(text: string): boolean {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return inString || depth > 0;
}

/** The plain words in an answer that was not the shape we asked for — fences and JSON stripped. */
export function proseOf(text: string): string {
  const s = String(text || '')
    .replace(/```[a-z]*\n?/gi, '')
    // From the brace that OPENS an object on, it was trying to be JSON. Only a brace followed by a
    // quoted key counts, so a template body quoted in prose ("Hello {{1}}") survives (BEA-1402).
    .replace(/\{\s*"[\s\S]*$/, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > PROSE_REPLY_CHARS ? `${s.slice(0, PROSE_REPLY_CHARS - 1)}…` : s;
}

/** The one sentence for a genuinely ambiguous message — and ONLY for that (BEA-1402). */
export const AMBIGUOUS_TEXT = "I couldn't work that out — try saying it another way.";

/** What the owner reads when a turn produced no answer — one true sentence per thing that can happen. */
export const TROUBLE_TEXT: Record<Exclude<TurnTrouble, 'none'>, string> = {
  'no-answer': 'The AI service did not answer just now, so this turn came back empty. Nothing you said is lost — send it again in a moment.',
  'cut-off': "The AI's answer ran past its length limit and stopped mid-way, so I could not read it. Nothing you said is lost — say it again in one short line and I will carry on.",
  unreadable: 'The AI answered in a shape I could not read. Nothing you said is lost — say it again in one short line and I will carry on.',
};

/** What the owner reads when the turn threw — the cause goes to the log, the plain sentence to him. */
export const THINKING_FAILED_TEXT = 'The AI service failed on this turn, so I have no answer for you. Nothing you said is lost — send it again in a moment.';

/** The one re-ask after an answer that could not be read: shorter, in shape, reply first. */
export const SHAPE_RETRY_TEXT = `Your last answer could not be read — it was not the JSON object asked for, or it ran past the length limit and stopped mid-way. Answer again now: ONLY the JSON object, with "reply" as the FIRST field and under 120 words, and leave "plan"/"spec" exactly as they were unless you are proposing a new one. Do not repeat long lists back.`;

/**
 * A half-written or shape-less answer still holds words meant for the owner — better than losing his
 * turn to a canned sentence (BEA-1402). The note says which of the two it was, so he knows whether
 * there is more of it coming.
 */
export function proseFallbackReply(prose: string, trouble: Exclude<TurnTrouble, 'none'> = 'unreadable'): string {
  const note = trouble === 'cut-off'
    ? '(The rest of that answer ran past its length limit and stopped mid-way, so there is no plan card with it — say "carry on" and I will finish it.)'
    : '(That came back outside the shape I expect, so there is no plan card with it — say "carry on" and I will put it back into a plan.)';
  return `${prose}\n\n${note}`;
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
  const bad = unhealthySources(plan, cards);
  if (!bad.length) return '';
  const parts = bad.map((c) => `${c.name} is failing at the vendor right now (${c.note})`);
  // No healthy source at all (BEA-1375): never "the other sources carry the run" — there are none. Said even
  // when the reply already talks about the outage, because the owner has to know why no plan card came.
  if (!planHasHealthySource(plan!, cards as any)) return `Note: ${parts.join('; ')}. Nothing in this plan can produce rows today — every source in it is failing. It needs a working source beside ${bad.length === 1 ? 'it' : 'them'} before it is worth creating, so I have not shown it as a plan yet.`;
  if (HEALTH_WORDS.test(String(reply || ''))) return '';
  return `Note: ${parts.join('; ')}. The plan keeps ${bad.length === 1 ? 'it' : 'them'} so ${bad.length === 1 ? 'it fills' : 'they fill'} in when the vendor repairs it — until then the other sources carry the run.`;
}

/**
 * The plan's sources whose card says FAILING (health known and not ok), one entry per action id, with the
 * card's own note — the plan card marks each such source ("down at the vendor right now — kept so it fills
 * in later"), and `healthNote()` writes the reply's note from the same list (BEA-1372). Since BEA-1375 the
 * same reader (`failingActions` in plan.ts) feeds `estimatePlanCost`, so the card, the cost and the note agree.
 */
export function unhealthySources(plan: AgentPlan | null | undefined, cards: Record<string, ToolKnowledge | undefined>): { actionId: string; name: string; note: string }[] {
  if (!plan) return [];
  return failingActions(plan, cards as any);
}

/** The reason handed back to the model when its plan has no source that can produce rows today (BEA-1375). */
export function noHealthySourceText(plan: AgentPlan, cards: Record<string, ToolKnowledge | undefined>): string {
  const names = unhealthySources(plan, cards).map((c) => c.name).join(', ');
  return `Your "plan" was NOT shown to the owner: every source in it is failing at the vendor today (${names}) — nothing in it can produce rows today. Add a working source beside them (a card whose health says working or has no verdict — for example a creators block on a working finder), or say plainly that nothing can produce rows today and ask the owner how to go on. Send the whole JSON again, or a "sample" if you must look first.`;
}

// ---- the goal interview: an expensive plan waits for what the result is FOR (BEA-1378) --------------

/**
 * The stakes gate's thresholds: a plan at or over EITHER figure is "expensive" — it must not be shown
 * until the owner has said what the result is for. The incident that made this a rule: 202 credits went
 * into a literal profile list when the goal ("understand how they post to get reach") needed posts.
 */
export const GOAL_STAKES = { credits: 50, aiTokens: 100_000 } as const;

/** Is this plan wide/expensive by the SERVER's own estimate? (≥ 50 credits or ≥ 100k AI tokens.) */
export function isExpensivePlan(cost: PlanCost | null | undefined): boolean {
  if (!cost) return false;
  return Number(cost.credits) >= GOAL_STAKES.credits || Number(cost.aiTokens) >= GOAL_STAKES.aiTokens;
}

/** The model's `goal` field — the owner's words, trimmed and capped — or null when it said none. */
export function goalOf(g: any): string | null {
  const s = typeof g?.goal === 'string' ? g.goal.trim() : '';
  return s ? s.slice(0, 300) : null;
}

/** The reason handed back to the model when its expensive plan has no goal established (BEA-1378). */
export function noGoalText(cost: PlanCost): string {
  return `Your "plan" was NOT shown to the owner: it is a big run (${costLineText(cost)}) and the owner has not said what the result is FOR. What they will do with it decides the SHAPE — posts vs profiles vs a report, the columns, the cadence — and a big run in the wrong shape is money into the wrong list. If the conversation already states the goal, put it in the "goal" field (their words) and send the plan again. If it does not, drop the plan and ask ONE plain question about what they will do with the result, with an example answer.`;
}

/**
 * The plain note under a reply whose expensive plan was stripped because no goal is established — the
 * owner must know why no plan card came (the same honesty as the healthy-source note, BEA-1375/1378).
 */
export function goalMissingNote(cost: PlanCost): string {
  return `Note: I have a plan sketched, but it is a big run (${costLineText(cost)}) and I have not shown it yet — I first need to know what the result is FOR, because that decides whether these are even the right rows. Tell me what you will do with it and I will show the plan, or reshape it.`;
}

/**
 * "For: <goal>" onto an agent's description — the smallest honest carrier (BEA-1378). Prefix when there
 * is no description; in front of one otherwise; untouched when the description already carries the goal.
 */
export function withGoal(description: string | null | undefined, goal: string | null | undefined): string | undefined {
  const g = String(goal || '').trim();
  const d = String(description || '').trim();
  if (!g) return d || undefined;
  if (d.toLowerCase().includes(g.toLowerCase())) return d;
  const line = `For: ${g}`;
  return d ? `${line} — ${d}` : line;
}

// ---- a finder is sampled before it is trusted (BEA-1375) --------------------------------------------

/**
 * The action ids this conversation has already looked at: every sample line the sampler wrote (it carries
 * `actionId` since BEA-1375; an older line without one is skipped — at worst one extra nudge in a very old
 * conversation) and the Social hand-off seed (the owner ran that one by hand). A finder in this set has been
 * seen; a plan on any other finder is sent back once so the model samples it first.
 */
export function sampledActionIds(state: { log?: any[]; seed?: { actionId?: string } | null } | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of state?.log || []) if (m && (m.kind === 'sample' || /^🔎/.test(String(m.text || ''))) && m.actionId) out.add(String(m.actionId));
  if (state?.seed?.actionId) out.add(String(state.seed.actionId));
  return out;
}

/** The creators blocks' finders the conversation has NOT sampled yet — ids, de-duped. */
export function unsampledFinders(plan: AgentPlan | null | undefined, sampled: Set<string>): string[] {
  if (!plan) return [];
  return [...new Set(plan.sources.filter((s) => s.kind === 'creators').map((s: any) => String(s.find?.actionId || '')).filter((id) => id && !sampled.has(id)))];
}

/** The nudge the model reads when it planned a creators block on a finder it never looked at. */
export function sampleFinderText(ids: string[]): string {
  return `Your "plan" was NOT shown to the owner yet: it plans a creators block on ${ids.join(', ')}, and you have not sampled that finder in this conversation. Rule: before a creators-first block, sample the finder once with the arguments you would use (reply with ONLY {"sample": {...}}) and judge the accounts real from what comes back — followers, posts, names that fit the topic. If they look real, send the plan again; if not, try another finder (Popular Search owners, Instagram's own user search) and say what you tried.`;
}

/**
 * The plain note under a plan whose creators finder was never sampled and cannot be now (the sample budget is
 * spent) — the owner must know the builder has not seen those accounts itself (BEA-1375).
 */
export function unsampledFinderNote(ids: string[], cards: Record<string, ToolKnowledge | undefined>): string {
  if (!ids.length) return '';
  const names = ids.map((id) => cards[id]?.name || shortId(id));
  return `Note: I have not looked at ${names.join(' or ')} myself in this conversation (my sample budget is used up), so I have not seen whether the accounts it finds are real — judge the first run's rows before trusting it.`;
}

/**
 * The line the builder writes under its reply when it shows a plan — the server's own cost figures, both of
 * them while a source is down: "Cost: ≈ 19 credits (≈ 11 while Search Hashtag Posts is down) · ≈ 65k AI tokens
 * ≈ ₹19 per run." The reply and the card can never disagree again (BEA-1375).
 */
export function costReplyLine(cost: PlanCost | null | undefined): string {
  return cost ? `Cost: ${costLineText(cost)}.` : '';
}

// ---- the Social hand-off: "Make it an agent" seeds the builder with the call just made (BEA-1372) ------

/** What a Social result hands the builder: the action, the exact arguments, a label, and a compact view of the answer. */
export type BuilderSeed = {
  actionId: string;
  args: Record<string, any>;
  /** "Instagram · Search Hashtag Posts" — the platform + action names as the Social page shows them. */
  label?: string;
  sample?: { count?: number; listKey?: string; credits?: number; notFound?: boolean; fields?: string[] };
};

/** `{ hashtag: 'smarthomeindia', date_posted: 'last-month' }` → "hashtag: smarthomeindia, date_posted: last-month" (≤ 6, `_`-keys out). */
export function seedArgsText(args: Record<string, any>): string {
  return Object.entries(args || {})
    .filter(([k, v]) => !String(k).startsWith('_') && v !== undefined && v !== null && v !== '')
    .slice(0, 6)
    .map(([k, v]) => { const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })(); return `${k}: ${s.length > 40 ? `${s.slice(0, 39)}…` : s}`; })
    .join(', ');
}

/** The builder's FIRST line after a Social hand-off — scripted, no model call, so it costs nothing and reads the same every time. */
export function seedLine(seed: BuilderSeed): string {
  const name = seed.label || shortId(seed.actionId);
  const args = seedArgsText(seed.args);
  const head = `You just ran ${name}${args ? ` (${args})` : ''}`;
  const s = seed.sample || {};
  const credits = s.credits === undefined ? '' : ` for ${s.credits === 1 ? '1 credit' : `${s.credits} credits`}`;
  let got: string;
  if (s.notFound) got = `and it found nothing today (0 credits) — an agent on a schedule keeps asking and writes the rows the day they appear.`;
  else if (typeof s.count === 'number') got = `and got ${s.count === 0 ? 'nothing back' : `${s.count} ${s.count === 1 ? (s.listKey ? singular(s.listKey) : 'record') : s.listKey ? s.listKey.split('.').pop() : 'items'}`}${credits}.`;
  else got = `and got an answer${credits}.`;
  return `${head} ${got} Is this the kind of thing you want, and how much of it? Tell me what the agent should do with it — how often, and where the rows should go — and I'll plan it from there.`;
}

/** The section the model reads about the hand-off — the exact id and arguments, so the plan starts from THAT call. */
export function seedText(seed: BuilderSeed | null | undefined): string {
  if (!seed?.actionId) return '';
  const s = seed.sample || {};
  const fields = Array.isArray(s.fields) && s.fields.length ? ` · fields: ${s.fields.slice(0, 8).join(', ')}` : '';
  const answer = s.notFound ? 'the vendor answered not_found (nothing today, 0 credits)' : typeof s.count === 'number' ? `${s.count} ${s.listKey ? s.listKey.split('.').pop() : 'items'}${fields}${s.credits !== undefined ? ` · ${s.credits} credit${s.credits === 1 ? '' : 's'}` : ''}` : 'an answer';
  return `The owner came here from the Social page, where they ran ${seed.actionId}${seed.label ? ` (${seed.label})` : ''} by hand with arguments ${JSON.stringify(seed.args || {})} and got ${answer}. Start from that action and those exact arguments — you already know it works — and design around it: ask what they want to do with it (how often, how much, where it goes), add sources or pages only when the ask needs them.`;
}

const singular = (listKey: string) => { const w = listKey.split('.').pop() || 'item'; return w.endsWith('s') ? w.slice(0, -1) : w; };
const shortId = (id: string) => String(id || '').replace(/^svc:/, '').replace('.', ' · ').replace(/_/g, ' ');

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
