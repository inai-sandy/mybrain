import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { BookmarksService, cleanTags, shouldRetry, MAX_READ_ATTEMPTS } from './bookmarks.service';

const YT = 'https://www.youtube.com/watch?v=abc123';
const WEB = 'https://nonexistent.invalid.example/page'; // fetch fails → treated as unreadable

function makeService(over: any = {}) {
  const created: any[] = [];
  const updated: any[] = [];
  const enqueued: any[] = [];
  const prisma: any = {
    item: {
      findMany: async () => over.existingRows ?? [],
      findFirst: async () => over.dupRow ?? null,
      create: async ({ data }: any) => {
        const row = { id: `id${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        updated.push({ where, data });
        return { id: where.id, ...data };
      },
      count: async () => created.length,
    },
    memoryOutbox: { deleteMany: async () => ({}) },
    setting: { upsert: async () => ({}), findUnique: async () => null },
  };
  const memory: any = {
    enqueue: async (content: string, opts: any) => enqueued.push({ content, opts }),
    deleteDoc: async () => undefined,
    searchBoth: async () => ({ supermemory: [], rag: [] }),
  };
  const summarizer: any = {
    isVideo: (url: string) => /youtube\.com|youtu\.be/.test(url),
    summarizeYouTube: async () => over.ytSummary ?? 'A clear summary of the video.',
    summarizeUrl: async () => over.urlSummary ?? null,
    summarizeText: async () => over.textSummary ?? 'A clear summary of the page.',
    hasKey: async () => over.hasModel ?? true,
  };
  const raindrop: any = {
    hasKey: async () => over.hasRaindrop ?? true,
    recent: async () => over.recent ?? [],
  };
  const instagram: any = { isInstagram: () => false, enrich: async () => null, configured: async () => false };
  const removed: string[] = [];
  const items: any = { remove: async (id: string) => removed.push(id) }; // the one true item delete (BEA-1049)
  const svc = new BookmarksService(prisma, memory, summarizer, raindrop, instagram, items);
  return { svc, created, updated, enqueued, removed };
}

const bm = (over: any) => ({ id: 1, title: 'T', link: '', excerpt: '', note: '', tags: [], created: '2026-05-10T00:00:00Z', ...over });

describe('BookmarksService', () => {
  beforeAll(() => {
    process.env.DATA_DIR = join(tmpdir(), 'mybrain-bm-test');
  });

  it('cleanTags lowercases, trims, dedupes', () => {
    expect(cleanTags([' SEO', 'seo', 'Cloud '])).toEqual(['seo', 'cloud']);
  });

  it('buildMarkdown puts the URL on the first line + marks YouTube source', () => {
    const { svc } = makeService();
    const md = svc.buildMarkdown(bm({ title: 'Cloud SEO', link: YT, tags: ['seo'] }) as any, 'Body.', false);
    expect(md.split('\n')[0]).toBe(YT);
    expect(md).toContain('# Cloud SEO');
    expect(md).toContain('**Tags:** seo');
    expect(md).toContain('**Source:** YouTube');
  });

  it('flags unreadable items in the markdown', () => {
    const { svc } = makeService();
    const md = svc.buildMarkdown(bm({ title: 'X', link: 'https://x.com' }) as any, 'From metadata.', true);
    expect(md).toContain("couldn't be read");
  });

  it('start() requires Raindrop and OpenRouter', async () => {
    expect(await makeService({ hasRaindrop: false }).svc.start()).toMatchObject({ ok: false, code: 'no_raindrop' });
    expect(await makeService({ hasModel: false }).svc.start()).toMatchObject({ ok: false, code: 'no_model' });
  });

  it('summarizes a YouTube link via Gemini and a dead web link as flagged; both stamped "bookmark"', async () => {
    const list = [bm({ id: 1, title: 'Vid', link: YT, tags: ['seo'] }), bm({ id: 2, title: 'Dead', link: WEB, excerpt: 'fallback', tags: ['x'] })];
    const { svc, created, enqueued } = makeService();
    const res = await svc.importBatch(list as any);
    expect(res).toMatchObject({ imported: 2, flagged: 1 });
    expect(created.find((c) => c.sourceUrl === YT).readFailed).toBe(false);
    expect(created.find((c) => c.sourceUrl === WEB).readFailed).toBe(true);
    expect(enqueued.length).toBe(2);
    expect(enqueued.every((e) => e.opts.tags.includes('bookmark'))).toBe(true);
  }, 15000);

  it('re-summarizes an existing unreadable bookmark in place (no duplicate)', async () => {
    const existing = new Map<string, any>([[YT, { id: 'old1', sourceUrl: YT, readFailed: true, supermemoryId: null, ragId: null, filePath: null }]]);
    const { svc, created, updated } = makeService();
    const res = await svc.importBatch([bm({ id: 1, title: 'Vid', link: YT }) as any], existing);
    expect(res).toMatchObject({ imported: 1, flagged: 0 });
    expect(created.length).toBe(0); // updated, not created
    expect(updated[0].where.id).toBe('old1');
    expect(updated[0].data.readFailed).toBe(false);
  }, 15000);

  // Dead links must not cost money every hour forever. (BEA-841)
  describe('retry cap for unreadable bookmarks (BEA-841)', () => {
    it('retries an unreadable bookmark only while it has attempts left', () => {
      expect(shouldRetry({ readFailed: true, readAttempts: 0 })).toBe(true);
      expect(shouldRetry({ readFailed: true, readAttempts: MAX_READ_ATTEMPTS - 1 })).toBe(true);
      expect(shouldRetry({ readFailed: true, readAttempts: MAX_READ_ATTEMPTS })).toBe(false); // gave up
      expect(shouldRetry({ readFailed: false, readAttempts: 0 })).toBe(false); // readable — nothing to retry
    });

    it('a failed retry burns one attempt; success clears the count', async () => {
      const existing = new Map<string, any>([[WEB, { id: 'dead1', sourceUrl: WEB, readFailed: true, readAttempts: 2, supermemoryId: null, ragId: null, filePath: null }]]);
      const { svc, updated } = makeService();
      await svc.importBatch([bm({ id: 1, title: 'Dead', link: WEB }) as any], existing);
      expect(updated[0].data.readAttempts).toEqual({ increment: 1 }); // still unreadable → one more spent

      const existing2 = new Map<string, any>([[YT, { id: 'ok1', sourceUrl: YT, readFailed: true, readAttempts: 4, supermemoryId: null, ragId: null, filePath: null }]]);
      const s2 = makeService();
      await s2.svc.importBatch([bm({ id: 2, title: 'Vid', link: YT }) as any], existing2);
      expect(s2.updated[0].data.readAttempts).toBe(0); // finally read → counter wiped
    }, 20000);
  });

  // Save any URL by hand — Raindrop stops being the only door in. (BEA-1050)
  describe('addManual (BEA-1050)', () => {
    it('rejects something that is not a web link', async () => {
      const { svc } = makeService();
      expect(await svc.addManual('not a url')).toMatchObject({ ok: false, code: 'bad_url' });
      expect(await svc.addManual('ftp://x')).toMatchObject({ ok: false, code: 'bad_url' });
    });

    it('refuses a link that is already saved instead of duplicating it', async () => {
      const { svc } = makeService({ dupRow: { id: 'x', title: 'Old one' } });
      const r = await svc.addManual('https://example.com/page');
      expect(r).toMatchObject({ ok: false, code: 'exists' });
      expect(r.message).toContain('Old one');
    });

    it('saves an unreadable link with the note kept and stamped "bookmark"', async () => {
      const { svc, created, enqueued } = makeService();
      const r = await svc.addManual(WEB, 'why I saved it');
      expect(r.ok).toBe(true);
      expect(created[0].source).toBe('bookmark');
      expect(created[0].readFailed).toBe(true); // dead host — honest flag, attempts counted
      expect(created[0].readAttempts).toBe(1);
      expect(enqueued[0].opts.tags).toContain('bookmark');
      expect(enqueued[0].content).toContain('why I saved it'); // his words survive into the brain
    }, 20000);
  });

  // Delete by explicit id only, and only rows that ARE bookmarks. (BEA-1049)
  describe('removeMany (BEA-1049)', () => {
    it('deletes only the ids that are really bookmarks, via the one true item delete', async () => {
      const { svc, removed } = makeService({ existingRows: [{ id: 'b1' }, { id: 'b2' }] });
      const r = await svc.removeMany(['b1', 'b2', 'not-a-bookmark']);
      expect(r).toEqual({ ok: true, deleted: 2 }); // findMany (the source filter) decides — a stray id can't take out a document
      expect(removed).toEqual(['b1', 'b2']);
    });

    it('an empty selection deletes nothing', async () => {
      const { svc, removed } = makeService({ existingRows: [] });
      expect(await svc.removeMany([])).toEqual({ ok: true, deleted: 0 });
      expect(removed).toEqual([]);
    });
  });

  it('auto-sync defaults to enabled, hourly', async () => {
    const { svc } = makeService();
    expect(await svc.getAutoSync()).toEqual({ enabled: true, intervalMinutes: 60 });
  });

  afterAll(async () => {
    await fs.rm(join(tmpdir(), 'mybrain-bm-test'), { recursive: true, force: true }).catch(() => undefined);
  });
});
