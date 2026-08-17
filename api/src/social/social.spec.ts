import { readFileSync } from 'fs';
import { join } from 'path';
import { ScrapeCreatorsProvider } from '../tools/scrapecreators.provider';
import { ServiceActionsService } from '../tools/service-actions.service';
import { TZ_OFFSET_MIN, localDayKey } from '../common/localday';
import { CEILING_KEY, SocialService, TOP_UP_URL } from './social.service';

/**
 * BEA-1356 — the Social section's answers.
 *
 * What is locked down: the counts on the page are the PROVIDER's counts (every platform, every
 * endpoint — from the spec, never a hand list); a run goes through the one run path and writes a
 * `ToolCall` row with `credits`; a 402 becomes a plain sentence with a top-up link; today's spend
 * is the sum of credits since the owner's local midnight over social platforms only; and the
 * ceiling reads the default (500) until the owner sets one (BEA-1358). Nothing here reaches the network.
 */
const SPEC = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'fixtures', 'scrapecreators-openapi.trimmed.json'), 'utf8'));

const connectorsWith = (apiKey?: string) => ({
  get: jest.fn(async () => (apiKey ? { apiKey } : null)),
  set: jest.fn(async () => undefined),
  remove: jest.fn(async () => undefined),
  listStatus: async () => [] as any[],
}) as any;

const jsonResponse = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });

function harness(opts: { apiKey?: string; ceiling?: string; sum?: number | null } = {}) {
  const provider = new ScrapeCreatorsProvider(connectorsWith(opts.apiKey));
  provider.useSpec(SPEC);
  const rows: any[] = [];
  const aggregateWhere: any[] = [];
  const prisma: any = {
    toolCall: {
      create: async ({ data }: any) => { rows.push(data); return data; },
      aggregate: async ({ where }: any) => { aggregateWhere.push(where); return { _sum: { credits: opts.sum === undefined ? 3 : opts.sum } }; },
    },
    setting: { findUnique: async ({ where }: any) => (where.key === CEILING_KEY && opts.ceiling ? { key: CEILING_KEY, value: opts.ceiling } : null) },
  };
  const llm: any = { completeHelper: jest.fn(async () => '{"handle":"INVENTED"}') };
  // The real run path, with the social provider owning its ids — exactly as in the app.
  const actions = new ServiceActionsService({} as any, llm, prisma, undefined, provider);
  const svc = new SocialService(provider, actions, prisma);
  return { svc, provider, rows, llm, aggregateWhere };
}

describe('the platform grid — every platform, counted by the provider (BEA-1356)', () => {
  it('lists every platform the provider reports, with its own endpoint count', async () => {
    const { svc, provider } = harness({ apiKey: 'k' });
    global.fetch = jest.fn(async () => jsonResponse(200, { success: true, creditCount: 25100 })) as any;
    const o = await svc.overview();
    const theirs = await provider.listServices();
    expect(o.platforms.length).toBe(theirs.length);
    expect(o.platforms.length).toBe(29);
    for (const p of o.platforms) {
      const t = theirs.find((x) => x.slug === p.slug)!;
      expect(t).toBeTruthy();
      expect(p.actionCount).toBe(t.actionCount);
      expect(p.tags.length).toBeGreaterThan(0);
    }
    // the header numbers
    expect(o.status.configured).toBe(true);
    expect(o.balance).toBe(25100);
    expect(o.spentToday).toBe(3);
    expect(o.ceiling).toBe(500); // the default ceiling until the owner sets one (BEA-1358)
    expect(o.spec.opCount).toBe(178);
    expect(o.topUpUrl).toBe(TOP_UP_URL);
  });

  it('with no key: says so, and still names the platforms rather than drawing an empty grid', async () => {
    const { svc } = harness({});
    const o = await svc.overview();
    expect(o.status.configured).toBe(false);
    expect(o.status.message).toMatch(/key/i);
    expect(o.balance).toBeNull();
    expect(o.platforms.length).toBe(29);
    expect(o.platforms.every((p) => p.connected === false)).toBe(true);
  });

  it('"check again" waits for the re-read (bounded) and reports why it failed', async () => {
    const { svc, provider } = harness({ apiKey: 'k' });
    let specFetches = 0;
    global.fetch = jest.fn(async (url: any) => {
      if (String(url).includes('openapi.json')) { specFetches++; return { ok: false, status: 503, text: async () => '', json: async () => ({}) }; }
      return jsonResponse(200, { success: true, creditCount: 1 });
    }) as any;
    const o = await svc.overview(true);
    expect(specFetches).toBe(1);
    expect(o.spec.lastError).toContain('503');
    expect(o.platforms.length).toBe(29); // the last good list stays
    expect(provider.specState().opCount).toBe(178);
  });

  it('shows the ceiling the owner set, and "no limit" when it is 0', async () => {
    expect((await harness({ ceiling: '120' }).svc.overview()).ceiling).toBe(120);
    expect((await harness({ ceiling: '0' }).svc.overview()).ceiling).toBeNull();
  });
});

