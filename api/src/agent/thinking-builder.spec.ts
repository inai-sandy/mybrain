import { AgentAreasService } from './agent-areas.service';
import { CEILING_NOTE, KEEP_AS_FETCHED, estimatePlanCost, planFromAgent } from '../social/plan';
import type { ToolKnowledge } from '../tools/tool-knowledge.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService } from '../llm/llm.service';
import {
  BLOCKS_TEXT, DESIGN_BUDGET, GOAL_STAKES, MAX_ASKS_PER_MESSAGE, PLAN_SHAPE_TEXT, RULES_TEXT, SAMPLE_LOOPS_PER_MESSAGE, budgetLine, cardText, costReplyLine, factsSection, fillTemplate, goalOf, healthNote, indexSection, isExpensivePlan, namedService, noHealthySourceText, overBudget, parseBuilderJson, pickCardIds, planToAgentInput,
  sampleFinderText, sampleViewText, sampledActionIds, unsampledFinderNote, unsampledFinders, validatePlan, seedLine, seedText, unhealthySources, withGoal,
} from './thinking-builder';
import { costLineText, creditsText, planHasHealthySource } from '../social/plan';

/**
 * BEA-1371 — the thinking builder. What these lock:
 *  (a) two different requirements → different FACTS in the prompt, and (with recorded model answers)
 *      different questions back — no fixed interview;
 *  (b) the sample loop: model asks `sample` → the sampler runs → its compact view is fed back →
 *      the final reply; capped at 3 rounds per owner message;
 *  (c) the plan validates, and `builderCreate` yields Agent fields `planFromAgent` reads back
 *      identically (the round trip);
 *  (d) the design budget spent → the best plan so far, not another question;
 *  (f) a plan on an unhealthy source says so, even when the model forgot.
 * (e) — no bare `complete()` — is `llm/agent-calls-follow-a-named-model.spec.ts`.
 */

// ---- fixtures: three know-how cards, as BEA-1368 builds them -------------------------------------

const card = (over: Partial<ToolKnowledge> & { actionId: string; name: string }): ToolKnowledge => ({
  service: over.actionId.split(':')[1].split('.')[0],
  provider: 'social',
  params: [],
  fields: [],
  hasDateField: false,
  paging: { how: 'none', source: 'none' },
  cost: { source: 'unknown' },
  health: { ok: true, known: false, successesLast24h: 0, failuresLast24h: 0, emptyLast24h: 0, callsLast30d: 0 },
  notes: [],
  updatedAt: '2026-08-18T00:00:00.000Z',
  ...over,
});

const HASHTAG = card({
  actionId: 'svc:instagram.search_hashtag', name: 'Instagram · Hashtag Search',
  description: 'Posts for a hashtag, from the Google index',
  params: [{ name: 'hashtag', required: true, type: 'string' }, { name: 'cursor', required: false, type: 'string' }],
  fields: [{ path: 'posts[].id', kind: 'id', seen: true }, { path: 'posts[].caption', kind: 'text', seen: true }, { path: 'posts[].taken_at', kind: 'date', seen: true }, { path: 'posts[].like_count', kind: 'number', seen: true }],
  hasDateField: true,
  paging: { how: 'cursor', field: 'cursor', cap: 11, source: 'notes' },
  cost: { credits: { typical: 1, min: 1, max: 1 }, source: 'observed' },
  health: { ok: false, known: true, successesLast24h: 0, failuresLast24h: 14, emptyLast24h: 14, callsLast30d: 40, note: 'Answered not_found (empty answers) for every call since 09:10Z — 14 calls, nothing found. On a search this can be the vendor\'s index being out, not your query.' },
  notes: ['Instagram has no location or country filter on any endpoint. "In India" has to come from India hashtags, India creators and reading captions — recall over precision.', 'Posts are dated (taken_at).'],
});
const POPULAR = card({
  actionId: 'svc:instagram.search_popular', name: 'Instagram · Popular Search',
  description: 'Popular posts for a query',
  params: [{ name: 'query', required: true, type: 'string' }],
  fields: [{ path: 'posts[].id', kind: 'id', seen: true }, { path: 'posts[].caption', kind: 'text', seen: true }],
  hasDateField: false,
  paging: { how: 'cursor', field: 'cursor', pageSize: 12, source: 'notes' },
  cost: { credits: { typical: 1, min: 1, max: 1 }, source: 'observed' },
  health: { ok: true, known: true, successesLast24h: 5, failuresLast24h: 0, emptyLast24h: 0, callsLast30d: 9, note: 'Working — 5 of 5 calls succeeded in the last 24 h.' },
  notes: ['Popular search: posts carry NO date — not usable for "last 30 days".'],
});
const PROFILES = card({
  actionId: 'svc:instagram.search_profiles', name: 'Instagram · Profile Search',
  params: [{ name: 'query', required: true, type: 'string' }],
  fields: [{ path: 'users[].username', kind: 'text', seen: true }, { path: 'users[].follower_count', kind: 'number', seen: true }],
  cost: { credits: { typical: 1, min: 1, max: 1 }, source: 'observed' },
});
const USER_POSTS = card({
  actionId: 'svc:instagram.user_posts', name: 'Instagram · User Posts',
  params: [{ name: 'handle', required: true, type: 'string' }, { name: 'trim', required: false, type: 'boolean' }],
  fields: [{ path: 'items[].id', kind: 'id', seen: true }, { path: 'items[].taken_at', kind: 'date', seen: true }],
  hasDateField: true,
  paging: { how: 'cursor', field: 'next_max_id', pageSize: 12, source: 'observed' },
  cost: { credits: { typical: 1, min: 1, max: 1 }, source: 'observed' },
});
const RELEASES = card({
  actionId: 'svc:github.list_releases', name: 'GitHub · List releases', provider: 'services',
  description: 'Releases of a repository, newest first',
  params: [{ name: 'owner', required: true, type: 'string' }, { name: 'repo', required: true, type: 'string' }, { name: 'per_page', required: false, type: 'integer' }],
  fields: [{ path: 'data[].id', kind: 'id', seen: false }, { path: 'data[].tag_name', kind: 'text', seen: false }, { path: 'data[].published_at', kind: 'date', seen: false }, { path: 'data[].prerelease', kind: 'bool', seen: false }],
  hasDateField: true,
  paging: { how: 'page', field: 'page', pageSize: 30, source: 'spec' },
  cost: { free: true, note: 'No metered cost — it runs on the connected account.', source: 'provider' },
});
const CARDS: Record<string, ToolKnowledge> = Object.fromEntries([HASHTAG, POPULAR, PROFILES, USER_POSTS, RELEASES].map((c) => [c.actionId, c]));

const SOCIAL_ASK = 'Get me all Instagram posts about smart home in India from the last 30 days into a Google Sheet and WhatsApp me the link every Monday 08:00';
const GITHUB_ASK = 'Tell me when a competitor releases something on GitHub';

// ---- a harness around AgentAreasService with a recorded model ------------------------------------

type Answer = (prompt: string, call: number) => any;

function harness(opts: { answer: Answer; state?: any; cards?: ToolKnowledge[]; sampler?: any }) {
  const settings = new Map<string, string>();
  if (opts.state) settings.set('agent.builder', JSON.stringify(opts.state));
  const created: any[] = [];
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => { settings.set(where.key, update?.value ?? create?.value); return {}; },
    },
    agentArea: { findUnique: async () => ({ id: 'ar1', name: 'A', tools: '[]' }), create: async ({ data }: any) => ({ id: 'ar-new', ...data }) },
    agent: { findMany: async () => [] },
  };
  const agentSvc: any = { createAgent: async (input: any) => { created.push(input); return { id: 'job1', areaId: input.areaId || 'ar-new', name: input.name }; }, updateAgent: async () => ({}) };
  const prompts: string[] = [];
  const llm: any = { completeHelper: jest.fn(async (_key: string, prompt: string) => { prompts.push(prompt); const a = opts.answer(prompt, prompts.length); return typeof a === 'string' ? a : JSON.stringify(a); }) };
  const promptsSvc = { get: async (k: any) => new PromptsService(prisma).get(k) };
  const tools = Object.values(opts.cards || CARDS).map((c) => ({ id: c.actionId, name: c.name, group: c.provider === 'social' ? 'Social' : 'Services', description: c.description || '', connected: true, kind: 'service', service: c.service }));
  const catalog: any = { catalog: async () => ({ groups: [], tools: [...tools, { id: 'web_search', name: 'Web search', group: 'Web', description: 'Search the live web', connected: true, kind: 'tool' }] }) };
  const knowledge: any = { lookup: async (ids: string[]) => ids.map((id) => (opts.cards ? opts.cards.find((c) => c.actionId === id) : CARDS[id])).filter(Boolean) };
  const svc = new AgentAreasService(prisma, agentSvc, llm, promptsSvc as any, catalog, opts.sampler, knowledge);
  return { svc, prompts, llm, created, settings, state: () => JSON.parse(settings.get('agent.builder') || '{}') };
}

const SOCIAL_PLAN = {
  name: 'Smart home India — Instagram digest',
  sources: [
    { kind: 'source', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, pages: 8 },
    { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 20 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, args: { trim: true }, keepDays: 30 } },
  ],
  task: 'Keep only posts about smart home in India from the last 30 days. Columns: creator, date, likes, caption, link.',
  mode: 'run',
  output: { kind: 'sheet', sheetId: null },
  notify: { whatsapp: true },
  schedule: { every: 'week', dow: 1, at: '08:00' },
  scheduleText: 'Every Monday at 08:00',
};

