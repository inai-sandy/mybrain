import { EmoRouterService } from './emo-router.service';
import { EmoCardsService } from './emo-cards.service';

function makeCards() {
  const created: any[] = [];
  const prisma: any = {
    emoCard: { create: async ({ data }: any) => { const r = { id: `c${created.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data }; created.push(r); return r; } },
  };
  return { svc: new EmoCardsService(prisma), created };
}

const prismaStub: any = { setting: { findUnique: jest.fn(async () => null) } };
const searchStub: any = { clarify: jest.fn(async () => undefined), run: jest.fn(async () => undefined) };
const taskStub: any = { handle: jest.fn(async () => undefined) };
const ideaStub: any = { handle: jest.fn(async () => undefined) };
const reminderStub: any = { handle: jest.fn(async () => undefined) };
const meetingStub: any = { handle: jest.fn(async () => undefined) };
const researchStub: any = { handle: jest.fn(async () => undefined) };
/** The close lane (BEA-1033) — never reached by these router tests, but the DI needs it. */
const closeStub: any = { handle: async () => undefined };

describe('EmoRouterService (BEA-863)', () => {
  it('splits one transcript into multiple cards across lanes', async () => {
    const llm: any = { completeWith: async () => JSON.stringify({ segments: [
      { lane: 'task', summary: 'Task: finish the BOM', text: 'finish the BOM by Friday' },
      { lane: 'reminder', summary: 'Reminder: Dharmendra, Fri', text: 'remind Dharmendra on Friday' },
      { lane: 'search', summary: 'Search: CCTV market', text: 'what do we have on the cctv market' },
    ] }) };
    const { svc, created } = makeCards();
    const out = await new EmoRouterService(prismaStub, llm, svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('… long dump …', { source: 'browser' });
    expect(out.cards).toHaveLength(3);
    expect(created.map((c) => c.lane)).toEqual(['task', 'reminder', 'search']);
    // terminal vs actionable status
    expect(created.find((c) => c.lane === 'task').status).toBe('cooking'); // waits for the task lane
    expect(created.every((c) => c.source === 'browser')).toBe(true);
  });

  it('marks story/note as done (the card is the result), actionable lanes as cooking', async () => {
    const llm: any = { completeWith: async () => JSON.stringify({ segments: [{ lane: 'story', summary: 'Met the vendor', text: 'met the vendor, felt good' }] }) };
    const { created } = makeCards();
    const { svc } = makeCards();
    await new EmoRouterService(prismaStub, llm, svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('met the vendor, felt good');
    // (use svc's own created via a fresh pair)
    const pair = makeCards();
    await new EmoRouterService(prismaStub, llm, pair.svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('met the vendor, felt good');
    expect(pair.created[0].lane).toBe('story');
    expect(pair.created[0].status).toBe('done');
    void created;
  });

  it('files a fallback note card when the LLM output is unusable — nothing is lost (BEA-863)', async () => {
    const llm: any = { completeWith: async () => 'sorry, I cannot help with that' };
    const { svc, created } = makeCards();
    const out = await new EmoRouterService(prismaStub, llm, svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('some rambling voice note');
    expect(out.cards).toHaveLength(1);
    expect(created[0].lane).toBe('note');
    expect(created[0].rawTranscript).toBe('some rambling voice note'); // the whole thing kept
  });

  it('device search runs immediately — no clarify questions from the EMO device (BEA-938)', async () => {
    const llm: any = { completeWith: async () => JSON.stringify({ segments: [
      { lane: 'search', summary: 'Search: CCTV market', text: 'what do we have on the cctv market' },
    ] }) };
    searchStub.clarify.mockClear();
    searchStub.run.mockClear();
    const { svc } = makeCards();
    await new EmoRouterService(prismaStub, llm, svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('cctv market', { source: 'emo-device' });
    expect(searchStub.run).toHaveBeenCalled();
    expect(searchStub.clarify).not.toHaveBeenCalled();
  });

  it('forced idea lane goes straight to the Ideas organiser (BEA-950)', async () => {
    const llm: any = { completeWith: jest.fn(async () => '{}') };
    ideaStub.handle.mockClear();
    const { svc } = makeCards();
    await new EmoRouterService(prismaStub, llm, svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('an app that reminds plants to water themselves', { source: 'emo-device', lane: 'idea' });
    expect(ideaStub.handle).toHaveBeenCalled();
    expect(llm.completeWith).not.toHaveBeenCalled();   // no router guess, no research
  });

  it('returns nothing for an empty transcript', async () => {
    const llm: any = { completeWith: async () => '' };
    const { svc } = makeCards();
    expect((await new EmoRouterService(prismaStub, llm, svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('   ')).cards).toHaveLength(0);
  });
});

// BEA-981 — story cards are filed under storyDay() (a morning story carries the open yesterday).
describe('EmoRouterService story day (BEA-981)', () => {
  it('story cards get the story day; other lanes keep the real day', async () => {
    const llm: any = { completeWith: async () => JSON.stringify({ segments: [
      { lane: 'story', summary: 'Met the vendor', text: 'met the vendor, felt good' },
      { lane: 'task', summary: 'Task: finish the BOM', text: 'finish the BOM' },
    ] }) };
    const { svc, created } = makeCards();
    jest.spyOn(svc, 'storyDay').mockResolvedValue('2026-07-15');
    await new EmoRouterService(prismaStub, llm, svc, searchStub, taskStub, ideaStub, reminderStub, meetingStub, researchStub, closeStub).route('dump');
    expect(created.find((c) => c.lane === 'story').day).toBe('2026-07-15');
    expect(created.find((c) => c.lane === 'task').day).toBe(await svc.todayKey());
  });
});
