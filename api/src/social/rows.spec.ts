import { flatten, markdownTable, remap, sheetUrl, spreadsheetIdOf, tableOf, valuesGrids } from './rows';

/** BEA-1357 — a provider's answer becomes spreadsheet rows, whatever shape it came in. */
describe('rows (BEA-1357)', () => {
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
    // no list under any key → the object itself is the row
    expect(t.rows).toHaveLength(1);
    expect(t.columns).toEqual(expect.arrayContaining(['user_username', 'user_follower_count', 'user_is_verified']));
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
