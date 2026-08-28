import { describe, it, expect } from 'vitest';

/**
 * The agents home follows the approved design (BEA-1533).
 *
 * `design/agents-redesign/concept-1-mission-control.html` is the design he approved: **what needs
 * you · what is running · what landed**, in that order, above the agents themselves.
 *
 * It was built, then taken apart. BEA-1181 removed "Running now" and "Landed today" on the reasoning
 * that History covers them, and pushed "Needs you" BELOW the agents grid. With ten agents that put
 * the most urgent thing on the page — a job stopped, waiting for an answer — off the bottom of the
 * screen. His words: *"Check our design files. You have given beautiful designs. None of it is
 * replicating now. You have done twice."*
 *
 * The data never went away: `/api/agent/home` has served `running` and `landed` throughout. Only the
 * drawing was missing. These tests hold the structure so it cannot quietly flatten again.
 */
describe('the agents home matches the approved design', () => {
  const src = () => require('fs').readFileSync(__dirname + '/Agents.tsx', 'utf8');

  it('has all three Mission Control strips', () => {
    const s = src();
    for (const id of ['mc-waiting', 'mc-running', 'mc-landed']) expect(s).toContain(`data-testid="${id}"`);
  });

  // Order is the design. "Waiting on you" first is the whole point — it is the only thing on this
  // page that is blocked on him.
  it('puts them in the designed order, above the agents grid', () => {
    const s = src();
    const w = s.indexOf('data-testid="mc-waiting"');
    const r = s.indexOf('data-testid="mc-running"');
    const l = s.indexOf('data-testid="mc-landed"');
    const grid = s.indexOf('\u{1F5C2} Your agents');   // the section comment, not the hint text
    expect(w).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(-1);
    expect(w).toBeLessThan(r);
    expect(r).toBeLessThan(l);
    expect(l).toBeLessThan(grid);
  });

  it('draws a live run with the steps it has taken', () => {
    const s = src();
    expect(s).toContain('function RunningCard');
    expect(s).toMatch(/r\.steps/);
    expect(s).toContain('animate-ping'); // the live dot from the design
  });

  it('draws what landed with a status pill', () => {
    const s = src();
    expect(s).toContain('function LandedRow');
    expect(s).toMatch(/l\.status/);
  });

  // The regression that prompted all of this: the waiting cards were rendered last.
  it('never renders the waiting cards after the agents grid again', () => {
    const s = src();
    const lastWaiting = s.lastIndexOf('<WaitingCard');
    const grid = s.indexOf('\u{1F5C2} Your agents');
    expect(grid).toBeGreaterThan(-1);
    expect(lastWaiting).toBeLessThan(grid);
  });

  // A job that ran four times overnight filled the strip with four identical lines and pushed the
  // rest off the screen. The design shows what DIFFERENT agents did.
  it('shows one landed row per agent, not every run', () => {
    const s = src();
    expect(s).toMatch(/const seen = new Set<string>\(\)/);
    expect(s).toMatch(/if \(seen\.has\(key\)\) continue/);
  });

  it('reads running and landed from the home payload the API already serves', () => {
    const s = src();
    expect(s).toMatch(/const running = home\?\.running/);
    expect(s).toMatch(/home\?\.landed/);   // read inside the per-agent dedupe
  });
});
