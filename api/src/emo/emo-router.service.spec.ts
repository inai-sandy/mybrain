import { EmoRouterService } from './emo-router.service';
import { EmoCardsService } from './emo-cards.service';

function makeCards() {
  const created: any[] = [];
  const prisma: any = {
    emoCard: { create: async ({ data }: any) => { const r = { id: `c${created.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data }; created.push(r); return r; } },
  };
  return { svc: new EmoCardsService(prisma), created };
}

const searchStub: any = { clarify: jest.fn(async () => undefined) };
const taskStub: any = { handle: jest.fn(async () => undefined) };
describe('EmoRouterService (BEA-863)', () => {
  it('splits one transcript into multiple cards across lanes', async () => {
    const llm: any = { complete: async () => JSON.stringify({ segments: [
      { lane: 'task', summary: 'Task: finish the BOM', text: 'finish the BOM by Friday' },
      { lane: 'reminder', summary: 'Reminder: Dharmendra, Fri', text: 'remind Dharmendra on Friday' },
      { lane: 'search', summary: 'Search: CCTV market', text: 'what do we have on the cctv market' },
    ] }) };
    const { svc, created } = makeCards();
    const out = await new EmoRouterService(llm, svc, searchStub, taskStub).route('… long dump …', { source: 'browser' });
    expect(out.cards).toHaveLength(3);
    expect(created.map((c) => c.lane)).toEqual(['task', 'reminder', 'search']);
    // terminal vs actionable status
    expect(created.find((c) => c.lane === 'task').status).toBe('cooking'); // waits for the task lane
    expect(created.every((c) => c.source === 'browser')).toBe(true);
  });

  it('marks story/note as done (the card is the result), actionable lanes as cooking', async () => {
    const llm: any = { complete: async () => JSON.stringify({ segments: [{ lane: 'story', summary: 'Met the vendor', text: 'met the vendor, felt good' }] }) };
    const { created } = makeCards();
    const { svc } = makeCards();
    await new EmoRouterService(llm, svc, searchStub, taskStub).route('met the vendor, felt good');
    // (use svc's own created via a fresh pair)
    const pair = makeCards();
    await new EmoRouterService(llm, pair.svc, searchStub, taskStub).route('met the vendor, felt good');
    expect(pair.created[0].lane).toBe('story');
    expect(pair.created[0].status).toBe('done');
    void created;
  });

  it('files a fallback note card when the LLM output is unusable — nothing is lost (BEA-863)', async () => {
    const llm: any = { complete: async () => 'sorry, I cannot help with that' };
    const { svc, created } = makeCards();
    const out = await new EmoRouterService(llm, svc, searchStub, taskStub).route('some rambling voice note');
    expect(out.cards).toHaveLength(1);
    expect(created[0].lane).toBe('note');
    expect(created[0].rawTranscript).toBe('some rambling voice note'); // the whole thing kept
  });

  it('returns nothing for an empty transcript', async () => {
    const llm: any = { complete: async () => '' };
    const { svc } = makeCards();
    expect((await new EmoRouterService(llm, svc, searchStub, taskStub).route('   ')).cards).toHaveLength(0);
  });
});
