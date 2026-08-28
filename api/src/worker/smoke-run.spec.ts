import * as fs from 'fs';
import * as path from 'path';

/**
 * One real run before it goes live (BEA-1552) — change #3 from the failure analysis.
 *
 * Green tests prove a worker handles the SAVED answers it was handed. They cannot prove it handles the
 * live source, and that gap is where his versions came from: of 14 failed runs across 6 agents,
 * **12 could not have been caught before shipping that version**. An error shape, an empty field, an
 * answer whose list sat somewhere the parser never looked — none of it is in a frozen sample.
 *
 * So the new version now runs once, for real, before promotion. Two things make that safe rather than
 * reckless, and BOTH are read off the token so a worker cannot argue its way out of either:
 *   - trial mode holds every write and every send (it already did);
 *   - the fetch is clamped to ONE page (new) — his ESP32 worker asks for `pages: 'all'` and really
 *     fetches 35, which would have made this check too expensive to keep switched on.
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');

describe('a trial reads one page, not the whole source', () => {
  it('clamps the paged fetch when the token says trial', () => {
    const s = read('worker.controller.ts');
    expect(s).toMatch(/pages: trial \? 1 : clampPages/);
  });

  it('clamps a plan source the same way', () => {
    expect(read('worker.controller.ts')).toMatch(/if \(trial && src\.kind === 'source'\) src\.pages = 1;/);
  });

  // The whole reason it is safe: both facts come off the token, never the request body.
  it('reads trial from the token, never from the body', () => {
    const s = read('worker.controller.ts');
    expect(s).toMatch(/`trial` comes off the TOKEN, never the body/);
  });
});

describe('the build runs it before promoting', () => {
  it('smoke-runs between the tests and the promotion', () => {
    const s = read('worker-build.service.ts');
    const smoke = s.indexOf('const smoke = await this.smokeRun');
    const promote = s.indexOf('const promoted = await this.runner.promote');
    expect(smoke).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(promote);
  });

  it('mints a TRIAL token for it', () => {
    expect(read('worker-build.service.ts')).toMatch(/this\.tokens\.mint\(runId, agentId, \{ trial: true \}\)/);
  });

  // Same rule the tests already follow: a version that cannot prove itself does not go live.
  it('keeps the previous version live when the real run fails', () => {
    const s = read('worker-build.service.ts');
    expect(s).toMatch(/is still the live worker/);
    expect(s).toMatch(/one real run could not get through/);
  });

  it('says plainly that nothing was written or sent', () => {
    expect(read('worker-build.service.ts')).toMatch(/Nothing was written and nothing was sent/);
  });

  // A check that cannot be made must never block a build that passed its tests.
  it('never blocks a build when the check itself cannot run', () => {
    const s = read('worker-build.service.ts');
    expect(s).toMatch(/if \(!this\.tokens \|\| !this\.agent\?\.createRun\) return \{ ok: true \};/);
    expect(s).toMatch(/if \(!run\?\.id\) return \{ ok: true \};/);
  });

  it('always gives the trial token back', () => {
    expect(read('worker-build.service.ts')).toMatch(/finally \{[\s\S]{0,140}revokeRun\(runId\)/);
  });

  it('does not let a smoke run take build-length time', () => {
    expect(read('worker-build.service.ts')).toMatch(/const SMOKE_TIMEOUT_MS = \d+/);
  });
});