describe('the platform page — every endpoint, grouped by the spec\'s own tags', () => {
  it('returns every endpoint of the platform, count == the provider\'s', async () => {
    const { svc, provider } = harness({ apiKey: 'k' });
    const page = await svc.platform('tiktok');
    const theirs = await provider.listActions('tiktok');
    expect(page).toBeTruthy();
    expect(page!.actions.length).toBe(theirs.length);
    expect(page!.actions.length).toBe(29);
    expect(page!.platform.actionCount).toBe(29);
    // every action carries the spec's tag(s) and a schema the form is generated from
    for (const a of page!.actions) {
      expect((a.tags || []).length).toBeGreaterThan(0);
      expect(a.schema?.type).toBe('object');
    }
    // the tags the page groups by are the ones on the actions, biggest group first
    const seen = new Set(page!.actions.flatMap((a) => a.tags || []));
    expect(new Set(page!.platform.tags)).toEqual(seen);
  });

  it('a platform with one endpoint, and a form with no parameters, are both ordinary', async () => {
    const { svc } = harness({ apiKey: 'k' });
    const one = await svc.platform('linktree');
    expect(one!.actions.length).toBe(1);
    // the spec has a handful of no-parameter endpoints; the schema is still an object
    const gen = (svc as any).social.generated();
    const bare = gen.actions.find((a: any) => !Object.keys(a.schema?.properties || {}).length);
    expect(bare).toBeTruthy();
    expect(bare.schema).toEqual({ type: 'object', properties: {} });
  });

  it('an unknown platform is null, not a crash', async () => {
    const { svc } = harness({ apiKey: 'k' });
    expect(await svc.platform('myspace')).toBeNull();
  });
});

