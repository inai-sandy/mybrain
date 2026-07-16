import { EmoCardsService } from './emo-cards.service';

function makePrisma() {
  const rows: any[] = [];
  let seq = 0;
  const prisma: any = {
    emoCard: {
      create: async ({ data }: any) => { const r = { id: `c${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(r); return r; },
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
      findMany: async ({ where = {}, orderBy, take, skip }: any = {}) => {
        let r = rows.filter((x) => (!where.status || x.status === where.status) && (!where.lane || x.lane === where.lane) && (!where.day || x.day === where.day));
        if (orderBy?.createdAt === 'desc') r = [...r].reverse();
        if (skip) r = r.slice(skip);
        if (take) r = r.slice(0, take);
        return r;
      },
      count: async ({ where = {} }: any = {}) => rows.filter((x) => (!where.status || x.status === where.status) && (!where.lane || x.lane === where.lane) && (!where.day || x.day === where.day)).length,
      update: async ({ where, data }: any) => { const r = rows.find((x) => x.id === where.id); Object.assign(r, data, { updatedAt: new Date() }); return r; },
      delete: async ({ where }: any) => { const i = rows.findIndex((x) => x.id === where.id); rows.splice(i, 1); return {}; },
    },
  };
  return { prisma, rows };
}

describe('EmoCardsService (BEA-861)', () => {
  it('creates a card with sensible defaults and serialised JSON fields', async () => {
    const { prisma } = makePrisma();
    const svc = new EmoCardsService(prisma);
    const card = await svc.create({ lane: 'task', summary: 'Task added: finish BOM', links: [{ kind: 'task', id: 't1', label: 'finish BOM' }] });
    expect(card.lane).toBe('task');
    expect(card.status).toBe('cooking'); // default
    expect(card.day).toBe(await svc.todayKey()); // today in the configured tz
    expect(card.links).toEqual([{ kind: 'task', id: 't1', label: 'finish BOM' }]); // parsed back to an array
    expect(card.needsOptions).toEqual([]);
  });

  it('lists newest-first with status/lane filters and a total', async () => {
    const { prisma } = makePrisma();
    const svc = new EmoCardsService(prisma);
    await svc.create({ lane: 'task', status: 'done' });
    await svc.create({ lane: 'search', status: 'needs_you' });
    const all = await svc.list();
    expect(all.total).toBe(2);
    expect(all.cards[0].lane).toBe('search'); // newest first
    const onlyNeeds = await svc.list({ status: 'needs_you' });
    expect(onlyNeeds.cards.map((c) => c.lane)).toEqual(['search']);
  });

  it('reports attention counts (needs you / cooking)', async () => {
    const { prisma } = makePrisma();
    const svc = new EmoCardsService(prisma);
    await svc.create({ lane: 'search', status: 'needs_you' });
    await svc.create({ lane: 'research', status: 'cooking' });
    await svc.create({ lane: 'task', status: 'done' });
    expect(await svc.counts()).toEqual({ needsYou: 1, cooking: 1 });
  });

  it('answer() records the reply and hands a Needs-you card back to its lane (cooking)', async () => {
    const { prisma } = makePrisma();
    const svc = new EmoCardsService(prisma);
    const card = await svc.create({ lane: 'search', status: 'needs_you', needsQuestion: 'Which region?' });
    const res = await svc.answer(card.id, 'South India, last 30 days');
    expect(res.ok).toBe(true);
    const fresh = await svc.get(card.id);
    expect(fresh.needsAnswer).toBe('South India, last 30 days');
    expect(fresh.status).toBe('cooking'); // re-queued for the lane
  });

  it('answer() is a no-op on a card that is not waiting', async () => {
    const { prisma } = makePrisma();
    const svc = new EmoCardsService(prisma);
    const card = await svc.create({ lane: 'task', status: 'done' });
    expect((await svc.answer(card.id, 'x')).ok).toBe(false);
  });

  it('updates and deletes a card', async () => {
    const { prisma } = makePrisma();
    const svc = new EmoCardsService(prisma);
    const card = await svc.create({ lane: 'research', status: 'cooking' });
    const done = await svc.update(card.id, { status: 'done', detail: '# Findings' });
    expect(done.status).toBe('done');
    expect(done.detail).toBe('# Findings');
    expect((await svc.remove(card.id)).ok).toBe(true);
    await expect(svc.get(card.id)).rejects.toThrow();
  });
});

// BEA-981 — which day a STORY belongs to: before noon a still-open yesterday, else today.
describe('EmoCardsService.storyDay (BEA-981)', () => {
  afterEach(() => jest.useRealTimers());

  function withClock(iso: string, yesterdayClosed: boolean) {
    jest.useFakeTimers().setSystemTime(new Date(iso));
    const { prisma } = makePrisma();
    prisma.dayClose = { findUnique: async () => (yesterdayClosed ? { day: 'x' } : null) };
    return new EmoCardsService(prisma);
  }

  it('a story told in the morning goes to the still-open yesterday', async () => {
    const svc = withClock('2026-07-16T03:00:00Z', false); // 08:30 IST
    expect(await svc.storyDay()).toBe('2026-07-15');
  });

  it('once yesterday is closed, a morning story is today’s', async () => {
    const svc = withClock('2026-07-16T03:00:00Z', true); // 08:30 IST, yesterday closed
    expect(await svc.storyDay()).toBe('2026-07-16');
  });

  it('after noon a story is today’s even if yesterday is still open', async () => {
    const svc = withClock('2026-07-16T09:00:00Z', false); // 14:30 IST
    expect(await svc.storyDay()).toBe('2026-07-16');
  });

  it('crosses month boundaries correctly', async () => {
    const svc = withClock('2026-07-01T03:00:00Z', false); // 08:30 IST on the 1st
    expect(await svc.storyDay()).toBe('2026-06-30');
  });
});
