import { EmoStoryService } from './emo-story.service';

function make(opts: { cards: any[]; existingStory?: string | null; closedDays?: string[]; today?: string }) {
  const updates: any[] = [];
  const submissions: Array<{ text: string; day?: string; noWrap?: boolean }> = [];
  const cards: any = {
    todayKey: () => opts.today ?? '2026-07-04',
    list: jest.fn(async () => ({ cards: opts.cards, total: opts.cards.length })),
    update: jest.fn(async (id: string, p: any) => { updates.push({ id, ...p }); return {}; }),
  };
  const prisma: any = { story: { findFirst: jest.fn(async () => (opts.existingStory != null ? { rawText: opts.existingStory } : null)) } };
  const daily: any = {
    submitStory: jest.fn(async (t: string, _s: string, _m: any, day?: string, noWrap?: boolean) => { submissions.push({ text: t, day, noWrap }); return {}; }),
    isClosed: jest.fn(async (d: string) => (opts.closedDays || []).includes(d)),
  };
  return { svc: new EmoStoryService(prisma, daily, cards), daily, updates, submissions, get submitted() { return submissions[submissions.length - 1]?.text ?? null; } };
}

describe('EmoStoryService (BEA-865)', () => {
  it('appends unmerged captures to the existing Day Story (never overwrites)', async () => {
    const h = make({ cards: [
      { id: 'c1', lane: 'story', day: '2026-07-04', rawTranscript: 'met the vendor, felt good', links: [] },
      { id: 'c2', lane: 'story', day: '2026-07-04', rawTranscript: 'stressed about the launch', links: [] },
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
      { id: 'c1', lane: 'story', day: '2026-07-04', rawTranscript: 'already in', links: [{ kind: 'story', id: '2026-07-04' }] },
    ] });
    const res = await h.svc.mergeToday();
    expect(res.merged).toBe(0);
    expect(h.daily.submitStory).not.toHaveBeenCalled();
  });

  it('creates a story from captures when none exists yet', async () => {
    const h = make({ cards: [{ id: 'c1', lane: 'story', day: '2026-07-04', rawTranscript: 'a quiet day', links: [] }], existingStory: null });
    await h.svc.mergeToday();
    expect(h.submitted).toBe('- a quiet day');
  });

  // BEA-981 — a story told the next morning carries the still-open previous day and merges THERE.
  it('merges a morning story into the still-open previous day — and never closes it', async () => {
    const h = make({ cards: [{ id: 'c1', lane: 'story', day: '2026-07-03', rawTranscript: 'told the next morning', links: [] }], today: '2026-07-04' });
    const res = await h.svc.mergeToday();
    expect(res.merged).toBe(1);
    expect(res.storyDay).toBe('2026-07-03');
    expect(h.submissions[0].day).toBe('2026-07-03');
    expect(h.submissions[0].noWrap).toBe(true); // Emo never closes the day
    expect(h.updates[0].links).toEqual([{ kind: 'story', id: '2026-07-03', label: 'In Day Story' }]);
  });

  it('never touches a day that is already closed — those captures stay as cards', async () => {
    const h = make({ cards: [{ id: 'c1', lane: 'story', day: '2026-07-03', rawTranscript: 'too late', links: [] }], today: '2026-07-04', closedDays: ['2026-07-03'] });
    const res = await h.svc.mergeToday();
    expect(res.merged).toBe(0);
    expect(h.daily.submitStory).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0); // no story link — still visible as unmerged
  });

  it("merges each day's captures into its own story", async () => {
    const h = make({ cards: [
      { id: 'c1', lane: 'story', day: '2026-07-04', rawTranscript: 'today moment', links: [] },
      { id: 'c2', lane: 'story', day: '2026-07-03', rawTranscript: 'yesterday moment', links: [] },
    ], today: '2026-07-04' });
    const res = await h.svc.mergeToday();
    expect(res.merged).toBe(2);
    expect(res.days).toEqual(['2026-07-03', '2026-07-04']); // oldest first, each into its own day
    expect(h.submissions.map((s) => s.day)).toEqual(['2026-07-03', '2026-07-04']);
  });
});
