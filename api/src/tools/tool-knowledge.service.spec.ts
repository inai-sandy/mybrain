import { readFileSync } from 'fs';
import { join } from 'path';
import { KnowledgeNote, KNOWLEDGE_NOTES, notesFor } from './knowledge-notes';
import { ScrapeCreatorsProvider } from './scrapecreators.provider';
import {
  creditsSeen,
  fieldsOfSchema,
  fieldsOfTruncated,
  fieldsOfValue,
  healthOf,
  kindOf,
  mergeFields,
  pagingOfSchema,
  ToolKnowledge,
  ToolKnowledgeService,
} from './tool-knowledge.service';

/**
 * BEA-1368 — the know-how layer: one fact card per action id from spec + ToolCall history + notes.
 *
 * Nothing here reaches the network: the social provider is fed the real spec (trimmed fixture) plus
 * the popular-search operation verbatim, Composio is a stub answering `getAction` from a fixed
 * schema, and the "database" is a stub `toolCall.findMany` over rows the tests write.
 */

const TRIMMED = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'scrapecreators-openapi.trimmed.json'), 'utf8'));

/** The real `/v1/instagram/search/popular` operation (2026-08-17 spec) — the fixture trims its example away. */
const POPULAR_OP = {
  tags: ['Instagram'],
  summary: 'Popular Search',
  description: 'Use this to explore an Instagram topic and the posts Instagram curates for it. Pass that cursor with the same query to fetch more posts. Each successful request costs 1 credit.',
  parameters: [
    { name: 'query', in: 'query', required: true, description: 'The Popular topic to search for.', schema: { type: 'string' }, example: 'basketball' },
    { name: 'cursor', in: 'query', required: false, description: 'The opaque cursor returned by the previous response.', schema: { type: 'string' } },
  ],
  responses: {
    '200': {
      content: {
        'application/json': {
          example: {
            success: true, credits_remaining: 99, credits_charged: 1, query: 'basketball', title: 'Basketball', total_media_count: 8800000,
            description: { plain_text: 'James Naismith invented basketball.', source_uris: ['https://en.wikipedia.org/wiki/Outline_of_basketball'], linked_terms: [] },
            suggested_terms: ['the tallest basketball player'],
            posts: [{
              id: 'POLARIS_3892957342260916992', shortcode: 'DYGkBO3NfMA', url: 'https://www.instagram.com/reel/DYGkBO3NfMA/', type: 'reel', caption: '#basketball',
              display_url: 'https://instagram.example.com/basketball-cover.jpg', play_count: 11993988,
              owner: { id: '17841409679275910', username: 'lukaceo', is_verified: false, profile_pic_url: 'https://instagram.example.com/lukaceo-profile.jpg' },
            }],
            cursor: 'opaque-cursor-from-response', has_more: true,
          },
        },
      },
    },
  },
};

const SPEC = { ...TRIMMED, paths: { ...TRIMMED.paths, '/v1/instagram/search/popular': { get: POPULAR_OP } } };

const connectors = { get: async () => ({ apiKey: 'sc-test-key' }), set: async () => undefined, remove: async () => undefined, listStatus: async () => [] } as any;

function socialProvider() {
  const p = new ScrapeCreatorsProvider(connectors);
  p.useSpec(SPEC);
  return p;
}

/** Composio's exact `GET /tools/GOOGLESHEETS_CREATE_GOOGLE_SHEET1` (2026-08-18), as `getAction()` returns it. */
const SHEET_ACTION = {
  id: 'svc:googlesheets.create_google_sheet1',
  name: 'Create Google Sheet',
  description: 'Creates a new Google Sheet with the given title.',
  service: 'googlesheets',
  risky: false,
  schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', description: 'The title for the new Google Sheet.', examples: ['Q4 Financial Report'] } } },
  responseSchema: {
    type: 'object',
    properties: {
      data: { type: 'object', properties: { response_data: { type: 'object', description: 'Details of the created spreadsheet, including its `spreadsheet_id` and information about its `sheets`.', additionalProperties: true } } },
      error: { type: 'string' },
      successful: { type: 'boolean' },
    },
  },
};

