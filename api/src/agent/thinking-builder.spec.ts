import { AgentAreasService } from './agent-areas.service';
import { CEILING_NOTE, KEEP_AS_FETCHED, estimatePlanCost, planFromAgent } from '../social/plan';
import type { ToolKnowledge } from '../tools/tool-knowledge.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService } from '../llm/llm.service';
import {
  DESIGN_BUDGET, SAMPLE_LOOPS_PER_MESSAGE, budgetLine, cardText, factsSection, fillTemplate, healthNote, overBudget, parseBuilderJson, pickCardIds, planToAgentInput,
  sampleViewText, validatePlan,
} from './thinking-builder';

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
    expect(input.toolArgs['svc:instagram.search_hashtag']).toEqual({ hashtag: 'smarthomeindia', _pages: 8 });
    expect(input.toolArgs['svc:instagram.search_profiles'].kind).toBe('creators');
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
  });

  it('rejects what the cards do not list, twice-used ids, and creators without a per-creator action', () => {
    expect(validatePlan({ name: 'x', sources: [{ actionId: 'svc:instagram.search_location', args: {} }] }, Object.keys(CARDS)).errors[0]).toMatch(/not one of the actions you were shown/);
    expect(validatePlan({ name: 'x', sources: [{ actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'a' } }, { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'b' } }] }, Object.keys(CARDS)).errors[0]).toMatch(/used twice/);
    expect(validatePlan({ name: 'x', sources: [{ kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: {} }, then: { argsFrom: { handle: 'username' } } }] }, Object.keys(CARDS)).errors.join(' ')).toMatch(/then\.actionId/);
    expect(validatePlan({ name: '', sources: [] }).errors).toEqual(['plan.name is missing', 'plan.sources must have at least one source']);
    expect(validatePlan(null).errors).toEqual(['plan must be an object']);
    expect(validatePlan({ ...SOCIAL_PLAN, schedule: { every: 'week', at: '8am' } }, Object.keys(CARDS)).errors[0]).toMatch(/plan\.schedule must be/);
    expect(validatePlan({ ...SOCIAL_PLAN, schedule: { every: 'hour' } }, Object.keys(CARDS)).errors).toEqual([]);
  });

  it('a bad plan is sent back to the model ONCE with the reasons; the fixed one is kept', async () => {
    const bad = { ...SOCIAL_PLAN, sources: [{ kind: 'source', actionId: 'svc:instagram.search_location', args: { q: 'India' } }] };
    const { svc, prompts, state } = harness({ answer: (prompt) => (/did not validate/.test(prompt) ? { reply: 'Fixed — here is the plan. Press Create when happy.', plan: SOCIAL_PLAN } : { reply: 'Here is the plan.', plan: bad }) });
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
    const { svc, state } = harness({ answer: (_p, n) => (n === 1 ? { reply: 'Plan for the area.', spec } : { reply: 'Direct plan instead.', plan: SOCIAL_PLAN }) });
    const r1 = await svc.builderChat('a daily news agent');
    expect(r1.spec.area.name).toBe('Daily News');
    expect(r1.plan).toBeNull();
    const r2 = await svc.builderChat('actually, instagram smart home posts');
    expect(r2.plan!.name).toBe(SOCIAL_PLAN.name);
    expect(state().spec).toBeNull();
  });
});

// ---- (d) the design budget ---------------------------------------------------------------------------

describe('the design budget (BEA-1371)', () => {
  it('under budget the model is told where it stands; over it, to propose the best plan and stop asking', () => {
    expect(budgetLine({ turns: 2, tokens: 9_000 })).toContain('turn 3 of 12');
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
    const { svc } = harness({ answer: () => ({ reply: 'Here is the plan — press Create when happy.', plan: SOCIAL_PLAN }) });
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
    expect(parseBuilderJson('{"reply":"hi","plan":{"name":"x"')).toEqual({ reply: 'hi', plan: { name: 'x' } });
    expect(parseBuilderJson('nothing')).toBeNull();
  });

  it('both prompt defaults carry the facts, blocks, sample, budget and rules slots and the plan shape', async () => {
    const prisma: any = { setting: { findUnique: async () => null } };
    for (const key of ['agent.builder', 'agent.jobBuilder'] as const) {
      const tpl = await new PromptsService(prisma).get(key);
      for (const slot of ['{{conversation}}', '{{facts}}', '{{tools}}', '{{blocks}}', '{{sample}}', '{{budget}}', '{{rules}}']) expect(tpl).toContain(slot);
      expect(tpl).toContain('"plan": null while something important is still open');
      expect(tpl).toContain('"kind":"creators"');
    }
  });
});