// ---- (a) facts differ, questions differ ----------------------------------------------------------

describe('questions come from the facts, not a script (BEA-1371)', () => {
  it('two different asks → different facts sections (most relevant cards first)', () => {
    const social = factsSection(Object.values(CARDS), SOCIAL_ASK);
    const github = factsSection(Object.values(CARDS), GITHUB_ASK);
    expect(social).not.toEqual(github);
    expect(social.indexOf('svc:instagram.')).toBeLessThan(social.indexOf('svc:github.list_releases'));
    expect(github.indexOf('svc:github.list_releases')).toBeLessThan(github.indexOf('svc:instagram.'));
    // The cards are written in full — the facts the questions must come from.
    expect(social).toContain('no location or country filter');
    expect(social).toContain('has a date field: NO'); // popular search
    expect(social).toContain('health: FAILING'); // hashtag search today
    expect(github).toContain('published_at (date, spec only)');
    expect(github).toContain('free (no credits)');
  });

  it('two different asks → different prompts and different questions back (recorded answers)', async () => {
    // The recorded pair: what Sonnet asked on each ask on 2026-08-18. Which one is returned depends only on the FACTS the prompt carries.
    const answer: Answer = (prompt) => {
      if (/svc:instagram\.search_hashtag[\s\S]*health: FAILING/.test(prompt) && /OWNER: Get me all Instagram posts/.test(prompt)) return { reply: 'Instagram cannot filter by country, and hashtag search is down at the vendor right now — I would still keep it so it fills in when it is back, and add India creators for volume today. Popular Search posts carry no date, so I would leave it out. Do you want only dated posts from the last 30 days (my default), or undated recent ones too?', plan: null };
      if (/svc:github\.list_releases/.test(prompt) && /OWNER: Tell me when a competitor/.test(prompt)) return { reply: 'Which repositories should I watch (owner/repo)? And does a pre-release count as a release, or only full ones (my default: full ones only)?', plan: null };
      return { reply: 'Tell me more.', plan: null };
    };
    const a = harness({ answer });
    const r1 = await a.svc.builderChat(SOCIAL_ASK);
    const b = harness({ answer });
    const r2 = await b.svc.builderChat(GITHUB_ASK);
    expect(a.prompts[0]).not.toEqual(b.prompts[0]);
    expect(r1.reply).toMatch(/undated/);
    expect(r1.reply).toMatch(/down at the vendor/);
    expect(r2.reply).toMatch(/repositories/);
    expect(r1.reply).not.toEqual(r2.reply);
    // Both went to the named helper on the design model, with a real timeout — never a bare complete().
    expect(a.llm.completeHelper.mock.calls[0][0]).toBe('agent-builder');
    expect(a.llm.completeHelper.mock.calls[0][4]).toEqual({ timeoutMs: 180_000 });
    // The prompt carries the blocks, the sample tool and the rules — the model plans, we do not script.
    expect(a.prompts[0]).toContain('PLANNING BLOCKS');
    expect(a.prompts[0]).toContain('"sample"');
    expect(a.prompts[0]).toContain('never a fixed list');
    // Nothing hard-coded: the reply is stored, no plan yet.
    expect(a.state().plan).toBeNull();
    expect(a.state().design.turns).toBe(1);
  });

  it('the shortlist → cards: only outside-service ids, most relevant first, capped', () => {
    const tools = [{ id: 'web_search', name: 'Web search' }, { id: 'svc:github.list_releases', name: 'List releases' }, { id: 'svc:instagram.search_hashtag', name: 'Hashtag Search' }];
    expect(pickCardIds(tools, GITHUB_ASK)[0]).toBe('svc:github.list_releases');
    expect(pickCardIds(tools, SOCIAL_ASK)[0]).toBe('svc:instagram.search_hashtag');
    expect(pickCardIds(tools, SOCIAL_ASK)).not.toContain('web_search');
    expect(pickCardIds(tools, SOCIAL_ASK, 1)).toHaveLength(1);
  });

  it('a NAMED service comes first, and no one service floods the cards (the live trap: Google Sheets pushed Instagram user posts out)', () => {
    const tools = [
      ...Array.from({ length: 36 }, (_, i) => ({ id: `svc:googlesheets.sheet_thing_${i}`, name: `Sheet thing ${i}` })),
      { id: 'svc:instagram.user_posts', name: 'User Posts' },
      { id: 'svc:instagram.search_hashtag', name: 'Search Hashtag Posts' },
      { id: 'svc:instagram.profile', name: 'Profile' },
      { id: 'svc:github.list_releases', name: 'List releases' },
    ];
    const ids = pickCardIds(tools, SOCIAL_ASK);
    expect(ids.slice(0, 3).sort()).toEqual(['svc:instagram.profile', 'svc:instagram.search_hashtag', 'svc:instagram.user_posts'].sort());
    expect(ids.filter((i) => i.startsWith('svc:googlesheets')).length).toBeLessThanOrEqual(20);
    expect(namedService('svc:instagram.x', ['instagram'])).toBe(true);
    expect(namedService('svc:googlesheets.x', ['google', 'sheet'])).toBe(false);
    expect(namedService('svc:googlesheets.x', ['googlesheet'])).toBe(true);
    // The rest are still LISTED (id — name) so the model knows they exist.
    const index = indexSection(tools, SOCIAL_ASK, ids);
    expect(index).toContain('- svc:googlesheets.sheet_thing_35 — Sheet thing 35');
    expect(index).not.toContain('svc:instagram.user_posts');
  });

  it('a Settings override of the prompt without the new slots still gets the facts, blocks and rules appended', () => {
    const out = fillTemplate('OLD {{conversation}}', { conversation: { label: 'Convo', text: 'hi' }, facts: { label: 'FACTS', text: 'card 1' }, rules: { label: 'RULES', text: 'be plain' } });
    expect(out).toContain('OLD hi');
    expect(out).toContain('FACTS:\ncard 1');
    expect(out).toContain('RULES:\nbe plain');
  });
});

// ---- (b) the sample loop ---------------------------------------------------------------------------

