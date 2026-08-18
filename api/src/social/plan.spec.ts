import { KEEP_AS_FETCHED, blockOf, clampPages, creatorField, dateFieldOf, dedupeKey, estimatePlanCost, itemDate, nextCursorOf, pagingOf, planActionIds, planFromAgent } from './plan';

/**
 * BEA-1369 — the plan JSON: `planFromAgent` reproduces today's jobs (pages 1, no creators), reads
 * `_pages` and a creators-first block, and `estimatePlanCost` does the arithmetic it says it does.
 */

const digest = () => ({
  id: 'ag1', name: 'Smart Home India — Instagram digest',
  tools: ['svc:instagram.search_hashtag', 'svc:instagram.reels_search', 'svc:instagram.search_popular'],
  toolArgs: {
    'svc:instagram.search_hashtag': { hashtag: 'smarthome', date_posted: 'last-month' },
    'svc:instagram.reels_search': { query: 'smarthome', date_posted: 'last-month' },
    'svc:instagram.search_popular': { query: 'homeautomation', _pages: 5 },
  },
  prompt: 'Only India. Columns: creator, link',
  outputDest: 'sheet', sheetId: null, notifyWhatsApp: true, mode: 'run',
  schedule: { every: 'week', dow: 1, at: '08:00' }, scheduleText: 'Every Monday at 08:00',
});

describe('planFromAgent', () => {
  it('reproduces an existing job: one source block per tool, pages 1 unless _pages says, args without _pages', () => {
    const p = planFromAgent(digest());
    expect(p.sources.map((s) => s.kind)).toEqual(['source', 'source', 'source']);
    expect(p.sources[0]).toEqual({ kind: 'source', id: 'svc:instagram.search_hashtag', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthome', date_posted: 'last-month' }, pages: 1 });
    expect(p.sources[2]).toEqual({ kind: 'source', id: 'svc:instagram.search_popular', actionId: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, pages: 5 });
    expect(p.merge).toBe(true);
    expect(p.shape).toEqual({ prompt: 'Only India. Columns: creator, link' });
    expect(p.watch).toBeUndefined();
    expect(p.output).toEqual({ kind: 'sheet', sheetId: null, append: false });
    expect(p.notify).toEqual({ whatsapp: true, telegram: false });
    expect(p.schedule).toEqual({ schedule: { every: 'week', dow: 1, at: '08:00' }, text: 'Every Monday at 08:00' });
    expect(p.mode).toBe('run');
    expect(p.ceilingNote).toMatch(/ceiling/);
  });

  it('as-fetched task → no shape; watch → no shape but a watch block; alert carries threshold + condition; append when a sheet id is set', () => {
    expect(planFromAgent({ ...digest(), prompt: KEEP_AS_FETCHED }).shape).toBeUndefined();
    const w = planFromAgent({ ...digest(), mode: 'watch' });
    expect(w.shape).toBeUndefined();
    expect(w.watch).toEqual({ mode: 'watch' });
    const a = planFromAgent({ ...digest(), mode: 'alert', threshold: '{"field":"follower_count","dir":"above","value":1000}', alertCondition: 'a post mentions a price', sheetId: 'S1' });
    expect(a.watch).toEqual({ mode: 'alert', threshold: { field: 'follower_count', dir: 'above', value: 1000 }, condition: 'a post mentions a price' });
    expect(a.notify.telegram).toBe(true);
    expect(a.output).toEqual({ kind: 'sheet', sheetId: 'S1', append: true });
    expect(planFromAgent({ ...digest(), outputDest: 'document' }).output).toEqual({ kind: 'document', sheetId: null, append: false });
  });

  it('a creators-first block: finder + take, then + argsFrom + keepDays, clamped; a toolArgs key the tools list forgot is still a source', () => {
    const p = planFromAgent({
      id: 'ag2', name: 'Creators', tools: ['svc:instagram.search_profiles'],
      toolArgs: { 'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 500 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, args: { trim: true }, keepDays: '30' } } },
      prompt: KEEP_AS_FETCHED,
    });
    expect(p.sources).toEqual([{ kind: 'creators', id: 'svc:instagram.search_profiles', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 50 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, args: { trim: true }, keepDays: 30 } }]);
    expect(planActionIds(p)).toEqual(['svc:instagram.search_profiles', 'svc:instagram.user_posts']);
    const stale = planFromAgent({ tools: [], toolArgs: { 'svc:x.y': { q: 1 } } });
    expect(stale.sources).toHaveLength(1);
  });

  it('clampPages: 1..11, defaults to 1', () => {
    expect([clampPages(undefined), clampPages('8'), clampPages(0), clampPages(99), clampPages('abc'), clampPages(3.7)]).toEqual([1, 8, 1, 11, 1, 3]);
    expect(blockOf('svc:a.b', { q: 'x', _pages: 2 })).toEqual({ kind: 'source', id: 'svc:a.b', actionId: 'svc:a.b', args: { q: 'x' }, pages: 2 });
  });
});

describe('estimatePlanCost', () => {
  it('pages × credits per page from the card when it says, else 1; creators = 1 + take; shaping ≈ items × 300; the how explains it', () => {
    const p = planFromAgent(digest());
    const noCards = estimatePlanCost(p);
    expect(noCards.credits).toBe(1 + 1 + 5);
    expect(noCards.items).toBe(12 * 7);
    expect(noCards.aiTokens).toBe(12 * 7 * 300);
    expect(noCards.how).toMatch(/Instagram search popular: 5 pages × 1 credit = 5/);
    expect(noCards.how).toMatch(/≈ 7 credits per run/);
    expect(noCards.how).toMatch(/shaping ≈ 84 items × 300 tokens/);
    const cards = { 'svc:instagram.search_popular': { cost: { credits: { typical: 2 } }, paging: { pageSize: 10 } } };
    const withCards = estimatePlanCost(p, cards);
    expect(withCards.credits).toBe(1 + 1 + 10);
    expect(withCards.items).toBe(12 + 12 + 50);
    // creators-first, no shaping
    const c = planFromAgent({ tools: ['svc:instagram.search_profiles'], toolArgs: { 'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: {}, take: 5 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' } } } }, prompt: KEEP_AS_FETCHED });
    const cc = estimatePlanCost(c);
    expect(cc.credits).toBe(6);
    expect(cc.aiTokens).toBe(0);
    expect(cc.how).toMatch(/once \(1\) \+ 5 creators × 1 credit = 6/);
    // a watch never shapes
    expect(estimatePlanCost(planFromAgent({ ...digest(), mode: 'watch' })).aiTokens).toBe(0);
  });
});

