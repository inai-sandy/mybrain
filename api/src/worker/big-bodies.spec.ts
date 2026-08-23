import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BODY_LIMIT } from '../common/body-limit';

/**
 * A day of real email is bigger than 100 KB (BEA-1455).
 *
 * Express defaults to a 100 KB request body, and nothing had ever noticed — everything that crossed
 * that line was small: Instagram posts, a table of rows, a plan. The owner's first agent that
 * summarises EMAIL died on it. The run fetched nine real messages cleanly, read them with the tool's
 * own recipe, and then failed with **"request entity too large"** the moment it sent them back for
 * the thinking step. Nothing written, nothing sent, and a message that named a size limit rather
 * than anything he could act on.
 *
 * The worker road is the reason this matters: the app fetches, hands the rows to the worker, and the
 * worker hands them back to be thought about. That round trip carries whole email bodies.
 */
describe('the app accepts a body big enough for real work', () => {
  it('is far above a day of email, and still bounded', () => {
    const mb = Number(String(BODY_LIMIT).replace(/[^0-9.]/g, ''));
    expect(String(BODY_LIMIT)).toMatch(/mb$/i);
    // Nine real emails with bodies ran past 100 KB. A busy day of 200 is comfortably inside this.
    expect(mb).toBeGreaterThanOrEqual(10);
    // And it is a limit, not an invitation: a runaway worker is still stopped.
    expect(mb).toBeLessThanOrEqual(50);
  });

  it('a test may read the limit WITHOUT starting the server', () => {
    // The first version of this imported it from `main.ts`, which runs `bootstrap()` on import and
    // binds port 8080 — so two suites fought over the port and the whole run failed at random.
    const src = readFileSync(join(__dirname, 'big-bodies.spec.ts'), 'utf8');
    expect(src).not.toMatch(/^import .* from '\.\.\/main';$/m);
    expect(src).toContain("from '../common/body-limit'");
  });

  it('the limit is written in ONE place', () => {
    // Two copies drift, and the one nobody remembers is the one that bites. Same habit that put a
    // stale rule in two functions an hour earlier (BEA-1454).
    const src = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    const hardcoded = src.match(/limit:\s*['"][0-9]+[a-z]{2}['"]/gi) || [];
    expect(hardcoded).toEqual([]);
    expect(src).toContain('json({ limit: BODY_LIMIT })');
    expect(src).toContain('urlencoded({ limit: BODY_LIMIT');
  });
});
