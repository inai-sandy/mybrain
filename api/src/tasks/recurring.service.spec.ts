import { DEFAULT_REST_DAYS, RecurringService } from './recurring.service';

/**
 * BEA-1117: a daily report never finishes. Confirming one "done" would stop the chase forever and
 * tomorrow's update would never be asked for — which is why the owner had to keep REJECTING
 * Jayanth's ticks by hand. The day is the unit of truth: a status satisfies today only.
 */
function makeSvc(opts: { restDays?: string | null; rows?: any[] } = {}) {
  const rows: any[] = opts.rows ? [...opts.rows] : [];
  const prisma: any = {
    setting: {
      findUnique: async () => (opts.restDays === undefined ? { value: JSON.stringify(['Sun']) } : opts.restDays === null ? null : { value: opts.restDays }),
      upsert: async ({ create }: any) => create,
    },
    taskStatusDay: {
      findUnique: async ({ where }: any) => rows.find((r) => r.taskId === where.taskId_day.taskId && r.day === where.taskId_day.day) || null,
      upsert: async ({ where, create, update }: any) => {
        const i = rows.findIndex((r) => r.taskId === where.taskId_day.taskId && r.day === where.taskId_day.day);
        if (i >= 0) rows[i] = { ...rows[i], ...update };
        else rows.push({ ...create });
        return rows[i >= 0 ? i : rows.length - 1];
      },
      create: async ({ data }: any) => { rows.push({ ...data }); return data; },
      findMany: async ({ where }: any) => rows.filter((r) => r.day === where.day),
    },
    task: { findMany: async () => [{ id: 't1', title: 'Send the daily production update', ownerContact: { id: 'c1', name: 'Jayanth' } }] },
  };
  return { svc: new RecurringService(prisma), rows: () => rows };
}

describe('rest days — nothing is owed, so nothing is missed', () => {
  it('defaults to Sunday off', async () => {
    const { svc } = makeSvc({ restDays: null });
    expect(await svc.restDays()).toEqual(DEFAULT_REST_DAYS);
  });

  it('treats a Sunday as a rest day', async () => {
    const { svc } = makeSvc();
    expect(await svc.isRestDay('2026-07-26')).toBe(true); // Sunday
    expect(await svc.isRestDay('2026-07-27')).toBe(false); // Monday
  });

  it('an explicit empty list means chase every day', async () => {
    const { svc } = makeSvc({ restDays: '[]' });
    expect(await svc.restDays()).toEqual([]);
    expect(await svc.isRestDay('2026-07-26')).toBe(false);
  });

  it('ignores junk in the setting rather than crashing', async () => {
    const { svc } = makeSvc({ restDays: 'not json' });
    expect(await svc.restDays()).toEqual(DEFAULT_REST_DAYS);
  });

  it('drops values that are not real weekday names', async () => {
    const { svc } = makeSvc({ restDays: JSON.stringify(['Sun', 'Funday', 42]) });
    expect(await svc.restDays()).toEqual(['Sun']);
  });

  it('saves only clean, de-duplicated weekdays', async () => {
    const { svc } = makeSvc();
    expect(await svc.setRestDays(['Sun', 'Sun', 'Wed', 'nope'])).toEqual({ days: ['Sun', 'Wed'] });
  });
});

describe('the per-day ledger', () => {
  it('marks today received and stores their exact words', async () => {
    const { svc, rows } = makeSvc();
    await svc.markReceived('t1', '2026-07-27', '24/07 OT, 8 members: 2 fitting, 2 mounting', 'c1');
    expect(await svc.isReceived('t1', '2026-07-27')).toBe(true);
    expect(rows()[0].quote).toContain('8 members');
  });

  it('yesterday being received says nothing about today', async () => {
    const { svc } = makeSvc();
    await svc.markReceived('t1', '2026-07-27', 'yesterday\'s update');
    expect(await svc.isReceived('t1', '2026-07-28')).toBe(false); // owed again today
  });

  it('is idempotent — a second arrival on the same day does not double up', async () => {
    const { svc, rows } = makeSvc();
    await svc.markReceived('t1', '2026-07-27', 'first');
    await svc.markReceived('t1', '2026-07-27', 'again');
    expect(rows()).toHaveLength(1);
  });

  it('a late arrival upgrades a missed day to received', async () => {
    const { svc } = makeSvc();
    await svc.markMissed('t1', '2026-07-27');
    await svc.markReceived('t1', '2026-07-27', 'sorry, here it is');
    expect(await svc.isReceived('t1', '2026-07-27')).toBe(true);
  });

  it('closing a day as missed never overwrites one that arrived', async () => {
    const { svc } = makeSvc();
    await svc.markReceived('t1', '2026-07-27', 'sent on time');
    expect(await svc.markMissed('t1', '2026-07-27')).toBe(false);
    expect(await svc.isReceived('t1', '2026-07-27')).toBe(true);
  });

  it('only records a miss once', async () => {
    const { svc, rows } = makeSvc();
    expect(await svc.markMissed('t1', '2026-07-27')).toBe(true);
    expect(await svc.markMissed('t1', '2026-07-27')).toBe(false);
    expect(rows()).toHaveLength(1);
  });
});

