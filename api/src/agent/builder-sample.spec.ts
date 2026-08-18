import { ServiceActionsService } from '../tools/service-actions.service';
import { AgentAreasService } from './agent-areas.service';
import { BuilderSampleService, SAMPLE_CELL_CHARS, SampleView, argsText, maskSecrets, sampleFields, sampleLine, trimCell } from './builder-sample.service';
import { SAMPLE_CAPS, TOP_BUILDER_SESSION, builderSettingKey } from './builder-session';

/**
 * BEA-1370 — "look for yourself": the capped sample call a builder conversation may take.
 *
 * Locked here: a healthy read gives the compact view AND writes the ordinary `ToolCall` row with
 * `runKind:'builder'`; the two caps (calls, credits) refuse BEFORE any call; a write / a risky action
 * is refused with a reason and no row; a vendor not_found is an honest view with 0 credits; the log
 * line's exact shape; a reset clears the counter.
 */

const POSTS = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i}`,
  caption: i === 0 ? 'x'.repeat(2000) : `Smart home post ${i}`,
  owner: { username: `user${i}`, full_name: `User ${i}` },
  url: `https://instagram.com/p/${i}`,
  like_count: 10 + i,
}));

const SEARCH = { id: 'svc:instagram.search_popular', name: 'Popular Search', description: 'Popular posts for a query', service: 'instagram', risky: false, method: 'GET', schema: { type: 'object', properties: { query: { type: 'string' } } } };
const HASHTAG = { id: 'svc:instagram.search_hashtag', name: 'Hashtag Search', description: '', service: 'instagram', risky: false, method: 'GET', schema: { type: 'object', properties: { hashtag: { type: 'string' }, date_posted: { type: 'string' } } } };
const CREATE_ISSUE = { id: 'svc:github.create_an_issue', name: 'Create an issue', description: '', service: 'github', risky: false, schema: { type: 'object', properties: { title: { type: 'string' } } } };
const DELETE_REPO = { id: 'svc:github.delete_a_repository', name: 'Delete a repository', description: '', service: 'github', risky: true, schema: { type: 'object', properties: {} } };
const LIST_ISSUES = { id: 'svc:github.list_repository_issues', name: 'List repository issues', description: '', service: 'github', risky: false, schema: { type: 'object', properties: { owner: { type: 'string' } } } };

function harness(over: { result?: any; execute?: (id: string, args: any) => any; settings?: Map<string, string>; budget?: any; lastCredits?: number } = {}) {
  const rows: any[] = [];
  const settings = over.settings || new Map<string, string>();
  const prisma: any = {
    toolCall: {
      create: async ({ data }: any) => { rows.push(data); return data; },
      findFirst: async () => (over.lastCredits === undefined ? null : { credits: over.lastCredits }),
    },
    setting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => { settings.set(where.key, update?.value ?? create?.value); return {}; },
    },
    agentArea: { findUnique: async () => ({ id: 'ar1', name: 'Research Agent', tools: '[]' }) },
    agent: { findMany: async () => [] },
  };
  const socialActions: Record<string, any> = { [SEARCH.id]: SEARCH, [HASHTAG.id]: HASHTAG };
  const social: any = {
    readOnly: true,
    owns: async (id: string) => id.startsWith('svc:instagram.'),
    getService: async () => ({ slug: 'instagram', name: 'Instagram', accounts: [], noAuth: true }),
    getAction: async (id: string) => socialActions[id] || null,
    execute: jest.fn(async (id: string, args: any) => {
      if (over.execute) return over.execute(id, args);
      if (over.result !== undefined) return over.result;
      return { ok: true, data: { success: true, credits_charged: 1, posts: POSTS }, credits: 1, ms: 480 };
    }),
    refresh: jest.fn(),
    listServices: async () => [{ slug: 'instagram' }],
  };
  const composioActions: Record<string, any> = { [CREATE_ISSUE.id]: CREATE_ISSUE, [DELETE_REPO.id]: DELETE_REPO, [LIST_ISSUES.id]: LIST_ISSUES };
  const services: any = {
    getService: async () => ({ slug: 'github', name: 'GitHub', accounts: [{ id: 'ca_1', label: 'sandy', status: 'ACTIVE' }] }),
    getAction: async (id: string) => composioActions[id] || null,
    execute: jest.fn(async () => ({ ok: true, data: [{ number: 1, title: 'A bug' }], ms: 50 })),
    refresh: jest.fn(),
  };
  const llm: any = { completeHelper: jest.fn(async () => '{}'), complete: jest.fn(async () => 'INVENTED') };
  const actions = new ServiceActionsService(services, llm, prisma, undefined, social);
  const svc = new BuilderSampleService(actions, services, social, prisma);
  if (over.budget) svc.setBudget(over.budget);
  const areas = new AgentAreasService(prisma, undefined as any, { completeHelper: async () => '{"reply":"ok","job":null,"spec":null}' } as any, { get: async () => 'T {{conversation}} {{agent}} {{tools}}' } as any, { catalog: async () => ({ groups: [], tools: [] }) } as any);
  return { svc, rows, settings, social, services, llm, areas };
}

