import { readFileSync } from 'fs';
import { join } from 'path';
import { endpointName, generateFromSpec, readOps, ScrapeCreatorsProvider, slugSegment, splitPath } from './scrapecreators.provider';
import { isRiskyAction, SERVICE_TOOL_ID_RE } from './service-provider';
import { ServiceActionsService } from './service-actions.service';
import { GROUP_ORDER, ToolCatalogService } from './tool-catalog.service';

/**
 * BEA-1355 — ScrapeCreators as the SECOND ServiceProvider, generated from their OpenAPI spec.
 *
 * The fixture is their real `openapi.json` (2026-08-17) with the big response examples trimmed
 * out — the operations, parameters and summaries are untouched, so the count it yields is the
 * count the live spec yields. Nothing in these tests reaches the network.
 */
const SPEC = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'scrapecreators-openapi.trimmed.json'), 'utf8'));

const connectorsWith = (apiKey?: string) => ({
  get: jest.fn(async () => (apiKey ? { apiKey } : null)),
  set: jest.fn(async () => undefined),
  remove: jest.fn(async () => undefined),
  listStatus: async () => [] as any[],
}) as any;

/** A provider with the fixture already generated, no boot fetch, no timer. */
function provider(apiKey?: string) {
  const p = new ScrapeCreatorsProvider(connectorsWith(apiKey));
  p.useSpec(SPEC);
  return p;
}

const jsonResponse = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });

describe('generation from the spec — every operation, nothing hand-written (BEA-1355)', () => {
  const gen = generateFromSpec(SPEC);

  it('yields exactly one action per operation in the spec — no cap, ever', () => {
    const ops = readOps(SPEC);
    expect(ops.length).toBeGreaterThan(100); // sanity: the fixture is the real spec, not a stub
    expect(gen.opCount).toBe(ops.length);
    expect(gen.actions.length).toBe(gen.opCount);
    // and the platforms between them hold every one of those actions
    expect(gen.platforms.reduce((n, p) => n + p.actions.length, 0)).toBe(gen.opCount);
    // 178 across 29 platforms on the day the fixture was taken — the numbers the design quotes
    expect(gen.opCount).toBe(178);
    expect(gen.platforms.length).toBe(29);
  });

  it('every id has the one shape, is unique, and never says the vendor\'s name', () => {
    const ids = gen.actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(SERVICE_TOOL_ID_RE);
      expect(id).not.toContain('scrapecreators');
      expect(id).not.toContain('scrape_creators');
    }
  });

  it('derives the ids the design names, from the path alone', () => {
    const ids = new Set(gen.actions.map((a) => a.id));
    expect(ids.has('svc:instagram.search_hashtag')).toBe(true);
    expect(ids.has('svc:youtube.video_transcript')).toBe(true);
    // v2 with no v1 twin keeps the bare name
    expect(ids.has('svc:instagram.user_posts')).toBe(true);
    // camelCase and kebab-case both flatten to snake_case
    expect(ids.has('svc:facebook.ad_library_company_ads')).toBe(true);
    expect(ids.has('svc:apple_music.album')).toBe(true);
    expect(ids.has('svc:tiktok.get_trending_feed')).toBe(true);
    // GET keeps the bare name; the POST twin of the same path adds the method
    expect(ids.has('svc:reddit.post_comments')).toBe(true);
    expect(ids.has('svc:reddit.post_comments_post')).toBe(true);
    // a path with nothing after the platform is the endpoint "get"
    expect(ids.has('svc:linktree.get')).toBe(true);
    // the account endpoints are ops too, and are not skipped
    expect(ids.has('svc:account.credit_balance')).toBe(true);
  });

  it('keeps the lowest version bare and suffixes a newer one, whatever order the spec lists them in', () => {
    const op = (summary: string) => ({ summary, parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], responses: { 200: {} } });
    const a = generateFromSpec({ paths: { '/v2/x/thing': { get: op('new') }, '/v1/x/thing': { get: op('old') } } });
    const b = generateFromSpec({ paths: { '/v1/x/thing': { get: op('old') }, '/v2/x/thing': { get: op('new') } } });
    for (const g of [a, b]) {
      expect(g.byId.get('svc:x.thing')?.name).toBe('old');
      expect(g.byId.get('svc:x.thing_v2')?.name).toBe('new');
      expect(g.actions.length).toBe(2);
    }
  });

  it('flattens path segments the same way every time', () => {
    expect(slugSegment('adLibrary')).toBe('ad_library');
    expect(slugSegment('apple-music')).toBe('apple_music');
    expect(slugSegment('credit-balance')).toBe('credit_balance');
    expect(splitPath('/v2/instagram/user/posts')).toEqual({ version: 2, platform: 'instagram', rest: ['user', 'posts'] });
    expect(splitPath('/instagram/profile')).toEqual({ version: 1, platform: 'instagram', rest: ['profile'] });
    expect(endpointName([])).toBe('get');
  });

  it('carries the parameter schema, the vendor\'s tags and a cost hint when the spec states one', () => {
    const a = gen.byId.get('svc:instagram.search_hashtag')!;
    expect(a.name).toBe('Search Hashtag Posts');
    expect(a.method).toBe('GET');
    expect(a.path).toBe('/v1/instagram/search/hashtag');
    expect(a.tags).toEqual(['Instagram']);
    expect(a.schema.required).toEqual(['hashtag']);
    expect(a.schema.properties.date_posted.enum).toContain('last-month');
    expect(a.responseExample?.credits_charged).toBe(1);
    // the demographics call says "26 credits" in prose — the hint is that sentence, never a number we assume
    expect(gen.byId.get('svc:tiktok.user_audience')?.costHint).toMatch(/26 credits/);
    // a POST body's fields become the schema too
    const post = gen.byId.get('svc:reddit.post_comments_post')!;
    expect(post.schema.properties.url).toBeTruthy();
    expect(post.schema.required).toEqual(['url']);
  });

  it('nothing here is ever gated — every action is a read, and our own rule agrees', () => {
    for (const a of gen.actions) {
      expect(a.risky).toBe(false);
      expect(isRiskyAction(a.id, a.service)).toBe(false);
    }
  });

  it('names each platform from the vendor\'s own tags', () => {
    const by = new Map(gen.platforms.map((p) => [p.slug, p]));
    expect(by.get('tiktok')?.name).toBe('TikTok');
    expect(by.get('facebook')?.name).toBe('Facebook');
    expect(by.get('apple_music')?.name).toBe('Apple Music');
    expect(by.get('tiktok')?.tags).toContain('TikTok Shop');
  });
});

