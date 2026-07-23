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
  // Folder organizer doubles (BEA-1046)
  const folderRows: any[] = over.folders ? [...over.folders] : [];
  const filings: any[] = [];
  prisma.bookmarkFolder = {
    findMany: async () => [...folderRows], // a copy, like real prisma — the service mutates its own list
    create: async ({ data }: any) => { const f = { id: `f${folderRows.length + 1}`, ...data }; folderRows.push(f); return f; },
  };
  prisma.item.updateMany = async ({ where, data }: any) => { filings.push({ id: where.id, ...data }); return { count: 1 }; };
  prisma.item.groupBy = async () => over.folderCounts ?? []; // rediscover topic sizes (BEA-1048)
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
    complete: async () => over.organizeReply ?? null, // folder organizer (BEA-1046)
  };
  const raindrop: any = {
    hasKey: async () => over.hasRaindrop ?? true,
    recent: async () => over.recent ?? [],
  };
  const instagram: any = { isInstagram: () => false, enrich: async () => null, configured: async () => false };
  const removed: string[] = [];
  const items: any = { remove: async (id: string) => removed.push(id) }; // the one true item delete (BEA-1049)
  // Research runs (BEA-1047)
  const startedRuns: any[] = [];
  const bridge: any = { startRun: async (input: any) => { startedRuns.push(input); return { id: 'run1' }; } };
  prisma.agentRun = { findMany: async () => over.researchRows ?? [] };
  const svc = new BookmarksService(prisma, memory, summarizer, raindrop, instagram, items, bridge, { get: async () => '' } as any);
  return { svc, created, updated, enqueued, removed, filings, folderRows, startedRuns };
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

  // Folders fill themselves — the owner never files by hand. (BEA-1046)
  describe('organize (BEA-1046)', () => {
    const unfiled = [
      { id: 'a1', title: 'Claude tips', summary: 's', tags: '["ai tools"]' },
      { id: 'a2', title: 'mmWave radar sensor', summary: 's', tags: '[]' },
      { id: 'a3', title: 'mystery link', summary: '', tags: '[]' },
    ];

    it('reuses existing folders, creates broad new ones, and leaves unsure rows in Others', async () => {
      const reply = JSON.stringify({ assignments: [{ id: 'a1', folder: 'AI' }, { id: 'a2', folder: 'Hardware' }, { id: 'a3', folder: 'Others' }] });
      const { svc, filings, folderRows } = makeService({ existingRows: unfiled, folders: [{ id: 'fAI', name: 'AI' }], organizeReply: reply });
      const r = await svc.organize();
      expect(r).toEqual({ filed: 2, left: 1, foldersCreated: 1 });
      expect(filings).toEqual([{ id: 'a1', folderId: 'fAI' }, { id: 'a2', folderId: 'f2' }]); // a3 untouched — unsure never guesses
      expect(folderRows.map((f: any) => f.name)).toEqual(['AI', 'Hardware']);
    });

    it('matches existing folder names case-insensitively instead of duplicating them', async () => {
      const reply = JSON.stringify({ assignments: [{ id: 'a1', folder: 'ai' }] });
      const { svc, folderRows } = makeService({ existingRows: [unfiled[0]], folders: [{ id: 'fAI', name: 'AI' }], organizeReply: reply });
      await svc.organize();
      expect(folderRows).toHaveLength(1); // no "ai" duplicate created
    });

    it('never crosses the 12-folder cap — extra names are dropped, the row stays in Others', async () => {
      const atCap = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
      const reply = JSON.stringify({ assignments: [{ id: 'a1', folder: 'Brand New Area' }] });
      const { svc, filings, folderRows } = makeService({ existingRows: [unfiled[0]], folders: atCap, organizeReply: reply });
      const r = await svc.organize();
      expect(r.filed).toBe(0);
      expect(filings).toEqual([]);
      expect(folderRows).toHaveLength(12);
    });

    it('does nothing (and spends nothing) when everything is already filed', async () => {
      const { svc } = makeService({ existingRows: [], organizeReply: 'MUST NOT BE USED' });
      expect(await svc.organize()).toEqual({ filed: 0, left: 0, foldersCreated: 0 });
    });

    it('an unparseable AI reply files nothing — never a wrong guess', async () => {
      const { svc, filings } = makeService({ existingRows: unfiled, organizeReply: 'sorry, no json here' });
      const r = await svc.organize();
      expect(r.filed).toBe(0);
      expect(filings).toEqual([]);
    });
  });

  // Forgotten bookmarks come back, one topic at a time. (BEA-1048)
  describe('rediscover (BEA-1048)', () => {
    const folders = [{ id: 'fA', name: 'AI' }, { id: 'fB', name: 'Hardware' }];
    const counts = [{ folderId: 'fA', _count: 5 }, { folderId: 'fB', _count: 4 }];
    const olds = [{ id: 'o1', title: 'old gem', sourceUrl: 'https://x', summary: 's', thumbnail: null, createdAt: new Date('2026-01-01') }];

    it('rotates topics with the shift control and wraps around', async () => {
      const { svc } = makeService({ folders, folderCounts: counts, existingRows: olds });
      const t0 = (await svc.rediscover(0)).topic!.name;
      const t1 = (await svc.rediscover(1)).topic!.name;
      const t2 = (await svc.rediscover(2)).topic!.name;
      expect(t1).not.toBe(t0); // shuffle really moves
      expect(t2).toBe(t0); // 2 topics → wraps back
    });

    it('shows nothing rather than a thin band when no folder has enough in it', async () => {
      const { svc } = makeService({ folders, folderCounts: [{ folderId: 'fA', _count: 2 }] });
      expect(await svc.rediscover()).toEqual({ topic: null, items: [], topics: 0 });
    });
  });

  // A bookmark stops being a dead end. (BEA-1047)
  describe('research (BEA-1047)', () => {
    it('starts a real agent run with the bookmark as context and a marker for finding it later', async () => {
      const { svc, startedRuns } = makeService({ dupRow: { id: 'b1', title: 'EMO pendant ideas', sourceUrl: 'https://x.com/emo', summary: 'wearable notes', source: 'raindrop' } });
      const r = await svc.research('b1', 'find similar products and their prices');
      expect(r).toEqual({ ok: true, runId: 'run1' });
      expect(startedRuns[0].prompt).toContain('[bookmark:b1]');
      expect(startedRuns[0].prompt).toContain('EMO pendant ideas');
      expect(startedRuns[0].prompt).toContain('find similar products and their prices');
      expect(startedRuns[0].save).toBe(true); // the report lands as a Document
      expect(startedRuns[0].title).toContain('Research:');
    });

    it('refuses an empty question and an unknown bookmark', async () => {
      const empty = await makeService({ dupRow: { id: 'b1' } }).svc.research('b1', '   ');
      expect(empty.ok).toBe(false);
      const missing = await makeService({ dupRow: null }).svc.research('nope', 'anything');
      expect(missing.ok).toBe(false);
    });

    it('lists past research runs so research is never lost', async () => {
      const rows = [{ id: 'r1', title: 'Research: X', status: 'done', startedAt: new Date(), outputDocId: 'doc9', extra: 'hidden' }];
      const { svc } = makeService({ researchRows: rows });
      const out = await svc.researchRuns('b1');
      expect(out.runs).toHaveLength(1);
      expect(out.runs[0]).toEqual({ id: 'r1', title: 'Research: X', status: 'done', startedAt: rows[0].startedAt, outputDocId: 'doc9' });
    });
  });

  it('markOpened stamps only bookmark rows, by id (BEA-1048)', async () => {
    const { svc, filings } = makeService();
    await svc.markOpened('b1');
    expect(filings).toHaveLength(1);
    expect(filings[0].id).toBe('b1');
    expect(filings[0].lastOpenedAt).toBeInstanceOf(Date);
  });

  it('auto-sync defaults to enabled, hourly', async () => {
    const { svc } = makeService();
    expect(await svc.getAutoSync()).toEqual({ enabled: true, intervalMinutes: 60 });
  });

  afterAll(async () => {
    await fs.rm(join(tmpdir(), 'mybrain-bm-test'), { recursive: true, force: true }).catch(() => undefined);
  });
});
