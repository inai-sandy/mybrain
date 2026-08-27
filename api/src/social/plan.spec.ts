import { KEEP_AS_FETCHED, blockOf, clampPages, costLineText, creatorField, creditsText, dateFieldOf, dedupeKey, downText, estimatePlanCost, isDirectFetchAgent, itemDate, nextCursorOf, pagingOf, planActionIds, planFromAgent, planHasHealthySource, rupees, sourceHint, sourceLabel } from './plan';
import { normaliseToolArgs } from './tool-args';

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

/**
 * BEA-1374 — sources are keyed by SOURCE id: several sources may share one action (five hashtags),
 * the old per-action storage reads unchanged, and the owner's live agent keeps its exact plan.
 */
describe('planFromAgent — sources keyed by source id (BEA-1374)', () => {
  const HASHTAGS = ['smarthomeindia', 'homeautomationindia', 'smarthome', 'homeautomation', 'smartlighting'];
  const fiveHashtags = () => {
    const toolArgs: Record<string, any> = {};
    HASHTAGS.forEach((h, i) => { toolArgs[i ? `svc:instagram.search_hashtag#${i + 1}` : 'svc:instagram.search_hashtag'] = { actionId: 'svc:instagram.search_hashtag', args: { hashtag: h }, _pages: 3 }; });
    return { id: 'ag5', name: 'Five hashtags', tools: ['svc:instagram.search_hashtag'], toolArgs, prompt: KEEP_AS_FETCHED, outputDest: 'sheet', sheetId: null };
  };

  it('five hashtag sources on ONE action → five source blocks, each with its own id, args and pages; the job is a direct fetch', () => {
    const p = planFromAgent(fiveHashtags());
    expect(p.sources).toHaveLength(5);
    expect(p.sources.map((s) => s.id)).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_hashtag#2', 'svc:instagram.search_hashtag#3', 'svc:instagram.search_hashtag#4', 'svc:instagram.search_hashtag#5']);
    expect(p.sources.map((s: any) => s.actionId)).toEqual(Array(5).fill('svc:instagram.search_hashtag'));
    expect(p.sources.map((s: any) => s.args.hashtag)).toEqual(HASHTAGS);
    expect(p.sources.map((s: any) => s.pages)).toEqual([3, 3, 3, 3, 3]);
    expect(p.merge).toBe(true);
    expect(planActionIds(p)).toEqual(['svc:instagram.search_hashtag']);
    expect(isDirectFetchAgent(fiveHashtags())).toBe(true);
    // the cost counts every source: 5 × 3 pages × 1 credit
    expect(estimatePlanCost(p).credits).toBe(15);
  });

  it('the source column / step hint tell repeated actions apart by their telling argument, and say nothing for a lone action', () => {
    const p = planFromAgent(fiveHashtags());
    expect(sourceLabel(p.sources[0], p.sources)).toBe('instagram.search_hashtag · smarthomeindia');
    expect(sourceLabel(p.sources[1], p.sources)).toBe('instagram.search_hashtag · homeautomationindia');
    expect(sourceHint(p.sources[4], p.sources)).toBe(' (smartlighting)');
    const d = planFromAgent(digest());
    expect(sourceLabel(d.sources[0], d.sources)).toBe('instagram.search_hashtag'); // one source per action — exactly as before
    expect(sourceHint(d.sources[0], d.sources)).toBe('');
  });

  it('the OLD shape reads unchanged: the same plan as before, in tools order, and normalising it is what a save writes back', () => {
    const before = planFromAgent(digest());
    const stored = normaliseToolArgs(digest().toolArgs);
    const after = planFromAgent({ ...digest(), toolArgs: stored });
    expect(after).toEqual(before);
    // tools order still wins over storage order for one-source-per-action jobs
    const shuffled = { ...digest(), toolArgs: { 'svc:instagram.search_popular': { query: 'homeautomation', _pages: 5 }, 'svc:instagram.search_hashtag': { hashtag: 'smarthome', date_posted: 'last-month' }, 'svc:instagram.reels_search': { query: 'smarthome', date_posted: 'last-month' } } };
    expect(planFromAgent(shuffled).sources.map((s) => s.id)).toEqual(before.sources.map((s) => s.id));
  });

  it("the owner's live agent (83ff0b15…, read before this change) → the exact same plan: 3 sources, popular × 5, Monday 08:00, WhatsApp on", () => {
    // `GET /api/agent/agents/83ff0b15-0d28-4aea-b771-138251fa944d` on 2026-08-18, before BEA-1374 shipped.
    const live = {
      id: '83ff0b15-0d28-4aea-b771-138251fa944d', name: 'Smart Home India — Instagram digest',
      tools: ['svc:instagram.search_hashtag', 'svc:instagram.reels_search', 'svc:instagram.search_popular'],
      toolArgs: { 'svc:instagram.search_hashtag': { hashtag: 'smarthome', date_posted: 'last-month' }, 'svc:instagram.reels_search': { query: 'smarthome', date_posted: 'last-month' }, 'svc:instagram.search_popular': { query: 'homeautomation', _pages: 5 } },
      outputDest: 'sheet', sheetId: null, notifyWhatsApp: true, mode: 'run', schedule: { every: 'week', dow: 1, at: '08:00' }, scheduleText: 'Every Monday at 08:00',
      prompt: 'Merge all sources into one list and de-duplicate on shortcode (or the post link). Keep only posts related to smart home / home automation in India, from the last 30 days when the post has a date — recall over precision: when unsure whether it is India, keep it. Columns: creator, followers, date, likes, views, paid partnership, location, caption, link. Leave a cell blank when the post does not say.',
    };
    const p = planFromAgent(live);
    expect(p.sources).toEqual([
      { kind: 'source', id: 'svc:instagram.search_hashtag', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthome', date_posted: 'last-month' }, pages: 1 },
      { kind: 'source', id: 'svc:instagram.reels_search', actionId: 'svc:instagram.reels_search', args: { query: 'smarthome', date_posted: 'last-month' }, pages: 1 },
      { kind: 'source', id: 'svc:instagram.search_popular', actionId: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, pages: 5 },
    ]);
    expect(p.output).toEqual({ kind: 'sheet', sheetId: null, append: false });
    expect(p.notify).toEqual({ whatsapp: true, telegram: false });
    expect(p.schedule).toEqual({ schedule: { every: 'week', dow: 1, at: '08:00' }, text: 'Every Monday at 08:00' });
    expect(estimatePlanCost(p).credits).toBe(7);
    // and the same after a save has rewritten the storage in the new shape
    expect(planFromAgent({ ...live, toolArgs: normaliseToolArgs(live.toolArgs) })).toEqual(p);
  });

  it('"keep adding" → append:true on one sheet even before it exists (Agent.sheetAppend); a named sheet still appends', () => {
    expect(planFromAgent({ ...digest(), sheetAppend: true }).output).toEqual({ kind: 'sheet', sheetId: null, append: true });
    expect(planFromAgent({ ...digest(), sheetAppend: true, sheetId: 'S9' }).output).toEqual({ kind: 'sheet', sheetId: 'S9', append: true });
    expect(planFromAgent({ ...digest(), sheetAppend: true, outputDest: 'document' }).output).toEqual({ kind: 'document', sheetId: null, append: false });
  });

  it('a new-shape value handed to blockOf reads too (the UI-facing helper)', () => {
    expect(blockOf('svc:a.b#2', { actionId: 'svc:a.b', args: { q: 'y' }, _pages: 4 })).toEqual({ kind: 'source', id: 'svc:a.b#2', actionId: 'svc:a.b', args: { q: 'y' }, pages: 4 });
    expect(blockOf('svc:a.b#2', { q: 'y' })).toEqual({ kind: 'source', id: 'svc:a.b#2', actionId: 'svc:a.b', args: { q: 'y' }, pages: 1 });
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
    // ≈ ₹ for the AI part (BEA-1372): a stated rate, in the how, 0 with no shaping
    expect(noCards.aiRupees).toBe(rupees(84 * 300));
    expect(noCards.how).toMatch(/≈ ₹\d+(\.\d)? \(at ₹0\.3 per 1k tokens, Sonnet\)/);
    expect(rupees(0)).toBe(0);
    expect(rupees(60_000)).toBe(18);
    expect(rupees(500)).toBe(0.2);
    const cards = { 'svc:instagram.search_popular': { cost: { credits: { typical: 2 } }, paging: { pageSize: 10 } } };
    const withCards = estimatePlanCost(p, cards);
    expect(withCards.credits).toBe(1 + 1 + 10);
    expect(withCards.items).toBe(12 + 12 + 50);
    // creators-first, no shaping
    const c = planFromAgent({ tools: ['svc:instagram.search_profiles'], toolArgs: { 'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: {}, take: 5 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' } } } }, prompt: KEEP_AS_FETCHED });
    const cc = estimatePlanCost(c);
    expect(cc.credits).toBe(6);
    expect(cc.aiTokens).toBe(0);
    expect(cc.aiRupees).toBe(0);
    expect(cc.how).toMatch(/no AI shaping — rows as fetched/);
    expect(cc.how).toMatch(/once \(1\) \+ 5 creators × 1 credit = 6/);
    // a watch never shapes
    expect(estimatePlanCost(planFromAgent({ ...digest(), mode: 'watch' })).aiTokens).toBe(0);
  });

  it('nowCredits (BEA-1375): what the run costs TODAY — a failing source is not counted; a failing finder finds no one; a failing per-creator action leaves the finder only', () => {
    const failing = { name: 'Popular Search', health: { known: true, ok: false, note: 'not_found for every call since 09:10Z' } };
    const p = planFromAgent(digest()); // search_hashtag + search_profiles + popular × 5 pages, all 1 credit
    const all = estimatePlanCost(p, {});
    expect(all.nowCredits).toBe(all.credits);
    expect(all.unhealthy).toBeUndefined();
    const popDown = estimatePlanCost(p, { 'svc:instagram.search_popular': failing });
    expect(popDown.credits).toBe(7);
    expect(popDown.nowCredits).toBe(2);
    expect(popDown.unhealthy).toEqual([{ actionId: 'svc:instagram.search_popular', name: 'Popular Search', note: 'not_found for every call since 09:10Z' }]);
    expect(popDown.how).toContain('(≈ 2 credits today while Popular Search is down — a failing call answers empty and is not charged)');
    expect(creditsText(popDown)).toBe('≈ 7 credits (≈ 2 while Popular Search is down)');
    // no verdict (known:false) is not failing; a name-less card falls back to the short name
    expect(estimatePlanCost(p, { 'svc:instagram.search_popular': { health: { known: false, ok: false } } }).nowCredits).toBe(7);
    expect(estimatePlanCost(p, { 'svc:instagram.search_popular': { health: { known: true, ok: false } } }).unhealthy![0]).toEqual({ actionId: 'svc:instagram.search_popular', name: 'Instagram search popular', note: 'every recent call failed' });
    // creators block: finder failing → 0 today; per-creator action failing → the finder's 1 credit only
    const c = planFromAgent({ tools: ['svc:instagram.search_profiles'], toolArgs: { 'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: {}, take: 5 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' } } } }, prompt: KEEP_AS_FETCHED });
    expect(estimatePlanCost(c, { 'svc:instagram.search_profiles': failing }).nowCredits).toBe(0);
    expect(estimatePlanCost(c, { 'svc:instagram.user_posts': failing }).nowCredits).toBe(1);
    expect(planHasHealthySource(c, { 'svc:instagram.search_profiles': failing })).toBe(false);
    expect(planHasHealthySource(c, { 'svc:instagram.user_posts': failing })).toBe(false);
    expect(planHasHealthySource(c, {})).toBe(true);
    // two down → "X and Y are down"
    expect(downText(['A', 'B'])).toBe('A and B are down');
    expect(downText(['A', 'B', 'C'])).toBe('A, B and C are down');
    expect(costLineText({ ...popDown, aiTokens: 0 })).toBe('≈ 7 credits (≈ 2 while Popular Search is down) per run · no AI cost');
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

