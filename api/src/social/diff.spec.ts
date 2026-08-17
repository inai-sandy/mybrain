import { cleanForCompare, diffResults, isVolatileUrl, itemKey, pickNumber, shapeOf, stableHash, storable, whatChanged } from './diff';

/**
 * BEA-1358 — the diff routine, all three shapes: lists keyed on a stable id (never position),
 * numbers previous → current with a threshold, text changed/unchanged with a "what changed" line.
 * Plus the things that would otherwise make "nothing changed" impossible: the envelope and
 * expiring CDN links are left out of the comparison.
 */

const post = (id: string, over: any = {}) => ({ id, shortcode: `sc_${id}`, caption: `post ${id}`, like_count: 10, url: `https://instagram.com/p/${id}`, ...over });
const listAnswer = (ids: string[], credits = 1) => ({ success: true, credits_charged: credits, credits_remaining: 900 - credits, posts: ids.map((i) => post(i)) });
const profile = (followers: number, over: any = {}) => ({ success: true, credits_charged: 1, data: { user: { username: 'legrand_in', full_name: 'Legrand India', biography: 'Wiring devices', follower_count: followers, following_count: 12, media_count: 300, profile_pic_url: `https://cdn.example.com/pic.jpg?oh=${Math.random()}&oe=123`, ...over } } });

describe('shape detection and the stable key', () => {
  it('a list of objects is a list, a profile is numbers, a transcript is text', () => {
    expect(shapeOf(listAnswer(['a']))).toBe('list');
    expect(shapeOf(profile(100))).toBe('number');
    expect(shapeOf('hello world')).toBe('text');
    expect(shapeOf({ transcript: 'hello there', success: true })).toBe('text');
  });
  it('items are keyed on id / shortcode / url / pk / aweme_id — the first stable one, never position', () => {
    expect(itemKey({ id: '1', shortcode: 'x' })).toEqual({ field: 'id', key: '1' });
    expect(itemKey({ shortcode: 'x', url: 'u' })).toEqual({ field: 'shortcode', key: 'x' });
    expect(itemKey({ pk: 99, username: 'a' })).toEqual({ field: 'pk', key: '99' });
    expect(itemKey({ aweme_id: '77' })).toEqual({ field: 'aweme_id', key: '77' });
    expect(itemKey({ node: { id: 'nested' } })).toEqual({ field: 'id', key: 'nested' }); // one level down
    expect(itemKey({ caption: 'no id at all' })).toBeNull();
  });
  it('a link shim / signed link that changes every fetch is not a change (Instagram external_lynx_url, seen live)', () => {
    const shim = (t: string) => `https://l.instagram.com/?u=https%3A%2F%2Fbit.ly%2FSPD_Legrand&e=${t}`;
    expect(isVolatileUrl(shim('AUBBRBoqcjCULcPQEML7L2mruh'))).toBe(true);
    expect(isVolatileUrl('https://scontent.cdninstagram.com/v/t51.jpg?_nc_ht=x&oh=abc&oe=123')).toBe(true);
    expect(isVolatileUrl('https://instagram.com/p/C1abc/')).toBe(false);
    expect(isVolatileUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isVolatileUrl('https://bit.ly/SPD_Legrand')).toBe(false);
    const d = diffResults(JSON.parse(storable(profile(100, { external_lynx_url: shim('AUBBRBoqcjCULcPQEML7L2mruh-Lji3l') }))), profile(100, { external_lynx_url: shim('AUDgFT2RUnSwTZSPXBf8j3U6smq02NCn') }));
    expect(d.changed).toBe(false);
  });
  it('the envelope and expiring links do not count as change', () => {
    const a = profile(100);
    const b: any = { ...profile(100), credits_remaining: 1 }; // a new credits_remaining and a new profile_pic_url token every fetch
    expect(stableHash(a)).toBe(stableHash(b));
    expect(cleanForCompare(a).credits_charged).toBeUndefined();
    expect(cleanForCompare(a).data.user.profile_pic_url).toBeUndefined();
    expect(cleanForCompare(a).data.user.follower_count).toBe(100);
  });
});

describe('lists — new items since last time, by id', () => {
  it('3 new posts appear → exactly those 3, by id, whatever their position', () => {
    const before = JSON.parse(storable(listAnswer(['a', 'b', 'c', 'd'])));
    // the new ones land at the top AND the middle, and one old post dropped off the page
    const now = listAnswer(['n1', 'a', 'n2', 'b', 'n3', 'c']);
    const d = diffResults(before, now);
    expect(d.shape).toBe('list');
    expect(d.changed).toBe(true);
    expect(d.newItems!.map((i) => i.id).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(d.keyField).toBe('id');
    expect(d.goneCount).toBe(1); // 'd' is no longer listed — said, not counted as new
    expect(d.summary).toMatch(/3 new items/);
    expect(d.detail).toContain('`n1`');
    expect(d.detail).toContain('https://instagram.com/p/n2');
  });
  it('the same list again → nothing changed, even when it came back in a different order with a different credit line', () => {
    const before = JSON.parse(storable(listAnswer(['a', 'b', 'c'], 1)));
    const d = diffResults(before, listAnswer(['c', 'a', 'b'], 0));
    expect(d.changed).toBe(false);
    expect(d.newItems).toEqual([]);
    expect(d.summary).toBe('nothing changed');
    expect(d.detail).toBe('');
  });
  it('an item that only drops off the page is not "new" and does not count as a change', () => {
    const before = JSON.parse(storable(listAnswer(['a', 'b', 'c'])));
    const d = diffResults(before, listAnswer(['a', 'b']));
    expect(d.changed).toBe(false);
    expect(d.goneCount).toBe(1);
    expect(d.summary).toMatch(/nothing new/);
  });
  it('a huge list is stored as keys + the first items, and the diff still works off the keys', () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `p${i}`);
    const stored = storable(listAnswer(ids));
    const parsed = JSON.parse(stored);
    expect(parsed.__keys.length).toBe(1200);
    expect(parsed.__items.length).toBe(500);
    const d = diffResults(parsed, listAnswer([...ids.slice(0, 100), 'brand-new']));
    expect(d.newItems!.map((i) => i.id)).toEqual(['brand-new']);
  });
  it('a list of users keyed on pk (Instagram search) — a new account is the new item', () => {
    const users = (pks: number[]) => ({ success: true, users: pks.map((pk) => ({ pk, username: `u${pk}`, is_verified: false })) });
    const d = diffResults(JSON.parse(storable(users([1, 2, 3]))), users([2, 3, 4]));
    expect(d.newItems!.map((u) => u.pk)).toEqual([4]);
    expect(d.keyField).toBe('pk');
  });
});

