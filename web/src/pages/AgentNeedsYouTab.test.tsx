import { describe, it, expect } from 'vitest';
import { areaNeedsYou } from './Agents';

/**
 * The "Needs you" tab (BEA-1514) — the fourth tab he approved in the Agents redesign plan.
 *
 * The plan promised All · Tools · Research · Needs you, and he said yes to it in so many words. It
 * shipped with only the first three: "waiting" existed as a dropdown option and as a section BELOW
 * the grid, so a parked agent was still something you had to scroll to or already know about.
 *
 * These lock the rule the tab, its count and the dropdown all share. One predicate, because a count
 * that disagrees with the list it counts is this module's most-repeated bug.
 */
describe('areaNeedsYou', () => {
  const job = (status?: string) => ({ lastRun: status ? { status } : null });

  it('is true when a job is parked on a question', () => {
    expect(areaNeedsYou({ jobs: [job('done'), job('awaiting_input')] })).toBe(true);
  });

  it('is true when a job paused for him', () => {
    expect(areaNeedsYou({ jobs: [job('paused')] })).toBe(true);
  });

  it('is false when every job just ran', () => {
    expect(areaNeedsYou({ jobs: [job('done'), job('failed')] })).toBe(false);
  });

  it('is false for an agent that has never run', () => {
    expect(areaNeedsYou({ jobs: [job()] })).toBe(false);
  });

  it('does not crash on an agent with no jobs at all', () => {
    expect(areaNeedsYou({ jobs: [] })).toBe(false);
    expect(areaNeedsYou({})).toBe(false);
    expect(areaNeedsYou(null)).toBe(false);
  });

  // A running job is NOT waiting on him — he has nothing to do about it.
  it('is false while a job is still running', () => {
    expect(areaNeedsYou({ jobs: [job('running')] })).toBe(false);
  });
});

describe('the tab is wired to that one predicate', () => {
  const src = () => require('fs').readFileSync(__dirname + '/Agents.tsx', 'utf8');

  it('offers Needs you as a tab, not only as a dropdown option', () => {
    expect(src()).toMatch(/k:\s*'needs'\s*as const/);
    expect(src()).toContain('Needs you');
  });

  // The count, the filter and the dropdown must all call it — an inline copy of the condition in any
  // of the three is how the tab and its number would start disagreeing.
  it('counts, filters and the dropdown all call areaNeedsYou', () => {
    // `\b`, not `[\s(]` — the count passes it by reference (`scope.filter(areaNeedsYou)`).
    const calls = (src().match(/areaNeedsYou\b/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(4); // the definition + count + tab filter + dropdown
  });

  it('nothing re-implements the waiting condition inline any more', () => {
    const inline = (src().match(/status\s*===\s*'awaiting_input'/g) || []).length;
    expect(inline).toBe(1); // only inside areaNeedsYou itself
  });
});
