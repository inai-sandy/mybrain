import { EmoStoryService } from './emo-story.service';

function make(opts: { cards: any[]; existingStory?: string | null }) {
  const updates: any[] = [];
  let submitted: string | null = null;
  const cards: any = {
    todayKey: () => '2026-07-04',
    list: jest.fn(async () => ({ cards: opts.cards, total: opts.cards.length })),
    update: jest.fn(async (id: string, p: any) => { updates.push({ id, ...p }); return {}; }),
  };
  const prisma: any = { story: { findFirst: jest.fn(async () => (opts.existingStory != null ? { rawText: opts.existingStory } : null)) } };
  const daily: any = { submitStory: jest.fn(async (t: string) => { submitted = t; return {}; }) };
  return { svc: new EmoStoryService(prisma, daily, cards), daily, updates, get submitted() { return submitted; } };
}

describe('EmoStoryService (BEA-865)', () => {
  it('appends unmerged captures to the existing Day Story (never overwrites)', async () => {
    const h = make({ cards: [
      { id: 'c1', lane: 'story', rawTranscript: 'met the vendor, felt good', links: [] },
      { id: 'c2', lane: 'story', rawTranscript: 'stressed about the launch', links: [] },
    ], existingStory: 'Woke up early and went for a walk.' });
    const res = await h.svc.mergeToday();
    expect(res.merged).toBe(2);
    expect(h.submitted).toContain('Woke up early'); // existing kept
    expect(h.submitted).toContain('- met the vendor, felt good'); // captures appended
    expect(h.submitted).toContain('- stressed about the launch');
    // each merged card gets a story link so it won't double-merge
    expect(h.updates[0].links).toEqual([{ kind: 'story', id: '2026-07-04', label: 'In Day Story' }]);
  });

  it('skips captures already merged (idempotent)', async () => {
    const h = make({ cards: [
      { id: 'c1', lane: 'story', rawTranscript: 'already in', links: [{ kind: 'story', id: '2026-07-04' }] },
    ] });
    const res = await h.svc.mergeToday();
    expect(res.merged).toBe(0);
    expect(h.daily.submitStory).not.toHaveBeenCalled();
  });

  it('creates a story from captures when none exists yet', async () => {
    const h = make({ cards: [{ id: 'c1', lane: 'story', rawTranscript: 'a quiet day', links: [] }], existingStory: null });
    await h.svc.mergeToday();
    expect(h.submitted).toBe('- a quiet day');
  });
});
