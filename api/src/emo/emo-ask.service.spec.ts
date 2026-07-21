import { EmoAskService } from './emo-ask.service';

function make(opts: { clarify?: string; answer?: string } = {}) {
  const created: any[] = [];
  const llm: any = {
    completeWith: jest.fn(async (_c: any, prompt: string) => {
      if (/narrowing a question/i.test(prompt)) return opts.clarify ?? 'ANSWER';
      if (/short spoken sentence/i.test(prompt)) return 'Short summary.';
      return '';
    }),
  };
  const memory: any = { searchBrain: jest.fn(async () => [{ title: 'Trading docs', content: 'notes' }]) };
  const explore: any = { ask: jest.fn(async () => ({ answer: opts.answer ?? 'Full answer.', sources: [], matches: 3, summary: 'Short summary.' })) };
  const cards: any = { create: jest.fn(async (c: any) => { created.push(c); return { id: 'card1', ...c }; }) };
  return { svc: new EmoAskService(llm, memory, explore, cards), llm, memory, explore, cards, created };
}

describe('EmoAskService (BEA-890)', () => {
  it('answers on the FIRST turn — no clarifying round, no grounding search (BEA-1012)', async () => {
    const { svc, explore, memory, llm } = make({ clarify: 'Which project — trading or panels?' });
    const r: any = await svc.ask({ question: 'what about Dharmendra' });
    expect(r.mode).toBe('answer');
    expect(explore.ask).toHaveBeenCalled();
    // the extra brain search that only fed the clarifying prompt is gone
    expect(memory.searchBrain).not.toHaveBeenCalled();
    // and no clarify/offer model round trips block the answer
    expect(llm.completeWith).not.toHaveBeenCalled();
  });

  it('does not make the owner wait for the follow-up offer (fetched separately) (BEA-1012)', async () => {
    const { svc } = make({ answer: 'You have 3 trading tasks.' });
    const r: any = await svc.ask({ question: 'the trading products' });
    expect(r.offer).toBeUndefined();
  });

  it('answers + files a Search card (voice gets the summary, card gets the detail)', async () => {
    const { svc, explore, created } = make({ answer: 'You have 3 trading tasks.' });
    const r: any = await svc.ask({ question: 'the trading products', history: [{ role: 'user', text: 'what about Dharmendra' }, { role: 'emo', text: 'Which project?' }] });
    expect(explore.ask).toHaveBeenCalled();
    expect(r.mode).toBe('answer');
    expect(r.cardId).toBe('card1');
    expect(created[0]).toMatchObject({ lane: 'search', status: 'done' });
    expect(created[0].detail).toContain('You have 3 trading tasks.'); // full answer lives on the card
    expect(r.summary).toBe('Short summary.'); // voice speaks the summary, not the detail
  });

  it('direct mode (EMO device, BEA-938) never clarifies — answers immediately on the first turn', async () => {
    const { svc, explore } = make({ clarify: 'Which project — trading or panels?' });
    const r: any = await svc.ask({ question: 'what about Dharmendra', direct: true });
    expect(r.mode).toBe('answer');
    expect(explore.ask).toHaveBeenCalled();
  });

  it('answers regardless of how much history there is', async () => {
    const { svc, explore } = make({ clarify: 'another?' });
    const history: any = [
      { role: 'user', text: 'q' }, { role: 'emo', text: 'c1' },
      { role: 'user', text: 'a1' }, { role: 'emo', text: 'c2' },
      { role: 'user', text: 'a2' }, { role: 'emo', text: 'c3' },
    ];
    const r: any = await svc.ask({ question: 'a3', history });
    expect(r.mode).toBe('answer');
    expect(explore.ask).toHaveBeenCalled();
  });

  it('folds earlier turns into the refined question sent to the brain', async () => {
    const { svc, explore } = make({ answer: 'done' });
    await svc.ask({ question: 'pending ones', history: [{ role: 'user', text: 'tasks for Srikar' }, { role: 'emo', text: 'Done or pending?' }] });
    expect(explore.ask).toHaveBeenCalledWith(expect.stringMatching(/tasks for Srikar.*pending ones/), expect.anything());
  });
});
