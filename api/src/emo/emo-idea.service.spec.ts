import { EmoIdeaService } from './emo-idea.service';

describe('EmoIdeaService (BEA-950)', () => {
  function make(card: any = { id: 'c1', lane: 'idea', rawTranscript: 'an app for plant watering', needsAnswer: null }) {
    const updates: any[] = [];
    const cards: any = { get: jest.fn(async () => card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return {}; }) };
    const ideas: any = { create: jest.fn(async () => ({ id: 'i1', title: 'Self-watering plant app' })) };
    return { svc: new EmoIdeaService(ideas, cards), ideas, updates };
  }

  it('creates ONE organized idea and links it on the card', async () => {
    const { svc, ideas, updates } = make();
    await svc.handle('c1');
    expect(ideas.create).toHaveBeenCalledTimes(1);
    expect(ideas.create).toHaveBeenCalledWith(expect.stringContaining('plant watering'));
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Idea saved: Self-watering plant app');
    expect(done.links).toEqual([{ kind: 'idea', id: 'i1', label: 'Self-watering plant app' }]);
  });

  it('failure keeps the words on the card as needs_you', async () => {
    const { svc, updates } = make();
    (svc as any).ideas.create = jest.fn(async () => { throw new Error('down'); });
    await svc.handle('c1');
    expect(updates[updates.length - 1].status).toBe('needs_you');
  });

  it('ignores non-idea cards', async () => {
    const { svc, ideas } = make({ id: 'c1', lane: 'note', rawTranscript: 'x' });
    await svc.handle('c1');
    expect(ideas.create).not.toHaveBeenCalled();
  });
});