const GITHUB_ACTION = {
  id: 'svc:github.list_repositories_for_the_authenticated_user',
  name: 'List repositories for the authenticated user',
  description: 'Lists repositories.',
  service: 'github',
  risky: false,
  schema: { type: 'object', properties: { page: { type: 'integer', description: 'Page number' }, per_page: { type: 'integer' }, since: { type: 'string', format: 'date-time' } } },
  responseSchema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, full_name: { type: 'string' }, html_url: { type: 'string', format: 'uri' }, pushed_at: { type: 'string', format: 'date-time' }, private: { type: 'boolean' } } } } } },
};

const H = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

function harness(rowsByAction: Record<string, any[]> = {}, notes?: KnowledgeNote[]) {
  const composio: any = {
    getAction: jest.fn(async (id: string) => (id === SHEET_ACTION.id ? SHEET_ACTION : id === GITHUB_ACTION.id ? GITHUB_ACTION : null)),
  };
  const findMany = jest.fn(async ({ where }: any) => (rowsByAction[where.action] || []).slice().sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)));
  const prisma: any = { toolCall: { findMany } };
  const svc = new ToolKnowledgeService(composio, socialProvider(), prisma);
  if (notes) svc.useNotes(notes);
  return { svc, composio, findMany };
}

const okRow = (over: any = {}) => ({ ok: true, gated: false, error: null, result: null, credits: 1, createdAt: ago(H), ...over });
const failRow = (error: string, over: any = {}) => ({ ok: false, gated: false, error, result: null, credits: 0, createdAt: ago(H), ...over });

// ---- the spec part ----------------------------------------------------------------------------

describe('spec part — what the vendor states (BEA-1368)', () => {
  it('svc:instagram.search_popular: cursor paging, no date field, cost 1, the lowercase note', async () => {
    const { svc } = harness();
    const card = (await svc.card('svc:instagram.search_popular'))!;
    expect(card).toBeTruthy();
    expect(card.provider).toBe('social');
    expect(card.service).toBe('instagram');
    expect(card.params.map((p) => p.name)).toEqual(['query', 'cursor']);
    expect(card.params[0].required).toBe(true);
    expect(card.paging.how).toBe('cursor');
    expect(card.paging.field).toBe('cursor');
    expect(card.paging.pageSize).toBe(12); // from the notes — the spec does not say it
    expect(card.hasDateField).toBe(false);
    expect(card.fields.some((f) => f.kind === 'date')).toBe(false);
    expect(card.cost.credits).toEqual({ typical: 1, min: 1, max: 1 });
    expect(card.cost.source).toBe('spec');
    expect(card.notes.some((n) => /lowercase/i.test(n))).toBe(true);
    // Fields come from the response example, envelope keys left out, lists read through their first item.
    const paths = card.fields.map((f) => f.path);
    expect(paths).toContain('posts[].caption');
    expect(paths).toContain('posts[].owner.username');
    expect(paths).not.toContain('success');
    expect(paths).not.toContain('credits_charged');
    expect(card.fields.find((f) => f.path === 'posts[].url')!.kind).toBe('url');
    expect(card.fields.find((f) => f.path === 'posts[].shortcode')!.kind).toBe('id');
    expect(card.fields.find((f) => f.path === 'posts[].play_count')!.kind).toBe('number');
    expect(card.fields.every((f) => f.seen === false)).toBe(true); // nothing observed yet
  });

  it('svc:instagram.search_hashtag: the spec states the 11-page ceiling and a dated filter', async () => {
    const { svc } = harness();
    const card = (await svc.card('svc:instagram.search_hashtag'))!;
    expect(card.paging).toMatchObject({ how: 'cursor', field: 'cursor', cap: 11, source: 'spec' });
    expect(card.params.find((p) => p.name === 'date_posted')!.enum).toEqual(['last-hour', 'last-day', 'last-week', 'last-month', 'last-year']);
    expect(card.notes.some((n) => /not_found/.test(n))).toBe(true);
    expect(card.notes.some((n) => /no location or country filter/i.test(n))).toBe(true); // the service-wide note lands too
  });

  it('a Composio action: params + response fields from its exact schema, cost free', async () => {
    const { svc, composio } = harness();
    const card = (await svc.card('svc:googlesheets.create_google_sheet1'))!;
    expect(composio.getAction).toHaveBeenCalledWith('svc:googlesheets.create_google_sheet1');
    expect(card.provider).toBe('services');
    expect(card.params).toEqual([{ name: 'title', required: true, type: 'string', description: 'The title for the new Google Sheet.', example: 'Q4 Financial Report' }]);
    expect(card.cost).toMatchObject({ free: true, source: 'provider' });
    // The wrapper (`data`, `successful`, `error`) is not a field; the bag under it is said in the vendor's words.
    expect(card.fields.map((f) => f.path)).toEqual(['response_data']);
    expect(card.responseNote).toMatch(/spreadsheet_id/);
    expect(card.notes.some((n) => /NO url/.test(n))).toBe(true);
    expect(card.paging.how).toBe('none');
  });

  it('a Composio list action: fields under data[] with kinds from the schema, page paging', async () => {
    const { svc } = harness();
    const card = (await svc.card('svc:github.list_repositories_for_the_authenticated_user'))!;
    expect(card.paging).toMatchObject({ how: 'page', field: 'page' });
    const by = Object.fromEntries(card.fields.map((f) => [f.path, f.kind]));
    expect(by['[].pushed_at']).toBe('date');
    expect(by['[].html_url']).toBe('url');
    expect(by['[].id']).toBe('id');
    expect(by['[].private']).toBe('bool');
    expect(card.hasDateField).toBe(true);
  });

  it('an id nobody knows answers null; a non-svc id answers null without asking anyone', async () => {
    const { svc, composio } = harness();
    expect(await svc.card('svc:nowhere.nothing')).toBeNull();
    expect(await svc.card('web_search')).toBeNull();
    expect(composio.getAction).toHaveBeenCalledTimes(1);
  });
});

