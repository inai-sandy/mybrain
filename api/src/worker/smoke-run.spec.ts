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

/**
 * The check runs the version it just built, and a held write is a FACT (BEA-1570).
 *
 * His new agent, 2026-08-29: *"the new agent Failed … No worker is installed for this job yet."* It
 * had been built correctly and passed its own tests 8 of 8. Three separate chicken-and-eggs then
 * stopped it going live, each hiding the next, and all three are the same mistake — the pre-flight
 * check asking about the LIVE worker when it means the one it has just built.
 */
describe('the pre-flight check names the version it built', () => {
  it('asks the runner for that exact version, never whatever is live', () => {
    const s = read('worker-build.service.ts');
    const call = s.slice(s.indexOf('const out: any = await this.runner'), s.indexOf('const heldAWrite'));
    expect(call).toMatch(/version/);
  });

  // Without a version the runner behaves exactly as it always has, so nothing already live changes.
  it('the runner still falls back to the live worker when no version is named', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services', 'host', 'worker-runner.server.js'), 'utf8');
    expect(s).toMatch(/wantVersion === null \? currentDirOf\(jobDir\) : versionDirOf\(jobDir, wantVersion\)/);
  });

  // A version off a request may never escape the job's own folder — digits, then a realpath check.
  it('proves a named version sits inside the job folder', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services', 'host', 'worker-runner.server.js'), 'utf8');
    const fn = s.slice(s.indexOf('function versionDirOf('), s.indexOf('function readMeta('));
    expect(fn).toMatch(/\^\\d\{1,9\}\$/);
    expect(fn).toMatch(/realpathSync/);
    expect(fn).toMatch(/startsWith\(base \+ path\.sep\)/);
  });

  // The second chicken-and-egg: meta.json was written only at promotion, so the check could not read
  // the kit version of the worker it was about to run and refused to start it.
  it('a version carries its own meta.json from the moment it is built', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services', 'host', 'worker-runner.server.js'), 'utf8');
    const build = s.slice(s.indexOf('const dir = path.join(jobDir, `v${version}`);'), s.indexOf('/** The build turn'));
    expect(build).toMatch(/meta\.json/);
    expect(build).toMatch(/promoted: false/);
  });
});

describe('a held write is a fact, not a form of words', () => {
  /**
   * The third: `reachedAHeldWrite` matched the sentence `Held back — …`, which only the direct-write
   * road writes. His worker held its sheet through the `/output` road, whose step reads "Trial — 20
   * rows ready for your sheet. Nothing was written." — a held write by any honest reading, and
   * invisible to that regex. So a working worker was called broken.
   */
  it('every road that holds something stamps the same fact', () => {
    const s = read('worker.controller.ts');
    // The direct write, the output route, and the notify route.
    const held = s.match(/kind: 'held'/g) || [];
    expect(held.length).toBeGreaterThanOrEqual(3);
  });

  it('the check reads that fact rather than matching prose', () => {
    const fn = read('worker-build.service.ts');
    const body = fn.slice(fn.indexOf('private async reachedAHeldWrite'), fn.indexOf('/** Is a build for this job in flight'));
    expect(body).toMatch(/kind === 'held'/);
  });

  // The old sentence still reads correctly, so runs recorded before the stamp are not re-judged.
  it('still recognises a run recorded before the stamp existed', () => {
    const fn = read('worker-build.service.ts');
    const body = fn.slice(fn.indexOf('private async reachedAHeldWrite'), fn.indexOf('/** Is a build for this job in flight'));
    expect(body).toMatch(/Held back —/);
  });
});
