import { EmoTaskService } from './emo-task.service';

function make(opts: { title?: string; llmFail?: boolean; card?: any } = {}) {
  const card = opts.card ?? { id: 'c1', lane: 'task', rawTranscript: 'finish the BOM by friday', summary: 'Task: finish the BOM', needsAnswer: null };
  const updates: any[] = [];
  const cards: any = { get: jest.fn(async () => card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return { ...card, ...p }; }) };
  const llm: any = { complete: jest.fn(async () => { if (opts.llmFail) throw new Error('down'); return opts.title ?? 'Finish the BOM'; }) };
  const tasks: any = { create: jest.fn(async (t: any) => ({ id: 't1', title: t.title })) };
  return { svc: new EmoTaskService(llm, tasks, cards), llm, tasks, updates };
}

describe('EmoTaskService (BEA-947: ONE task per utterance)', () => {
  it('creates exactly one task with a cleaned title', async () => {
    const { svc, tasks, updates } = make({ title: 'Finish the BOM by Friday' });
    await svc.handle('c1');
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Finish the BOM by Friday', category: 'Emo', auto: true }));
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Task added: Finish the BOM by Friday');
    expect(done.links).toHaveLength(1);
  });

  it('NEVER splits: a multi-item dump still becomes one task', async () => {
    const { svc, tasks } = make({
      title: 'Call Ravi and send the invoice',
      card: { id: 'c1', lane: 'task', rawTranscript: 'call ravi and also send the invoice and buy milk', summary: '', needsAnswer: null },
    });
    await svc.handle('c1');
    expect(tasks.create).toHaveBeenCalledTimes(1);
  });

  it('LLM down: falls back to the raw words, still one task, nothing lost', async () => {
    const { svc, tasks, updates } = make({ llmFail: true });
    await svc.handle('c1');
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(tasks.create.mock.calls[0][0].title).toContain('finish the BOM');
    expect(updates[updates.length - 1].status).toBe('done');
  });

  it('ignores a non-task card', async () => {
    const { svc, tasks } = make({ card: { id: 'c1', lane: 'note', rawTranscript: 'x' } });
    await svc.handle('c1');
    expect(tasks.create).not.toHaveBeenCalled();
  });
});
