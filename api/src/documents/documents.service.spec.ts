import { DocumentsService } from './documents.service';

// Minimal in-memory fake of the Prisma `document` model.
function fakePrisma() {
  const rows: any[] = [];
  const settings: Record<string, string> = {};
  return {
    _rows: rows,
    setting: {
      findUnique: async ({ where }: any) => (where.key in settings ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create?.value;
        return { key: where.key, value: settings[where.key] };
      },
    },
    document: {
      create: async ({ data }: any) => {
        const row = { id: 'id-' + (rows.length + 1), createdAt: new Date(), updatedAt: new Date(), shared: false, ...data };
        rows.push(row);
        return row;
      },
      findMany: async () => [...rows].reverse(),
      findUnique: async ({ where }: any) =>
        rows.find((r) => (where.id ? r.id === where.id : where.shortCode ? r.shortCode === where.shortCode : r.slug === where.slug)) || null,
      findFirst: async ({ where }: any) =>
        rows.find((r) => r.slug === where.slug && (!where.NOT || r.id !== where.NOT.id)) || null,
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        const resolved: any = { ...data };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as any)) resolved[k] = (r[k] || 0) + (v as any).increment;
        }
        Object.assign(r, resolved, { updatedAt: new Date() });
        return r;
      },
      delete: async ({ where }: any) => {
        const i = rows.findIndex((x) => x.id === where.id);
        if (i < 0) throw new Error('not found');
        return rows.splice(i, 1)[0];
      },
    },
  };
}

// Fake LLM: returns a fixed summary JSON so create() can auto-fill deterministically.
function fakeLlm() {
  return { completeWith: async () => '{"description":"A note about important research.","tags":["ai-tag"]}' };
}
// Fake ItemsService for convert-to-Capture.
function fakeItems() {
  return { store: async () => ({ item: { id: 'item-1' }, deduped: false }) };
}