describe('the sample loop (BEA-1371 ↔ BEA-1370)', () => {
  const view = (n: number) => ({ ok: true, actionId: 'svc:instagram.search_popular', name: 'Instagram · Popular Search', args: { query: `q${n}` }, count: 12, listKey: 'posts', fields: [{ path: 'id', kind: 'id' }, { path: 'caption', kind: 'text' }], hasDate: false, items: [{ id: '1', caption: 'a smart home' }], credits: 1, ms: 300, budget: { used: n, calls: 3, credits: n, maxCredits: 5 } });

  it('model asks → sampler runs → compact view is fed back → final reply (one sample)', async () => {
    const sampler = { sample: jest.fn(async (_s: string, _id: string, _a: any) => view(1)) };
    const { svc, prompts } = harness({ sampler, answer: (prompt, n) => (n === 1 ? { sample: { actionId: 'svc:instagram.search_popular', args: { query: 'smart home' } } } : { reply: `Popular Search gave ${/12 items under "posts"/.test(prompt) ? '12 posts' : '?'} with no date, so I leave it out. Only dated posts?`, plan: null }) });
    const r = await svc.builderChat(SOCIAL_ASK);
    expect(sampler.sample).toHaveBeenCalledTimes(1);
    expect(sampler.sample.mock.calls[0]).toEqual(['new-agent', 'svc:instagram.search_popular', { query: 'smart home' }]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('SAMPLE RESULT for svc:instagram.search_popular');
    expect(prompts[1]).toContain('has a date field: NO');
    expect(r.reply).toBe('Popular Search gave 12 posts with no date, so I leave it out. Only dated posts?');
  });

  it(`is capped at ${SAMPLE_LOOPS_PER_MESSAGE} rounds per owner message — then the model must answer`, async () => {
    let n = 0;
    const sampler = { sample: jest.fn(async () => view(++n)) };
    const { svc, prompts } = harness({ sampler, answer: (prompt) => (/No more samples for this message/.test(prompt) ? { reply: 'Fine — I have enough. Only dated posts?', plan: null } : { sample: { actionId: 'svc:instagram.search_popular', args: { query: 'x' } } }) });
    const r = await svc.builderChat(SOCIAL_ASK);
    expect(sampler.sample).toHaveBeenCalledTimes(SAMPLE_LOOPS_PER_MESSAGE);
    expect(prompts).toHaveLength(SAMPLE_LOOPS_PER_MESSAGE + 2);
    expect(r.reply).toBe('Fine — I have enough. Only dated posts?');
  });

  it("the sampler's 🔎 line, written into the same row, survives the turn — and the owner's message stays first", async () => {
    // A sampler that behaves like the real one: appends its line to the row the builder keeps.
    const settingsRef: { get?: () => any; set?: (v: any) => void } = {};
    const sampler = {
      sample: jest.fn(async () => {
        const st = settingsRef.get!();
        st.log = [...(st.log || []), { who: 'ai', kind: 'sample', text: '🔎 I tried Instagram · Popular Search (query: x) — 12 posts · fields: id, caption · no date field · 1 credit', at: 'now' }];
        st.samples = { used: 1, credits: 1 };
        settingsRef.set!(st);
        return view(1);
      }),
    };
    const h = harness({ sampler, answer: (_p, n) => (n === 1 ? { sample: { actionId: 'svc:instagram.search_popular', args: { query: 'x' } } } : { reply: 'Only dated posts?', plan: null }) });
    settingsRef.get = () => h.state();
    settingsRef.set = (v) => h.settings.set('agent.builder', JSON.stringify(v));
    await h.svc.builderChat(SOCIAL_ASK);
    const log = h.state().log;
    expect(log.map((m: any) => m.who)).toEqual(['you', 'ai', 'ai']);
    expect(log[1].kind).toBe('sample');
    expect(log[1].text).toMatch(/^🔎 I tried/);
    expect(log[2].text).toBe('Only dated posts?');
    expect(h.state().samples).toEqual({ used: 1, credits: 1 }); // ③'s counter carried, not overwritten
  });

  it('a refused sample is fed back as a refusal, no line', () => {
    const t = sampleViewText({ ...view(0), ok: false, refused: true, error: 'sample budget used (3 of 3 samples · 3 of 5 credits) — ask me instead', items: [], fields: [] } as any);
    expect(t).toContain('refused — sample budget used');
  });
});

// ---- (c) the plan: validate → create → the same fields read back --------------------------------------

describe('the plan validates and round-trips into an Agent (BEA-1371 ↔ BEA-1369)', () => {
  it('a good plan → canonical AgentPlan (through planFromAgent) with cost from the cards', () => {
    const { plan, errors } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    expect(errors).toEqual([]);
    expect(plan!.sources).toHaveLength(2);
    expect(plan!.sources[0]).toEqual({ kind: 'source', id: 'svc:instagram.search_hashtag', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, pages: 8 });
    expect(plan!.sources[1]).toMatchObject({ kind: 'creators', id: 'svc:instagram.search_profiles', find: { take: 20 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, args: { trim: true }, keepDays: 30 } });
    expect(plan!.merge).toBe(true);
    expect(plan!.shape).toEqual({ prompt: SOCIAL_PLAN.task });
    expect(plan!.output).toEqual({ kind: 'sheet', sheetId: null, append: false });
    expect(plan!.notify).toEqual({ whatsapp: true, telegram: false });
    expect(plan!.schedule).toEqual({ schedule: { every: 'week', dow: 1, at: '08:00' }, text: 'Every Monday at 08:00' });
    expect(plan!.ceilingNote).toBe(CEILING_NOTE);
    const cost = estimatePlanCost(plan!, CARDS);
    // 8 pages × 1 + (1 finder + 20 creators × 1) = 29 credits; items 8×12 + 20×12 = 336 → ×300 tokens
    expect(cost.credits).toBe(29);
    expect(cost.aiTokens).toBe(336 * 300);
  });

  it('planToAgentInput is planFromAgent\'s inverse — the round trip is exact', () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    const input = planToAgentInput(plan!, (id) => CARDS[id]?.provider === 'social');
    expect(input.tools).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_profiles']);
    // the storage shape is keyed by SOURCE id, each entry naming its action (BEA-1374)
    expect(input.toolArgs['svc:instagram.search_hashtag']).toEqual({ actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, _pages: 8 });
    expect(input.toolArgs['svc:instagram.search_profiles'].kind).toBe('creators');
    expect(input.sheetAppend).toBe(false);
    expect(input.outputDest).toBe('sheet');
    expect(input.notifyWhatsApp).toBe(true);
    expect(input.category).toBe('Social');
    expect(input.origin).toBe('social');
    expect(planFromAgent(input)).toEqual(plan);
  });

  it('a Watch plan keeps mode, condition and threshold through the round trip; mixed providers → no Social category', () => {
    const raw = { name: 'Competitor releases', sources: [{ kind: 'source', actionId: 'svc:github.list_releases', args: { owner: 'acme', repo: 'widget' }, pages: 1 }], task: KEEP_AS_FETCHED, mode: 'alert', alertCondition: 'a new full release (not a pre-release)', threshold: { field: 'data[].id', dir: 'above', value: 0 }, output: { kind: 'document' }, notify: { whatsapp: true }, schedule: { every: 'hour', minute: 0 }, scheduleText: 'Every hour' };
    const { plan, errors } = validatePlan(raw, Object.keys(CARDS));
    expect(errors).toEqual([]);
    expect(plan!.watch).toEqual({ mode: 'alert', threshold: { field: 'data[].id', dir: 'above', value: 0 }, condition: 'a new full release (not a pre-release)' });
    expect(plan!.shape).toBeUndefined();
    expect(plan!.notify.telegram).toBe(true);
    const input = planToAgentInput(plan!, (id) => CARDS[id]?.provider === 'social');
    expect(input.category).toBeUndefined();
    expect(planFromAgent(input)).toEqual(plan);
    expect(estimatePlanCost(plan!, CARDS).aiTokens).toBe(0); // no shaping on a watch
    expect(estimatePlanCost(plan!, CARDS).credits).toBe(0); // the card says free — never "≈ 1 credit" for a GitHub read
  });

  it('rejects what the cards do not list, and creators without a per-creator action; the same action twice is FINE (BEA-1374)', () => {
    expect(validatePlan({ name: 'x', sources: [{ actionId: 'svc:instagram.search_location', args: {} }] }, Object.keys(CARDS)).errors[0]).toMatch(/not one of the actions you were shown/);
    const twice = validatePlan({ name: 'x', sources: [{ actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'a' } }, { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'b' } }] }, Object.keys(CARDS));
    expect(twice.errors).toEqual([]);
    expect(twice.plan!.sources.map((s) => s.id)).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_hashtag#2']);
    expect(validatePlan({ name: 'x', sources: [{ kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: {} }, then: { argsFrom: { handle: 'username' } } }] }, Object.keys(CARDS)).errors.join(' ')).toMatch(/then\.actionId/);
    expect(validatePlan({ name: '', sources: [] }).errors).toEqual(['plan.name is missing', 'plan.sources must have at least one source']);
    expect(validatePlan(null).errors).toEqual(['plan must be an object']);
    expect(validatePlan({ ...SOCIAL_PLAN, schedule: { every: 'week', at: '8am' } }, Object.keys(CARDS)).errors[0]).toMatch(/plan\.schedule must be/);
    expect(validatePlan({ ...SOCIAL_PLAN, schedule: { every: 'hour' } }, Object.keys(CARDS)).errors).toEqual([]);
  });

  it('a bad plan is sent back to the model ONCE with the reasons; the fixed one is kept', async () => {
    const bad = { ...SOCIAL_PLAN, sources: [{ kind: 'source', actionId: 'svc:instagram.search_location', args: { q: 'India' } }] };
    // `goal` is stated so the BEA-1378 stakes gate lets this (expensive) plan through — the goal interview has its own tests below.
    const { svc, prompts, state } = harness({ answer: (prompt) => (/did not validate/.test(prompt) ? { reply: 'Fixed — here is the plan. Press Create when happy.', goal: 'track smart home content', plan: SOCIAL_PLAN } : { reply: 'Here is the plan.', goal: 'track smart home content', plan: bad }) });
    const r = await svc.builderChat('only dated posts, yes');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('not one of the actions you were shown');
    expect(r.plan!.sources[0].id).toBe('svc:instagram.search_hashtag');
    expect(r.cost!.credits).toBe(29);
    expect(r.reply).toMatch(/^Fixed/);
    expect(state().plan.name).toBe(SOCIAL_PLAN.name);
    expect(state().spec).toBeNull();
  });

  it('a plan that stays bad → reply only, no plan', async () => {
    const bad = { ...SOCIAL_PLAN, sources: [{ kind: 'source', actionId: 'svc:instagram.search_location', args: {} }] };
    const { svc, prompts } = harness({ answer: () => ({ reply: 'Here is the plan.', plan: bad }) });
    const r = await svc.builderChat('go');
    expect(prompts).toHaveLength(2);
    expect(r.plan).toBeNull();
    expect(r.reply).toBe('Here is the plan.');
  });

  it('Create builds a normal Agent from the plan — the fields the runner and the picture read back are the same plan', async () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    const cost = estimatePlanCost(plan!, CARDS);
    const { svc, created, state } = harness({ answer: () => ({}), state: { log: [], spec: null, plan, cost } });
    const r = await svc.builderCreate();
    expect(r.ok).toBe(true);
    expect(r.url).toBe('/agent/a/job1');
    expect(created).toHaveLength(1);
    const input = created[0];
    expect(input.origin).toBe('social');
    expect(input.category).toBe('Social');
    expect(input.areaId).toBeUndefined(); // its own area, same name — createAgent does that
    expect(planFromAgent(input)).toEqual(plan); // the round trip
    expect(state().plan).toBeNull();
    expect(state().log.at(-1).text).toContain('Created ✓');
  });

  it('the job builder does the same, inside its area, and skips the ordinary job path', async () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    const { svc, created, settings } = harness({ answer: () => ({}) });
    settings.set('agent.jobBuilder.ar1', JSON.stringify({ log: [], job: null, plan, cost: null }));
    const r = await svc.jobBuilderCreate('ar1', { tools: ['web_search'] });
    expect(r.url).toBe('/agent/a/job1');
    expect(created[0].areaId).toBe('ar1');
    expect(created[0].tools).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_profiles']); // the plan's, not the ticks
    expect(planFromAgent(created[0])).toEqual(plan);
  });

  it('an ordinary spec still works beside it, and a plan replaces a spec (one proposal at a time)', async () => {
    const spec = { area: { name: 'Daily News', icon: '📰' }, jobs: [{ name: 'Tech', task: 'get news' }] };
    const { svc, state } = harness({ answer: (_p, n) => (n === 1 ? { reply: 'Plan for the area.', spec } : { reply: 'Direct plan instead.', goal: 'track smart home content', plan: SOCIAL_PLAN }) });
    const r1 = await svc.builderChat('a daily news agent');
    expect(r1.spec.area.name).toBe('Daily News');
    expect(r1.plan).toBeNull();
    const r2 = await svc.builderChat('actually, instagram smart home posts');
    expect(r2.plan!.name).toBe(SOCIAL_PLAN.name);
    expect(state().spec).toBeNull();
  });
});