describe('run it right there — through the one run path, and written down with its cost', () => {
  it('runs with the form\'s values, writes a ToolCall row with credits, and hands back the whole answer', async () => {
    const { svc, rows, llm } = harness({ apiKey: 'k' });
    const answer = { success: true, credits_remaining: 25099, credits_charged: 1, data: { username: 'legrand_in', follower_count: 1200 } };
    global.fetch = jest.fn(async (url: any) => {
      expect(String(url)).toContain('/v1/instagram/profile?handle=legrand_in');
      return jsonResponse(200, answer);
    }) as any;

    const r = await svc.run('svc:instagram.profile', { handle: 'legrand_in', unknownField: 'dropped' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(answer);
    expect(r.credits).toBe(1);
    expect(r.actionName).toBeTruthy();
    // no model call: the form IS the arguments
    expect(llm.completeHelper).not.toHaveBeenCalled();
    // the flight recorder row, exactly like an agent's
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, service: 'instagram', action: 'svc:instagram.profile', runKind: 'social', credits: 1 });
    expect(JSON.parse(rows[0].arguments)).toEqual({ handle: 'legrand_in' });
  });

  it('a cache hit is credits 0, and 0 is what is written down', async () => {
    const { svc, rows } = harness({ apiKey: 'k' });
    global.fetch = jest.fn(async () => jsonResponse(200, { success: true, credits_charged: 0, data: {} })) as any;
    const r = await svc.run('svc:instagram.profile', { handle: 'x' });
    expect(r.ok).toBe(true);
    expect(r.credits).toBe(0);
    expect(rows[0].credits).toBe(0);
  });

  it('a form left blank on a no-parameter endpoint runs with no model call at all', async () => {
    const { svc, llm } = harness({ apiKey: 'k' });
    global.fetch = jest.fn(async () => jsonResponse(200, { success: true, credits_charged: 1, ideas: [] })) as any;
    const gen = (svc as any).social.generated();
    const bare = gen.actions.find((a: any) => !Object.keys(a.schema?.properties || {}).length);
    const r = await svc.run(bare.id, {});
    expect(r.ok).toBe(true);
    expect(llm.completeHelper).not.toHaveBeenCalled();
  });

  it('a missing required field is a plain sentence on the form — nothing is sent', async () => {
    const { svc, rows } = harness({ apiKey: 'k' });
    global.fetch = jest.fn(async () => { throw new Error('must not be called'); }) as any;
    const r = await svc.run('svc:instagram.profile', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Fill in handle/);
    expect(rows).toHaveLength(0);
  });

  it('types the form\'s text the way the schema says (numbers, booleans)', async () => {
    const { svc } = harness({ apiKey: 'k' });
    let seen = '';
    global.fetch = jest.fn(async (url: any) => { seen = String(url); return jsonResponse(200, { success: true, credits_charged: 1 }); }) as any;
    // TikTok video comments: `url` (string, required), `cursor` (number), `trim` (boolean).
    const r = await svc.run('svc:tiktok.video_comments', { url: 'https://www.tiktok.com/@x/video/1', cursor: '20', trim: 'true' });
    expect(r.ok).toBe(true);
    expect(seen).toContain('cursor=20');
    expect(seen).toContain('trim=true');
  });

  it('402 → "credits are out" with the top-up link, never the raw refusal', async () => {
    const { svc, rows } = harness({ apiKey: 'k' });
    global.fetch = jest.fn(async () => jsonResponse(402, { success: false, credits_charged: 0, error: 'payment_required', message: 'Insufficient credits' })) as any;
    const r = await svc.run('svc:instagram.profile', { handle: 'x' });
    expect(r.ok).toBe(false);
    expect(r.outOfCredits).toBe(true);
    expect(r.error).toMatch(/credits are out/i);
    expect(r.error).not.toContain('payment_required');
    expect(r.topUpUrl).toBe(TOP_UP_URL);
    // still written down as a failed call, charged nothing
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].credits).toBe(0);
  });

  it('their own error comes through in plain words (the hashtag outage: 404 "No posts found")', async () => {
    const { svc } = harness({ apiKey: 'k' });
    global.fetch = jest.fn(async () => jsonResponse(404, { success: false, credits_charged: 0, error: 'not_found', message: 'No posts found' })) as any;
    const r = await svc.run('svc:instagram.search_hashtag', { hashtag: 'x' });
    expect(r.ok).toBe(false);
    expect(r.outOfCredits).toBeUndefined();
    expect(r.error).toContain('No posts found');
    expect(r.credits).toBe(0);
  });

  it('an id that is not one of ours is refused before anything runs', async () => {
    const { svc, rows } = harness({ apiKey: 'k' });
    const r = await svc.run('svc:github.create_an_issue', {});
    expect(r.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe('today\'s spend — since the owner\'s local midnight, social platforms only', () => {
  it('asks for the sum of credits since local midnight, over the platform slugs, credits not null', async () => {
    const { svc, aggregateWhere } = harness({ apiKey: 'k', sum: 12 });
    const now = new Date('2026-08-17T20:30:00Z'); // 02:00 IST on the 18th
    const n = await svc.spentToday(['tiktok', 'instagram'], now);
    expect(n).toBe(12);
    const where = aggregateWhere[0];
    expect(where.service).toEqual({ in: ['tiktok', 'instagram'] });
    expect(where.credits).toEqual({ not: null });
    // local midnight of the 18th IST = 17th 18:30 UTC
    const expected = new Date(new Date(`${localDayKey(now)}T00:00:00Z`).getTime() - TZ_OFFSET_MIN * 60000);
    expect(localDayKey(now)).toBe('2026-08-18');
    expect(where.createdAt.gte.toISOString()).toBe(expected.toISOString());
    expect(expected.toISOString()).toBe('2026-08-17T18:30:00.000Z');
  });

  it('is 0 when nothing was spent, and 0 when the database cannot answer', async () => {
    const a = harness({ apiKey: 'k', sum: null });
    expect(await a.svc.spentToday(['tiktok'])).toBe(0);
    const b = new SocialService(a.provider, {} as any, { toolCall: { aggregate: async () => { throw new Error('down'); } } } as any);
    expect(await b.spentToday(['tiktok'])).toBe(0);
  });
});