// ---- the observed part -----------------------------------------------------------------------

describe('observed part — from ToolCall rows (BEA-1368)', () => {
  it('a search endpoint that answered not_found for every call in 24 h → health.ok false, said as empty answers', async () => {
    const rows = [
      failRow('Instagram could not do that: No posts found', { createdAt: ago(2 * H) }),
      failRow('Instagram could not do that: No posts found', { createdAt: ago(5 * H) }),
      failRow('Instagram could not do that: No posts found', { createdAt: ago(20 * H) }),
      okRow({ createdAt: ago(40 * H), credits: 1, result: '{"posts":[{"url":"https://x/1","taken_at":1723900000}],"cursor":null}' }),
    ];
    const { svc } = harness({ 'svc:instagram.search_hashtag': rows });
    const card = (await svc.card('svc:instagram.search_hashtag'))!;
    expect(card.health.ok).toBe(false);
    expect(card.health.known).toBe(true);
    expect(card.health.failuresLast24h).toBe(3);
    expect(card.health.emptyLast24h).toBe(3);
    expect(card.health.successesLast24h).toBe(0);
    expect(card.health.note).toMatch(/not_found \(empty answers\) for every call since \d{2}:\d{2}Z/);
    expect(card.health.lastError).toBe('No posts found');
    expect(card.health.lastOkAt).toBe(rows[3].createdAt.toISOString());
    // The one good answer 40 h ago still taught it the fields — and that posts are dated.
    expect(card.fields.find((f) => f.path === 'posts[].taken_at')).toMatchObject({ kind: 'date', seen: true });
    expect(card.hasDateField).toBe(true);
  });

  it('a healthy tool → ok true with lastOkAt, real credits typical/min/max, items per page from a whole recorded page', async () => {
    const page = { success: true, credits_charged: 1, posts: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, caption: `post ${i}` })), cursor: 'c2', has_more: true };
    const rows = [
      okRow({ createdAt: ago(1 * H), credits: 1, result: JSON.stringify(page) }),
      okRow({ createdAt: ago(3 * H), credits: 0, result: JSON.stringify(page) }), // a cache hit
      okRow({ createdAt: ago(6 * H), credits: 1, result: JSON.stringify(page) }),
    ];
    const { svc } = harness({ 'svc:instagram.search_popular': rows });
    const card = (await svc.card('svc:instagram.search_popular'))!;
    expect(card.health).toMatchObject({ ok: true, known: true, successesLast24h: 3, failuresLast24h: 0 });
    expect(card.health.lastOkAt).toBe(rows[0].createdAt.toISOString());
    expect(card.cost).toMatchObject({ credits: { typical: 1, min: 0, max: 1 }, source: 'observed' });
    expect(card.paging).toMatchObject({ how: 'cursor', pageSize: 12 });
    expect(card.fields.find((f) => f.path === 'posts[].caption')).toMatchObject({ seen: true, example: 'post 0' });
  });

  it('a one-shot action never gets a page size, even when its answer holds a small list', async () => {
    const answer = { response_data: { spreadsheet_id: 'abc', sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] } };
    const { svc } = harness({ 'svc:googlesheets.create_google_sheet1': [okRow({ credits: null, result: JSON.stringify(answer) })] });
    const card = (await svc.card('svc:googlesheets.create_google_sheet1'))!;
    expect(card.paging).toEqual({ how: 'none', source: 'none' });
    expect(card.fields.find((f) => f.path === 'response_data.spreadsheet_id')).toMatchObject({ kind: 'id', seen: true });
  });

  it('a mixed day says both numbers and the last error; held-for-approval rows are neither', async () => {
    const rows = [
      okRow({ createdAt: ago(1 * H), credits: null }),
      failRow('GitHub could not do that: Not Found (404)', { createdAt: ago(2 * H), credits: null }),
      failRow('Held for your approval — nothing was sent.', { createdAt: ago(3 * H), gated: true, credits: null }),
      failRow('You said no, so nothing was done: Delete a repository on GitHub — x/y.', { createdAt: ago(4 * H), gated: true, credits: null }),
    ];
    const health = healthOf('svc:github.list_repositories_for_the_authenticated_user', rows);
    expect(health).toMatchObject({ ok: true, successesLast24h: 1, failuresLast24h: 1, emptyLast24h: 0 });
    // An APPROVED call that then ran and failed is gated:true too — and it is a real failure.
    const ran = healthOf('svc:github.delete_a_repository', [failRow('GitHub could not do that: Not Found (404)', { gated: true, credits: null })]);
    expect(ran).toMatchObject({ ok: false, failuresLast24h: 1 });
    expect(health.note).toMatch(/1 succeeded, 1 failed/);
    expect(health.lastError).toBe('Not Found (404)');
  });

  it('a not_found on a NON-search endpoint is a plain failure, not an empty answer', () => {
    const health = healthOf('svc:instagram.profile', [failRow('Instagram could not do that: not_found')]);
    expect(health.ok).toBe(false);
    expect(health.emptyLast24h).toBe(0);
    expect(health.note).toMatch(/^Failed for every call since/);
  });

  it('a tool with no calls in 24 h is not judged: known false, ok stays true, and it says so', () => {
    expect(healthOf('svc:x.y', [])).toMatchObject({ ok: true, known: false, callsLast30d: 0, note: 'No calls recorded yet.' });
    const h = healthOf('svc:x.y', [okRow({ createdAt: ago(30 * H) })]);
    expect(h).toMatchObject({ ok: true, known: false, callsLast30d: 1 });
    expect(h.note).toMatch(/Not used in the last 24 h/);
  });

  it('a truncated recorded answer still teaches the flat keys — nothing invented about depth', () => {
    const cut = '{\n  "success": true,\n  "data": {\n    "user": {\n      "pk": "2235598760",\n      "is_private": false,\n      "follower_count": 1200,\n      "profile_pic_url": "https://cdn.example.com/a.jpg?oh=abc&oe=def",\n      "biography": "Smart hom';
    const fields = fieldsOfTruncated(cut);
    const by = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(by.success).toBeUndefined();
    expect(by.pk).toMatchObject({ kind: 'id', seen: true });
    expect(by.follower_count.kind).toBe('number');
    expect(by.profile_pic_url).toMatchObject({ kind: 'url', example: 'https://cdn.example.com/a.jpg' }); // signed part dropped
    expect(by.biography).toBeUndefined(); // cut mid-string — not read
  });

  it('typical credits is the usual non-zero charge; cache hits keep min at 0', () => {
    expect(creditsSeen([okRow({ credits: 15 }), okRow({ credits: 15 }), okRow({ credits: 0 }), okRow({ credits: 16 })])).toEqual({ typical: 15, min: 0, max: 16, samples: 4 });
    expect(creditsSeen([okRow({ credits: null })])).toBeUndefined();
  });
});

