import { TasksService } from './tasks.service';

/**
 * The morning dump learns the same rule as briefings: someone else's work goes to that person,
 * linked ONLY on an exact, unique contact match. Anything unclear stays on the owner's board —
 * a wrongly-assigned task is worse than one he has to reassign by hand. (BEA-1040)
 */
function make(llmJson: any, contacts: any[]) {
  const settings: Record<string, string> = {};
  const tasks: any[] = [];
  let seq = 0;
  const prisma: any = {
    setting: { findUnique: async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null) },
    contact: { findMany: async () => contacts },
    brainDump: { create: async ({ data }: any) => ({ id: `d${++seq}`, ...data }) },
    task: {
      create: async ({ data }: any) => { const t = { id: `t${++seq}`, status: 'open', rolloverCount: 0, createdAt: new Date(), ...data }; tasks.push(t); return t; },
      findMany: async () => tasks,
    },
  };
  const llm: any = { completeWith: async () => JSON.stringify(llmJson) };
  const prompts: any = { get: async () => 'PROMPT' };
  const memory: any = { indexEntity: async () => undefined, reindexContact: async () => undefined };
  return { svc: new TasksService(prisma, llm, prompts, memory) as any, tasks };
}

const CONTACTS = [
  { id: 'c1', name: 'Ramesh', aliases: '[]' },
  { id: 'c2', name: 'Dharmendra', aliases: '[]' },
  { id: 'c3', name: 'Dharmendra', aliases: '[]' }, // namesakes — must never be guessed between
];

describe('the dump gives each task to the right person (BEA-1040)', () => {
  it('his work goes to him, mine stays mine — from one dump', async () => {
    const { svc, tasks } = make({ question: null, tasks: [
      { title: 'Send the vendor list', who: 'Ramesh' },
      { title: 'Call the bank', who: null },
    ] }, CONTACTS);
    await svc.dump('Ramesh needs to send the vendor list. I need to call the bank.');
    expect(tasks[0]).toMatchObject({ ownerContactId: 'c1', party: 'Ramesh' });
    expect(tasks[1].ownerContactId).toBeNull();
  });

  it('a name shared by two contacts stays on MY board — never guessed', async () => {
    const { svc, tasks } = make({ question: null, tasks: [{ title: 'Fix the labels', who: 'Dharmendra' }] }, CONTACTS);
    await svc.dump('Dharmendra must fix the labels');
    expect(tasks[0].ownerContactId).toBeNull();
    expect(tasks[0].party).toBeNull();
  });

  it('an unknown name stays on my board too', async () => {
    const { svc, tasks } = make({ question: null, tasks: [{ title: 'x', who: 'Somebody New' }] }, CONTACTS);
    await svc.dump('Somebody New must do x');
    expect(tasks[0].ownerContactId).toBeNull();
  });

  it('the response already carries the owner so the review sheet can show it', async () => {
    const { svc } = make({ question: null, tasks: [{ title: 'Send it', who: 'Ramesh' }] }, CONTACTS);
    const r = await svc.dump('Ramesh must send it');
    expect(r.tasks[0].owner).toEqual({ id: 'c1', name: 'Ramesh' });
    expect(r.tasks[0].party).toBe('Ramesh');
  });

  it('a dump with no who behaves exactly as before', async () => {
    const { svc, tasks } = make({ question: null, tasks: [{ title: 'Plain old task' }] }, CONTACTS);
    await svc.dump('plain old task');
    expect(tasks[0].ownerContactId).toBeNull();
  });
});

import { dumpKey } from './tasks.service';

/** One "the" must not defeat the duplicate block — proven live before this fix. (BEA-1040) */
describe('dumpKey — filler-proof dedupe', () => {
  it('treats titles that differ only by filler as the same task', () => {
    expect(dumpKey('Send the signed distributor agreement')).toBe(dumpKey('Send signed distributor agreement'));
    expect(dumpKey('Call the bank today')).toBe(dumpKey('call bank'));
  });
  it('keeps genuinely different tasks apart', () => {
    expect(dumpKey('Send the vendor list')).not.toBe(dumpKey('Send the price list'));
  });
});