const stateOf = (settings: Map<string, string>, session: string) => JSON.parse(settings.get(builderSettingKey(session)) || '{}');

describe('the builder samples a read (BEA-1370)', () => {
  it('a healthy read → count, fields with kinds, ≤3 trimmed items, credits, and a ToolCall row with runKind builder', async () => {
    const { svc, rows, settings, social } = harness();
    const v = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'home automation' });

    expect(v.ok).toBe(true);
    expect(v.name).toBe('Instagram · Popular Search');
    expect(v.count).toBe(12);
    expect(v.listKey).toBe('posts');
    expect(v.items).toHaveLength(3);
    // trimmed: the 2000-char caption is cut at the cell cap
    expect(String(v.items[0].caption).length).toBeLessThanOrEqual(SAMPLE_CELL_CHARS);
    expect(v.items[1].caption).toBe('Smart home post 1');
    // fields with kinds, relative to one item, by the know-how card's own rule
    const kinds = Object.fromEntries(v.fields.map((f) => [f.path, f.kind]));
    expect(kinds).toMatchObject({ id: 'id', caption: 'text', 'owner.username': 'text', url: 'url', like_count: 'number' });
    expect(v.hasDate).toBe(false);
    expect(v.credits).toBe(1);
    expect(v.ms).toBe(480);
    expect(v.budget).toEqual({ used: 1, calls: SAMPLE_CAPS.calls, credits: 1, maxCredits: SAMPLE_CAPS.credits });

    // the arguments went out exactly as given (pinned) — no model call
    expect(social.execute).toHaveBeenCalledWith(SEARCH.id, { query: 'home automation' }, {});
    // the ordinary flight-recorder row, marked as the builder's
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, runKind: 'builder', action: SEARCH.id, credits: 1, runId: builderSettingKey(TOP_BUILDER_SESSION) });

    // the conversation carries the counter and the line the owner sees
    const st = stateOf(settings, TOP_BUILDER_SESSION);
    expect(st.samples).toEqual({ used: 1, credits: 1 });
    expect(st.log).toHaveLength(1);
    expect(st.log[0].who).toBe('ai');
    expect(st.log[0].kind).toBe('sample');
    expect(st.log[0].text).toBe('🔎 I tried Instagram · Popular Search (query: home automation) — 12 posts · fields: id, caption, owner, url, like_count · no date field · 1 credit');
  });

  it('a job builder session is charged to that area\'s conversation, and the top-level one is separate', async () => {
    const { svc, settings } = harness();
    await svc.sample('ar1', SEARCH.id, { query: 'x' });
    expect(stateOf(settings, 'ar1').samples).toEqual({ used: 1, credits: 1 });
    expect(settings.has(builderSettingKey(TOP_BUILDER_SESSION))).toBe(false);
  });

  it('the 4th sample in one conversation is refused with the plain reason, and no call is made', async () => {
    const { svc, social, rows } = harness();
    for (let i = 0; i < SAMPLE_CAPS.calls; i++) {
      const v = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: `q${i}` });
      expect(v.ok).toBe(true);
    }
    expect(social.execute).toHaveBeenCalledTimes(3);
    const v = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'one more' });
    expect(v.ok).toBe(false);
    expect(v.refused).toBe(true);
    expect(v.error).toBe('sample budget used (3 of 3 samples · 3 of 5 credits) — ask me instead');
    expect(social.execute).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(3);
  });

  it('the credit cap: a call that would pass 5 credits is refused before it is made', async () => {
    // Two samples at 3 credits each: the first passes (3), the second would make 6 → refused.
    const { svc, social } = harness({ result: { ok: true, data: { posts: POSTS.slice(0, 2) }, credits: 3, ms: 10 }, lastCredits: 3 });
    const a = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'a' });
    expect(a.ok).toBe(true);
    expect(a.budget.credits).toBe(3);
    const b = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'b' });
    expect(b.refused).toBe(true);
    expect(b.error).toBe('sample budget used (1 of 3 samples · 3 of 5 credits (this one would cost about 3)) — ask me instead');
    expect(social.execute).toHaveBeenCalledTimes(1);
  });

  it('once 5 credits are spent, the next sample is refused even at 1 credit', async () => {
    const settings = new Map<string, string>();
    settings.set(builderSettingKey(TOP_BUILDER_SESSION), JSON.stringify({ log: [], spec: null, samples: { used: 2, credits: 5 } }));
    const { svc, social } = harness({ settings });
    const v = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'q' });
    expect(v.refused).toBe(true);
    expect(v.error).toContain('5 of 5 credits');
    expect(social.execute).not.toHaveBeenCalled();
  });

  it('a write is refused with a reason — no call, no ToolCall row', async () => {
    const { svc, services, rows } = harness();
    const v = await svc.sample(TOP_BUILDER_SESSION, CREATE_ISSUE.id, { title: 'x' });
    expect(v.ok).toBe(false);
    expect(v.refused).toBe(true);
    expect(v.error).toBe('I only sample reads — "Create an issue" changes something, so I did not try it. Ask me instead.');
    expect(services.execute).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
    // and it did not count against the budget
    expect(v.budget.used).toBe(0);
  });

  it('a risky (gated) action is refused with a reason — never a gate pause', async () => {
    const { svc, services, rows } = harness();
    const v = await svc.sample(TOP_BUILDER_SESSION, DELETE_REPO.id, {});
    expect(v.refused).toBe(true);
    expect(v.error).toBe('I only sample reads — "Delete a repository" cannot be undone, so I did not try it. Ask me instead.');
    expect(services.execute).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('a Composio read (verb-first) is allowed, and its view has no credits (the provider does not meter)', async () => {
    const { svc, services } = harness();
    const v = await svc.sample(TOP_BUILDER_SESSION, LIST_ISSUES.id, { owner: 'inai-sandy' });
    expect(v.ok).toBe(true);
    expect(services.execute).toHaveBeenCalledTimes(1);
    expect(v.count).toBe(1);
    expect(v.credits).toBe(0);
    expect(v.name).toBe('GitHub · List repository issues');
  });

  it('an action it cannot load is refused, not tried', async () => {
    const { svc, services, social } = harness();
    const v = await svc.sample(TOP_BUILDER_SESSION, 'svc:github.no_such_thing', {});
    expect(v.refused).toBe(true);
    expect(v.error).toContain('could not load');
    expect(services.execute).not.toHaveBeenCalled();
    expect(social.execute).not.toHaveBeenCalled();
  });

  it('the daily Social ceiling is checked first, like a job — over → refused, no call', async () => {
    const budget = { check: jest.fn(async () => ({ ok: false, spent: 498, ceiling: 500, estimate: 3, reason: 'over' })) };
    const { svc, social, rows } = harness({ budget });
    const v = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'q' });
    expect(budget.check).toHaveBeenCalledWith(SEARCH.id);
    expect(v.refused).toBe(true);
    expect(v.error).toBe('The daily Social credit ceiling would be passed (498 of 500 credits spent today), so I did not try it. Ask me instead.');
    expect(social.execute).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('two samples landing together are taken one at a time — the cap holds', async () => {
    const settings = new Map<string, string>();
    settings.set(builderSettingKey(TOP_BUILDER_SESSION), JSON.stringify({ log: [], spec: null, samples: { used: 2, credits: 2 } }));
    const { svc, social } = harness({ settings });
    const [a, b] = await Promise.all([svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'a' }), svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'b' })]);
    expect(a.ok).toBe(true);
    expect(b.refused).toBe(true);
    expect(social.execute).toHaveBeenCalledTimes(1);
  });

  it('a ceiling check that cannot answer refuses (fails closed), and secret-named arguments are masked in what is shown', async () => {
    const budget = { check: jest.fn(async () => { throw new Error('db down'); }) };
    const { svc, social } = harness({ budget });
    const v = await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'q', api_key: 'sk-live-123' });
    expect(v.refused).toBe(true);
    expect(v.error).toContain('could not check the daily Social credit ceiling');
    expect(social.execute).not.toHaveBeenCalled();
    expect(v.args).toEqual({ query: 'q', api_key: '••••' });
    expect(maskSecrets({ token: 'x', q: 'y' })).toEqual({ token: '••••', q: 'y' });
  });

  it('a vendor not_found is an honest view: the plain reason, 0 credits, still one sample used, still a line', async () => {
    const { svc, settings, rows } = harness({ result: { ok: false, error: 'not_found (No posts found)', status: 404, notFound: true, credits: 0, ms: 300 } });
    const v = await svc.sample(TOP_BUILDER_SESSION, HASHTAG.id, { hashtag: 'smarthome', date_posted: 'last-month' });
    expect(v.ok).toBe(false);
    expect(v.refused).toBeUndefined();
    expect(v.notFound).toBe(true);
    expect(v.credits).toBe(0);
    expect(v.count).toBe(0);
    expect(v.error).toContain('not_found');
    expect(v.budget).toEqual({ used: 1, calls: 3, credits: 0, maxCredits: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, runKind: 'builder', credits: 0 });
    const st = stateOf(settings, TOP_BUILDER_SESSION);
    expect(st.log[0].text).toBe('🔎 I tried Instagram · Hashtag Search (hashtag: smarthome, date_posted: last-month) — no luck: Instagram could not do that: not_found (No posts found) · 0 credits');
  });

  it('a reset of the conversation clears the counter (top-level and per-area)', async () => {
    const { svc, settings, areas } = harness();
    await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'q' });
    await svc.sample('ar1', SEARCH.id, { query: 'q' });
    expect(stateOf(settings, TOP_BUILDER_SESSION).samples.used).toBe(1);
    expect(stateOf(settings, 'ar1').samples.used).toBe(1);
    await areas.builderReset();
    await areas.jobBuilderReset('ar1');
    expect(stateOf(settings, TOP_BUILDER_SESSION).samples).toBeUndefined();
    expect(stateOf(settings, 'ar1').samples).toBeUndefined();
    expect(await svc.budgetOf(TOP_BUILDER_SESSION)).toEqual({ used: 0, credits: 0 });
  });

  it('a chat turn keeps the counter and the sample line (the builders carry `samples` through)', async () => {
    const { svc, settings, areas } = harness();
    await svc.sample(TOP_BUILDER_SESSION, SEARCH.id, { query: 'q' });
    await svc.sample('ar1', SEARCH.id, { query: 'q' });
    await areas.builderChat('hello');
    await areas.jobBuilderChat('ar1', 'hello');
    expect(stateOf(settings, TOP_BUILDER_SESSION).samples).toEqual({ used: 1, credits: 1 });
    expect(stateOf(settings, 'ar1').samples).toEqual({ used: 1, credits: 1 });
    expect(stateOf(settings, 'ar1').log[0].kind).toBe('sample');
  });
});

