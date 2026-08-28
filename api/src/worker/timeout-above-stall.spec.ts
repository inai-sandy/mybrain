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
