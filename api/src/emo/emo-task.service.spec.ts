import { EmoTaskService } from './emo-task.service';

function make(dumpResult: any, card: any = { id: 'c1', lane: 'task', rawTranscript: 'finish the BOM by friday', summary: 'Task: finish the BOM', needsAnswer: null }) {
  const updates: any[] = [];
  const cards: any = { get: jest.fn(async () => card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return { ...card, ...p }; }) };
  const tasks: any = {
    dump: jest.fn(async () => dumpResult),
    create: jest.fn(async (t: any) => ({ id: 'best1', title: t.title })),
  };
  return { svc: new EmoTaskService(tasks, cards), tasks, updates };
}

describe('EmoTaskService (BEA-866 / BEA-877)', () => {
  it('creates real tasks from the recording and links them on the card', async () => {
    const { svc, tasks, updates } = make({ tasks: [{ id: 't1', title: 'finish the BOM' }] });
    await svc.handle('c1');
    expect(tasks.dump).toHaveBeenCalledWith(expect.stringContaining('BOM'), 'emo');
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Task added: finish the BOM');
    expect(done.links).toEqual([{ kind: 'task', id: 't1', label: 'finish the BOM' }]);
  });

  it('auto-splits one recording into several task cards-links', async () => {
    const { svc, updates } = make({ tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }, { id: 't3', title: 'C' }] });
    await svc.handle('c1');
    const done = updates[updates.length - 1];
    expect(done.summary).toBe('3 tasks added');
    expect(done.links).toHaveLength(3);
  });

  it('surfaces the dump clarity question on the card (Needs-you) the FIRST time it is vague', async () => {
    const { svc, tasks, updates } = make({ question: 'What is “stuff”?', tasks: [] });
    await svc.handle('c1');
    expect(tasks.create).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'needs_you', needsQuestion: 'What is “stuff”?' });
  });

  it('does NOT discard a still-vague 2nd answer — captures a best-effort task (BEA-877)', async () => {
    const card = { id: 'c1', lane: 'task', rawTranscript: 'do the thing for the launch', summary: 'Task', needsAnswer: 'the launch thing' };
    const { svc, tasks, updates } = make({ question: 'still unclear — what thing?', tasks: [] }, card);
    await svc.handle('c1');
    expect(tasks.create).toHaveBeenCalled(); // captured, not dropped as "Nothing to add"
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toMatch(/Task added/);
    expect(done.links[0]).toMatchObject({ kind: 'task', id: 'best1' });
  });

  it('ignores a non-task card', async () => {
    const { svc, tasks } = make({ tasks: [] }, { id: 'c1', lane: 'search' });
    await svc.handle('c1');
    expect(tasks.dump).not.toHaveBeenCalled();
  });
});
