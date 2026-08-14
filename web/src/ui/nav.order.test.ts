import { describe, it, expect } from 'vitest';
import { NAV_GROUPS } from './nav';

/**
 * BEA-1322 — News must sit ABOVE the sidebar's scroll fold. Parked at the bottom, the
 * entry was clipped by the nav's overflow and clicks landed on dead space, which read
 * as "the page is broken". Keeping it directly under Daily keeps it always visible.
 */
describe('sidebar order (BEA-1322)', () => {
  it('News is the group right after Daily', () => {
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels.indexOf('News')).toBe(labels.indexOf('Daily') + 1);
  });
});
