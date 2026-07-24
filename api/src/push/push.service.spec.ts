import { PushService } from './push.service';

jest.mock('web-push', () => ({
  generateVAPIDKeys: jest.fn(() => ({ publicKey: 'PUB', privateKey: 'PRIV' })),
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(async () => undefined),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = require('web-push');

function fakePrisma() {
  const settings = new Map<string, string>();
  const subs: any[] = [];
  return {
    _subs: subs,
    _settings: settings,
    setting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => { settings.set(where.key, (settings.has(where.key) ? update.value : create.value)); return { key: where.key, value: settings.get(where.key) }; },
    },
    pushSubscription: {
      upsert: async ({ where, create, update }: any) => {
        const i = subs.findIndex((s) => s.endpoint === where.endpoint);
        if (i >= 0) Object.assign(subs[i], update);
        else subs.push({ id: 'ps' + subs.length, ...create });
        return subs[i >= 0 ? i : subs.length - 1];
      },
      deleteMany: async ({ where }: any) => {
        const before = subs.length;
        for (let i = subs.length - 1; i >= 0; i--) if (subs[i].endpoint === where.endpoint) subs.splice(i, 1);
        return { count: before - subs.length };
      },
      findMany: async () => [...subs],
      count: async () => subs.length,
    },
  };
}

describe('PushService (BEA-1088)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('mints VAPID keys once and reuses them', async () => {
    const prisma = fakePrisma();
    const svc = new PushService(prisma as any);
    expect((await svc.publicKey()).key).toBe('PUB');
    const svc2 = new PushService(prisma as any); // fresh instance, same DB
    expect((await svc2.publicKey()).key).toBe('PUB');
    expect(webpush.generateVAPIDKeys).toHaveBeenCalledTimes(1); // second boot reads, not re-mints
  });

  it('subscribe validates and upserts by endpoint; unsubscribe removes', async () => {
    const prisma = fakePrisma();
    const svc = new PushService(prisma as any);
    expect((await svc.subscribe({} as any)).ok).toBe(false); // garbage in → clean refusal
    const sub = { endpoint: 'https://fcm/x', keys: { p256dh: 'k1', auth: 'a1' } };
    expect((await svc.subscribe(sub, 'Phone')).ok).toBe(true);
    expect((await svc.subscribe(sub, 'Phone')).ok).toBe(true); // same device again → no duplicate
    expect((await svc.count()).devices).toBe(1);
    await svc.unsubscribe('https://fcm/x');
    expect((await svc.count()).devices).toBe(0);
  });

  it('send delivers to every device and prunes dead endpoints (410)', async () => {
    const prisma = fakePrisma();
    const svc = new PushService(prisma as any);
    await svc.subscribe({ endpoint: 'https://fcm/alive', keys: { p256dh: 'k', auth: 'a' } });
    await svc.subscribe({ endpoint: 'https://fcm/dead', keys: { p256dh: 'k', auth: 'a' } });
    webpush.sendNotification.mockImplementation(async (s: any) => {
      if (s.endpoint.includes('dead')) { const e: any = new Error('gone'); e.statusCode = 410; throw e; }
    });
    const r = await svc.send({ title: 'T', body: 'B', isAsk: true });
    expect(r.sent).toBe(1);
    expect(r.pruned).toBe(1);
    expect((await svc.count()).devices).toBe(1); // the dead one is gone for good
  });

  it('quiet hours hold ordinary pushes but direct asks always deliver', async () => {
    const prisma = fakePrisma();
    prisma._settings.set('push.quietStart', '22');
    prisma._settings.set('push.quietEnd', '7');
    const svc = new PushService(prisma as any);
    await svc.subscribe({ endpoint: 'https://fcm/x', keys: { p256dh: 'k', auth: 'a' } });
    // 23:00 IST = 17:30 UTC
    const night = new Date('2026-07-24T17:30:00Z');
    expect(await svc.inQuietHours(night)).toBe(true);
    // 10:00 IST = 04:30 UTC
    expect(await svc.inQuietHours(new Date('2026-07-24T04:30:00Z'))).toBe(false);

    jest.spyOn(svc, 'inQuietHours').mockResolvedValue(true);
    expect((await svc.send({ title: 'run done', body: 'x' })).held).toBe(true); // ordinary → held at night
    expect((await svc.send({ title: 'needs you', body: 'x', isAsk: true })).sent).toBe(1); // ask → delivered
  });
});