describe('DocumentsService', () => {
  it('creates a markdown doc with a slug, tags, and an auto description', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'My Research Notes', contentText: '# Heading\n\nSome **important** body text here.', tags: ['research', 'notes'] });
    expect(doc.title).toBe('My Research Notes');
    expect(doc.slug).toMatch(/^my-research-notes-[a-z0-9]{6}$/);
    expect(doc.tags).toEqual(['research', 'notes']);
    expect(doc.description).toContain('important');
    expect(doc.description).not.toContain('#');
    expect(doc.contentText).toContain('Heading');
  });

  // The folder was declared on the input type but never written to the row, so EVERY document made
  // through create() — the "New Document" folder picker, and every email saved from Gmail — landed
  // with no folder at all, silently. (BEA-1341)
  it('actually saves the folder a document was created in', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Filed note', contentText: 'hello', collectionId: 'col-email' });
    expect(prisma._rows[0].collectionId).toBe('col-email');
    expect(doc.collectionId).toBe('col-email');
  });

  it('files an uploaded markdown file into the folder it was given', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    // This is the exact path a saved email takes: a .md upload routed through create().
    await svc.createFromUpload(
      { originalname: 'Quote for 25 boards.md', mimetype: 'text/markdown', buffer: Buffer.from('# Quote', 'utf8') },
      { collectionId: 'col-email' },
    );
    expect(prisma._rows[0].collectionId).toBe('col-email');
  });

  it('leaves the folder empty when none was asked for', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    await svc.create({ title: 'Loose note', contentText: 'hello' });
    expect(prisma._rows[0].collectionId).toBeNull();
  });

  // The owner's "Markdown" button on the document page. (BEA-1342)
  describe('markdownOf', () => {
    const build = () => {
      const prisma = fakePrisma();
      return { prisma, svc: new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any) };
    };

    it('returns the text of a markdown document as-is', async () => {
      const { svc } = build();
      const doc = await svc.create({ title: 'Note', contentText: '# Hello\n\nBody.' });
      expect(await svc.markdownOf(doc.id)).toBe('# Hello\n\nBody.');
    });

    it('converts an HTML document to real markdown, not raw HTML', async () => {
      const { svc } = build();
      const doc = await svc.create({ title: 'Page', kind: 'html', contentText: '<h1>Title</h1><p>Some <b>bold</b> text.</p>' });
      const md = await svc.markdownOf(doc.id);
      expect(md).toContain('# Title');
      expect(md).toContain('**bold**');
      expect(md).not.toContain('<h1>'); // showing HTML and calling it markdown would be a lie
    });

    it('has no markdown form for a pdf, an image or a multi-file site', async () => {
      const { svc } = build();
      for (const kind of ['pdf', 'image', 'site']) {
        const doc = await svc.create({ title: `A ${kind}`, kind, contentText: 'ignored' });
        expect(await svc.markdownOf(doc.id)).toBeNull();
      }
    });

    it('complains clearly when the document is gone', async () => {
      const { svc } = build();
      await expect(svc.markdownOf('nope')).rejects.toThrow(/not found/i);
    });
  });

  it('recovers a UTF-8 filename that multer decoded as latin1 (em-dash) (BEA-801)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    // busboy hands us the UTF-8 bytes of "Report — Final.md" decoded as latin1 (the mojibake)
    const mangled = Buffer.from('Report — Final.md', 'utf8').toString('latin1');
    const doc = await svc.createFromUpload({ originalname: mangled, mimetype: 'text/markdown', buffer: Buffer.from('# hi', 'utf8'), size: 4 });
    expect(doc.title).toBe('Report — Final'); // clean em-dash, not "Report â€" Final"
    expect(doc.title).not.toMatch(/â€/);
  });

  it('lists newest-first without content, gets full content, updates, and deletes', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const a = await svc.create({ title: 'First', contentText: 'a' });
    await svc.create({ title: 'Second', contentText: 'b' });
    const listed = await svc.list();
    expect(listed.documents).toHaveLength(2);
    expect(listed.documents[0].title).toBe('Second'); // newest first
    expect((listed.documents[0] as any).contentText).toBeUndefined(); // list payload is light

    const updated = await svc.update(a.id, { title: 'First Edited', contentText: 'aa', tags: ['x'] });
    expect(updated?.title).toBe('First Edited');
    expect(updated?.contentText).toBe('aa');
    expect(updated?.tags).toEqual(['x']);

    await svc.remove(a.id);
    expect((await svc.list()).documents).toHaveLength(1);
  });

  it('shares a doc and only returns it publicly once shared', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Shareable', contentText: 'hello world' });
    expect(await svc.getShared(doc.slug)).toBeNull(); // not shared yet

    await svc.setShared(doc.id, true);
    const pub = await svc.getShared(doc.slug);
    expect(pub?.title).toBe('Shareable');
    expect(pub?.contentText).toBe('hello world');

    await svc.setShared(doc.id, false);
    expect(await svc.getShared(doc.slug)).toBeNull();
  });

  it('mints a short code on first share and resolves it (only while shared) (BEA-584)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Linkable', contentText: 'hi' });

    const shared = await svc.setShared(doc.id, true);
    expect(shared?.shortCode).toBeTruthy();
    const code = shared!.shortCode as string;

    expect(await svc.resolveShortCode(code)).toEqual({ slug: doc.slug });

    await svc.setShared(doc.id, false);
    expect(await svc.resolveShortCode(code)).toBeNull(); // not shared anymore
    expect(await svc.resolveShortCode('nope')).toBeNull();
  });

  it('ranks title matches above body matches, and tolerates typos (BEA-590)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    await svc.create({ title: 'Pricing Strategy', contentText: 'how we set prices' }); // title match
    await svc.create({ title: 'Random Notes', contentText: 'a note that mentions pricing once' }); // body match
    await svc.create({ title: 'Unrelated', contentText: 'nothing here' });

    const exact = await svc.search('pricing');
    expect(exact.documents.length).toBe(2);
    expect(exact.documents[0].title).toBe('Pricing Strategy'); // title outranks body

    // Typo tolerance: "pricng" still finds the titled doc.
    const typo = await svc.search('pricng');
    expect(typo.documents.some((d) => d.title === 'Pricing Strategy')).toBe(true);
  });

  it('requires all tokens for short queries (BEA-590)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    await svc.create({ title: 'Quarterly Budget Report', contentText: 'numbers' });

    expect((await svc.search('quarterly budget')).documents.length).toBe(1);
    expect((await svc.search('quarterly zzzzz')).documents.length).toBe(0); // 2 tokens, both required
  });

  it('unzips a multi-file site, picks index.html, serves assets, blocks traversal (BEA-587)', async () => {
    const os = require('os');
    const fsx = require('fs');
    const path = require('path');
    const AdmZip = require('adm-zip');
    process.env.DATA_DIR = fsx.mkdtempSync(path.join(os.tmpdir(), 'mybrain-docs-'));

    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<h1>Hi</h1><link rel="stylesheet" href="style.css">'));
    zip.addFile('style.css', Buffer.from('body{color:red}'));
    zip.addFile('assets/app.js', Buffer.from('console.log(1)'));
    const buf = zip.toBuffer();

    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.createFromUpload({ originalname: 'My Site.zip', mimetype: 'application/zip', buffer: buf, size: buf.length });
    expect(doc.kind).toBe('site');
    expect(doc.siteEntry).toBe('index.html');

    const entry = await svc.siteFile(doc.id, '');
    expect(entry?.mime).toBe('text/html');
    expect(fsx.readFileSync(entry!.filePath, 'utf8')).toContain('Hi');

    expect((await svc.siteFile(doc.id, 'style.css'))?.mime).toBe('text/css');
    expect((await svc.siteFile(doc.id, 'assets/app.js'))?.mime).toBe('text/javascript');

    // Path traversal is blocked, and missing files return null.
    expect(await svc.siteFile(doc.id, '../../etc/passwd')).toBeNull();
    expect(await svc.siteFile(doc.id, 'nope.css')).toBeNull();
  });

  it('rejects a ZIP with no HTML page (BEA-587)', async () => {
    const os = require('os');
    const fsx = require('fs');
    const path = require('path');
    const AdmZip = require('adm-zip');
    process.env.DATA_DIR = fsx.mkdtempSync(path.join(os.tmpdir(), 'mybrain-docs-'));
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('no html here'));
    const buf = zip.toBuffer();
    const svc = new DocumentsService(fakePrisma() as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    await expect(svc.createFromUpload({ originalname: 'x.zip', mimetype: 'application/zip', buffer: buf, size: buf.length })).rejects.toThrow(/No HTML/i);
  });

  it('only allows public download when the owner opts in (BEA-597)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Downloadable', contentText: '# Hi\n\nbody' });
    await svc.setShared(doc.id, true);

    // Shared but downloads off → nothing.
    expect(await svc.sharedDownload(doc.slug)).toBeNull();
    expect((await svc.getShared(doc.slug) as any).allowDownload).toBe(false);

    await svc.setProtection(doc.id, { allowDownload: true });
    const dl = (await svc.sharedDownload(doc.slug)) as any;
    expect(dl.filename).toMatch(/\.md$/);
    expect(dl.content).toContain('body');
    expect((await svc.getShared(doc.slug) as any).allowDownload).toBe(true);

    // Turning it back off closes the download again.
    await svc.setProtection(doc.id, { allowDownload: false });
    expect(await svc.sharedDownload(doc.slug)).toBeNull();
  });

  it('stars and unstars a document (BEA-596)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Fav', contentText: 'x' });
    expect(doc.starred).toBe(false);

    const starred = await svc.setStarred(doc.id, true);
    expect(starred?.starred).toBe(true);
    expect((await svc.get(doc.id))?.starred).toBe(true);

    const unstarred = await svc.setStarred(doc.id, false);
    expect(unstarred?.starred).toBe(false);
  });

  it('counts public opens of a shared doc (BEA-586)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Popular', contentText: 'hi' });
    await svc.setShared(doc.id, true);

    await svc.getShared(doc.slug);
    await svc.getShared(doc.slug);
    const full = await svc.get(doc.id);
    expect(full?.viewCount).toBe(2);

    // A private (unshared) doc is not counted.
    await svc.setShared(doc.id, false);
    await svc.getShared(doc.slug);
    expect((await svc.get(doc.id))?.viewCount).toBe(2);
  });

  it('password-protects a share: locked until the right password unlocks it (BEA-585)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Secret', contentText: 'classified' });
    await svc.setShared(doc.id, true);

    const shaped = await svc.setProtection(doc.id, { password: 'hunter2' });
    expect(shaped?.hasPassword).toBe(true);

    const pub = (await svc.getShared(doc.slug)) as any;
    expect(pub.locked).toBe(true);
    expect(pub.contentText).toBeUndefined();

    expect((await svc.unlockShared(doc.slug, 'wrong')).ok).toBe(false);
    const good = (await svc.unlockShared(doc.slug, 'hunter2')) as any;
    expect(good.ok).toBe(true);
    expect(good.contentText).toBe('classified');
    expect(good.token).toBeTruthy();

    // Removing the password opens it back up.
    await svc.setProtection(doc.id, { password: null });
    expect((await svc.getShared(doc.slug) as any).contentText).toBe('classified');
  });

  it('expiry hides a shared doc and its short code (BEA-585)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Timed', contentText: 'tick' });
    const { shortCode } = await svc.setShared(doc.id, true) as any;

    await svc.setProtection(doc.id, { expiresAt: '2000-01-01T00:00:00.000Z' }); // in the past
    expect((await svc.getShared(doc.slug) as any).expired).toBe(true);
    expect(await svc.resolveShortCode(shortCode)).toBeNull();
    expect(await svc.sharedFile(doc.slug)).toBeNull();

    // Clearing expiry brings it back.
    await svc.setProtection(doc.id, { expiresAt: null });
    expect((await svc.getShared(doc.slug) as any).contentText).toBe('tick');
  });

  it('renames the public link and rejects a duplicate / too-short name (BEA-584)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const a = await svc.create({ title: 'Alpha', contentText: 'a' });
    const b = await svc.create({ title: 'Beta', contentText: 'b' });

    const renamed = await svc.setSlug(a.id, 'My Cool Page!');
    expect(renamed.slug).toBe('my-cool-page'); // normalised

    await expect(svc.setSlug(b.id, 'my-cool-page')).rejects.toThrow(/already taken/i);
    await expect(svc.setSlug(b.id, 'x')).rejects.toThrow(/at least 2/i);
  });

  it('manages the ingest token (create, verify constant-time, regenerate)', async () => {
    const svc = new DocumentsService(fakePrisma() as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const t = await svc.ingestToken();
    expect(t).toHaveLength(64);
    expect(await svc.ingestToken()).toBe(t); // stable across reads
    expect(await svc.verifyIngestToken(t)).toBe(true);
    expect(await svc.verifyIngestToken('wrong')).toBe(false);
    expect(await svc.verifyIngestToken('')).toBe(false);
    const t2 = await svc.regenerateIngestToken();
    expect(t2).not.toBe(t);
    expect(await svc.verifyIngestToken(t)).toBe(false);
    expect(await svc.verifyIngestToken(t2)).toBe(true);
  });

  it('converts a text document into Capture (memory)', async () => {
    const svc = new DocumentsService(fakePrisma() as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Memo', contentText: 'remember this content' });
    const res = await svc.convertToCapture(doc.id);
    expect(res.ok).toBe(true);
    expect(res.itemId).toBe('item-1');
  });

  it('produces a download payload with a safe filename', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any, { get: async () => '' } as any);
    const doc = await svc.create({ title: 'Hello / World!', contentText: '# Hi' });
    const raw = await svc.raw(doc.id);
    expect(raw?.filename).toBe('hello-world.md');
    expect(raw?.content).toBe('# Hi');
  });
});

