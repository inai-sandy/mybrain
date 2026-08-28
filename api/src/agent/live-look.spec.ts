import { hasMorePages, orderingOf } from './builder-sample.service';
import { toolsText } from './goal';

/**
 * One real look before the goal is written (BEA-1549).
 *
 * Read from the record: 6 agents, 33 versions, 14 failed runs — and **12 of the 14 could not have been
 * caught before shipping that version**, because a build's tests run against frozen saved answers
 * while every failure was a property of the LIVE source.
 *
 * His ESP32 agent is the proof. Four rebuilds, each learning one live fact after promotion:
 *   v1,v2  sort by newest, then rank by score  → needs every post first, unbounded
 *   v3     asked for top, then ASSERTED the vendor returned them ordered → threw away 70 good posts
 *   v5     asked for top, 11 pages             → the ceiling hid 160 posts, so it could never finish
 *   v6     asked for top, all pages            → 35 pages, 233 items, sheet written
 *
 * Every one of those is answerable by a single call before a line of code is written: how many came
 * back, is there another page, is it already sorted. That is what this adds.
 */
describe('hasMorePages — is there another page?', () => {
  it('finds the vendor cursor keys the real fetch follows', () => {
    expect(hasMorePages({ posts: [], after: 't3_abc' })).toBe(true);
    expect(hasMorePages({ data: { next_max_id: '99' } })).toBe(true);
    expect(hasMorePages({ paging: { end_cursor: 'x' } })).toBe(true);
    expect(hasMorePages({ has_more: true })).toBe(true);
  });

  it('says no when the cursor is empty, null or false', () => {
    expect(hasMorePages({ after: null })).toBe(false);
    expect(hasMorePages({ after: '' })).toBe(false);
    expect(hasMorePages({ has_more: false })).toBe(false);
  });

  // A full page is not evidence of a next one, and an empty page is not evidence there is none.
  it('never guesses from the item count', () => {
    expect(hasMorePages({ posts: new Array(100).fill({}) })).toBe(false);
    expect(hasMorePages({ posts: [] })).toBe(false);
  });

  it('survives rubbish', () => {
    expect(hasMorePages(null)).toBe(false);
    expect(hasMorePages('nope' as any)).toBe(false);
  });
});

describe('orderingOf — did the vendor already sort it?', () => {
  const cols = ['title', 'score'];

  it('spots a descending numeric column', () => {
    expect(orderingOf([['a', 90], ['b', 50], ['c', 10]], cols)).toEqual({ field: 'score', descending: true });
  });

  it('spots an ascending one', () => {
    expect(orderingOf([['a', 1], ['b', 5], ['c', 9]], cols)).toEqual({ field: 'score', descending: false });
  });

  // THE case: Reddit's top/week is not perfectly ordered, and v3 threw because it assumed otherwise.
  it('returns null when nothing is reliably ordered — which means "sort it yourself"', () => {
    expect(orderingOf([['a', 90], ['b', 120], ['c', 10]], cols)).toBeNull();
  });

  // Two rows are in some order by accident; three is the least that means anything.
  it('refuses to judge fewer than three rows', () => {
    expect(orderingOf([['a', 9], ['b', 1]], cols)).toBeNull();
  });

  it('ignores a column that is all the same value', () => {
    expect(orderingOf([['a', 7], ['b', 7], ['c', 7]], cols)).toBeNull();
  });

  it('ignores non-numeric columns', () => {
    expect(orderingOf([['c', 'x'], ['b', 'y'], ['a', 'z']], ['title', 'tag'])).toBeNull();
  });
});

describe('the goal prompt is told what the real call found', () => {
  const look = (o: any) => toolsText([{ actionId: 'svc:reddit.search', name: 'Search', card: 'card', look: o } as any]);

  it('says how many came back and whether there are more', () => {
    const t = look({ count: 7, morePages: true, ordering: null });
    expect(t).toContain('**7** items on one page');
    expect(t).toContain('are more pages');
  });

  // The fact that finishes a job instead of asking him: the source ran out.
  it('says plainly when that was everything', () => {
    expect(look({ count: 12, morePages: false, ordering: null })).toContain('no next page');
  });

  it('says when the vendor already sorted it, and which way', () => {
    expect(look({ count: 9, morePages: false, ordering: { field: 'score', descending: true } })).toMatch(/already sorted by .*score.*highest first/);
  });

  // The v3 lesson, stated before any code is written.
  it('tells it to sort for itself when the order cannot be relied on', () => {
    expect(look({ count: 9, morePages: true, ordering: null })).toContain('sort what you fetch yourself');
  });

  it('says when items carry no date, so a "last N days" job knows up front', () => {
    expect(look({ count: 5, morePages: false, ordering: null, hasDate: false })).toContain('cannot be filtered here');
  });

  // A look that failed is itself a fact about the source, not a reason to hide it.
  it('reports a failed look rather than pretending it did not happen', () => {
    expect(look({ count: 0, error: 'Internal Server Error' })).toContain('A real call just now FAILED');
  });
});