// ---- no secrets ---------------------------------------------------------------------------------

describe('no secrets in fields or examples (BEA-1368)', () => {
  it('a key that says it is a secret never carries an example, from a real answer or a schema', () => {
    const fields = fieldsOfValue({ access_token: 'ya29.abcdefghijklmnopqrstuvwxyz0123456789', api_key: 'sk-live-xyz', password: 'hunter2', name: 'ok' });
    const by = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(by.access_token.example).toBeUndefined();
    expect(by.api_key.example).toBeUndefined();
    expect(by.password.example).toBeUndefined();
    expect(by.name.example).toBe('ok');
    const s = fieldsOfSchema({ type: 'object', properties: { token: { type: 'string', example: 'tok_123' }, title: { type: 'string', example: 'Hello' } } });
    expect(s.find((f) => f.path === 'token')!.example).toBeUndefined();
    expect(s.find((f) => f.path === 'title')!.example).toBe('Hello');
  });

  it('a long run with no spaces (a token, a hash) is not an example either; a signed link loses its query', () => {
    const fields = fieldsOfValue({ blob: 'a'.repeat(64), pic: 'https://cdn.example.com/x.jpg?oh=SECRETSIG&oe=1' });
    expect(fields.find((f) => f.path === 'blob')!.example).toBeUndefined();
    expect(fields.find((f) => f.path === 'pic')!.example).toBe('https://cdn.example.com/x.jpg');
  });

  it('a whole card built from rows carrying secrets has none of them in it', async () => {
    const leaky = { success: true, posts: [{ id: '1', caption: 'hi', owner: { username: 'u', session_token: 'SESSION-SECRET-VALUE-XYZ' } }], api_key: 'sk-LEAKED-KEY' };
    const { svc } = harness({ 'svc:instagram.search_popular': [okRow({ result: JSON.stringify(leaky) })] });
    const card = (await svc.card('svc:instagram.search_popular'))!;
    const text = JSON.stringify(card);
    expect(text).not.toContain('SESSION-SECRET-VALUE-XYZ');
    expect(text).not.toContain('sk-LEAKED-KEY');
  });
});