describe('the pure helpers', () => {
  const base = (over: Partial<SampleView>): SampleView => ({ ok: true, actionId: 'svc:instagram.search_popular', name: 'Instagram · Popular Search', args: {}, count: 0, fields: [], hasDate: false, items: [], credits: 0, ms: 0, budget: { used: 1, calls: 3, credits: 1, maxCredits: 5 }, ...over });

  it('sampleLine — the healthy shape, with a date field named when there is one', () => {
    const v = base({ args: { query: 'home automation' }, count: 12, listKey: 'posts', credits: 1, fields: [{ path: 'caption', kind: 'text' }, { path: 'owner.username', kind: 'text' }, { path: 'url', kind: 'url' }, { path: 'taken_at', kind: 'date' }] });
    expect(sampleLine(v)).toBe('🔎 I tried Instagram · Popular Search (query: home automation) — 12 posts · fields: caption, owner, url, taken_at · has a date field (taken_at) · 1 credit');
    expect(sampleLine(base({ count: 0, credits: 0 }))).toBe('🔎 I tried Instagram · Popular Search — nothing came back · no fields to show · no date field · 0 credits');
    expect(sampleLine(base({ count: 1, credits: 2, fields: [{ path: 'username', kind: 'text' }] }))).toBe('🔎 I tried Instagram · Popular Search — 1 record · fields: username · no date field · 2 credits');
  });

  it('sampleLine — the failure shape and the field ellipsis', () => {
    expect(sampleLine(base({ ok: false, args: { hashtag: 'smarthome' }, error: 'Instagram could not do that: not_found (No posts found).' }))).toBe('🔎 I tried Instagram · Popular Search (hashtag: smarthome) — no luck: Instagram could not do that: not_found (No posts found) · 0 credits');
    const many = base({ count: 3, listKey: 'items', credits: 1, fields: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((p) => ({ path: p, kind: 'text' as const })) });
    expect(sampleLine(many)).toContain('fields: a, b, c, d, e, f… ·');
  });

  it('argsText / trimCell / sampleFields', () => {
    expect(argsText({ query: 'x', _pages: 3, empty: '', n: 2 })).toBe(' (query: x, n: 2)');
    expect(argsText({})).toBe('');
    expect(trimCell('y'.repeat(1000)).length).toBe(SAMPLE_CELL_CHARS);
    expect(trimCell(5)).toBe(5);
    expect(trimCell(null)).toBe('');
    const f = sampleFields({ success: true, credits_charged: 1, posts: [{ id: 'a', taken_at: 1720000000, tags: ['x'], owner: { username: 'u' } }] }, 'posts');
    expect(f).toEqual([{ path: 'id', kind: 'id' }, { path: 'taken_at', kind: 'date' }, { path: 'owner.username', kind: 'text' }]);
    // a single record: its own fields, envelope skipped
    expect(sampleFields({ success: true, user: { username: 'u', follower_count: 3 } })).toEqual([{ path: 'user.username', kind: 'text' }, { path: 'user.follower_count', kind: 'number' }]);
  });
});