// ---- (d) the design budget ---------------------------------------------------------------------------

/**
 * BEA-1374 — several sources on the SAME action (five hashtags), and "keep adding" means append to
 * ONE sheet. The builder's text says so, the plan validates and round-trips, Create carries it.
 */
describe('several sources on one action + "keep adding" (BEA-1374)', () => {
  const HASHTAGS = ['smarthomeindia', 'homeautomationindia', 'smarthome', 'homeautomation', 'smartlighting'];
  const FIVE_HASHTAGS = {
    name: 'Smart home India — five hashtags',
    sources: HASHTAGS.map((h) => ({ kind: 'source', actionId: 'svc:instagram.search_hashtag', args: { hashtag: h }, pages: 3 })),
    task: KEEP_AS_FETCHED, mode: 'run',
    output: { kind: 'sheet', sheetId: null, append: true },
    notify: { whatsapp: false },
    schedule: { every: 'week', dow: 1, at: '08:00' }, scheduleText: 'Every Monday at 08:00',
  };

  it('a fixture answer with five hashtag sources validates → five sources of the SAME action with their own ids, args and pages', () => {
    const { plan, errors } = validatePlan(FIVE_HASHTAGS, Object.keys(CARDS));
    expect(errors).toEqual([]);
    expect(plan!.sources).toHaveLength(5);
    expect(plan!.sources.map((s) => s.id)).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_hashtag#2', 'svc:instagram.search_hashtag#3', 'svc:instagram.search_hashtag#4', 'svc:instagram.search_hashtag#5']);
    expect(plan!.sources.map((s: any) => s.actionId)).toEqual(Array(5).fill('svc:instagram.search_hashtag'));
    expect(plan!.sources.map((s: any) => s.args.hashtag)).toEqual(HASHTAGS);
    expect(plan!.sources.every((s: any) => s.pages === 3)).toBe(true);
    expect(estimatePlanCost(plan!, CARDS).credits).toBe(15); // 5 × 3 pages × 1
  });

  it('…and round-trips through planToAgentInput → planFromAgent exactly; tools lists the action ONCE; toolArgs holds five entries', () => {
    const { plan } = validatePlan(FIVE_HASHTAGS, Object.keys(CARDS));
    const input = planToAgentInput(plan!, (id) => CARDS[id]?.provider === 'social');
    expect(input.tools).toEqual(['svc:instagram.search_hashtag']);
    expect(Object.keys(input.toolArgs)).toHaveLength(5);
    expect(input.toolArgs['svc:instagram.search_hashtag#4']).toEqual({ actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'homeautomation' }, _pages: 3 });
    expect(planFromAgent(input)).toEqual(plan);
  });

  it('"keep adding" → output.append:true on ONE sheet: the plan says append with no sheet yet, and Create carries sheetAppend:true', async () => {
    const { plan } = validatePlan(FIVE_HASHTAGS, Object.keys(CARDS));
    expect(plan!.output).toEqual({ kind: 'sheet', sheetId: null, append: true });
    const input = planToAgentInput(plan!);
    expect(input.sheetAppend).toBe(true);
    expect(input.sheetId).toBeNull();
    // the owner's own sheet: append too, but nothing to create later
    const own = validatePlan({ ...FIVE_HASHTAGS, output: { kind: 'sheet', sheetId: 'S1' } }, Object.keys(CARDS)).plan!;
    expect(own.output).toEqual({ kind: 'sheet', sheetId: 'S1', append: true });
    expect(planToAgentInput(own).sheetAppend).toBe(false);
    // a Document output never appends
    expect(validatePlan({ ...FIVE_HASHTAGS, output: { kind: 'document', append: true } }, Object.keys(CARDS)).plan!.output.append).toBe(false);
    // Create → createAgent gets the plan's fields, and reads back as the same plan
    const cost = estimatePlanCost(plan!, CARDS);
    const { svc, created } = harness({ answer: () => ({}), state: { log: [], spec: null, plan, cost } });
    await svc.builderCreate();
    expect(created[0].sheetAppend).toBe(true);
    expect(planFromAgent(created[0])).toEqual(plan);
  });

  it('a recorded conversation: five hashtags + "keep adding to one sheet each week" → the plan the model answers is kept as five sources + append', async () => {
    // Hashtag search WORKING here — a plan of only failing sources is refused since BEA-1375 (its own tests below).
    const cards = [{ ...HASHTAG, health: { ...HASHTAG.health, ok: true, note: 'Working.' } }, POPULAR, PROFILES, USER_POSTS, RELEASES];
    const { svc } = harness({ cards, answer: (prompt) => (/OWNER: Five hashtags/.test(prompt) ? { reply: 'Five hashtag sources on Search Hashtag Posts, 3 pages each, kept adding to one sheet every Monday. Press Create when happy.', plan: FIVE_HASHTAGS, cost: { credits: 15, aiTokens: 0 } } : { reply: 'Which hashtags?', plan: null }) });
    const r = await svc.builderChat('Five hashtags: #smarthomeindia #homeautomationindia #smarthome #homeautomation #smartlighting — 3 pages each, keep adding to one sheet each week');
    expect(r.plan!.sources).toHaveLength(5);
    expect(new Set(r.plan!.sources.map((s: any) => s.actionId)).size).toBe(1);
    expect(r.plan!.output).toEqual({ kind: 'sheet', sheetId: null, append: true });
    expect(r.cost!.credits).toBe(15);
  });

  it('the builder text: no "one source per action" limit any more; several sources may share an action; keep adding = append to one sheet; the plan shape carries append', () => {
    expect(BLOCKS_TEXT).not.toMatch(/ONE source per action id/);
    expect(BLOCKS_TEXT).toMatch(/Several sources may use the SAME action with different arguments/);
    expect(BLOCKS_TEXT).toMatch(/five hashtags/i);
    expect(RULES_TEXT).toMatch(/keep adding/i);
    expect(RULES_TEXT).toMatch(/append:true on ONE sheet/);
    expect(PLAN_SHAPE_TEXT).toMatch(/"append":true\|false/);
  });
});

describe('the design budget (BEA-1371)', () => {
  it('under budget the model is told where it stands; over it, to propose the best plan and stop asking', () => {
    expect(budgetLine({ turns: 2, tokens: 9_000 })).toContain('turn 3 of 12');
    expect(DESIGN_BUDGET.tokens).toBeGreaterThanOrEqual(400_000); // a sampled turn is ~50k ≈ tokens live (5 model calls over the facts)
    expect(overBudget({ turns: DESIGN_BUDGET.turns, tokens: 0 })).toBe(true);
    expect(overBudget({ turns: 0, tokens: DESIGN_BUDGET.tokens })).toBe(true);
    expect(budgetLine({ turns: 12, tokens: 20_000 })).toMatch(/DESIGN BUDGET SPENT[\s\S]*Do NOT ask another question/);
  });

  it('budget spent + the model still asks → the best plan so far comes back, and no sample is run', async () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    const sampler = { sample: jest.fn(async () => ({}) as any) };
    const { svc, prompts, llm } = harness({ sampler, answer: () => ({ reply: 'One more thing — which hashtags?', plan: null }), state: { log: [], spec: null, plan, cost: null, design: { turns: DESIGN_BUDGET.turns, tokens: 5_000 } } });
    const r = await svc.builderChat('hmm');
    expect(prompts[0]).toContain('DESIGN BUDGET SPENT');
    expect(r.plan).toEqual(plan);
    expect(r.cost!.credits).toBe(29);
    expect(sampler.sample).not.toHaveBeenCalled();
    expect(llm.completeHelper).toHaveBeenCalledTimes(1);
  });

  it('every turn adds to the counter (turns + ≈ tokens), and it survives in the row', async () => {
    const { svc, state } = harness({ answer: () => ({ reply: 'Which repos?', plan: null }) });
    await svc.builderChat(GITHUB_ASK);
    await svc.builderChat('acme/widget');
    expect(state().design.turns).toBe(2);
    expect(state().design.tokens).toBeGreaterThan(1000);
    await svc.builderReset();
    expect(state().design).toBeUndefined();
  });
});

// ---- (f) honesty: an unhealthy source is said -----------------------------------------------------------

describe('an unhealthy source is said (BEA-1371)', () => {
  it('the card says FAILING → the note names it and how the plan copes; a reply that already says so gets no second note', () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    const note = healthNote(plan, CARDS, 'Here is the plan. Press Create when happy.');
    expect(note).toMatch(/Instagram · Hashtag Search is failing at the vendor right now/);
    expect(note).toMatch(/keeps it so it fills in when the vendor repairs it/);
    expect(healthNote(plan, CARDS, 'Hashtag search is down at the vendor right now — I keep it so it fills in later.')).toBe('');
    expect(healthNote(plan, { ...CARDS, 'svc:instagram.search_hashtag': { ...HASHTAG, health: { ...HASHTAG.health, ok: true } } }, 'plan')).toBe('');
    expect(healthNote(null, CARDS, 'x')).toBe('');
  });

  it('the reply the owner reads carries the note when the model forgot it', async () => {
    const { svc } = harness({ answer: () => ({ reply: 'Here is the plan — press Create when happy.', goal: 'track smart home content', plan: SOCIAL_PLAN }) });
    const r = await svc.builderChat('yes');
    expect(r.reply).toMatch(/Note: Instagram · Hashtag Search is failing at the vendor right now/);
  });
});