// ---- notes merge ------------------------------------------------------------------------------

describe('notes merge (BEA-1368)', () => {
  it('exact id first, then a prefix glob, then the whole service — and nothing that does not match', () => {
    const notes: KnowledgeNote[] = [
      { match: 'instagram', notes: ['service-wide'] },
      { match: 'svc:instagram.search_*', notes: ['every search'] },
      { match: 'svc:instagram.search_popular', notes: ['just popular'] },
      { match: 'tiktok', notes: ['not this one'] },
      { match: 'svc:instagram.profile', notes: ['not this one either'] },
    ];
    expect(notesFor('svc:instagram.search_popular', 'instagram', notes).flatMap((n) => n.notes)).toEqual(['just popular', 'every search', 'service-wide']);
    expect(notesFor('svc:instagram.profile', 'instagram', notes).flatMap((n) => n.notes)).toEqual(['not this one either', 'service-wide']);
    expect(notesFor('svc:github.x', 'github', notes)).toEqual([]);
  });

  it('a note can pin paging and cost where the spec is silent, but the spec wins where it speaks', async () => {
    const notes: KnowledgeNote[] = [{ match: 'svc:instagram.search_hashtag', notes: ['n'], paging: { how: 'page', pageSize: 8, cap: 3 }, cost: { credits: 99 } }];
    const { svc } = harness({}, notes);
    const card = (await svc.card('svc:instagram.search_hashtag'))!;
    expect(card.paging.how).toBe('cursor'); // the spec has a cursor param
    expect(card.paging.cap).toBe(11); // the spec's stated cap, not the note's
    expect(card.paging.pageSize).toBe(8); // the spec does not say — the note fills it
    expect(card.cost).toMatchObject({ credits: { typical: 99, min: 99, max: 99 }, source: 'notes' }); // no prose, no rows → the note
    expect(card.notes).toEqual(['n']);
  });

  it('every shipped note is keyed to a real thing: an svc: id, a glob, or a bare service slug', () => {
    for (const n of KNOWLEDGE_NOTES) {
      expect(n.notes.length).toBeGreaterThan(0);
      expect(/^svc:[a-z0-9_]+\.[a-z0-9_]+\*?$|^[a-z0-9_]+$/.test(n.match)).toBe(true);
    }
  });
});

// ---- lookup batching + cache ------------------------------------------------------------------

