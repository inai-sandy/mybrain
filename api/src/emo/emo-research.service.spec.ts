import { EmoResearchService } from './emo-research.service';

function make(opts: { card: any; brief?: string; clarify?: string }) {
  const updates: any[] = [];
  const cards: any = { get: jest.fn(async () => opts.card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return {}; }) };
  const llm: any = { complete: jest.fn(async (prompt: string) => (prompt.includes('research brief') ? (opts.brief ?? '{"topic":"CCTV market","question":"What is the CCTV market in India?"}') : (opts.clarify ?? '{"questions":["What angle?"],"options":["Overview","Competitors"]}')) ) };
  const flows: any = { create: jest.fn(async () => ({ id: 'f1' })), planAndSave: jest.fn(async () => ({ id: 'f1' })) };
  return { svc: new EmoResearchService(llm, cards, flows), cards, flows, updates };
}

describe('EmoResearchService (BEA-870)', () => {
  it('clarifies first on a fresh research card (deep research always clarifies)', async () => {
    const { svc, flows, updates } = make({ card: { id: 'c1', lane: 'research', rawTranscript: 'research the cctv market', summary: 'Research: CCTV', status: 'cooking', needsAnswer: null } });
    await svc.handle('c1');
    expect(flows.create).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'needs_you' });
    expect(updates[0].needsQuestion).toMatch(/angle/i);
  });

  it('builds & saves a flow (does NOT run it) once the clarify is answered', async () => {
    const { svc, flows, updates } = make({ card: { id: 'c1', lane: 'research', rawTranscript: 'research the cctv market', summary: 'Research: CCTV', status: 'needs_you', needsAnswer: 'competitors, last 2 years' } });
    await svc.handle('c1');
    expect(flows.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Research: CCTV market' }));
    expect(flows.planAndSave).toHaveBeenCalledWith('f1');
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Research flow ready: CCTV market');
    expect(done.links[0]).toMatchObject({ kind: 'flow', id: 'f1' });
    expect(done.detail).toMatch(/NOT running/i); // it does not auto-run
  });

  it('still saves the flow if branch planning fails', async () => {
    const { svc, flows, updates } = make({ card: { id: 'c1', lane: 'research', status: 'needs_you', needsAnswer: 'x', rawTranscript: 'research widgets', summary: 'Research: widgets' } });
    flows.planAndSave.mockRejectedValueOnce(new Error('planner down'));
    await svc.handle('c1');
    expect(updates[updates.length - 1].status).toBe('done'); // flow was created; plan failure is non-fatal
  });

  it('ignores a non-research card', async () => {
    const { svc, flows } = make({ card: { id: 'c1', lane: 'task' } });
    await svc.handle('c1');
    expect(flows.create).not.toHaveBeenCalled();
  });
});
