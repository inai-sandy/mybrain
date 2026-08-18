import { actionIdsOf, entryOf, legacyValueOf, normaliseToolArgs, sourceIdFor, toolsFor } from './tool-args';

/**
 * BEA-1374 — `Agent.toolArgs` is keyed by SOURCE id, and the older per-action shape reads
 * transparently through the ONE reader every consumer uses (`normaliseToolArgs`).
 */
describe('normaliseToolArgs (BEA-1374)', () => {
  it('the old shape { "<svc id>": args } → { "<svc id>": { actionId, args } } — source id = the action id, `_pages` lifted beside the args', () => {
    const old = {
      'svc:instagram.search_hashtag': { hashtag: 'smarthome', date_posted: 'last-month' },
      'svc:instagram.search_popular': { query: 'homeautomation', _pages: 5 },
    };
    expect(normaliseToolArgs(old)).toEqual({
      'svc:instagram.search_hashtag': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthome', date_posted: 'last-month' } },
      'svc:instagram.search_popular': { actionId: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, _pages: 5 },
    });
  });

  it('the new shape passes through — five hashtags on ONE action are five sources', () => {
    const tags = ['smarthomeindia', 'homeautomationindia', 'smarthome', 'homeautomation', 'smartlighting'];
    const map: Record<string, any> = {};
    tags.forEach((t, i) => { map[i ? `svc:instagram.search_hashtag#${i + 1}` : 'svc:instagram.search_hashtag'] = { actionId: 'svc:instagram.search_hashtag', args: { hashtag: t }, _pages: 3 }; });
    const out = normaliseToolArgs(map);
    expect(Object.keys(out)).toHaveLength(5);
    expect(new Set(Object.values(out).map((e: any) => e.actionId))).toEqual(new Set(['svc:instagram.search_hashtag']));
    expect(out['svc:instagram.search_hashtag#3']).toEqual({ actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthome' }, _pages: 3 });
    // and it is idempotent
    expect(normaliseToolArgs(out)).toEqual(out);
  });

  it('a creators block is the same in both shapes; a finder id missing inside it comes from the key', () => {
    const block = { kind: 'creators', find: { args: { query: 'smart home india' }, take: 10 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, keepDays: 30 } };
    const out = normaliseToolArgs({ 'svc:instagram.search_profiles': block, 'svc:instagram.search_profiles#2': { ...block, find: { ...block.find, actionId: 'svc:instagram.search_profiles' } } });
    expect((out['svc:instagram.search_profiles'] as any).find.actionId).toBe('svc:instagram.search_profiles');
    expect((out['svc:instagram.search_profiles#2'] as any).find.actionId).toBe('svc:instagram.search_profiles');
    expect((out['svc:instagram.search_profiles'] as any).then).toEqual(block.then);
  });

  it('a mix of shapes reads, junk is skipped, and not-an-object → {}', () => {
    const out = normaliseToolArgs({ 'svc:a.b': { q: 1 }, 'svc:a.b#2': { actionId: 'svc:a.b', args: { q: 2 } }, nope: 'text', 'svc:c.d': null, 'svc:e.f': [1, 2] });
    expect(Object.keys(out)).toEqual(['svc:a.b', 'svc:a.b#2']);
    expect(out['svc:a.b']).toEqual({ actionId: 'svc:a.b', args: { q: 1 } });
    expect(out['svc:a.b#2']).toEqual({ actionId: 'svc:a.b', args: { q: 2 } });
    expect(normaliseToolArgs(null)).toEqual({});
    expect(normaliseToolArgs('x')).toEqual({});
    expect(normaliseToolArgs([])).toEqual({});
  });

  it('legacyValueOf ↔ entryOf round-trip: the editors keep their per-source value', () => {
    const e = { actionId: 'svc:instagram.search_popular', args: { query: 'x' }, _pages: 4 };
    expect(legacyValueOf(e)).toEqual({ query: 'x', _pages: 4 });
    expect(entryOf('svc:instagram.search_popular', { query: 'x', _pages: 4 })).toEqual(e);
    expect(legacyValueOf({ actionId: 'svc:a.b', args: { q: 1 }, _pages: 1 })).toEqual({ q: 1 }); // 1 page = no key
  });

  it('sourceIdFor: the action id first, then #2, #3 — never one already taken', () => {
    expect(sourceIdFor('svc:a.b', [])).toBe('svc:a.b');
    expect(sourceIdFor('svc:a.b', ['svc:a.b'])).toBe('svc:a.b#2');
    expect(sourceIdFor('svc:a.b', ['svc:a.b', 'svc:a.b#2', 'svc:a.b#3'])).toBe('svc:a.b#4');
    expect(sourceIdFor('svc:a.b', ['svc:a.b', 'svc:a.b#3'])).toBe('svc:a.b#2');
  });

  it('actionIdsOf / toolsFor: every action the sources call, deduped; a source id that slipped into tools is dropped', () => {
    const map = normaliseToolArgs({
      'svc:instagram.search_hashtag': { hashtag: 'a' },
      'svc:instagram.search_hashtag#2': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'b' } },
      'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: {} }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' } } },
    });
    expect(actionIdsOf(map)).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_profiles', 'svc:instagram.user_posts']);
    expect(toolsFor(map, ['svc:instagram.search_hashtag#2', 'web_search', 'svc:instagram.search_hashtag'])).toEqual(['web_search', 'svc:instagram.search_hashtag', 'svc:instagram.search_profiles', 'svc:instagram.user_posts']);
  });
});
