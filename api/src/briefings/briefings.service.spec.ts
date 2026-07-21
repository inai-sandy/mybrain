import { BriefingsService } from './briefings.service';

/**
 * The promises this service makes to the owner:
 *   - drafting saves NOTHING,
 *   - only the tasks he kept are created,
 *   - his words are never lost, even when the AI is down,
 *   - deleting the note never deletes the work. (BEA-1020)
 */
function make(llmReply: string | null | Error) {
  const briefings: any[] = [];
  const created: any[] = [];
  let seq = 0;
  const prisma: any = {
    contact: { findUnique: async ({ where }: any) => (where.id === 'c1' ? { id: 'c1', name: 'Ramesh' } : null) },
    setting: { findUnique: async () => null },
    briefing: {
      create: async ({ data }: any) => { const r = { id: `b${++seq}`, createdAt: new Date(), updatedAt: new Date(), tasks: [], ...data }; briefings.push(r); return r; },
      findUnique: async ({ where }: any) => briefings.find((b) => b.id === where.id) || null,
      findMany: async () => briefings.slice().reverse(),
      update: async ({ where, data }: any) => { const b = briefings.find((x) => x.id === where.id); Object.assign(b, data); return b; },
      delete: async ({ where }: any) => { const i = briefings.findIndex((x) => x.id === where.id); return briefings.splice(i, 1)[0]; },
    },
  };
  const llm: any = {
    completeWith: async () => { if (llmReply instanceof Error) throw llmReply; return llmReply; },
  };
  const prompts: any = { get: async () => 'PROMPT' };
  const tasks: any = { create: async (d: any) => { const t = { id: `t${++seq}`, status: 'open', ...d }; created.push(t); return t; } };
  const chases: any[] = [];
  const reminders: any = { create: async (d: any) => { chases.push(d); return d; } };
  return { svc: new BriefingsService(prisma, llm, prompts, tasks, reminders), briefings, created, chases };
}

const GOOD = JSON.stringify({
  summary: 'GST filing and the vendor list',
  tasks: [
    { title: 'Finish the GST filing', note: 'by Friday', category: 'Admin', priority: 'high', estimateMin: 60 },
    { title: 'Send the vendor list', priority: 'medium' },
  ],
});

describe('draft — proposes, never saves (BEA-1020)', () => {
  it('splits a briefing into the separate things that person owes', async () => {
    const { svc, briefings, created } = make(GOOD);
    const d = await svc.draft('c1', 'Ramesh needs to finish the GST filing by Friday and send me the vendor list');
    expect(d.tasks.map((t) => t.title)).toEqual(['Finish the GST filing', 'Send the vendor list']);
    expect(d.summary).toBe('GST filing and the vendor list');
    expect(briefings).toHaveLength(0); // nothing saved
    expect(created).toHaveLength(0); // no tasks created
  });

  it('keeps your words when the AI is unavailable — one task holding the whole briefing', async () => {
    const { svc } = make(new Error('model down'));
    const d = await svc.draft('c1', 'Ramesh owes me the GST filing');
    expect(d.tasks).toHaveLength(1);
    expect(d.tasks[0].title).toContain('Ramesh owes me the GST filing');
  });

  it('falls back the same way when the AI returns nonsense', async () => {
    const { svc } = make('not json at all');
    const d = await svc.draft('c1', 'something he owes me');
    expect(d.tasks).toHaveLength(1);
    expect(d.tasks[0].note).toBe('something he owes me');
  });

  it('drops empty titles and caps a runaway split', async () => {
    const many = JSON.stringify({ summary: 's', tasks: [{ title: '' }, ...Array.from({ length: 40 }, (_, i) => ({ title: `t${i}` }))] });
    const { svc } = make(many);
    const d = await svc.draft('c1', 'lots');
    expect(d.tasks).toHaveLength(20);
    expect(d.tasks.every((t) => t.title)).toBe(true);
  });

  it('refuses an empty briefing', async () => {
    const { svc } = make(GOOD);
    await expect(svc.draft('c1', '   ')).rejects.toThrow();
  });

  it('refuses a contact that does not exist', async () => {
    const { svc } = make(GOOD);
    await expect(svc.draft('nope', 'anything')).rejects.toThrow();
  });
});