describe('the day log the owner reads', () => {
  it('shows an unanswered item as waiting on a working day', async () => {
    const { svc } = makeSvc();
    const log = await svc.dayLog('2026-07-27'); // Monday
    expect(log.restDay).toBe(false);
    expect(log.items[0]).toMatchObject({ title: 'Send the daily production update', status: 'waiting' });
    expect(log.items[0].contact).toMatchObject({ name: 'Jayanth' });
  });

  it('shows "off" rather than a miss on a rest day', async () => {
    const { svc } = makeSvc();
    const log = await svc.dayLog('2026-07-26'); // Sunday
    expect(log.restDay).toBe(true);
    expect(log.items[0].status).toBe('off');
  });

  it('shows what arrived, with the words', async () => {
    const { svc } = makeSvc();
    await svc.markReceived('t1', '2026-07-27', 'OT 8 members');
    const log = await svc.dayLog('2026-07-27');
    expect(log.items[0]).toMatchObject({ status: 'received', quote: 'OT 8 members' });
  });
});

/**
 * BEA-1121: a daily report never reaches a review queue, so a missed day has to reach the owner
 * the same evening. Closed once per day, never on a rest day, and only misses are worth a message.
 */
describe('closing the day and the miss summary', () => {
  const EVENING = new Date('2026-07-27T15:00:00Z'); // 20:30 IST, Monday — past the digest hour
  const MIDDAY = new Date('2026-07-27T06:00:00Z'); // 11:30 IST — the day is not over

  function svcFor(opts: { rows?: any[]; closedDay?: string; restDays?: string } = {}) {
    const rows: any[] = opts.rows ? [...opts.rows] : [];
    const settings: Record<string, string> = {};
    if (opts.closedDay) settings['recurring.closedDay'] = opts.closedDay;
    settings['recurring.restDays'] = opts.restDays ?? JSON.stringify(['Sun']);
    const prisma: any = {
      setting: {
        findUnique: async ({ where }: any) => (settings[where.key] ? { value: settings[where.key] } : null),
        upsert: async ({ where, create }: any) => { settings[where.key] = create.value; return create; },
      },
      taskStatusDay: {
        findUnique: async ({ where }: any) => rows.find((r) => r.taskId === where.taskId_day.taskId && r.day === where.taskId_day.day) || null,
        upsert: async ({ where, create, update }: any) => {
          const i = rows.findIndex((r) => r.taskId === where.taskId_day.taskId && r.day === where.taskId_day.day);
          if (i >= 0) rows[i] = { ...rows[i], ...update }; else rows.push({ ...create });
          return rows[0];
        },
        create: async ({ data }: any) => { rows.push({ ...data }); return data; },
        findMany: async () => rows,
      },
      task: {
        findMany: async () => [
          { id: 't1', title: 'Send the daily production update', ownerContact: { name: 'Jayanth' } },
          { id: 't2', title: 'Send the OT update', ownerContact: { name: 'Jayanth' } },
        ],
      },
    };
    return { svc: new RecurringService(prisma), rows: () => rows, settings };
  }

  it('says nothing before the day is over', async () => {
    const { svc, rows } = svcFor();
    expect(await svc.closeDay(MIDDAY)).toBeNull();
    expect(rows()).toHaveLength(0); // and records no miss yet
  });

  it('records the misses and returns them for ONE summary', async () => {
    const { svc } = svcFor();
    const out = await svc.closeDay(EVENING);
    expect(out).toEqual({
      day: '2026-07-27',
      missed: [
        { title: 'Send the daily production update', contact: 'Jayanth' },
        { title: 'Send the OT update', contact: 'Jayanth' },
      ],
    });
  });

  it('leaves out what actually arrived', async () => {
    const { svc } = svcFor({ rows: [{ taskId: 't1', day: '2026-07-27', status: 'received' }] });
    const out = await svc.closeDay(EVENING);
    expect(out?.missed.map((m) => m.title)).toEqual(['Send the OT update']);
  });

  it('says nothing when everything came in', async () => {
    const { svc } = svcFor({ rows: [
      { taskId: 't1', day: '2026-07-27', status: 'received' },
      { taskId: 't2', day: '2026-07-27', status: 'received' },
    ] });
    expect(await svc.closeDay(EVENING)).toBeNull();
  });

  it('never sends twice for the same day', async () => {
    const { svc } = svcFor();
    expect((await svc.closeDay(EVENING))?.missed).toHaveLength(2);
    expect(await svc.closeDay(EVENING)).toBeNull(); // second pass is silent
  });

  it('records nothing on a rest day — nothing was owed', async () => {
    const { svc, rows } = svcFor({ restDays: JSON.stringify(['Mon']) }); // make the test day a rest day
    expect(await svc.closeDay(EVENING)).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});
