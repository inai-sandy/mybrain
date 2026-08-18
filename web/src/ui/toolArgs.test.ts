import { describe, expect, it } from 'vitest';
import { addSourceRow, normaliseToolArgs, sourceIdFor, sourcesOf, toolArgsOf, toolsOf } from './toolArgs';

/** BEA-1374 — the web mirror of `api/src/social/tool-args.ts`: sources keyed by source id, old shape reads. */
describe('toolArgs (web mirror, BEA-1374)', () => {
  it('old shape → source rows (id = action id), _pages kept as the editor value; new shape passes through', () => {
    const rows = sourcesOf({ 'svc:instagram.search_hashtag': { hashtag: 'a' }, 'svc:instagram.search_popular': { query: 'q', _pages: 5 } });
    expect(rows).toEqual([
      { id: 'svc:instagram.search_hashtag', actionId: 'svc:instagram.search_hashtag', value: { hashtag: 'a' } },
      { id: 'svc:instagram.search_popular', actionId: 'svc:instagram.search_popular', value: { query: 'q', _pages: 5 } },
    ]);
    const five = sourcesOf({ 'svc:instagram.search_hashtag': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'a' }, _pages: 3 }, 'svc:instagram.search_hashtag#2': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'b' }, _pages: 3 } });
    expect(five.map((r) => [r.id, r.actionId, r.value])).toEqual([['svc:instagram.search_hashtag', 'svc:instagram.search_hashtag', { hashtag: 'a', _pages: 3 }], ['svc:instagram.search_hashtag#2', 'svc:instagram.search_hashtag', { hashtag: 'b', _pages: 3 }]]);
    expect(normaliseToolArgs(null)).toEqual({});
  });

  it('rows → toolArgs (new shape) + tools (actions once each, incl. a creators block\'s per-creator action)', () => {
    let rows = sourcesOf({ 'svc:instagram.search_hashtag': { hashtag: 'a' } });
    rows = addSourceRow(rows, 'svc:instagram.search_hashtag', { hashtag: 'b', _pages: 2 });
    rows = addSourceRow(rows, 'svc:instagram.search_hashtag', { hashtag: 'c' });
    rows = addSourceRow(rows, 'svc:instagram.search_profiles', { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'x' }, take: 5 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' } } });
    expect(rows.map((r) => r.id)).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_hashtag#2', 'svc:instagram.search_hashtag#3', 'svc:instagram.search_profiles']);
    expect(toolArgsOf(rows)).toEqual({
      'svc:instagram.search_hashtag': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'a' } },
      'svc:instagram.search_hashtag#2': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'b' }, _pages: 2 },
      'svc:instagram.search_hashtag#3': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'c' } },
      'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'x' }, take: 5 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' } } },
    });
    expect(toolsOf(rows)).toEqual(['svc:instagram.search_hashtag', 'svc:instagram.search_profiles', 'svc:instagram.user_posts']);
    // removing the first keeps #2 and #3 as they are — ids are stable
    const rest = rows.filter((r) => r.id !== 'svc:instagram.search_hashtag');
    expect(Object.keys(toolArgsOf(rest))).toEqual(['svc:instagram.search_hashtag#2', 'svc:instagram.search_hashtag#3', 'svc:instagram.search_profiles']);
    expect(sourceIdFor('svc:instagram.search_hashtag', rest.map((r) => r.id))).toBe('svc:instagram.search_hashtag');
  });
});