describe('create — only what the owner kept (BEA-1020)', () => {
  it('creates exactly the approved tasks, all owned by that person', async () => {
    const { svc, created, briefings } = make(GOOD);
    await svc.create('c1', { text: 'the story', summary: 'sum', tasks: [{ title: 'Send the vendor list' }] });
    expect(briefings).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: 'Send the vendor list', ownerContactId: 'c1', briefingId: 'b1' });
  });

  it('keeps your exact words on the briefing', async () => {
    const { svc, briefings } = make(GOOD);
    await svc.create('c1', { text: 'he said he would do it after Diwali', tasks: [{ title: 'x' }] });
    expect(briefings[0].rawText).toBe('he said he would do it after Diwali');
  });

  it('refuses to save with every task dropped', async () => {
    const { svc } = make(GOOD);
    await expect(svc.create('c1', { text: 'story', tasks: [] })).rejects.toThrow();
  });
});

describe('update / remove (BEA-1020)', () => {
  it('editing the wording does NOT create tasks again', async () => {
    const { svc, created } = make(GOOD);
    await svc.create('c1', { text: 'story', tasks: [{ title: 'one' }] });
    expect(created).toHaveLength(1);
    await svc.update('b1', { rawText: 'story, fixed a typo' });
    expect(created).toHaveLength(1); // still one
  });

  it('deleting a briefing KEEPS the tasks it created', async () => {
    const { svc, briefings } = make(GOOD);
    await svc.create('c1', { text: 'story', tasks: [{ title: 'one' }] });
    briefings[0].tasks = [{ id: 't1' }];
    const r = await svc.remove('b1');
    expect(r).toEqual({ ok: true, keptTasks: 1 });
  });

  it('refuses to blank out a briefing', async () => {
    const { svc } = make(GOOD);
    await svc.create('c1', { text: 'story', tasks: [{ title: 'one' }] });
    await expect(svc.update('b1', { rawText: '  ' })).rejects.toThrow();
  });
});

describe('contextFor — what the agent reads (BEA-1020)', () => {
  it('returns nothing when the person has never been briefed', async () => {
    const { svc } = make(GOOD);
    expect(await svc.contextFor('c1')).toBe('');
  });

  it('returns every briefing, dated', async () => {
    const { svc } = make(GOOD);
    await svc.create('c1', { text: 'first story', tasks: [{ title: 'a' }] });
    await svc.create('c1', { text: 'second story', tasks: [{ title: 'b' }] });
    const ctx = await svc.contextFor('c1');
    expect(ctx).toContain('first story');
    expect(ctx).toContain('second story');
    expect(ctx).toMatch(/^\[\d{4}-\d{2}-\d{2}\]/);
  });
});

describe('the chase is set in the same step (BEA-1021)', () => {
  it('starts a daily chase per task when times are given', async () => {
    const { svc, chases } = make(GOOD);
    await svc.create('c1', { text: 'story', tasks: [{ title: 'one' }, { title: 'two' }], chase: { times: ['09:00', '17:30'] } });
    expect(chases).toHaveLength(2);
    expect(chases[0]).toMatchObject({ contactId: 'c1', repeat: 'daily', times: ['09:00', '17:30'] });
    expect(chases[0].taskId).toBeTruthy(); // the chase is attached to real work
  });

  it('creates no chase when the owner did not ask for one', async () => {
    const { svc, chases } = make(GOOD);
    await svc.create('c1', { text: 'story', tasks: [{ title: 'one' }] });
    expect(chases).toHaveLength(0);
  });

  it('ignores rubbish times rather than scheduling nonsense', async () => {
    const { svc, chases } = make(GOOD);
    await svc.create('c1', { text: 'story', tasks: [{ title: 'one' }], chase: { times: ['25:99', 'later', '09:00'] } });
    expect(chases[0].times).toEqual(['09:00']);
  });

  it('a failing chase never loses the task', async () => {
    const { svc, created } = make(GOOD);
    (svc as any).reminders.create = async () => { throw new Error('postbox down'); };
    await svc.create('c1', { text: 'story', tasks: [{ title: 'one' }], chase: { times: ['09:00'] } });
    expect(created).toHaveLength(1);
  });
});
