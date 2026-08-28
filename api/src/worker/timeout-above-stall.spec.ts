import * as fs from 'fs';
import * as path from 'path';
import { STALL_MINUTES } from './worker-sweeper.service';

/**
 * The wall clock is the last resort, not the first (BEA-1556).
 *
 * His run: *"The worker took too long and was stopped after 300s."* It had made **39 calls** and was
 * still fetching.
 *
 * The 5-minute budget was set when a worker fetched at most 11 pages. BEA-1548 then taught workers to
 * ask for `pages: 'all'` — because stopping at a ceiling is exactly what made his agent ask questions
 * it could have answered itself. His Reddit job really needs 35 pages and about 250 seconds. I changed
 * the workload and left the budget alone, and the next real run died on it.
 *
 * The fix is not "make it bigger". It is that a wall clock **cannot tell a stuck worker from a busy
 * one**, so it must sit above the thing that can: the stall watchdog, which measures PROGRESS.
 */
const runner = () => fs.readFileSync(path.join(__dirname, '../../../services/host/worker-runner.server.js'), 'utf8');

const numAfter = (src: string, name: string): number => {
  const line = src.split('\n').find((l) => l.includes(`const ${name} = `)) || '';
  const m = line.match(/\|\|\s*([\d_]+)\s*\)/);
  return m ? Number(m[1].replace(/_/g, '')) : NaN;
};

describe('the timeouts agree with each other', () => {
  const src = runner();
  const wall = numAfter(src, 'DEFAULT_TIMEOUT');
  const ceiling = numAfter(src, 'MAX_TIMEOUT');

  it('gives a paging job room to finish', () => {
    // 35 pages at ~7s each is ~250s; the old 300s left almost none.
    expect(wall).toBeGreaterThan(600_000);
  });

  // The important relationship: for a wedged worker the watchdog must win, because its message is
  // useful ("nothing was written for 20 minutes") and a wall clock's never is.
  it('sits ABOVE the stall watchdog, so the watchdog fires first', () => {
    expect(wall).toBeGreaterThan(STALL_MINUTES * 60_000);
  });

  it('stays under the hard ceiling', () => {
    expect(wall).toBeLessThanOrEqual(ceiling);
  });

  it('says why, where the number is', () => {
    expect(src).toMatch(/wall clock is the LAST resort/i);
    expect(src).toMatch(/measures PROGRESS, not elapsed time/);
  });
});

import { NO_PRIVATE_CLOCK_RULE } from '../agent/prompt-rules';

/**
 * A worker must not invent its own clock (BEA-1561).
 *
 * With the runner's ceiling raised to 25 minutes, the very next run still died — at 240 seconds, on a
 * stopwatch the worker had written into ITSELF:
 *
 *     const SOURCE_TIMEOUT_MS = 240_000;
 *     "Reddit search timed out after 240 seconds; nothing was written."
 *
 * It was 30 pages in with 204 items collected and still making progress. Codex had budgeted just under
 * the runner's OLD 5-minute limit; when that limit moved, the worker's private copy could not.
 *
 * A worker that abandons a fetch mid-progress throws away every page already paid for and produces
 * nothing — the exact outcome the "ask for all the pages" rule exists to prevent.
 */
describe('workers do not carry their own stopwatch', () => {
  it('forbids a self-imposed wall clock, by name', () => {
    expect(NO_PRIVATE_CLOCK_RULE).toMatch(/do NOT give yourself a wall clock/i);
    expect(NO_PRIVATE_CLOCK_RULE).toMatch(/SOURCE_TIMEOUT_MS/);
  });

  // The reason, so the rule survives being rewritten: a slow fetch is not a stuck one.
  it('says why a long fetch is not a hung one', () => {
    expect(NO_PRIVATE_CLOCK_RULE).toMatch(/A long paged fetch is not a hung one/i);
    expect(NO_PRIVATE_CLOCK_RULE).toMatch(/every page already paid for/i);
  });

  // It must not become "never time anything out" — a single hanging call is still fair game.
  it('still allows timing out one hanging call', () => {
    expect(NO_PRIVATE_CLOCK_RULE).toMatch(/never the job as a whole/i);
  });

  it('reaches both briefs, written once', () => {
    for (const f of ['goal-build.ts', 'build-brief.ts']) {
      const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
      expect(s).toContain('NO_PRIVATE_CLOCK_RULE');
      expect(s).not.toContain('do NOT give yourself a wall clock');
    }
  });
});