describe('numbers — previous → current, and the threshold', () => {
  it('followers moved → "followers 37,570 → 38,102", nothing else invented', () => {
    const d = diffResults(JSON.parse(storable(profile(37570))), profile(38102));
    expect(d.shape).toBe('number');
    expect(d.changed).toBe(true);
    expect(d.summary).toBe('followers 37,570 → 38,102');
    expect(d.numbers).toEqual([{ field: 'follower_count', prev: 37570, cur: 38102, delta: 532 }]);
    expect(d.detail).toContain('| followers | 37,570 | 38,102 | +532 |');
  });
  it('the same profile again → nothing changed (the picture link and credits differ every fetch)', () => {
    const d = diffResults(JSON.parse(storable(profile(100))), profile(100));
    expect(d.changed).toBe(false);
    expect(d.summary).toBe('nothing changed');
  });
  it('a bio change on a profile is reported as a text field change', () => {
    const d = diffResults(JSON.parse(storable(profile(100))), profile(100, { biography: 'Wiring devices · new store open' }));
    expect(d.changed).toBe(true);
    expect(d.texts).toEqual([{ field: 'biography', prev: 'Wiring devices', cur: 'Wiring devices · new store open' }]);
    expect(d.summary).toMatch(/biography/);
  });
  it('the threshold: crossed when it goes above the line, NOT crossed while it stays above, and the main number is picked when none is named', () => {
    const th = { dir: 'above' as const, value: 38000 };
    const crossed = diffResults(JSON.parse(storable(profile(37570))), profile(38102), { threshold: th });
    expect(crossed.threshold).toMatchObject({ field: 'follower_count', met: true, crossed: true, prev: 37570, cur: 38102 });
    expect(crossed.summary).toMatch(/followers went above 38,000/);
    const stays = diffResults(JSON.parse(storable(profile(38102))), profile(38500), { threshold: th });
    expect(stays.threshold).toMatchObject({ met: true, crossed: false });
    expect(stays.summary).not.toMatch(/went above/);
    const under = diffResults(JSON.parse(storable(profile(100))), profile(120), { threshold: th });
    expect(under.threshold).toMatchObject({ met: false, crossed: false });
  });
  it('a threshold on a named field, "below", and over a list (the biggest value across items)', () => {
    const d = diffResults(JSON.parse(storable(profile(100, { following_count: 12 }))), profile(100, { following_count: 5 }), { threshold: { field: 'following_count', dir: 'below', value: 10 } });
    expect(d.threshold).toMatchObject({ field: 'following_count', crossed: true, prev: 12, cur: 5 });
    expect(pickNumber(listAnswer(['a', 'b']))!).toEqual({ field: 'like_count', value: 10 });
    const before = listAnswer(['a', 'b']);
    const now = { ...listAnswer(['a', 'b']), posts: [post('a', { like_count: 12000 }), post('b')] };
    const l = diffResults(JSON.parse(storable(before)), now, { threshold: { field: 'like_count', dir: 'above', value: 10000 } });
    expect(l.threshold).toMatchObject({ met: true, crossed: true, cur: 12000, prev: 10 });
    expect(l.changed).toBe(true); // no new item, but the line was crossed — that IS the change
  });
  it('a baseline has no previous number, so nothing "crossed" on the first comparison', () => {
    const d = diffResults(null, profile(50000), { threshold: { dir: 'above', value: 10000 } });
    expect(d.threshold).toMatchObject({ met: true, crossed: false, prev: null, cur: 50000 });
  });
});

describe('text — changed / unchanged with a "what changed" line', () => {
  it('the same transcript twice → unchanged', () => {
    const d = diffResults(JSON.parse(storable({ transcript: 'hello there world', success: true, credits_charged: 2 })), { transcript: 'hello there world', success: true, credits_charged: 0 });
    expect(d.shape).toBe('text');
    expect(d.changed).toBe(false);
  });
  it('a bio that grew says by how much and from where', () => {
    const d = diffResults('Wiring devices for every home', 'Wiring devices for every home. New store in Pune.');
    expect(d.changed).toBe(true);
    expect(d.summary).toMatch(/text changed — 4 words added, from “home\. New store in Pune\.”/);
    expect(d.detail).toContain('> was: Wiring devices for every home');
    expect(d.detail).toContain('> now: Wiring devices for every home. New store in Pune.');
    expect(whatChanged('a b c', 'a b')).toBe('text changed — 1 word removed, from “c”');
    expect(whatChanged('', 'a b')).toBe('text appeared (2 words)');
  });
});