/**
 * THE CURSOR THE CARD NAMES (BEA-1497).
 *
 * His ESP32 agent asked for 100 posts, fetched page 1, and stopped at 19 — reporting "that was
 * everything after 1 page". It was not. The answer carried `after: "t3_1vwwa3b"`, and the action's
 * own know-how card said **"paging: cursor via after"** in plain words.
 *
 * The cause: `nextCursorOf` matched against a hardcoded list of names vendors might use for a
 * cursor, and `after` was not on it. That list is a guess, and every new vendor makes it more wrong.
 * When the card names the field, the card wins.
 */
describe('finding the next page', () => {
  it('uses the field the action’s card names, even when the list has never heard of it', () => {
    const answer = { posts: [], after: 't3_1vwwa3b' };
    expect(nextCursorOf(answer, 'after')).toEqual({ key: 'after', value: 't3_1vwwa3b' });
  });

  it('knows `after` now even with no card — the exact miss that cost the run', () => {
    expect(nextCursorOf({ posts: [], after: 't3_1vwwa3b' })).toEqual({ key: 'after', value: 't3_1vwwa3b' });
  });

  it('prefers the card’s field over a different one that happens to be present', () => {
    // A vendor carrying both must page the way its card says, not the way the list guesses.
    const answer = { cursor: 'guess-me', paging_id: 'x', after: 'the-real-one' };
    expect(nextCursorOf(answer, 'after')?.value).toBe('the-real-one');
  });

  it('falls back to the list when the card says nothing', () => {
    expect(nextCursorOf({ next_max_id: 'abc' })?.key).toBe('next_max_id');
  });

  it('treats an absent or empty cursor as the end, however it is named', () => {
    expect(nextCursorOf({ posts: [], after: null }, 'after')).toBeNull();
    expect(nextCursorOf({ posts: [], after: '' }, 'after')).toBeNull();
    expect(nextCursorOf({ posts: [] }, 'after')).toBeNull();
    expect(nextCursorOf(null, 'after')).toBeNull();
  });
});
