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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
    const doc = await svc.create({ title: 'My Research Notes', contentText: '# Heading\n\nSome **important** body text here.', tags: ['research', 'notes'] });
    expect(doc.title).toBe('My Research Notes');
    expect(doc.slug).toMatch(/^my-research-notes-[a-z0-9]{6}$/);
    expect(doc.tags).toEqual(['research', 'notes']);
    expect(doc.description).toContain('important');
    expect(doc.description).not.toContain('#');
    expect(doc.contentText).toContain('Heading');
  });

  it('lists newest-first without content, gets full content, updates, and deletes', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(fakePrisma() as any, fakeLlm() as any, fakeItems() as any);
    await expect(svc.createFromUpload({ originalname: 'x.zip', mimetype: 'application/zip', buffer: buf, size: buf.length })).rejects.toThrow(/No HTML/i);
  });

  it('counts public opens of a shared doc (BEA-586)', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
    const a = await svc.create({ title: 'Alpha', contentText: 'a' });
    const b = await svc.create({ title: 'Beta', contentText: 'b' });

    const renamed = await svc.setSlug(a.id, 'My Cool Page!');
    expect(renamed.slug).toBe('my-cool-page'); // normalised

    await expect(svc.setSlug(b.id, 'my-cool-page')).rejects.toThrow(/already taken/i);
    await expect(svc.setSlug(b.id, 'x')).rejects.toThrow(/at least 2/i);
  });

  it('manages the ingest token (create, verify constant-time, regenerate)', async () => {
    const svc = new DocumentsService(fakePrisma() as any, fakeLlm() as any, fakeItems() as any);
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
    const svc = new DocumentsService(fakePrisma() as any, fakeLlm() as any, fakeItems() as any);
    const doc = await svc.create({ title: 'Memo', contentText: 'remember this content' });
    const res = await svc.convertToCapture(doc.id);
    expect(res.ok).toBe(true);
    expect(res.itemId).toBe('item-1');
  });

  it('produces a download payload with a safe filename', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any, fakeLlm() as any, fakeItems() as any);
    const doc = await svc.create({ title: 'Hello / World!', contentText: '# Hi' });
    const raw = await svc.raw(doc.id);
    expect(raw?.filename).toBe('hello-world.md');
    expect(raw?.content).toBe('# Hi');
  });
});
