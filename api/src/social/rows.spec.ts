import { flatten, markdownTable, remap, sheetUrl, spreadsheetIdOf, tableOf, valuesGrids } from './rows';

/** BEA-1357 — a provider's answer becomes spreadsheet rows, whatever shape it came in. */
describe('rows (BEA-1357)', () => {
  it("BEA-1373: an Instagram post's own shape keeps its caption, shortcode and owner inside the 40-column cap — caption:{text} at flat key #75 of ~140 was falling off and 82 live rows had blank captions", () => {
    const junk = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`flag_${i}`, i % 2 === 0]));
    const item = { pk: '1', id: '1_2', ...junk, code: 'DcI_hzDAnN', taken_at: 1755000000, caption: { pk: 'c1', text: 'One light. Endless possibilities. #smarthomeindia', type: 1 }, user: { pk: '9', username: 'mmlites', full_name: 'MM Lites' }, like_count: 40, play_count: 1200, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`more_${i}`, `v${i}`])) };
    const t = tableOf({ items: [item] });
    expect(t.columns.length).toBeLessThanOrEqual(40);
    for (const c of ['caption_text', 'code', 'user_username', 'user_full_name', 'like_count', 'play_count', 'taken_at', 'id']) expect(t.columns).toContain(c);
    const row = Object.fromEntries(t.columns.map((c, i) => [c, t.rows[0][i]]));
    expect(row.caption_text).toBe('One light. Endless possibilities. #smarthomeindia');
    expect(row.user_username).toBe('mmlites');
  });

  const posts = {
    success: true,
    credits_charged: 1,
    posts: [
      { url: 'https://instagram.com/p/a', caption: 'Smart home in Hyderabad', like_count: 12, owner: { username: 'legrand_in', follower_count: 900 }, tags: ['smarthome', 'india'] },
      { url: 'https://instagram.com/p/b', caption: 'Another', like_count: -1, owner: { username: 'x', follower_count: 5 }, extra: { deep: { too: 1 } } },
    ],
  };

  it('a list → one row per item, nested one level flattened, preferred columns first', () => {
    const t = tableOf(posts);
    expect(t.itemCount).toBe(2);
    expect(t.rows).toHaveLength(2);
    expect(t.listKey).toBe('posts');
    expect(t.columns.slice(0, 3)).toEqual(['owner_username', 'caption', 'url']);
    expect(t.columns).toContain('owner_follower_count');
    expect(t.columns).toContain('tags'); // scalar arrays are joined
    expect(t.columns).not.toContain('extra_deep'); // deeper than one level is dropped
    expect(t.columns).not.toContain('success'); // envelope keys never become columns
    const row = t.rows[0];
    expect(row[t.columns.indexOf('tags')]).toBe('smarthome, india');
    expect(row[t.columns.indexOf('like_count')]).toBe(12);
  });

  it('a profile (no list) → ONE row, so an "append every week" agent tracks a number over time', () => {
    const t = tableOf({ success: true, user: { username: 'legrand_in', follower_count: 900, is_verified: true } });
    // no list under any key → the object itself is the row, unwrapped out of its envelope
    expect(t.rows).toHaveLength(1);
    expect(t.columns).toEqual(expect.arrayContaining(['username', 'follower_count', 'is_verified']));
  });

  it('the live Instagram profile shape — {success, credits, data:{user:{…}}} — is ONE row of the user, not zero rows', () => {
    // Seen live 2026-08-17: the first acceptance run answered "no items" because the profile sat two
    // envelopes deep and one-level flattening dropped it whole.
    const t = tableOf({ success: true, credits_remaining: 25089, credits_charged: 1, data: { user: { pk: '2235598760', username: 'legrand_in', follower_count: 900, is_private: false, biography: 'Legrand India', hd_profile_pic_url_info: { url: 'https://x/y.jpg' } } } });
    expect(t.rows).toHaveLength(1);
    expect(t.columns).toEqual(expect.arrayContaining(['username', 'follower_count', 'biography', 'hd_profile_pic_url_info_url']));
    expect(t.rows[0][t.columns.indexOf('username')]).toBe('legrand_in');
  });

  it('a transcript → one row with a text column; nothing → no rows', () => {
    expect(tableOf('hello there').columns).toEqual(['text']);
    expect(tableOf(null).rows).toEqual([]);
    expect(tableOf({ success: true }).rows).toEqual([]);
  });

  it('flatten keeps scalars, joins scalar arrays, folds one level of nesting', () => {
    expect(flatten({ a: 1, b: [1, 2], c: { d: 'x', e: [3] }, f: { g: { h: 1 } } })).toEqual({ a: 1, b: '1, 2', c_d: 'x', c_e: '3' });
  });

  it('remap re-orders rows under a sheet\'s existing header, blank where the sheet\'s column is missing', () => {
    const t = { columns: ['caption', 'url'], rows: [['hi', 'u1']] };
    expect(remap(t, ['URL', 'likes', 'Caption'])).toEqual([['u1', '', 'hi']]);
  });

  it('reads the values grids out of a batch-get answer in range order, and the spreadsheet id out of a create answer', () => {
    const grids = valuesGrids({ data: { valueRanges: [{ range: 'Sheet1!A1:A3', values: [['h'], ['1'], ['2']] }, { range: 'Sheet1!1:1', values: [['h', 'k']] }] } });
    expect(grids).toHaveLength(2);
    expect(grids[0]).toHaveLength(3);
    expect(grids[1][0]).toEqual(['h', 'k']);
    expect(valuesGrids({ data: { valueRanges: [{ range: 'x' }] } })).toEqual([]); // an empty range has no values key
    expect(spreadsheetIdOf({ data: { spreadsheetId: 'abc123' } })).toBe('abc123');
    expect(spreadsheetIdOf({ response_data: { spreadsheet_id: 'z' } })).toBe('z');
    expect(spreadsheetIdOf({ nope: 1 })).toBeNull();
    // The create action returns no URL — it is BUILT from the id, never guessed.
    expect(sheetUrl('abc123')).toBe('https://docs.google.com/spreadsheets/d/abc123');
  });

  it('a markdown table escapes pipes and says how many rows it left out', () => {
    const md = markdownTable(['a', 'b'], [['x|y', 1], ['z', 2], ['w', 3]], 2);
    expect(md).toContain('| a | b |');
    expect(md).toContain('x\\|y');
    expect(md).toContain('…and 1 more rows');
  });
});
