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

describe('the chat designs nothing (BEA-1466)', () => {
  it('both builder prompts say so, in his own words', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const src = readFileSync(join(__dirname, '../prompts/prompts.service.ts'), 'utf8');

    // Twice: the top builder and the per-job builder. One of them left as it was would be the same
    // "two places, one rule" failure that has cost a live run three times this week.
    expect(src.split('THE ONE RULE').length - 1).toBeGreaterThanOrEqual(2);
    expect(src).toContain('It will not create any rough idea based on my discussion');
    expect(src).toContain('"brief": null. ALWAYS null');
    expect(src).toContain('"job": null. ALWAYS null');
  });

  it('tells it to collect the tools HE names, and only those', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const src = readFileSync(join(__dirname, '../prompts/prompts.service.ts'), 'utf8');
    expect(src).toContain('Only ids he chose, never one you thought useful');
  });

  it('forbids the summary that kept losing his requirements', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const src = readFileSync(join(__dirname, '../prompts/prompts.service.ts'), 'utf8');
    expect(src).toContain('Do NOT summarise the conversation back to him');
    expect(src).toContain('Codex\nreads the real conversation, not your version of it');
  });

  it('the turn engine drops a brief or a plan even if the model sends one anyway', () => {
    // The prompt is not the guard. This builder has talked its way past a prompt more than once, so
    // the code refuses too — `CHAT_ONLY` short-circuits both branches before they can be read.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const src = readFileSync(join(__dirname, 'agent-areas.service.ts'), 'utf8');
    expect(src).toContain('const CHAT_ONLY = true');
    expect(src).toContain('CHAT_ONLY ? null : briefRequestOf(g)');
    expect(src).toMatch(/if \(CHAT_ONLY\) break;\s*\n\s*if \(!g\?\.plan/);
  });
});
