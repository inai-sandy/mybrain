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
    // Sliced rather than measured. This used to pin a 400-character distance between the two lines,
    // which broke the moment BEA-1571 added the repeat-question guard inside the same branch — a
    // test that fails when a branch grows is measuring the wrong thing. What is asserted is
    // unchanged: inside `if (trial)`, it takes its OWN default and returns without asking him.
    const branch = s.slice(s.indexOf('if (trial) {', s.indexOf('async ask')), s.indexOf('const deadlineHours'));
    expect(branch).toContain('const taken = ifNoAnswer ?? (choices[0] ?? \'\')');
    expect(branch).toContain('return { answered: true, answer: taken, trial: true, asked: false }');
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

/**
 * A check that answers itself must not answer for ever (BEA-1571).
 *
 * The pre-flight check of his YouTube agent asked the SAME question 1,610 times in 150 seconds —
 * 3,227 steps, 764KB of step log — and every one was answered here in microseconds. Both halves
 * were individually right: a trial holds the sheet write, so there is genuinely no link to hand
 * back, and a trial never reaches his phone, so it answers itself at once. Together they spin,
 * because a worker quite reasonably retries when the answer does not solve its problem.
 */
describe('a check stops a worker that keeps asking the same thing', () => {
  const src = () => require('fs').readFileSync(__dirname + '/worker.controller.ts', 'utf8');

  it('counts the repeats per run and per question', () => {
    const s = src();
    expect(s).toMatch(/private readonly trialAsks = new Map<string, Map<string, number>>/);
    expect(s).toMatch(/const seen = \(asked\.get\(key\) \|\| 0\) \+ 1/);
  });

  it('gives up after a small number of tries, not a large one', () => {
    const s = src();
    const m = s.match(/const TRIAL_ASK_LIMIT = (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(5);
  });

  // The message must name the real cause. "Your worker is broken" would be wrong — it is asking a
  // perfectly sensible question that a CHECK, by design, can never answer.
  it('says why the question cannot be answered in a check', () => {
    const s = src();
    const stop = s.slice(s.indexOf('if (seen > TRIAL_ASK_LIMIT)'), s.indexOf('const taken = ifNoAnswer'));
    expect(stop).toMatch(/holds every write/i);
    expect(stop).toMatch(/real run/i);
  });

  // A REAL run still waits for him as long as it takes — BEA-1565 is not touched by this.
  it('caps only a check, never a real run', () => {
    const s = src();
    const guard = s.slice(s.indexOf('if (trial) {', s.indexOf('async ask')), s.indexOf('const deadlineHours'));
    expect(guard).toMatch(/TRIAL_ASK_LIMIT/);
    // The limit is inside the `if (trial)` branch and appears nowhere else.
    expect((s.match(/TRIAL_ASK_LIMIT/g) || []).length).toBe(2); // the constant, and this one use
  });

  it('forgets the tally when the run ends', () => {
    expect(src()).toMatch(/this\.trialAsks\.delete\(runId\)/);
  });
});
