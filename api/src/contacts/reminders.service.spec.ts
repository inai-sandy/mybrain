import { spreadTimes, RemindersService } from './reminders.service';

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

describe('RemindersService.draftMessage reformat (BEA-720)', () => {
  it('reformats the user’s own rough words via the LLM', async () => {
    const llm: any = { complete: async () => '  "Hi Ravi, any update on the samples?"  ' };
    const svc = new RemindersService({} as any, llm, {} as any);
    const { message } = await svc.draftMessage({ userInput: 'chase ravi re samples', contactName: 'Ravi' });
    expect(message).toBe('Hi Ravi, any update on the samples?'); // quotes + whitespace stripped
  });
  it('falls back to the raw words if the LLM fails', async () => {
    const llm: any = { complete: async () => { throw new Error('down'); } };
    const svc = new RemindersService({} as any, llm, {} as any);
    const { message } = await svc.draftMessage({ userInput: 'call sunil tomorrow', contactName: 'Sunil' });
    expect(message).toBe('call sunil tomorrow');
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
