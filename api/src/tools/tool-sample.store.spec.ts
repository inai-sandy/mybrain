import { execSync } from 'child_process';
import { existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { gunzipSync as unzip } from 'zlib';
import { ToolSampleService } from './tool-sample.service';
import { ServiceActionsService } from './service-actions.service';
import { isUsable, MASK, PER_ACTION_GOOD, PER_AGENT_FAILING, RAW_MAX, TOTAL_BUDGET_BYTES } from './tool-sample';

/**
 * The sample store against a REAL SQLite database (BEA-1386, `specs/AGENT-WORKERS.md` §A).
 *
 * A fake Prisma would prove nothing here: the three things that matter are that the payload is a
 * BLOB and not base64, that the migration really sets `auto_vacuum = INCREMENTAL`, and that evicting
 * samples really makes the file on disk smaller. All three are properties of SQLite, not of our code.
 */

const API_DIR = join(__dirname, '..', '..');
const TEST_DB = join(API_DIR, 'prisma', 'test-tool-sample.db');
const URL = `file:${TEST_DB}`;

jest.setTimeout(300_000);

/** A small, realistic Instagram answer — public content, with one personal field in it. */
const ANSWER = {
  success: true,
  data: {
    items: [
      { id: '3456789012345678901', shortcode: 'C4xYz9AbCdE', taken_at: 1755800000, caption: { text: 'New launch' }, like_count: 431 },
      { id: '3456789012345678902', shortcode: 'C4xYz9AbCdF', taken_at: 1755700000, caption: { text: 'Ping us at hello@example.com' }, like_count: 12 },
    ],
    user: { pk: '51242237037', username: 'smart_home_india', email: 'sandy@example.com', follower_count: 18234 },
  },
  credits_charged: 1,
};

function actions(prisma: any, samples: ToolSampleService, answer: any = ANSWER, opts: { social?: boolean } = {}) {
  const provider: any = {
    readOnly: true,
    // The public-scraping provider claims every id here, so `providerFor()` routes to it — the same
    // road a real Instagram read takes. `social:false` builds the OTHER provider instead.
    owns: jest.fn(async () => true),
    getService: jest.fn(async (slug: string) => ({ slug, name: slug, accounts: [], noAuth: true })),
    getAction: jest.fn(async (id: string) => ({
      id,
      name: 'An action',
      service: id.split(':')[1].split('.')[0],
      method: 'GET',
      schema: { type: 'object', properties: { hashtag: { type: 'string' }, q: { type: 'string' } } },
    })),
    execute: jest.fn(async () => ({ ok: true, data: answer, ms: 40, credits: 1 })),
    refresh: jest.fn(),
  };
  const llm: any = { completeHelper: jest.fn(async () => '{}') };
  const social = opts.social === false ? undefined : provider;
  const svc = new ServiceActionsService(provider, llm, prisma, undefined, social, undefined, samples);
  return { svc, provider };
}

describe('ToolSample — the store (BEA-1386)', () => {
  let prisma: any;
  let samples: ToolSampleService;

  beforeAll(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    // The REAL migrations, so this database is made exactly the way the live one is.
    execSync('npx prisma migrate deploy', { cwd: API_DIR, env: { ...process.env, DATABASE_URL: URL }, stdio: 'ignore' });
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    samples = new ToolSampleService(prisma);
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    for (const f of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (existsSync(f)) rmSync(f);
  });

  beforeEach(async () => {
    await prisma.toolSample.deleteMany({});
    await prisma.toolCall.deleteMany({});
  });

  it('the migration leaves the database on auto_vacuum = INCREMENTAL', async () => {
    const rows: any = await prisma.$queryRawUnsafe('PRAGMA auto_vacuum');
    expect(Number(rows?.[0]?.auto_vacuum)).toBe(2);
  });

  it('keeps the whole answer from a real read, masked, and replays it', async () => {
    const { svc, provider } = actions(prisma, samples);
    const r = await svc.runDetailed('svc:instagram.search_hashtag', '', { args: { hashtag: 'smarthomeindia' }, argsPinned: true, runKind: 'agent', agentId: 'job-1' });
    expect(r.ok).toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(1);

    const row = await prisma.toolSample.findFirst({});
    expect(row).toBeTruthy();
    expect(row.service).toBe('instagram');
    expect(row.action).toBe('search_hashtag');
    expect(row.actionId).toBe('svc:instagram.search_hashtag');
    expect(row.agentId).toBe('job-1');
    expect(row.kind).toBe('good');
    expect(JSON.parse(row.arguments)).toEqual({ hashtag: 'smarthomeindia' });

    // A gzip BLOB, never base64: the nightly backup copies this database whole.
    expect(Buffer.isBuffer(row.payload)).toBe(true);
    expect(row.payload[0]).toBe(0x1f);
    expect(row.payload[1]).toBe(0x8b);
    expect(row.bytes).toBe(row.payload.length);

    // The parsed payload is the provider's answer, minus what the masker took out.
    const replayed = await samples.replay('svc:instagram.search_hashtag');
    expect(replayed).toEqual({
      ...ANSWER,
      data: {
        ...ANSWER.data,
        items: [ANSWER.data.items[0], { ...ANSWER.data.items[1], caption: { text: `Ping us at ${MASK}` } }],
        user: { ...ANSWER.data.user, email: MASK },
      },
    });
    // Everything else survives, whole — this is what a worker's tests will stand on.
    expect(replayed.data.items).toHaveLength(2);
    expect(replayed.data.items[0].id).toBe('3456789012345678901');
    expect(replayed.data.user.follower_count).toBe(18234);
  });

  it('never keeps a Vault answer, a WhatsApp conversation, a write or a service nobody opted in', async () => {
    const { svc } = actions(prisma, samples, { secret: 'hunter2' });
    await svc.runDetailed('svc:vault.get_secret', '', { args: {}, argsPinned: true });
    await svc.runDetailed('svc:whatsapp.get_conversation', '', { args: {}, argsPinned: true });
    await svc.runDetailed('svc:gmail.fetch_emails', '', { args: {}, argsPinned: true });
    await svc.runDetailed('svc:instagram.direct_messages', '', { args: {}, argsPinned: true });
    await svc.runDetailed('svc:googlesheets.batch_get', '', { args: {}, argsPinned: true });
    expect(await prisma.toolSample.count()).toBe(0);
    // …and the calls themselves still ran and were written down, exactly as before.
    expect(await prisma.toolCall.count()).toBe(5);
  });

  it('never keeps an answer another provider served, even under an opted-in slug', async () => {
    // The general provider has its own `twitter`, signed in to the owner's OWN account: reading his
    // followers is his address book, not public content. Same slug, different road, no sample.
    const { svc } = actions(prisma, samples, ANSWER, { social: false });
    const r = await svc.runDetailed('svc:twitter.followers', '', { args: {}, argsPinned: true });
    expect(r.ok).toBe(true);
    expect(await prisma.toolSample.count()).toBe(0);
    expect(await prisma.toolCall.count()).toBe(1);
  });

  it('stores a 3 MB answer truncated and marks it unusable for tests', async () => {
    const big = { items: Array.from({ length: 12_000 }, (_, i) => ({ id: String(i), caption: { text: `a post about home automation number ${i} `.repeat(6) } })) };
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(3 * 1024 * 1024);
    const { svc } = actions(prisma, samples, big);
    await svc.runDetailed('svc:tiktok.search', '', { args: { q: 'home' }, argsPinned: true });

    const row = await prisma.toolSample.findFirst({ where: { actionId: 'svc:tiktok.search' } });
    expect(row).toBeTruthy();
    expect(row.note).toMatch(/^truncated:/);
    expect(isUsable(row)).toBe(false);
    // Kept as evidence: the stored bytes are the gzip of exactly the cap, never the whole 3 MB.
    expect(unzip(row.payload).length).toBe(RAW_MAX);
    // A cut JSON does not parse, so replay skips it rather than handing back half an answer.
    expect(await samples.replay('svc:tiktok.search')).toBeNull();
  });

  it('keeps a real-sized Instagram profile answer whole — 436 KB is a normal answer, not an outlier (BEA-1395)', async () => {
    // Measured on the owner's own job during the acceptance run: ONE `svc:instagram.profile` answer
    // was 436 KB, because a profile carries its whole video timeline and every dash manifest with it.
    // At the old 256 KB cap every answer that job ever gets was kept truncated and unusable, so no
    // worker for it could be built, tested or repaired against anything real.
    const profile = {
      data: {
        user: {
          pk: '80262880207',
          username: 'smart.home.fixes',
          full_name: 'Smart Home Fixes',
          follower_count: 13_590,
          edge_felix_video_timeline: {
            edges: Array.from({ length: 12 }, (_, i) => ({ node: { id: `396904114771660813${i}`, dash_info: { video_dash_manifest: `<MPD>${'x'.repeat(35_000)}</MPD>` } } })),
          },
        },
      },
    };
    const size = Buffer.byteLength(JSON.stringify(profile));
    expect(size).toBeGreaterThan(400 * 1024);
    expect(size).toBeLessThan(RAW_MAX);

    const { svc } = actions(prisma, samples, profile);
    await svc.runDetailed('svc:instagram.profile', '', { args: { handle: 'smart.home.fixes' }, argsPinned: true });

    const row = await prisma.toolSample.findFirst({ where: { actionId: 'svc:instagram.profile' } });
    expect(row.note).toBeNull();
    expect(isUsable(row)).toBe(true);
    // …and it comes back whole, which is what a worker's fixtures and every repair stand on.
    const replayed = await samples.replay('svc:instagram.profile');
    expect(replayed?.data?.user?.username).toBe('smart.home.fixes');
    expect(replayed?.data?.user?.follower_count).toBe(13_590);
  });

  it('replays without touching a provider', async () => {
    const { svc, provider } = actions(prisma, samples);
    await svc.runDetailed('svc:instagram.search_hashtag', '', { args: { hashtag: 'x' }, argsPinned: true });
    const calls = provider.execute.mock.calls.length;

    const replayed = await samples.replay('svc:instagram.search_hashtag');
    expect(replayed?.data?.items).toHaveLength(2);
    expect(provider.execute).toHaveBeenCalledTimes(calls);
    expect(provider.getAction).toHaveBeenCalledTimes(1);
    // The store has no provider on it at all — that is the structural guarantee behind the spy.
    expect(Object.values(samples as any).some((v: any) => v && typeof v.execute === 'function')).toBe(false);
  });

  it('keeps only the newest few answers per call shape, and only ten failing ones per job', async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
    for (let i = 0; i < 8; i++) await sample(prisma, { actionId: 'svc:instagram.user_posts', argsHash: 'h1', createdAt: at(i), note: `n${i}` });
    for (let i = 0; i < 3; i++) await sample(prisma, { actionId: 'svc:instagram.user_posts', argsHash: 'h2', createdAt: at(i) });
    for (let i = 0; i < 14; i++) await sample(prisma, { actionId: 'svc:instagram.user_posts', argsHash: 'h1', kind: 'failing', agentId: 'job-1', createdAt: at(i) });

    const swept = await samples.sweep();
    expect(swept.deleted).toBe(3 + 4);
    expect(await prisma.toolSample.count({ where: { argsHash: 'h1', kind: 'good' } })).toBe(PER_ACTION_GOOD);
    expect(await prisma.toolSample.count({ where: { argsHash: 'h2' } })).toBe(3);
    expect(await prisma.toolSample.count({ where: { kind: 'failing' } })).toBe(PER_AGENT_FAILING);
    // Oldest first: the survivors are the newest five.
    const left = await prisma.toolSample.findMany({ where: { argsHash: 'h1', kind: 'good' }, orderBy: { createdAt: 'asc' } });
    expect(left.map((r: any) => r.note)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7']);
  });

  it('holds the total budget, oldest first', async () => {
    // Only the accounting is under test here, so the payloads stay small and `bytes` carries the
    // size — the sweep counts the column, which is what a real 20 MB sample would have written.
    const twenty = 20 * 1024 * 1024;
    for (let i = 0; i < 6; i++) {
      await sample(prisma, { actionId: `svc:instagram.a${i}`, argsHash: `h${i}`, bytes: twenty, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)), note: `n${i}` });
    }
    const swept = await samples.sweep();
    expect(swept.deleted).toBe(1);
    expect(swept.freed).toBe(twenty);
    const left = await prisma.toolSample.findMany({ orderBy: { createdAt: 'asc' } });
    expect(left.map((r: any) => r.note)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(left.reduce((n: number, r: any) => n + r.bytes, 0)).toBeLessThanOrEqual(TOTAL_BUDGET_BYTES);
  });

  it('never evicts a sample a worker is standing on', async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await sample(prisma, { actionId: 'svc:instagram.user_posts', argsHash: 'h1', createdAt: at(i) }));
    // The hook the worker folders fill in later: `samples/index.json` names what its tests use.
    samples.setPinned(() => [ids[0]]);
    await samples.sweep();
    samples.setPinned(() => []);

    expect(await prisma.toolSample.findUnique({ where: { id: ids[0] } })).toBeTruthy();
    expect(await prisma.toolSample.count()).toBe(PER_ACTION_GOOD + 1);
  });

  it('gives the space back to the disk: evicting 50 MB really shrinks the database file', async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
    // 55 real one-megabyte payloads on ONE call shape. Random bytes, so nothing here is compressible
    // and the file has to carry all of it.
    const MB = 1024 * 1024;
    for (let i = 0; i < 55; i++) {
      await sample(prisma, { actionId: 'svc:instagram.user_posts', argsHash: 'h1', createdAt: at(i), payload: randomBytes(MB), bytes: MB });
    }
    await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
    const before = statSync(TEST_DB).size;
    expect(before).toBeGreaterThan(50 * MB);

    const swept = await samples.sweep();
    expect(swept.deleted).toBe(50);
    expect(swept.freed).toBe(50 * MB);
    expect(await prisma.toolSample.count()).toBe(PER_ACTION_GOOD);

    await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
    const after = statSync(TEST_DB).size;
    // Without `auto_vacuum = INCREMENTAL` + `PRAGMA incremental_vacuum` this number would be
    // unchanged, and the nightly backup would keep copying 55 MB of evicted samples for ever.
    expect(after).toBeLessThan(before - 45 * MB);
  });
});

/** One row, written straight to the database — the sweep's input, without going through a vendor. */
async function sample(prisma: any, over: any = {}): Promise<string> {
  const row = await prisma.toolSample.create({
    data: {
      service: 'instagram',
      action: 'user_posts',
      actionId: 'svc:instagram.user_posts',
      argsHash: 'h1',
      arguments: '{}',
      payload: Buffer.from('{"ok":true}'),
      bytes: 11,
      kind: 'good',
      ...over,
    },
    select: { id: true },
  });
  return row.id;
}
