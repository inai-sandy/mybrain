import { pagingOfSchema } from './tool-knowledge.service';
import { nextCursorOf } from '../social/plan';

/**
 * A vendor's cursor is recognised by SHAPE, not by a list of spellings (BEA-1574).
 *
 * His words, 2026-08-29: *"it has only bought 20 videos. I asked it to bring as many as possible."*
 *
 * The agent asked for every YouTube video matching "AI Agents" from the last seven days. It fetched
 * ONE page of 20 and said *"this endpoint does not page (every page there is asked)"*. The answer it
 * had in its hands carried `continuationToken`, and the action's own schema takes a parameter called
 * `continuationToken`, described by the vendor as *"Continuation token to get more videos. Get
 * 'continuationToken' from previous response."* Both halves were right there and neither was read,
 * because the hand-kept lists have `page_token`, `next_page_token` and `continuation` — and none of
 * those is `continuationToken`.
 *
 * This is the THIRD real run lost to that list being incomplete (Reddit's `after` was BEA-1497). The
 * list is a guess at how every vendor on earth spells one idea, and it will always be wrong for the
 * next one. Shape closes the class while staying evidence rather than guesswork: the name is the
 * vendor's own, read off its own schema.
 */

describe('the vendor schema decides how an action pages', () => {
  const schema = (props: Record<string, any>) => ({ properties: props });

  // The exact case that cost him the run.
  it('reads YouTube search as a cursor on continuationToken', () => {
    const out = pagingOfSchema(schema({
      query: { description: 'Search query' },
      uploadDate: { description: 'Upload date' },
      sortBy: { description: 'Sort by' },
      type: { description: 'Type of content to search for' },
      continuationToken: { description: "Continuation token to get more videos. Get 'continuationToken' from previous response." },
    }));
    expect(out).toMatchObject({ how: 'cursor', field: 'continuationToken' });
  });

  it('recognises the other spellings the list never had', () => {
    for (const name of ['continuation_token', 'nextToken', 'pageCursor', 'next_key', 'continuation']) {
      expect(pagingOfSchema(schema({ q: {}, [name]: {} }))).toMatchObject({ how: 'cursor', field: name });
    }
  });

  it('still prefers an exact known name when both are present', () => {
    // `cursor` is in the hand-kept list and must keep winning, so nothing already working moves.
    const out = pagingOfSchema(schema({ cursor: {}, continuationToken: {} }));
    expect(out.field).toBe('cursor');
  });

  it('reads a page NUMBER as a page, not a cursor', () => {
    expect(pagingOfSchema(schema({ q: {}, pageNumber: {} }))).toMatchObject({ how: 'page', field: 'pageNumber' });
  });

  /**
   * The guard that makes shape-matching safe: an ordinary argument must never be mistaken for a
   * cursor. `token` on its own is an API key, not a page handle, and paging on it would send the
   * vendor its own credential as a cursor.
   */
  it('never mistakes an ordinary argument for a cursor', () => {
    const out = pagingOfSchema(schema({
      query: {}, token: {}, id: {}, key: {}, type: {}, region: {}, limit: {}, count: {}, trim: {}, handle: {}, includeExtras: {},
    }));
    expect(out).toEqual({ how: 'none' });
  });
});

describe('the answer itself is read the same way', () => {
  it('finds continuationToken in the answer', () => {
    const out = nextCursorOf({ success: true, videos: [1, 2], continuationToken: 'abc123' });
    expect(out).toEqual({ key: 'continuationToken', value: 'abc123' });
  });

  it('prefers the field the card names, over any guess', () => {
    const out = nextCursorOf({ cursor: 'guessed', continuationToken: 'named' }, 'continuationToken');
    expect(out).toEqual({ key: 'continuationToken', value: 'named' });
  });

  // A cursor is a scalar you hand back. A list or an object is a page of results.
  it('never returns a list or an object as a cursor', () => {
    expect(nextCursorOf({ continuation: [1, 2, 3] })).toBeNull();
    expect(nextCursorOf({ nextCursor: { a: 1 } })).toBeNull();
  });

  it('says there is no next page when the vendor sends none', () => {
    expect(nextCursorOf({ success: true, videos: [1, 2], continuationToken: null })).toBeNull();
    expect(nextCursorOf({ success: true, videos: [] })).toBeNull();
  });
});
