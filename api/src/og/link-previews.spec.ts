import { buildOgRoutes, cleanDescription, injectOg, ogTags, OgMeta } from './link-previews';

const SHELL = [
  '<!doctype html><html><head><title>My Brain</title>',
  '<!--og-->',
  '<meta property="og:title" content="My Brain">',
  '<meta property="og:image" content="https://mybrain.1site.ai/og-default.png">',
  '<!--/og-->',
  '</head><body><div id="root"></div></body></html>',
].join('');

const META: OgMeta = {
  title: 'Tom & Jerry <notes>',
  description: 'A "quoted" description',
  image: 'https://mybrain.1site.ai/api/og/skill/abc/card.png',
  url: 'https://mybrain.1site.ai/skill/abc',
};

const ORIGIN = 'https://mybrain.1site.ai';
const count = (h: string, needle: string) => h.split(needle).length - 1;

describe('link previews (BEA-1133 / BEA-1134)', () => {
  it('replaces the default block so a page never has two og:title tags', () => {
    const out = injectOg(SHELL, META);
    expect(count(out, 'property="og:title"')).toBe(1);
    expect(count(out, 'property="og:image"')).toBe(1);
    expect(out).not.toContain('og-default.png');
    expect(out).toContain('content="Tom &amp; Jerry &lt;notes&gt;"');
    expect(out).toContain('<title>Tom &amp; Jerry &lt;notes&gt;</title>');
  });

  it('escapes quotes so the meta tag cannot be broken out of', () => {
    const out = injectOg(SHELL, META);
    expect(out).toContain('content="A &quot;quoted&quot; description"');
  });

  it('still works on a shell with no markers (older build)', () => {
    const out = injectOg('<html><head><title>x</title></head><body></body></html>', META);
    expect(count(out, 'property="og:title"')).toBe(1);
    expect(out).toContain('</head>');
  });

  it('always emits the size hints crawlers need', () => {
    const t = ogTags(META);
    expect(t).toContain('og:image:width" content="1200"');
    expect(t).toContain('og:image:height" content="630"');
    expect(t).toContain('twitter:card" content="summary_large_image"');
  });

  it('cleans markdown and falls back when there is nothing to say', () => {
    expect(cleanDescription('# Hello  **world**\n\nmore')).toBe('Hello world more');
    expect(cleanDescription('')).toBe('Shared from My Brain');
    expect(cleanDescription(null, 'Saved in My Brain.')).toBe('Saved in My Brain.');
    expect(cleanDescription('x'.repeat(500)).length).toBe(180);
  });

  describe('resolvers', () => {
    const docs = {
      ogMeta: jest.fn(async (slug: string) => (slug === 'live' ? { title: 'Doc', description: 'd', image: 'i', url: `${ORIGIN}/d/live` } : null)),
      resolveShortCode: jest.fn(async (code: string) => (code === 'abc' ? { slug: 'live' } : null)),
    };
    const prisma = {
      skill: { findUnique: jest.fn(async ({ where }: any) => (where.id === 's1' ? { id: 's1', title: 'Start a new app', description: 'Does things', shared: true } : where.id === 's2' ? { id: 's2', title: 'Private', description: 'x', shared: false } : null)) },
      meeting: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'm1' ? { id: 'm1', title: 'Board call', summary: 'SECRET SUMMARY', shared: true, createdAt: new Date('2026-07-20T10:00:00Z') } : null)) },
      item: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'i1' ? { id: 'i1', title: 'A bookmark', summary: 'about things', shared: true } : null)) },
    };
    const routes = buildOgRoutes({ docs: docs as any, prisma });
    const byPath = (p: string) => routes.find((r) => r.path === p)!;

    it('serves a shared skill with its own title, description and card', async () => {
      const m = await byPath('/skill/:id').resolve({ id: 's1' }, ORIGIN);
      expect(m).toEqual({
        title: 'Start a new app',
        description: 'Does things',
        image: `${ORIGIN}/api/og/skill/s1/card.png`,
        url: `${ORIGIN}/skill/s1`,
      });
    });

    it('returns null for a skill that is not shared, and for one that does not exist', async () => {
      expect(await byPath('/skill/:id').resolve({ id: 's2' }, ORIGIN)).toBeNull();
      expect(await byPath('/skill/:id').resolve({ id: 'nope' }, ORIGIN)).toBeNull();
    });

    it('gives a short link the same card as its long form, under its own URL', async () => {
      const m = await byPath('/s/:code').resolve({ code: 'abc' }, ORIGIN);
      expect(m?.title).toBe('Doc');
      expect(m?.url).toBe(`${ORIGIN}/s/abc`);
      expect(await byPath('/s/:code').resolve({ code: 'gone' }, ORIGIN)).toBeNull();
    });

    it('never puts a meeting summary into the preview (chat apps cache it)', async () => {
      const m = await byPath('/meeting-view/:id').resolve({ id: 'm1' }, ORIGIN);
      expect(m?.title).toBe('Board call');
      expect(m?.description).not.toContain('SECRET');
      expect(m?.description).toContain('20 Jul 2026');
    });

    it('serves a shared bookmark', async () => {
      const m = await byPath('/view/:id').resolve({ id: 'i1' }, ORIGIN);
      expect(m?.title).toBe('A bookmark');
      expect(m?.image).toBe(`${ORIGIN}/api/og/item/i1/card.png`);
    });

    it('serves the public radar card through RadarFeedService, and skips it when unwired (BEA-1325)', async () => {
      const radar = { ogMeta: jest.fn(async (origin: string) => ({ title: 'AI News Daily — My Brain', description: 'Hot now: X', image: `${origin}/og-default.png`, url: `${origin}/radar` })) };
      const withRadar = buildOgRoutes({ docs: docs as any, prisma, radar });
      const m = await withRadar.find((r) => r.path === '/radar')!.resolve({}, ORIGIN);
      expect(m?.title).toBe('AI News Daily — My Brain');
      expect(m?.url).toBe(`${ORIGIN}/radar`);
      // Without the dep the route resolves null → the default card, never a crash.
      expect(await byPath('/radar').resolve({}, ORIGIN)).toBeNull();
    });

    it('does NOT register the private contact board or Gmail request pages', () => {
      const paths = routes.map((r) => r.path);
      expect(paths).not.toContain('/t/:slug');
      expect(paths).not.toContain('/request-view/:shareId');
    });

    it('survives a database error by falling back to the default card', async () => {
      const boom = { skill: { findUnique: jest.fn(async () => { throw new Error('db down'); }) } };
      const r = buildOgRoutes({ docs: docs as any, prisma: boom });
      await expect(r.find((x) => x.path === '/skill/:id')!.resolve({ id: 's1' }, ORIGIN)).resolves.toBeNull();
    });
  });
});