describe('the provider behind the seam', () => {
  const origFetch = global.fetch;
  const origKey = process.env.SCRAPECREATORS_API_KEY;
  beforeEach(() => { delete process.env.SCRAPECREATORS_API_KEY; });
  afterEach(() => { global.fetch = origFetch; if (origKey === undefined) delete process.env.SCRAPECREATORS_API_KEY; else process.env.SCRAPECREATORS_API_KEY = origKey; });

  it('lists every platform as a service and every op as its action', async () => {
    const p = provider('k');
    const services = await p.listServices();
    expect(services.length).toBe(29);
    const ig = services.find((s) => s.slug === 'instagram')!;
    expect(ig).toMatchObject({ name: 'Instagram', category: 'Social', connected: true, actionCount: 19, authMode: 'API_KEY', managedAuth: false, noAuth: false });
    expect(ig.accounts).toHaveLength(1);
    const actions = await p.listActions('instagram');
    expect(actions.length).toBe(19);
    expect(await p.getAction('svc:instagram.search_hashtag')).toBeTruthy();
    expect(await p.owns('svc:instagram.search_hashtag')).toBe(true);
    expect(await p.owns('svc:github.create_an_issue')).toBe(false);
  });

  it('with no key: platforms are listed but not connected, and connectedOnly is empty', async () => {
    const p = provider();
    expect((await p.listServices()).every((s) => !s.connected && s.accounts.length === 0)).toBe(true);
    expect(await p.listServices({ connectedOnly: true })).toEqual([]);
    expect((await p.status()).configured).toBe(false);
  });

  it('connect() without a key asks for one — the needsCredentials shape /tools already draws', async () => {
    const p = provider();
    const r = await p.connect('instagram');
    expect(r.needsCredentials).toBe(true);
    expect(r.fields?.map((f) => f.name)).toEqual(['apiKey']);
    expect(r.fields?.[0].secret).toBe(true);
  });

  it('connect() with a key checks it for real, then saves it once for every platform', async () => {
    const connectors = connectorsWith();
    const p = new ScrapeCreatorsProvider(connectors);
    p.useSpec(SPEC);
    global.fetch = jest.fn(async () => jsonResponse(200, { success: true, creditCount: 25099 })) as any;
    const r = await p.connect('tiktok', { credentials: { apiKey: 'sk-new' } });
    expect(r.ok).toBe(true);
    expect(r.done).toBe(true);
    expect(r.message).toContain('25,099');
    expect(connectors.set).toHaveBeenCalledWith('scrapecreators', { apiKey: 'sk-new' });
    // a rejected key is a plain sentence, never the vendor's body and never the key
    global.fetch = jest.fn(async () => jsonResponse(401, { success: false, message: 'Invalid API key sk-new' })) as any;
    const bad = await p.connect('tiktok', { credentials: { apiKey: 'sk-new' } });
    expect(bad.ok).toBe(false);
    expect(bad.message).not.toContain('sk-new');
  });

  it('execute() makes ONE call to their API with the key, and reads credits_charged off the answer', async () => {
    const p = provider('sk-test');
    const calls: any[] = [];
    global.fetch = jest.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return jsonResponse(200, { success: true, credits_remaining: 25098, credits_charged: 1, hashtag: 'smarthomeindia', posts: [{ shortcode: 'x' }], cursor: null });
    }) as any;
    const r = await p.execute('svc:instagram.search_hashtag', { hashtag: 'smarthomeindia', date_posted: 'last-month' });
    expect(r.ok).toBe(true);
    expect(r.credits).toBe(1);
    expect(r.data.posts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.scrapecreators.com/v1/instagram/search/hashtag');
    expect(u.searchParams.get('hashtag')).toBe('smarthomeindia');
    expect(u.searchParams.get('date_posted')).toBe('last-month');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers['x-api-key']).toBe('sk-test');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('a cache hit on their side is recorded as 0, not 1 — and a 15-credit call as 15', async () => {
    const p = provider('sk-test');
    global.fetch = jest.fn(async () => jsonResponse(200, { success: true, credits_charged: 0, posts: [] })) as any;
    expect((await p.execute('svc:instagram.search_hashtag', { hashtag: 'x' })).credits).toBe(0);
    global.fetch = jest.fn(async () => jsonResponse(200, { success: true, credits_charged: 15, comments: [] })) as any;
    expect((await p.execute('svc:instagram.post_comments', { url: 'https://instagram.com/p/x' })).credits).toBe(15);
  });

  it('a POST endpoint sends its arguments as the JSON body', async () => {
    const p = provider('sk-test');
    let seen: any;
    global.fetch = jest.fn(async (url: string, init: any) => { seen = { url, init }; return jsonResponse(200, { success: true, credits_charged: 1, comments: [] }); }) as any;
    const r = await p.execute('svc:reddit.post_comments_post', { url: 'https://reddit.com/r/x/comments/1', trim: true });
    expect(r.ok).toBe(true);
    expect(seen.init.method).toBe('POST');
    expect(JSON.parse(seen.init.body)).toEqual({ url: 'https://reddit.com/r/x/comments/1', trim: true });
    expect(new URL(seen.url).search).toBe('');
  });

  it('a refusal is a failed result with their reason — never a throw, never the key', async () => {
    const p = provider('sk-test');
    global.fetch = jest.fn(async () => jsonResponse(400, { success: false, message: 'cursor cannot exceed 11' })) as any;
    const r = await p.execute('svc:instagram.search_hashtag', { hashtag: 'x', cursor: '12' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('cursor cannot exceed 11');
    // an id that is not ours, or no key at all, is answered the same calm way
    expect((await p.execute('svc:github.create_an_issue', {})).ok).toBe(false);
    expect((await provider().execute('svc:instagram.search_hashtag', { hashtag: 'x' })).error).toContain('API key');
  });

  it('their "No posts found" (404, error:not_found, 0 credits) is a failed result marked notFound — any other refusal is not (BEA-1359)', async () => {
    const p = provider('sk-test');
    // exactly what api.scrapecreators.com answered on 2026-08-18 for every hashtag / reels search
    global.fetch = jest.fn(async () => jsonResponse(404, { success: false, credits_remaining: 25068, credits_charged: 0, error: 'not_found', errorStatus: 404, message: 'No posts found' })) as any;
    const r = await p.execute('svc:instagram.search_hashtag', { hashtag: 'smarthomeindia', date_posted: 'last-month' });
    expect(r.ok).toBe(false);
    expect(r.notFound).toBe(true);
    expect(r.credits).toBe(0);
    expect(r.error).toContain('No posts found');
    global.fetch = jest.fn(async () => jsonResponse(404, { success: false, credits_charged: 0, error: 'not_found', errorStatus: 404, message: 'No scrapeable reels found for that query. You were not charged for this request.' })) as any;
    expect((await p.execute('svc:instagram.reels_search', { query: 'smart home India' })).notFound).toBe(true);
    for (const [status, body] of [[429, { success: false, message: 'rate limited' }], [402, { success: false, message: 'out of credits' }], [500, { success: false, message: 'boom' }], [400, { success: false, message: 'cursor cannot exceed 11' }]] as [number, any][]) {
      global.fetch = jest.fn(async () => jsonResponse(status, body)) as any;
      const x = await p.execute('svc:instagram.search_hashtag', { hashtag: 'x' });
      expect(x.ok).toBe(false);
      expect(x.notFound).toBeUndefined();
    }
  });

  // ---- BEA-1364: the first call after a deploy failed "fetch failed" — name the cause, retry once ----

  const transportError = (code: string, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

  it('retries ONCE when fetch() itself rejects with a transport error, and the second answer wins', async () => {
    const p = provider('sk-test');
    let n = 0;
    global.fetch = jest.fn(async () => {
      n += 1;
      if (n === 1) throw transportError('ECONNRESET', 'socket hang up');
      return jsonResponse(200, { success: true, credits_charged: 1, data: { username: 'legrand_in' } });
    }) as any;
    const r = await p.execute('svc:instagram.profile', { handle: 'legrand_in' });
    expect(r.ok).toBe(true);
    expect(r.credits).toBe(1);
    expect(n).toBe(2);
  });

  it('two transport failures in a row fail with the CAUSE named — never bare "fetch failed"', async () => {
    const p = provider('sk-test');
    global.fetch = jest.fn(async () => { throw transportError('ECONNRESET', 'socket hang up'); }) as any;
    const r = await p.execute('svc:instagram.profile', { handle: 'legrand_in' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('fetch failed (ECONNRESET: socket hang up)');
    expect(r.error).not.toContain('sk-test');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2); // once, not for ever
    // a DNS hiccup reads the same way
    global.fetch = jest.fn(async () => { throw transportError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.scrapecreators.com'); }) as any;
    expect((await p.execute('svc:instagram.profile', { handle: 'x' })).error).toContain('EAI_AGAIN');
  });

  it('never retries a call that reached them: 402 / 404 / 429 / success:false / timeout = exactly one request', async () => {
    const p = provider('sk-test');
    for (const [status, body] of [[402, { success: false, message: 'Out of credits' }], [404, { success: false, message: 'No posts found' }], [429, { success: false, message: 'slow down' }], [200, { success: false, message: 'refused' }]] as [number, any][]) {
      global.fetch = jest.fn(async () => jsonResponse(status, body)) as any;
      const r = await p.execute('svc:instagram.profile', { handle: 'x' });
      expect(r.ok).toBe(false);
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    }
    // a timeout is an answer too (they may have started the work): one request, the old plain sentence
    global.fetch = jest.fn(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }) as any;
    const t = await p.execute('svc:instagram.profile', { handle: 'x' });
    expect(t.ok).toBe(false);
    expect(t.error).toBe('Scrape Creators did not answer in time.');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('a transport failure while checking the balance is named the same way', async () => {
    const p = provider('sk-test');
    global.fetch = jest.fn(async () => { throw transportError('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:443'); }) as any;
    const s = await p.status();
    expect(s.reachable).toBe(false);
    expect(s.message).toContain('ECONNREFUSED');
  });

  it('when their spec cannot be read, the last good generated list is served', async () => {
    const p = provider('k');
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const r = await p.loadSpec();
    expect(r.ok).toBe(false);
    expect(r.opCount).toBe(178);
    expect((await p.listServices()).length).toBe(29);
    expect(p.generated()?.actions.length).toBe(178);
    // and a spec that reads but is empty is not taken either
    global.fetch = jest.fn(async () => jsonResponse(200, { paths: {} })) as any;
    expect((await p.loadSpec()).ok).toBe(false);
    expect(p.generated()?.actions.length).toBe(178);
  });

  it('a live spec read replaces the list with whatever the spec now has — no cap', async () => {
    process.env.SCRAPECREATORS_SPEC_CACHE = join(require('os').tmpdir(), `sc-spec-${process.pid}.json`);
    const p = provider('k');
    const bigger = JSON.parse(JSON.stringify(SPEC));
    bigger.paths['/v1/newplatform/thing'] = { get: { summary: 'Thing', parameters: [], responses: { 200: {} } } };
    global.fetch = jest.fn(async () => jsonResponse(200, bigger)) as any;
    const r = await p.loadSpec();
    expect(r.ok).toBe(true);
    expect(r.opCount).toBe(179);
    expect(await p.getAction('svc:newplatform.thing')).toBeTruthy();
    delete process.env.SCRAPECREATORS_SPEC_CACHE;
  });
});

describe('the catalog: a Social group with exactly the spec\'s count, only when the key is set', () => {
  const origFetch = global.fetch;
  const origKey = process.env.SCRAPECREATORS_API_KEY;
  const connectors = (configured: string[]) => ({
    listStatus: async () => ['tavily', 'telegram'].map((name) => ({ name, configured: configured.includes(name) })),
    get: async () => null,
  }) as any;
  const skills = { list: async () => [] } as any;
  beforeEach(() => { global.fetch = (async () => ({ ok: false })) as any; delete process.env.SCRAPECREATORS_API_KEY; });
  afterEach(() => { global.fetch = origFetch; if (origKey === undefined) delete process.env.SCRAPECREATORS_API_KEY; else process.env.SCRAPECREATORS_API_KEY = origKey; });

  it('with the key: every action of every platform is in the Social group', async () => {
    const p = provider('k');
    // status() asks the balance; the network is off in this test, so it is "configured, unreachable"
    const svc = new ToolCatalogService(connectors(['tavily']), skills, undefined, undefined, p);
    const { groups, tools } = await svc.catalog();
    const social = groups.find((g) => g.group === 'Social')!;
    expect(social).toBeTruthy();
    expect(social.tools.length).toBe(p.generated()!.opCount);
    expect(social.tools.length).toBe(178);
    expect(social.tools.every((t) => SERVICE_TOOL_ID_RE.test(t.id) && t.connected && t.risky === false && t.service)).toBe(true);
    expect(tools.find((t) => t.id === 'svc:instagram.search_hashtag')?.name).toBe('Instagram: Search Hashtag Posts');
    // groups stay in the fixed order, Social right after Services
    expect(GROUP_ORDER.indexOf('Social')).toBe(GROUP_ORDER.indexOf('Services') + 1);
    // and Chat's list — the same builder — sees them as connected
    const forChat = await svc.connectedServiceTools();
    expect(forChat.filter((t) => t.group === 'Social').length).toBe(178);
  });

  it('without the key: the catalog is exactly what it was — no Social group, no error', async () => {
    const before = await new ToolCatalogService(connectors(['tavily']), skills).catalog();
    const after = await new ToolCatalogService(connectors(['tavily']), skills, undefined, undefined, provider()).catalog();
    expect(after.groups.map((g) => g.group)).toEqual(before.groups.map((g) => g.group));
    expect(after.tools.map((t) => t.id)).toEqual(before.tools.map((t) => t.id));
    expect(after.groups.find((g) => g.group === 'Social')).toBeUndefined();
  });
});

describe('the run path: routed by exact id, and the ToolCall row carries the credits', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  function harness(charged: number) {
    const rows: any[] = [];
    const prisma: any = { toolCall: { create: async ({ data }: any) => { rows.push(data); return data; } } };
    const composio: any = {
      getService: jest.fn(async () => ({ slug: 'github', name: 'GitHub', accounts: [{ id: 'ca_1', label: 'sandy', status: 'ACTIVE' }] })),
      getAction: jest.fn(async () => ({ id: 'svc:github.create_an_issue', name: 'Create an issue', description: '', service: 'github', risky: false, schema: { type: 'object', properties: {} } })),
      execute: jest.fn(async () => ({ ok: true, data: { number: 7 }, ms: 5 })),
      refresh: jest.fn(),
    };
    const llm: any = { completeHelper: jest.fn(async () => '{}'), complete: jest.fn(async () => 'INVENTED') };
    const social = provider('sk-test');
    global.fetch = jest.fn(async () => jsonResponse(200, { success: true, credits_remaining: 100, credits_charged: charged, posts: [{ shortcode: 'abc', caption: 'smart home' }], cursor: null })) as any;
    const svc = new ServiceActionsService(composio, llm, prisma, undefined, social);
    return { svc, rows, composio, llm, social };
  }

  it('a social id runs on the social provider and writes credits from the answer', async () => {
    const { svc, rows, composio, llm } = harness(1);
    const out = await svc.run('svc:instagram.search_hashtag', 'find smart home posts', { runId: 'r1', runKind: 'flow', nodeId: 'n1', args: { hashtag: 'smarthomeindia', date_posted: 'last-month' } });
    expect(out).toContain('Instagram: Search Hashtag Posts');
    expect(out).toContain('smart home');
    expect(composio.execute).not.toHaveBeenCalled();
    expect(llm.completeHelper).not.toHaveBeenCalled(); // pinned arguments → no model call
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, service: 'instagram', action: 'svc:instagram.search_hashtag', credits: 1, gated: false, accountId: 'default' });
  });

  it('a read-only provider is never gated, even for an id whose words would trip the name rule', async () => {
    const { svc, rows, social } = harness(1);
    // a synthetic future endpoint whose path happens to say "block" — a read all the same
    const spec = JSON.parse(JSON.stringify(SPEC));
    spec.paths['/v1/twitter/block/list'] = { get: { summary: 'Blocked accounts', parameters: [{ name: 'handle', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: {} } } };
    social.useSpec(spec);
    expect(isRiskyAction('svc:twitter.block_list', 'twitter')).toBe(true); // the rule alone WOULD gate it
    await svc.run('svc:twitter.block_list', '', { args: { handle: 'x' } });
    expect(rows[0]).toMatchObject({ ok: true, gated: false, credits: 1 });
  });

  it('a cache hit is written as 0 credits, not 1', async () => {
    const { svc, rows } = harness(0);
    await svc.run('svc:instagram.search_hashtag', '', { args: { hashtag: 'x' } });
    expect(rows[0].credits).toBe(0);
  });

  it('an id the social provider does not own still goes where it always went, with credits null', async () => {
    const { svc, rows, composio } = harness(1);
    await svc.run('svc:github.create_an_issue', 'make one', { args: {} });
    expect(composio.execute).toHaveBeenCalled();
    expect(rows[0].credits).toBeNull();
  });
});