describe('paging + date helpers the runner uses', () => {
  it('pagingOf: the card wins; else the answer\'s cursor key names the param; else a page number in the args; else none', () => {
    expect(pagingOf({ how: 'cursor', field: 'cursor' }, {}, {})).toEqual({ param: 'cursor', how: 'cursor' });
    expect(pagingOf({ how: 'page', field: 'page' }, {}, {})).toEqual({ param: 'page', how: 'page' });
    expect(pagingOf(null, {}, { cursor: 'abc' })).toEqual({ param: 'cursor', how: 'cursor' });
    expect(pagingOf({ how: 'none' }, {}, { next_max_id: '9_1' })).toEqual({ param: 'next_max_id', how: 'cursor' });
    expect(pagingOf(null, { page: 1 }, { posts: [] })).toEqual({ param: 'page', how: 'page' });
    expect(pagingOf(null, { q: 'x' }, { posts: [] })).toBeNull();
    expect(nextCursorOf({ cursor: null, next_max_id: '5' })).toEqual({ key: 'next_max_id', value: '5' });
    expect(nextCursorOf({ cursor: false })).toBeNull();
  });
  it('itemDate reads epoch seconds, ms and ISO; dateFieldOf prefers the card\'s date field inside the list, then the usual names', () => {
    expect(itemDate({ taken_at: 1447459882 }, 'taken_at')).toBe(1447459882 * 1000);
    expect(itemDate({ t: 1447459882000 }, 't')).toBe(1447459882000);
    expect(itemDate({ d: '2026-08-01T00:00:00Z' }, 'd')).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(itemDate({ d: 'soon' }, 'd')).toBeNull();
    expect(itemDate({}, 'd')).toBeNull();
    const items = [{ id: 1, taken_at: 1447459882, caption: 'x' }];
    expect(dateFieldOf(items, [{ path: 'items[].taken_at', kind: 'date' }, { path: 'items[].caption.created_at', kind: 'date' }])).toBe('taken_at');
    expect(dateFieldOf(items, [{ path: 'items[].posted_on', kind: 'date' }])).toBe('taken_at'); // the card's field is not on the items → the usual names
    expect(dateFieldOf([{ id: 1, caption: 'no date' }], null)).toBeNull();
    expect(dateFieldOf([], null)).toBeNull();
  });
  it('dedupeKey uses the stable id, never position; creatorField reads flat, dotted and one level down', () => {
    expect(dedupeKey({ id: 'A', caption: 'x' })).toBe(dedupeKey({ id: 'A', caption: 'y' }));
    expect(dedupeKey({ shortcode: 'S1' })).not.toBe(dedupeKey({ shortcode: 'S2' }));
    expect(dedupeKey({ caption: 'same' })).toBe(dedupeKey({ caption: 'same' }));
    expect(creatorField({ username: 'a' }, 'username')).toBe('a');
    expect(creatorField({ owner: { username: 'b' } }, 'owner.username')).toBe('b');
    expect(creatorField({ user: { username: 'c' } }, 'username')).toBe('c');
    expect(creatorField({ username: '' }, 'username')).toBeUndefined();
  });
});

describe('GET /social/plan/:agentId (the job page\'s "≈ N credits per run")', () => {
  it('answers the plan + a cost from the cards it could look up; a missing agent is 404', async () => {
    const { SocialController } = await import('./social.controller');
    const agents = { getAgent: jest.fn(async (id: string) => (id === 'ag1' ? digest() : null)) };
    const knowledge = { lookup: jest.fn(async (ids: string[]) => ids.filter((i) => i === 'svc:instagram.search_popular').map((i) => ({ actionId: i, cost: { credits: { typical: 1 } }, paging: { how: 'cursor', pageSize: 12 } }))) };
    const c = new SocialController({} as any, {} as any, agents as any, knowledge as any);
    const out = await c.plan('ag1');
    expect(out.plan.sources).toHaveLength(3);
    expect(out.cost.credits).toBe(7);
    expect(knowledge.lookup).toHaveBeenCalledWith(['svc:instagram.search_hashtag', 'svc:instagram.reels_search', 'svc:instagram.search_popular']);
    await expect(c.plan('nope')).rejects.toThrow(/No such agent/);
  });
});
