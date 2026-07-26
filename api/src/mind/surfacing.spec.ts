import { isSurfaced, surfacedWhere, MIN_DAYS_TO_SURFACE } from './surfacing';

/**
 * BEA-1142. Most findings carried evidence from ONE day — the engine saw a single Tuesday and
 * stated a trait. That is why the owner refuted 16 of the 23 he judged. Three separate days is
 * the bar; his own confirm or pin overrides it.
 */
describe('nothing surfaces until it held up on 3 separate days (BEA-1142)', () => {
  it('holds back a finding seen on one or two days', () => {
    expect(isSurfaced({ daysSeen: 1 })).toBe(false);
    expect(isSurfaced({ daysSeen: 2 })).toBe(false);
  });

  it('surfaces one seen on three days', () => {
    expect(isSurfaced({ daysSeen: 3 })).toBe(true);
    expect(isSurfaced({ daysSeen: 9 })).toBe(true);
  });

  it('lets the owner overrule the counter', () => {
    expect(isSurfaced({ daysSeen: 1, validated: 'confirmed' })).toBe(true);
    expect(isSurfaced({ daysSeen: 1, pinned: true })).toBe(true);
  });

  it('never surfaces something retired or refuted, however many days', () => {
    expect(isSurfaced({ daysSeen: 20, status: 'retired' })).toBe(false);
    expect(isSurfaced({ daysSeen: 20, validated: 'refuted' })).toBe(false);
    expect(isSurfaced({ daysSeen: 20, validated: 'refuted', pinned: true })).toBe(false);
  });

  it('treats a missing count as one day, not as surfaced', () => {
    expect(isSurfaced({})).toBe(false);
  });

  it('the database rule matches the in-memory rule', () => {
    expect(MIN_DAYS_TO_SURFACE).toBe(3);
    expect(surfacedWhere.OR).toContainEqual({ daysSeen: { gte: 3 } });
    expect(surfacedWhere.OR).toContainEqual({ validated: 'confirmed' });
    expect(surfacedWhere.OR).toContainEqual({ pinned: true });
  });
});