// ---- the model + the pieces the prompt is made of ---------------------------------------------------------

describe('the pieces (BEA-1371)', () => {
  it('the agent-builder helper is registered on Sonnet 5 via the API — never Codex, never a cheaper model', () => {
    expect(LlmService.HELPERS['agent-builder']).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' });
  });

  it('a card is written in full — params, fields with kinds, date, paging, cost, health, notes', () => {
    const t = cardText(HASHTAG);
    expect(t).toContain('### svc:instagram.search_hashtag — Instagram · Hashtag Search');
    expect(t).toContain('params: hashtag* (string) · cursor (string)');
    expect(t).toContain('posts[].taken_at (date)');
    expect(t).toContain('has a date field: yes');
    expect(t).toContain('paging: cursor via "cursor" · at most 11 pages');
    expect(t).toContain('cost: 1 credit per call typical (1–1)');
    expect(t).toContain('health: FAILING — Answered not_found');
    expect(t).toContain('note: Instagram has no location or country filter');
    expect(cardText(RELEASES)).toContain('data[].published_at (date, spec only)');
    expect(cardText(PROFILES)).toContain('health: no verdict');
  });

  it('parses JSON out of prose and fences, and closes a cut-off object', () => {
    expect(parseBuilderJson('```json\n{"reply":"hi","plan":null}\n```')).toEqual({ reply: 'hi', plan: null });
    // A brace we had to close ourselves marks the answer as cut off (BEA-1402), so the turn can say so.
    expect(parseBuilderJson('{"reply":"hi","plan":{"name":"x"')).toEqual({ reply: 'hi', plan: { name: 'x' }, cutOff: true });
    expect(parseBuilderJson('nothing')).toBeNull();
    // Cut inside a string (the first live turn): the reply survives, marked cut off.
    expect(parseBuilderJson('{"reply":"Here is the plan.\\nIt fetches a lot","plan":{"name":"x","sources":[{"kind":"sou')).toEqual({ reply: 'Here is the plan.\nIt fetches a lot', cutOff: true });
  });

  it('both prompt defaults carry the facts, blocks, sample, budget and rules slots, the plan shape and the goal field (BEA-1378)', async () => {
    const prisma: any = { setting: { findUnique: async () => null } };
    for (const key of ['agent.builder', 'agent.jobBuilder'] as const) {
      const tpl = await new PromptsService(prisma).get(key);
      for (const slot of ['{{conversation}}', '{{facts}}', '{{tools}}', '{{blocks}}', '{{sample}}', '{{budget}}', '{{rules}}']) expect(tpl).toContain(slot);
      expect(tpl).toContain('"plan": null while something important is still open');
      expect(tpl).toContain('"kind":"creators"');
      // The goal field (BEA-1378): the model repeats the owner's goal in every answer once known.
      expect(tpl).toContain('"goal": null until the owner has said what the result is FOR');
    }
  });
});

// ---- BEA-1372: the screens — what the plan card reads, and the Social hand-off seed ---------------------

describe('the plan card reads the failing sources and the ₹ (BEA-1372)', () => {
  it('unhealthySources lists each FAILING card once with its note; the reply note is written from the same list', () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    const bad = unhealthySources(plan, CARDS);
    expect(bad).toEqual([{ actionId: 'svc:instagram.search_hashtag', name: 'Instagram · Hashtag Search', note: expect.any(String) }]);
    expect(healthNote(plan, CARDS, 'plan')).toContain(bad[0].note);
    expect(unhealthySources(plan, { ...CARDS, 'svc:instagram.search_hashtag': { ...HASHTAG, health: { ...HASHTAG.health, ok: true } } })).toEqual([]);
    expect(unhealthySources(null, CARDS)).toEqual([]);
  });

  it('a chat turn hands the card `cost.unhealthy` beside the arithmetic and ≈ ₹ — the UI marks the source from that, not from the reply text', async () => {
    const { svc, state } = harness({ answer: () => ({ reply: 'Hashtag search is down at the vendor right now — kept so it fills in later.', goal: 'track smart home content', plan: SOCIAL_PLAN }) });
    const r = await svc.builderChat('yes');
    expect(r.cost?.unhealthy?.map((u) => u.actionId)).toEqual(['svc:instagram.search_hashtag']);
    expect(r.cost?.aiRupees).toBeGreaterThan(0);
    expect(r.cost?.how).toMatch(/≈ ₹/);
    expect(state().cost.unhealthy).toHaveLength(1); // survives in the row for a reload
  });
});

