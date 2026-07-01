import { spreadTimes, localTimesToUtc, RemindersService } from './reminders.service';

describe('localTimesToUtc — reminder times are in the user tz (BEA-734)', () => {
  it('interprets HH:MM as IST and converts to the right UTC instant', () => {
    const now = new Date('2026-07-01T00:00:00Z'); // 05:30 IST, same local day
    const [d] = localTimesToUtc(['09:00'], now, 330);
    expect(d.toISOString()).toBe('2026-07-01T03:30:00.000Z'); // 9 AM IST = 03:30 UTC
  });
  it('skips slots already >2 min in the past, keeps future ones', () => {
    const now = new Date('2026-07-01T12:00:00Z'); // 17:30 IST
    const out = localTimesToUtc(['09:00', '20:00'], now, 330);
    expect(out).toHaveLength(1); // 9 AM IST already passed → skipped
    expect(out[0].toISOString()).toBe('2026-07-01T14:30:00.000Z'); // 8 PM IST = 14:30 UTC
  });
});

describe('RemindersService.suggestions (BEA-721)', () => {
  it('lists open tasks with a party, resolves contacts, flags no-number + active reminder', async () => {
    const prisma: any = {
      task: { findMany: async () => [
        { id: 't1', title: 'Get PCB samples', party: 'Ravi', dueDate: null, pinned: false },
        { id: 't2', title: 'Call back', party: 'Sunil', dueDate: null, pinned: false },
        { id: 't3', title: 'No party', party: '  ', dueDate: null, pinned: false },
      ] },
      reminder: { findMany: async () => [{ taskId: 't2' }] },
    };
    const contacts: any = { findByName: async (n: string) => (n.toLowerCase() === 'ravi' ? { id: 'c1', name: 'Ravi', whatsappNumber: '91999' } : null) };
    const svc = new RemindersService(prisma, {} as any, contacts);
    const { suggestions } = await svc.suggestions();
    expect(suggestions).toHaveLength(2); // blank-party task excluded
    const ravi = suggestions.find((s) => s.task.id === 't1')!;
    expect(ravi.noNumber).toBe(false);
    const sunil = suggestions.find((s) => s.task.id === 't2')!;
    expect(sunil.noNumber).toBe(true); // no matching contact
    expect(sunil.hasActiveReminder).toBe(true);
  });
});


describe('RemindersService pause/resume (BEA-720)', () => {
  function makeSvc(cur: any) {
    const calls = { deleteMany: 0, createMany: 0, updateData: null as any };
    const prisma: any = {
      reminder: {
        findUnique: async () => cur,
        update: async ({ data }: any) => { calls.updateData = data; cur = { ...cur, ...data }; return cur; },
      },
      reminderSend: {
        deleteMany: async () => { calls.deleteMany++; return {}; },
        createMany: async () => { calls.createMany++; return {}; },
      },
    };
    const svc = new RemindersService(prisma, {} as any, {} as any);
    return { svc, calls };
  }

  it('pause → status paused, clears queued sends, queues nothing new', async () => {
    const { svc, calls } = makeSvc({ id: 'r1', status: 'active', times: JSON.stringify(['09:00', '16:30']), taskId: null, contact: {}, sends: [] });
    await svc.pause('r1');
    expect(calls.updateData.status).toBe('paused');
    expect(calls.deleteMany).toBe(1);
    expect(calls.createMany).toBe(0);
  });

  it('resume → status active, re-queues today’s sends from stored times', async () => {
    const { svc, calls } = makeSvc({ id: 'r1', status: 'paused', times: JSON.stringify(['09:00', '16:30']), taskId: null, contact: {}, sends: [] });
    await svc.resume('r1');
    expect(calls.updateData.status).toBe('active');
    expect(calls.createMany).toBe(1);
  });
});

describe('RemindersService.draftMessage clean up (BEA-720/731)', () => {
  // No picker set → the default (reliable) engine; formatComplete calls llm.completeWith.
  const prisma: any = { setting: { findUnique: async () => null } };

  it('reformats the user’s own rough words via the chosen engine', async () => {
    const llm: any = { completeWith: async () => '  "Hi Ravi, any update on the samples?"  ' };
    const svc = new RemindersService(prisma, llm, {} as any);
    const { message } = await svc.draftMessage({ userInput: 'chase ravi re samples', contactName: 'Ravi' });
    expect(message).toBe('Hi Ravi, any update on the samples?'); // quotes + whitespace stripped
  });

  it('retries once, then falls back to the raw words if the engine keeps failing (BEA-731)', async () => {
    let calls = 0;
    const llm: any = { completeWith: async () => { calls++; return ''; } };
    const svc = new RemindersService(prisma, llm, {} as any);
    const { message } = await svc.draftMessage({ userInput: 'call sunil tomorrow', contactName: 'Sunil' });
    expect(message).toBe('call sunil tomorrow'); // raw preserved, never lost
    expect(calls).toBe(2); // tried, then retried once
  });
});

describe('spreadTimes (BEA-720)', () => {
  it('1 reminder → just the morning', () => {
    expect(spreadTimes(1)).toEqual(['09:00']);
  });
  it('3 reminders → spread across the day (first 9, last 16:30)', () => {
    const t = spreadTimes(3);
    expect(t[0]).toBe('09:00');
    expect(t[2]).toBe('16:30');
    expect(t).toHaveLength(3);
  });
  it('caps at 5 and is sorted ascending', () => {
    const t = spreadTimes(9);
    expect(t).toHaveLength(5);
    const mins = t.map((x) => Number(x.split(':')[0]) * 60 + Number(x.split(':')[1]));
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });
  it('clamps below 1 to 1', () => {
    expect(spreadTimes(0)).toEqual(['09:00']);
  });
});
