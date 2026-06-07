import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { BookmarksService, cleanTags } from './bookmarks.service';

function makeService(over: any = {}) {
  const created: any[] = [];
  const enqueued: any[] = [];
  const prisma: any = {
    item: {
      findMany: async () => over.existing ?? [],
      create: async ({ data }: any) => {
        const row = { id: `id${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
      update: async () => ({}),
      count: async () => created.length,
    },
    setting: { upsert: async () => ({}), findUnique: async () => null },
  };
  const memory: any = { enqueue: async (content: string, opts: any) => enqueued.push({ content, opts }) };
  const llm: any = { complete: async () => over.summary ?? 'A clear ~250 word summary of the page.' };
  const raindrop: any = {
    hasKey: async () => over.hasRaindrop ?? true,
    recent: async () => over.recent ?? [],
  };
  const tavily: any = {
    hasKey: async () => over.hasTavily ?? true,
    extract: async (url: string) => (over.unreadable?.includes(url) ? null : 'real page text'),
  };
  const svc = new BookmarksService(prisma, memory, llm, raindrop, tavily);
  return { svc, created, enqueued };
}

describe('BookmarksService', () => {
  beforeAll(() => {
    process.env.DATA_DIR = join(tmpdir(), 'mybrain-bm-test');
  });

  it('cleanTags lowercases, trims, dedupes', () => {
    expect(cleanTags([' SEO', 'seo', 'Cloud '])).toEqual(['seo', 'cloud']);
  });

  it('buildMarkdown puts the URL on the first line + includes tags and date', () => {
    const { svc } = makeService();
    const md = svc.buildMarkdown(
      { id: 1, title: 'Cloud SEO', link: 'https://x.com/a', excerpt: '', note: '', tags: ['seo', 'cloud'], created: '2026-05-01T00:00:00Z' } as any,
      'Body summary.',
      false,
    );
    expect(md.split('\n')[0]).toBe('https://x.com/a');
    expect(md).toContain('# Cloud SEO');
    expect(md).toContain('**Tags:** seo, cloud');
    expect(md).toContain('2026-05-01');
  });

  it('flags unreadable pages and marks them in the markdown, never dropping them', () => {
    const { svc } = makeService();
    const md = svc.buildMarkdown(
      { id: 1, title: 'Paywalled', link: 'https://p.com', excerpt: '', note: '', tags: [], created: '2026-05-01' } as any,
      'From metadata.',
      true,
    );
    expect(md).toContain("couldn't be fully read");
  });

  it('requires Raindrop and Tavily to be connected', async () => {
    const a = await makeService({ hasRaindrop: false }).svc.sync();
    expect(a).toMatchObject({ ok: false, code: 'no_raindrop' });
    const b = await makeService({ hasTavily: false }).svc.sync();
    expect(b).toMatchObject({ ok: false, code: 'no_tavily' });
  });

  it('imports new bookmarks, flags unreadable ones, and stamps "bookmark" into memory', async () => {
    const recent = [
      { id: 1, title: 'Readable', link: 'https://ok.com', excerpt: '', note: '', tags: ['seo'], created: '2026-05-10T00:00:00Z' },
      { id: 2, title: 'Blocked', link: 'https://paywall.com', excerpt: 'ex', note: 'mine', tags: ['cloud'], created: '2026-05-11T00:00:00Z' },
    ];
    const { svc, created, enqueued } = makeService({ recent, unreadable: ['https://paywall.com'] });
    const res = await svc.sync();

    expect(res).toMatchObject({ ok: true, imported: 2, flagged: 1, total: 2, skipped: 0 });
    // both items stored as raindrop source
    expect(created.every((c) => c.source === 'raindrop')).toBe(true);
    // the blocked one is flagged readFailed
    expect(created.find((c) => c.sourceUrl === 'https://paywall.com').readFailed).toBe(true);
    expect(created.find((c) => c.sourceUrl === 'https://ok.com').readFailed).toBe(false);
    // every memory write carries the "bookmark" stamp
    expect(enqueued.length).toBe(2);
    expect(enqueued.every((e) => e.opts.tags.includes('bookmark'))).toBe(true);
  });

  it('skips bookmarks already imported (dedup by link)', async () => {
    const recent = [{ id: 1, title: 'Dup', link: 'https://dup.com', excerpt: '', note: '', tags: [], created: '2026-05-10T00:00:00Z' }];
    const { svc, created } = makeService({ recent, existing: [{ sourceUrl: 'https://dup.com' }] });
    const res = await svc.sync();
    expect(res).toMatchObject({ ok: true, imported: 0, skipped: 1 });
    expect(created.length).toBe(0);
  });

  afterAll(async () => {
    await fs.rm(join(tmpdir(), 'mybrain-bm-test'), { recursive: true, force: true }).catch(() => undefined);
  });
});