describe('the Social hand-off seeds the builder (BEA-1372)', () => {
  const seed = { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia', date_posted: 'last-month' }, label: 'Instagram · Search Hashtag Posts', sample: { count: 8, listKey: 'posts', credits: 1, fields: ['id', 'caption', 'owner'] } };

  it('the first line is scripted from the call: name, args, count, credits, and the question', () => {
    expect(seedLine(seed)).toBe('You just ran Instagram · Search Hashtag Posts (hashtag: smarthomeindia, date_posted: last-month) and got 8 posts for 1 credit. Is this the kind of thing you want, and how much of it? Tell me what the agent should do with it — how often, and where the rows should go — and I\'ll plan it from there.');
    expect(seedLine({ ...seed, sample: { notFound: true } })).toMatch(/found nothing today \(0 credits\) — an agent on a schedule keeps asking/);
    expect(seedLine({ ...seed, sample: { count: 1, listKey: 'posts', credits: 2 } })).toMatch(/got 1 post for 2 credits/);
    expect(seedLine({ actionId: 'svc:tiktok.profile', args: {} })).toMatch(/^You just ran tiktok · profile and got an answer\./);
    // the model's section carries the exact id + args; empty when there is no seed (so fillTemplate appends nothing)
    expect(seedText(seed)).toMatch(/ran svc:instagram\.search_hashtag \(Instagram · Search Hashtag Posts\) by hand with arguments \{"hashtag":"smarthomeindia","date_posted":"last-month"\} and got 8 posts · fields: id, caption, owner · 1 credit/);
    expect(seedText(null)).toBe('');
  });

  it('POST seed → a FRESH conversation whose first line is the builder\'s (kind seed), no model call; the next turn\'s prompt carries the id + args', async () => {
    const { svc, llm, prompts, state } = harness({ answer: () => ({ reply: 'How often, and where should the rows go?', plan: null }), state: { log: [{ who: 'you', text: 'old talk' }], spec: { area: { name: 'Old' } } } });
    const st = await svc.builderSeed(seed as any);
    expect(llm.completeHelper).not.toHaveBeenCalled();
    expect(st.log).toHaveLength(1);
    expect(st.log[0]).toMatchObject({ who: 'ai', kind: 'seed' });
    expect(st.log[0].text).toMatch(/^You just ran Instagram · Search Hashtag Posts/);
    expect(st.spec).toBeNull();
    expect(state().seed.actionId).toBe('svc:instagram.search_hashtag');
    // the same seed again (a page reload) does NOT wipe the conversation; a different call starts over
    await svc.builderChat('every Monday, into one sheet');
    expect(prompts[0]).toMatch(/Where the owner came from/);
    expect(prompts[0]).toMatch(/svc:instagram\.search_hashtag .* by hand with arguments \{"hashtag":"smarthomeindia"/);
    const again = await svc.builderSeed(seed as any);
    expect(again.log.length).toBe(3);
    const other = await svc.builderSeed({ ...seed, args: { hashtag: 'homeautomation' } } as any);
    expect(other.log).toHaveLength(1);
    await expect(svc.builderSeed({ actionId: 'web_search', args: {} } as any)).rejects.toThrow(/which action/);
    await expect(svc.builderSeed({ actionId: 'svc:instagram.search_hashtag', args: { q: 'x'.repeat(5000) } } as any)).rejects.toThrow(/too long/);
  });

  it('two equal seeds at ONCE write one line, not two (serialised)', async () => {
    const { svc } = harness({ answer: () => ({ reply: 'x' }) });
    const [a, b] = await Promise.all([svc.builderSeed(seed as any), svc.builderSeed(seed as any)]);
    expect(a.log).toHaveLength(1);
    expect(b.log).toHaveLength(1);
    expect((await svc.builderState()).log).toHaveLength(1);
  });
});

// ---- BEA-1375: lessons from the acceptance run --------------------------------------------------------------
//
// The run got there only because the owner pushed four times: (1) the first plan was four hashtag searches on a
// source the card said was FAILING — an empty sheet today; (2) creators-first on an unsampled finder that answered
// look-alike dead accounts; (3) "runs once now" as if agreed; (4) ≈19 credits shown, 11 charged. Each is a rule the
// builder now holds, and where the server can check it, it does.

describe('a plan needs a HEALTHY source (BEA-1375)', () => {
  const HASHTAGS_ONLY = {
    name: 'Smart Home India — weekly digest',
    sources: ['smarthomeindia', 'smarthomeautomationindia', 'homeautomationindia', 'smarthome'].map((h) => ({ kind: 'source', actionId: 'svc:instagram.search_hashtag', args: { hashtag: h, date_posted: 'last-month' }, pages: 2 })),
    task: 'Keep only posts whose caption mentions India. Columns: hashtag, post url, caption, owner username.', mode: 'run',
    output: { kind: 'sheet', sheetId: null }, notify: { whatsapp: true },
    schedule: { every: 'week', dow: 1, at: '08:00' }, scheduleText: 'every Monday at 8am',
  };
  const WITH_FALLBACK = { ...HASHTAGS_ONLY, sources: [...HASHTAGS_ONLY.sources, { kind: 'creators', find: { actionId: 'svc:instagram.search_popular', args: { query: 'smart home india' }, take: 10 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'owner.username' }, keepDays: 30 } }] };
  const OWNER = 'Get me all the Instagram posts related to Smart Home in India from the last 30 days. Fetch it and create a Google Sheet and update the information. Send the copy to my WhatsApp.';

  it('planHasHealthySource: only failing sources → no; a working (or no-verdict) block beside them → yes; a creators block on a failing finder is not healthy', () => {
    const only = validatePlan(HASHTAGS_ONLY, Object.keys(CARDS)).plan!;
    expect(planHasHealthySource(only, CARDS)).toBe(false);
    expect(planHasHealthySource(validatePlan(WITH_FALLBACK, Object.keys(CARDS)).plan!, CARDS)).toBe(true);
    // no cards at all → nothing is known to fail → healthy
    expect(planHasHealthySource(only, {})).toBe(true);
    const badFinder = validatePlan({ ...HASHTAGS_ONLY, sources: [{ kind: 'creators', find: { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'x' }, take: 5 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'owner.username' } } }] }, Object.keys(CARDS)).plan!;
    expect(planHasHealthySource(badFinder, CARDS)).toBe(false);
  });

  it('the health note never says "the other sources carry the run" when there are none — it says nothing in this plan can produce rows today', () => {
    const only = validatePlan(HASHTAGS_ONLY, Object.keys(CARDS)).plan!;
    const note = healthNote(only, CARDS, 'Here is the plan. Press Create when happy.');
    expect(note).toMatch(/Nothing in this plan can produce rows today/);
    expect(note).not.toMatch(/other sources carry the run/);
    // said even when the reply already talks about the outage — the owner must know why no plan card came
    expect(healthNote(only, CARDS, 'Hashtag search is down at the vendor right now.')).toMatch(/Nothing in this plan can produce rows today/);
    // with a working source beside it, the old wording holds (and a reply that says so gets no second note)
    const mixed = validatePlan(WITH_FALLBACK, Object.keys(CARDS)).plan!;
    expect(healthNote(mixed, CARDS, 'plan')).toMatch(/until then the other sources carry the run/);
    expect(healthNote(mixed, CARDS, 'Hashtag search is down at the vendor right now — kept so it fills in later.')).toBe('');
  });

  it('the acceptance conversation: a plan of only failing hashtag searches is sent back ONCE; if the model still sends it, no plan is shown (reply only) and the reply says why', async () => {
    const { svc, prompts, state } = harness({ answer: () => ({ reply: 'Here is the plan: search 4 hashtags, 2 pages each. Press Create when happy.', plan: HASHTAGS_ONLY }) });
    const r = await svc.builderChat(OWNER);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your "plan" was NOT shown to the owner: every source in it is failing at the vendor today (Instagram · Hashtag Search)');
    expect(prompts[1]).toContain(noHealthySourceText(validatePlan(HASHTAGS_ONLY, Object.keys(CARDS)).plan!, CARDS));
    expect(r.plan).toBeNull();
    expect(r.cost).toBeNull();
    expect(r.reply).toMatch(/Nothing in this plan can produce rows today/);
    expect(r.reply).not.toMatch(/other sources carry the run/);
    expect(r.reply).not.toMatch(/^Cost:/m); // no plan → no cost line
    expect(state().plan).toBeNull();
  });

  it('…and when the model adds a working fallback on the send-back, THAT plan is shown, with both cost figures', async () => {
    const { svc, prompts } = harness({ answer: (prompt) => (/NOT shown to the owner: every source in it is failing/.test(prompt)
      ? { reply: 'Hashtag search is down at the vendor today, so I add a fallback: Popular Search finds 10 real creators and I pull their own last-30-day posts. Press Create when happy.', plan: WITH_FALLBACK }
      : { reply: 'Here is the plan: search 4 hashtags, 2 pages each. Press Create when happy.', plan: HASHTAGS_ONLY }) });
    const r = await svc.builderChat(OWNER);
    expect(prompts).toHaveLength(2);
    expect(r.plan!.sources).toHaveLength(5);
    expect(r.cost!.credits).toBe(19); // 4 × 2 pages + 1 finder + 10 creators
    expect(r.cost!.nowCredits).toBe(11); // the four failing hashtag searches are not charged today
    expect(r.cost!.unhealthy!.map((u) => u.name)).toEqual(['Instagram · Hashtag Search']);
    expect(r.reply).toMatch(/Cost: ≈ 19 credits \(≈ 11 while Instagram · Hashtag Search is down\) · ≈ \d+k AI tokens ≈ ₹\d+ per run\./);
    expect(r.reply).not.toMatch(/Note: .*Nothing in this plan/); // the model said "down" itself and the plan has a working source
  });

  it('a plan with a working source is never sent back for health; a plan with no cards known at all is not either', async () => {
    const { svc, prompts } = harness({ answer: () => ({ reply: 'Popular Search owners → their posts. Press Create when happy.', plan: { ...WITH_FALLBACK, sources: WITH_FALLBACK.sources.slice(4) } }) });
    const r = await svc.builderChat(OWNER);
    expect(prompts).toHaveLength(1);
    expect(r.plan!.sources).toHaveLength(1);
    expect(r.cost!.nowCredits).toBe(r.cost!.credits);
    expect(r.cost!.unhealthy).toBeUndefined();
    expect(r.reply).toMatch(/Cost: ≈ 11 credits · /); // one figure when everything works
  });
});