describe('lookup batching and the 10-minute cache (BEA-1368)', () => {
  it('many ids at once: one answer per known id, unknown ones left out, duplicates folded, capped at 50', async () => {
    const { svc, composio, findMany } = harness();
    const ids = ['svc:instagram.search_popular', 'svc:instagram.search_hashtag', 'svc:googlesheets.create_google_sheet1', 'svc:nowhere.nothing', 'svc:instagram.search_popular', 'not-an-id'];
    const cards = await svc.lookup(ids);
    expect(cards.map((c: ToolKnowledge) => c.actionId).sort()).toEqual(['svc:googlesheets.create_google_sheet1', 'svc:instagram.search_hashtag', 'svc:instagram.search_popular']);
    // Composio was asked only for the ids that are not the social provider's; ToolCall read once per unique id.
    expect(composio.getAction.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['svc:googlesheets.create_google_sheet1', 'svc:nowhere.nothing']);
    expect(findMany).toHaveBeenCalledTimes(3);

    const many = Array.from({ length: 80 }, (_, i) => `svc:github.action_${i}`);
    composio.getAction.mockClear();
    await svc.lookup(many);
    expect(composio.getAction).toHaveBeenCalledTimes(50);
  });

  it('a second read inside 10 minutes is served from memory; fresh=1 rebuilds', async () => {
    const { svc, composio, findMany } = harness();
    await svc.card('svc:googlesheets.create_google_sheet1');
    await svc.card('svc:googlesheets.create_google_sheet1');
    expect(composio.getAction).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
    await svc.card('svc:googlesheets.create_google_sheet1', { fresh: true });
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('30 warm ids answer well under 2 s', async () => {
    const { svc } = harness();
    const ids = Array.from({ length: 30 }, (_, i) => (i % 2 ? 'svc:instagram.search_popular' : 'svc:googlesheets.create_google_sheet1'));
    await svc.lookup(ids);
    const t = Date.now();
    await svc.lookup(ids);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('with no database at all the card is spec + notes and health is simply unknown', async () => {
    const svc = new ToolKnowledgeService({ getAction: async () => null } as any, socialProvider());
    const card = (await svc.card('svc:instagram.search_popular'))!;
    expect(card.health).toMatchObject({ ok: true, known: false, callsLast30d: 0 });
    expect(card.paging.pageSize).toBe(12);
  });
});

// ---- small pure pieces ------------------------------------------------------------------------

describe('kinds, paging and merging (BEA-1368)', () => {
  it('kinds are read from the key and the value together', () => {
    expect(kindOf('taken_at', 1723900000)).toBe('date');
    expect(kindOf('created_at', '2026-08-18T10:12:20.911Z')).toBe('date');
    expect(kindOf('like_count', 12)).toBe('number');
    expect(kindOf('id', 'abc')).toBe('id');
    expect(kindOf('url', 'https://x')).toBe('url');
    expect(kindOf('is_verified', true)).toBe('bool');
    expect(kindOf('posts', [])).toBe('list');
    expect(kindOf('owner', {})).toBe('object');
    expect(kindOf('caption', 'hello world')).toBe('text');
    expect(kindOf('timezone', null)).toBe('text');
  });

  it('paging is named by the schema: cursor-ish params, page params, a stated cap, else none', () => {
    expect(pagingOfSchema({ properties: { cursor: { type: 'string', description: 'cannot exceed 11' } } })).toEqual({ how: 'cursor', field: 'cursor', cap: 11 });
    expect(pagingOfSchema({ properties: { page: { type: 'integer', description: 'Must be between 1 and 11; page 12 or greater returns a 400' } } })).toEqual({ how: 'page', field: 'page', cap: 11 });
    expect(pagingOfSchema({ properties: { next_max_id: { type: 'string' } } })).toMatchObject({ how: 'cursor', field: 'next_max_id' });
    expect(pagingOfSchema({ properties: { handle: { type: 'string' } } })).toEqual({ how: 'none' });
  });

  it('merging keeps the spec field, marks it seen and takes the real example; a new key from an answer is added', () => {
    const merged = mergeFields(
      [{ path: 'posts[].caption', kind: 'text', seen: false }, { path: 'posts[].url', kind: 'url', seen: false }],
      [{ path: 'posts[].caption', kind: 'text', seen: true, example: 'real one' }, { path: 'extra', kind: 'number', seen: true }],
    );
    expect(merged.find((f) => f.path === 'posts[].caption')).toEqual({ path: 'posts[].caption', kind: 'text', seen: true, example: 'real one' });
    expect(merged.find((f) => f.path === 'posts[].url')!.seen).toBe(false);
    expect(merged.find((f) => f.path === 'extra')).toBeTruthy();
    // A flat key from a truncated answer matches the spec field with that leaf name.
    const flat = mergeFields([{ path: 'data.user.pk', kind: 'id', seen: false }], [{ path: 'pk', kind: 'id', seen: true, example: '22' }]);
    expect(flat).toEqual([{ path: 'data.user.pk', kind: 'id', seen: true, example: '22' }]);
  });
});
