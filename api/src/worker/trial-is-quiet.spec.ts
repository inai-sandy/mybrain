import * as fs from 'fs';
import * as path from 'path';

/**
 * A check before going live must be silent, and must not lie to the worker (BEA-1554).
 *
 * Two bugs I shipped in BEA-1553, both visible in one run of his ESP32 agent:
 *
 *   Search Reddit — fetching page 1, 7 items so far
 *   Fetched Reddit until it ran out and found 6 matching posts
 *   Waiting for you: Reddit had only 6 ESP32 posts, not 100. Write all 6, or stop?
 *   WhatsApp sent (template) — asked you: ...
 *
 * That was `runKind: trial` — my pre-promotion smoke run, on a build he never asked for.
 *
 *  1. **It messaged him.** Trial mode holds writes and sends, but an ASK went out through a different
 *     door. A check that interrupts him is not a check.
 *  2. **It told the worker the source ran out.** The worker asked for `pages: 'all'`, my clamp handed
 *     it ONE page and said nothing, so "no more pages" read as "that was everything". Reddit really
 *     had 233 posts that week. A cap the caller cannot see is worse than no cap, because the wrong
 *     conclusion looks like a fact.
 */
const ctl = () => fs.readFileSync(path.join(__dirname, 'worker.controller.ts'), 'utf8');

describe('a trial never reaches his phone', () => {
  it('takes its own default instead of asking', () => {
    const s = ctl();
    expect(s).toMatch(/if \(trial\) \{[\s\S]{0,400}return \{ answered: true, answer: taken, trial: true, asked: false \}/);
  });

  // It must still learn what it exists to learn: needing to ask is not a failure of the check.
  it('records the question on the run so nothing is hidden', () => {
    expect(ctl()).toMatch(/Not asked — this is a check, not a real run/);
  });

  it('uses the answer the worker itself nominated for no reply', () => {
    expect(ctl()).toMatch(/const taken = ifNoAnswer \?\? \(choices\[0\] \?\? ''\)/);
  });

  // The ask must be decided from the TOKEN, like every other trial rule.
  it('reads trial from the token on the ask path', () => {
    expect(ctl()).toMatch(/const \{ runId, agentId, trial \} = who\(req\)/);
  });
});

describe('a capped fetch says it was capped', () => {
  it('tells the worker this was one page, not the whole source', () => {
    const s = ctl();
    expect(s).toMatch(/cappedForCheck: true/);
    expect(s).toMatch(/Do NOT treat this as the source running out/);
  });

  // The exact wrong conclusion it drew last time.
  it('warns that there is very likely more', () => {
    expect(ctl()).toMatch(/there is very likely more/);
  });

  it('still clamps, so the check stays cheap', () => {
    expect(ctl()).toMatch(/pages: trial \? 1 : clampPages/);
  });
});

/**
 * The gate must not fail a worker for the trial's own doing (BEA-1554).
 *
 * v8 passed its tests, fetched Reddit, produced rows — then reached `create_google_sheet1`, which the
 * trial correctly HELD. With no sheet id back, the worker correctly reported it had none, and my gate
 * read that as a defect and refused to promote. v7 stayed live for no good reason.
 *
 * Left alone, this would have blocked **every agent that creates anything** — nearly all of them.
 */
describe('the gate judges only what it can', () => {
  const svc = () => fs.readFileSync(path.join(__dirname, 'worker-build.service.ts'), 'utf8');

  it('passes the check when the run reached a held write', () => {
    const s = svc();
    expect(s).toMatch(/const heldAWrite = await this\.reachedAHeldWrite\(runId\)/);
    expect(s).toMatch(/const ok = out\?\.status !== 'failed' \|\| heldAWrite/);
  });

  // The marker is the step the controller already writes — not a new signal invented for this.
  it('spots the hold from the step the controller already writes', () => {
    expect(svc()).toMatch(/Held back —/);
  });

  // It must still catch a worker that cannot even reach a write.
  it('still fails when the run broke before any write', () => {
    const s = svc();
    expect(s).toMatch(/return ok \? \{ ok: true \} : \{ ok: false/);
  });

  it('says why this is not a loophole', () => {
    expect(svc()).toMatch(/at all means the worker started, fetched/);
  });
});