/** BEA-1101: outputs stay out of the brain until "Add to my Brain" — which uses the proven
 *  convert-to-capture path and flips the marker exactly once. */
describe('addToBrain (BEA-1101)', () => {
  function build(row: any) {
    const updates: any[] = [];
    const stored: any[] = [];
    const prisma: any = {
      document: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async (args: any) => { updates.push(args); return row; }),
      },
    };
    const items: any = { store: jest.fn(async (content: string) => { stored.push(content); return { item: { id: 'it1' }, deduped: false }; }) };
    const { DocumentsService } = require('./documents.service');
    const svc = new (DocumentsService as any)(prisma, {} as any, items, {} as any);
    return { svc, updates, stored };
  }

  it('indexes on demand and clears the marker', async () => {
    const { svc, updates, stored } = build({ id: 'd1', noIndex: true, title: 'Report', contentText: 'the findings', tags: '["agent"]', sourceUrl: null });
    const r = await svc.addToBrain('d1');
    expect(r).toEqual({ ok: true });
    expect(stored[0]).toContain('the findings'); // really went to Capture/RAG
    expect(updates[0].data.noIndex).toBe(false);
  });

  it('is a no-op when the output was already added', async () => {
    const { svc, updates, stored } = build({ id: 'd1', noIndex: false, title: 'Report', contentText: 'x', tags: '[]' });
    const r = await svc.addToBrain('d1');
    expect(r).toEqual({ ok: true, already: true });
    expect(stored.length).toBe(0);
    expect(updates.length).toBe(0);
  });
});