describe('a finder is sampled before a creators block is trusted (BEA-1375)', () => {
  const view = (actionId: string) => ({ ok: true, actionId, name: 'Instagram · Profile Search', args: { query: 'smart home india' }, count: 10, listKey: 'users', fields: [{ path: 'username', kind: 'text' }, { path: 'follower_count', kind: 'number' }], hasDate: false, items: [{ username: 'smart_home_india', follower_count: 20 }], credits: 1, ms: 300, budget: { used: 1, calls: 3, credits: 1, maxCredits: 5 } });
  const CREATORS_PLAN = { ...SOCIAL_PLAN, sources: [SOCIAL_PLAN.sources[1]] }; // creators on search_profiles → user_posts, nothing else

  it('sampledActionIds reads the sampler\'s lines (actionId) and the hand-off seed; unsampledFinders names the finders not yet seen', () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    expect(unsampledFinders(plan, new Set())).toEqual(['svc:instagram.search_profiles']);
    expect(unsampledFinders(plan, sampledActionIds({ log: [{ who: 'ai', kind: 'sample', actionId: 'svc:instagram.search_profiles', text: '🔎 I tried…' }] }))).toEqual([]);
    expect(unsampledFinders(plan, sampledActionIds({ log: [], seed: { actionId: 'svc:instagram.search_profiles' } }))).toEqual([]);
    expect(unsampledFinders(plan, sampledActionIds({ log: [{ who: 'ai', kind: 'sample', actionId: 'svc:instagram.search_popular', text: '🔎' }] }))).toEqual(['svc:instagram.search_profiles']);
    expect(unsampledFinders(null, new Set())).toEqual([]);
    expect(sampleFinderText(['svc:instagram.search_profiles'])).toMatch(/sample the finder once/);
  });

  it('a plan on an unsampled finder is held back with the rule; the model samples; the sampler runs; the plan that follows is shown', async () => {
    const sampler = { sample: jest.fn(async (_s: string, id: string) => view(id)) };
    const { svc, prompts } = harness({ sampler, answer: (prompt) => {
      if (/SAMPLE RESULT for svc:instagram.search_profiles/.test(prompt)) return { reply: 'I looked: the profiles are name matches with 20 followers — thin. I still keep them, and pull each one\'s own posts. Press Create when happy.', plan: CREATORS_PLAN };
      if (/you have not sampled that finder in this conversation/.test(prompt)) return { sample: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' } } };
      return { reply: 'Find 20 creators, then their posts. Press Create when happy.', plan: CREATORS_PLAN };
    } });
    const r = await svc.builderChat(SOCIAL_ASK);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(sampleFinderText(['svc:instagram.search_profiles']));
    expect(sampler.sample).toHaveBeenCalledTimes(1);
    expect(sampler.sample.mock.calls[0].slice(1)).toEqual(['svc:instagram.search_profiles', { query: 'smart home india' }]);
    expect(prompts[2]).toContain('SAMPLE RESULT for svc:instagram.search_profiles');
    expect(r.plan!.sources[0].kind).toBe('creators');
    expect(r.reply).toMatch(/^I looked:/);
  });

  it('a finder already sampled in this conversation (or run by hand on the Social page) is not asked for again', async () => {
    const sampler = { sample: jest.fn(async (_s: string, id: string) => view(id)) };
    const seen = { log: [{ who: 'you', text: 'hi' }, { who: 'ai', kind: 'sample', actionId: 'svc:instagram.search_profiles', text: '🔎 I tried Instagram · Profile Search (query: smart home india) — 10 users · 1 credit' }], spec: null, plan: null, cost: null, samples: { used: 1, credits: 1 } };
    const h = harness({ sampler, state: seen, answer: () => ({ reply: 'Plan. Press Create when happy.', plan: CREATORS_PLAN }) });
    const r = await h.svc.builderChat('go on');
    expect(sampler.sample).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(1);
    expect(r.plan).not.toBeNull();
    const seeded = harness({ sampler, state: { log: [{ who: 'ai', kind: 'seed', text: 'You just ran…' }], seed: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' } } }, answer: () => ({ reply: 'Plan. Press Create when happy.', plan: CREATORS_PLAN }) });
    expect((await seeded.svc.builderChat('yes')).plan).not.toBeNull();
    expect(sampler.sample).not.toHaveBeenCalled();
  });

  it('with no sample budget left (or no sampler) the plan is shown as before — the nudge cannot ask for what it cannot run — and the reply says the finder was not looked at', async () => {
    const sampler = { sample: jest.fn(async (_s: string, id: string) => view(id)) };
    const h = harness({ sampler, state: { log: [], spec: null, plan: null, cost: null, samples: { used: 3, credits: 3 } }, answer: () => ({ reply: 'Plan. Press Create when happy.', plan: CREATORS_PLAN }) });
    const r = await h.svc.builderChat(SOCIAL_ASK);
    expect(r.plan).not.toBeNull();
    expect(sampler.sample).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(1);
    expect(r.reply).toContain('Note: I have not looked at Instagram · Profile Search myself in this conversation (my sample budget is used up)');
    expect(unsampledFinderNote([], CARDS)).toBe('');
    const none = harness({ answer: () => ({ reply: 'Plan. Press Create when happy.', plan: CREATORS_PLAN }) });
    expect((await none.svc.builderChat(SOCIAL_ASK)).plan).not.toBeNull();
    // the rule the first live run needed: a FAILING card is the answer — samples are kept for the finder
    expect(RULES_TEXT).toMatch(/A card whose health says FAILING today IS the answer — do not spend a sample checking it again/);
    expect(RULES_TEXT).toMatch(/keep one for the finder of any creators block you may plan/);
  });

  it(`model calls per owner message are capped at ${MAX_ASKS_PER_MESSAGE} — a model that keeps sending an unhealthy plan or asking is cut off, not looped`, async () => {
    const sampler = { sample: jest.fn(async (_s: string, id: string) => view(id)) };
    let n = 0;
    const { svc, prompts } = harness({ sampler, answer: () => (++n % 2 ? { sample: { actionId: 'svc:instagram.search_profiles', args: { query: `q${n}` } } } : { reply: 'x', plan: { ...CREATORS_PLAN, sources: [{ kind: 'source', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'a' } }] } }) });
    const r = await svc.builderChat(SOCIAL_ASK);
    expect(prompts.length).toBeLessThanOrEqual(MAX_ASKS_PER_MESSAGE);
    expect(sampler.sample.mock.calls.length).toBeLessThanOrEqual(SAMPLE_LOOPS_PER_MESSAGE);
    expect(r.plan).toBeNull();
  });
});

describe('when it runs and where it goes are settled before the plan; the cost is the server\'s (BEA-1375)', () => {
  it('the rules say so, in the prompt the model reads: healthy source first, sample the finder, settle when/where, quote the server\'s cost', async () => {
    expect(RULES_TEXT).toMatch(/A plan needs at least one HEALTHY source — one that can produce rows TODAY/);
    expect(RULES_TEXT).toMatch(/a plan of only failing sources is not shown to the owner/);
    expect(RULES_TEXT).toMatch(/Before a creators-first block, SAMPLE the finder once/);
    expect(RULES_TEXT).toMatch(/Popular Search owners, Instagram's own user search/);
    expect(RULES_TEXT).toMatch(/"When it runs" and "where the rows go" are OPEN until the owner has said them, or has accepted your default in so many words/);
    expect(RULES_TEXT).toMatch(/Never write "runs once now" or "a new sheet" into a plan as if it were agreed/);
    expect(RULES_TEXT).toMatch(/Cost numbers are the SERVER's, never yours/);
    expect(RULES_TEXT).not.toMatch(/state your arithmetic\)/);
    const { svc, prompts } = harness({ answer: () => ({ reply: 'ok', plan: null }) });
    await svc.builderChat('Get me all the Instagram posts related to Smart Home in India from the last 30 days into a Google Sheet.');
    expect(prompts[0]).toMatch(/Cost numbers are the SERVER's/);
    expect(prompts[0]).toMatch(/the server writes the ≈ cost line under it/); // the prompt default no longer asks for ≈ figures in prose
    expect(prompts[0]).not.toMatch(/the plan in words with ≈ credits and ≈ AI tokens/);
  });

  it('a recorded conversation: schedule + destination unstated → the model asks (no plan); the owner answers → the plan carries them', async () => {
    const OWNER = 'OWNER: Get me all the Instagram posts related to Smart Home in India from the last 30 days. Fetch it and create a Google Sheet and update the information. Send the copy to my WhatsApp.';
    const { svc, state } = harness({ answer: (prompt) => (/OWNER: Every Monday 8am, a new sheet each run/.test(prompt)
      ? { reply: 'Set: every Monday 8am, a new sheet each run, link on WhatsApp. Press Create when happy.', plan: { ...SOCIAL_PLAN, sources: [{ kind: 'source', actionId: 'svc:instagram.search_popular', args: { query: 'smart home india' }, pages: 2 }] } }
      : new RegExp(OWNER).test(prompt) ? { reply: 'One thing before the plan: run it once now, or on a schedule — every Monday 8am, say? And a new Google Sheet each run, or one sheet kept adding to?', plan: null } : { reply: '?', plan: null }) });
    const first = await svc.builderChat(OWNER.replace(/^OWNER: /, ''));
    expect(first.plan).toBeNull();
    expect(first.reply).toMatch(/every Monday 8am, say\?/);
    expect(first.reply).not.toMatch(/Cost:/);
    const second = await svc.builderChat('Every Monday 8am, a new sheet each run');
    expect(second.plan!.schedule).toEqual({ schedule: { every: 'week', dow: 1, at: '08:00' }, text: 'Every Monday at 08:00' });
    expect(second.plan!.output).toEqual({ kind: 'sheet', sheetId: null, append: false });
    expect(second.reply).toMatch(/Cost: ≈ 2 credits · ≈ 7k AI tokens ≈ ₹2 per run\./); // 2 pages × 12 items × 300 tokens = 7,200
    expect(state().cost.nowCredits).toBe(2);
  });

  it('the cost line the reply and the card share: both figures while a source is down, one when all is well; a refinement turn is handed the server\'s cost to quote', async () => {
    const { plan } = validatePlan(SOCIAL_PLAN, Object.keys(CARDS));
    const cost = estimatePlanCost(plan!, CARDS);
    expect(cost.credits).toBe(29); // 8 pages + 1 finder + 20 creators
    expect(cost.nowCredits).toBe(21); // the 8 hashtag pages answer empty today
    expect(cost.unhealthy?.map((u) => u.name)).toEqual(['Instagram · Hashtag Search']);
    expect(creditsText(cost)).toBe('≈ 29 credits (≈ 21 while Instagram · Hashtag Search is down)');
    expect(cost.how).toContain('(≈ 21 credits today while Instagram · Hashtag Search is down — a failing call answers empty and is not charged)');
    expect(costLineText(cost)).toBe(`≈ 29 credits (≈ 21 while Instagram · Hashtag Search is down) · ≈ ${Math.round(cost.aiTokens / 1000)}k AI tokens ≈ ₹${cost.aiRupees} per run`);
    expect(costReplyLine(cost)).toBe(`Cost: ${costLineText(cost)}.`);
    expect(costReplyLine(null)).toBe('');
    expect(creditsText({ credits: 5, nowCredits: 5, unhealthy: [] })).toBe('≈ 5 credits');
    expect(creditsText({ credits: 1, nowCredits: 1 })).toBe('≈ 1 credit');
    // the next turn's prompt carries the server's cost of the last plan, so the model quotes it, not its own
    const { svc, prompts } = harness({ state: { log: [], spec: null, plan, cost }, answer: () => ({ reply: 'ok', plan: null }) });
    await svc.builderChat('what does it cost?');
    expect(prompts[0]).toContain(`Server cost of that plan (quote these, not your own): ${costLineText(cost)}`);
  });
});

// ---- BEA-1378: the goal interview — what is the result FOR ------------------------------------------------

/**
 * The incident that made this a rule: "all smart home profiles on Instagram" was planned literally
 * (202 credits into a profile list) when the goal — "understand how they post content to get maximum
 * reach" — needed POSTS. The builder now settles the goal before planning; an expensive plan with no
 * goal established is stripped to reply-only, the same mechanism as the healthy-source rule.
 */
describe('the goal interview — understand what the result is FOR (BEA-1378)', () => {
  // Expensive AND healthy — only the goal gate can hold it back: 29 credits, ≈ 100,800 AI tokens (≥ 100k).
  const EXPENSIVE = {
    name: 'Smart home outliers',
    sources: [
      { kind: 'source', actionId: 'svc:instagram.search_popular', args: { query: 'smart home india' }, pages: 8 },
      { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 20 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, args: { trim: true }, keepDays: 30 } },
    ],
    task: 'Columns: creator, date, plays, likes, caption, link.',
    mode: 'run', output: { kind: 'sheet', sheetId: null }, notify: { whatsapp: true }, schedule: null,
  };
  // The literal ask, cheap: one profile-search page, rows as fetched — 1 credit, no AI.
  const CHEAP_PROFILES = {
    name: 'Smart home profiles',
    sources: [{ kind: 'source', actionId: 'svc:instagram.search_profiles', args: { query: 'smart home' }, pages: 1 }],
    task: KEEP_AS_FETCHED, mode: 'run', output: { kind: 'document' }, notify: { whatsapp: false }, schedule: null,
  };
  const GOAL = 'understand how they are posting content to get the maximum reach';

  it('the rules teach it: FOR before planning (one plain question with an example), the goal decides the shape, a mismatch is SAID and the owner may insist, a stated goal is never re-asked', () => {
    expect(RULES_TEXT).toMatch(/Before planning ANYTHING, understand what the result is FOR/);
    expect(RULES_TEXT).toMatch(/ONE plain question with an example answer/);
    expect(RULES_TEXT).toMatch(/The goal decides the SHAPE of the result/);
    expect(RULES_TEXT).toMatch(/not from the literal noun in the ask/);
    expect(RULES_TEXT).toMatch(/literal ask and the goal point at DIFFERENT shapes, say so before planning and propose the goal's shape/);
    expect(RULES_TEXT).toMatch(/shall I plan that instead/);
    expect(RULES_TEXT).toMatch(/The owner may still insist on the literal ask — then build exactly that/);
    expect(RULES_TEXT).toMatch(/never re-ask a goal already stated/);
    expect(RULES_TEXT).toMatch(/"goal" JSON field/);
    // the pieces
    expect(GOAL_STAKES).toEqual({ credits: 50, aiTokens: 100_000 });
    expect(isExpensivePlan({ credits: 50, aiTokens: 0 } as any)).toBe(true);
    expect(isExpensivePlan({ credits: 3, aiTokens: 100_000 } as any)).toBe(true);
    expect(isExpensivePlan({ credits: 49, aiTokens: 99_999 } as any)).toBe(false);
    expect(isExpensivePlan(null)).toBe(false);
    expect(goalOf({ goal: `  ${GOAL}  ` })).toBe(GOAL);
    expect(goalOf({ goal: '' })).toBeNull();
    expect(goalOf({})).toBeNull();
    // "For: <goal>" onto a description — prefix, in front of an existing one, never doubled.
    expect(withGoal(null, GOAL)).toBe(`For: ${GOAL}`);
    expect(withGoal('Weekly digest', GOAL)).toBe(`For: ${GOAL} — Weekly digest`);
    expect(withGoal(`For: ${GOAL}`, GOAL)).toBe(`For: ${GOAL}`);
    expect(withGoal('Weekly digest', null)).toBe('Weekly digest');
    expect(withGoal(null, null)).toBeUndefined();
  });

  it('no goal stated → an expensive plan is held: sent back ONCE, and when the model then asks the question, the first reply asks what it is for and contains NO plan', async () => {
    const { svc, prompts, state } = harness({ answer: (prompt) => (/has not said what the result is FOR/.test(prompt)
      ? { reply: 'What will you use this result for? For example: to learn how these accounts get reach.', plan: null }
      : { reply: 'Here is the plan.', plan: EXPENSIVE }) });
    const r = await svc.builderChat('Get me all the smart home profiles on Instagram');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('it is a big run');
    expect(prompts[1]).toContain('has not said what the result is FOR');
    expect(r.plan).toBeNull();
    expect(r.goal).toBeNull();
    expect(r.reply).toMatch(/What will you use this result for\?/);
    expect(r.reply).toContain('I first need to know what the result is FOR'); // why no plan card came
    expect(state().plan).toBeNull();
    expect(state().goal).toBeUndefined();
  });

  it('a model that STILL sends the expensive plan with no goal → the plan is stripped, reply-only — the same mechanism as the healthy-source rule', async () => {
    const { svc, prompts, state } = harness({ answer: () => ({ reply: 'Here is the plan.', plan: EXPENSIVE }) });
    const r = await svc.builderChat('Get me all the smart home profiles on Instagram');
    expect(prompts).toHaveLength(2); // nudged once, then cut off
    expect(r.plan).toBeNull();
    expect(r.cost).toBeNull();
    expect(r.reply).toContain('I first need to know what the result is FOR');
    expect(state().plan).toBeNull();
  });

  it('the goal stated → NO goal question: the plan comes through with `goal` beside plan/cost, it is remembered, and the next turn is told not to re-ask', async () => {
    const { svc, prompts, state } = harness({ answer: (_p, n) => (n === 1
      ? { reply: 'Plan for outliers. Press Create when happy.', goal: GOAL, plan: EXPENSIVE }
      : { reply: 'ok', goal: GOAL, plan: null }) });
    const r = await svc.builderChat(`Get me all the smart home profiles on Instagram — I want to ${GOAL}`);
    expect(prompts).toHaveLength(1); // no nudge, no question round
    expect(r.plan!.name).toBe('Smart home outliers');
    expect(r.goal).toBe(GOAL);
    expect(r.cost!.aiTokens).toBeGreaterThanOrEqual(100_000);
    expect(state().goal).toBe(GOAL);
    // the next turn's prompt carries the goal so it is never re-asked
    await svc.builderChat('make it weekly');
    expect(prompts[1]).toContain('What the result is FOR (the owner already said — do not ask again');
    expect(prompts[1]).toContain(GOAL);
  });

  it('a cheap plan passes the gate without a goal — so when the owner insists on the literal shape, the literal (cheap) plan is shown', async () => {
    // No goal at all: a small ask must not be interrogated by the server (the rules still tell the model to ask).
    const { svc: svc1, prompts: p1 } = harness({ answer: () => ({ reply: 'Here it is. Press Create when happy.', plan: CHEAP_PROFILES }) });
    const r1 = await svc1.builderChat('list smart home profiles');
    expect(p1).toHaveLength(1);
    expect(r1.plan!.name).toBe('Smart home profiles');
    // The owner insisted on the literal ask after the mismatch was said: goal known, literal plan → shown.
    const { svc: svc2, state } = harness({ state: { log: [], spec: null, plan: null, cost: null, goal: GOAL }, answer: () => ({ reply: 'All right — the literal profile list. Press Create when happy.', goal: GOAL, plan: CHEAP_PROFILES }) });
    const r2 = await svc2.builderChat('no, just give me the profiles list');
    expect(r2.plan!.name).toBe('Smart home profiles');
    expect(r2.goal).toBe(GOAL);
    expect(state().goal).toBe(GOAL);
  });

  it('a plan that fixed its health but waits for the goal carries ONLY the goal note — the earlier "every source is failing" note does not leak (review fix)', async () => {
    // Round 1: only-failing-sources plan → health nudge. Round 2: a HEALTHY but expensive plan, still
    // no goal → held for the goal. Round 3: the model asks the question. The reply must explain the
    // hold with the goal note alone — the stale health refusal belongs to a plan that no longer exists.
    const FAILING_ONLY = { ...EXPENSIVE, sources: [{ kind: 'source', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthome' }, pages: 8 }] };
    const { svc, prompts } = harness({ answer: (prompt) => (
      /has not said what the result is FOR/.test(prompt) ? { reply: 'What will you use this result for? For example: to learn how these accounts get reach.', plan: null }
        : /every source in it is failing at the vendor today/.test(prompt) ? { reply: 'Here is a working plan instead.', plan: EXPENSIVE }
          : { reply: 'Here is the plan.', plan: FAILING_ONLY }) });
    const r = await svc.builderChat('Get me all the smart home profiles on Instagram');
    expect(prompts).toHaveLength(3); // health nudge, then goal nudge, then the question
    expect(r.plan).toBeNull();
    expect(r.reply).toContain('I first need to know what the result is FOR');
    expect(r.reply).not.toContain('Nothing in this plan can produce rows today'); // the stale note must not leak
  });

  it('the goal lands on the created agent: builderCreate and jobBuilderCreate write "For: <goal>" onto the description; reset drops the goal', async () => {
    const { plan } = validatePlan(EXPENSIVE, Object.keys(CARDS));
    const { svc, created, state } = harness({ answer: () => ({}), state: { log: [], spec: null, plan, cost: estimatePlanCost(plan!, CARDS), goal: GOAL } });
    const r = await svc.builderCreate();
    expect(r.ok).toBe(true);
    expect(created[0].description).toBe(`For: ${GOAL}`);
    expect(state().goal).toBeUndefined(); // dropped with the plan — the next design starts fresh
    // the job builder, inside its area
    const { svc: jb, created: jcreated, settings } = harness({ answer: () => ({}) });
    settings.set('agent.jobBuilder.ar1', JSON.stringify({ log: [], job: null, plan, cost: null, goal: GOAL }));
    await jb.jobBuilderCreate('ar1');
    expect(jcreated[0].description).toBe(`For: ${GOAL}`);
    // reset drops it
    const { svc: rs, state: rstate } = harness({ answer: () => ({}), state: { log: [], spec: null, plan: null, cost: null, goal: GOAL } });
    await rs.builderReset();
    expect(rstate().goal).toBeUndefined();
  });
});
