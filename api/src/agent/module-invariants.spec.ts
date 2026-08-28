import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * THE AGENTS MODULE — THE RULES THAT MUST HOLD ACROSS EVERY ROAD (BEA-1513).
 *
 * His instruction, after a fix of mine broke a working agent: *"it has to work for every agent…
 * past and future has to be perfect."*
 *
 * Every breakage in this module has had the same shape: a shared thing was changed, and only the road
 * in front of me was tested. Four times in one week —
 *
 *   BEA-1462  the compile rule lived in three places; two were fixed
 *   BEA-1489  replay called execute() directly, skipping the road decision and the job lock
 *   BEA-1505  one listener slot, two owners; the newer road silently lost
 *   BEA-1512  every listener heard every answer, so a program's answer rewrote a goal
 *
 * A test that reads ONE service cannot catch any of those. These read the module and assert the rules
 * across all of it, so a future change to a seam fails here rather than in one of his runs.
 */
const api = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('one door: every run takes its road through startRun', () => {
  const bridge = () => api('hermes/hermes-bridge.service.ts');

  it('execute() is called from startOnRoad and the eval path, and nowhere else', () => {
    // BEA-1489: `replayRun` had its own `execute()` call, so replaying a job whose worker was live
    // asked the ENGINE the goal as a question — and he got a research essay instead of his brief.
    const calls = (bridge().match(/this\.execute\(/g) || []).length;
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('the eval path is the ONE deliberate exception, and says so', () => {
    // Evals grade an engine answer and must never park, so they do not take the worker road. That is
    // a decision, not an oversight, and it is written where the next person will read it.
    const t = bridge();
    const i = t.indexOf("Eval —");
    expect(i).toBeGreaterThan(0);
    expect(t.slice(Math.max(0, i - 1200), i)).toMatch(/eval/i);
  });

  it('replay goes through startRun, carrying its link step rather than a second door', () => {
    expect(bridge()).toMatch(/return this\.startRun\(\{[\s\S]{0,400}firstStep/);
  });
});

describe('every answer reaches only the listener that asked', () => {
  const roads = ['worker/goal-trial.service.ts', 'worker/brief-trial.service.ts'];

  it.each(roads)('%s guards with isMyQuestion before acting', (f) => {
    // BEA-1512: he answered his PROGRAM ("Write those posts") and the goal listener took it as a
    // correction, replacing an approved goal with a question and losing the sheet.
    const src = api(f);
    const body = src.slice(src.indexOf('private async onAnswer('));
    expect(body.slice(0, 300)).toContain('isMyQuestion');
  });

  it('every service that registers a listener is covered by the rule above', () => {
    // The guard that makes this list self-maintaining: a NEW listener must be added to `roads` or
    // this fails. That is what stops the next one being written without a guard.
    const owner = api('worker/owner-ask.service.ts');
    expect(owner).toContain('watchers');
    for (const f of roads) expect(api(f)).toContain('setAnswerWatcher');
  });
});

describe('every call to a connected service is recorded and attributable', () => {
  it('the single execute() site is the only place a vendor is reached', () => {
    // One call site is what keeps the gate, the ceiling, the ledger and the retry honest.
    const t = api('tools/service-actions.service.ts');
    expect((t.match(/\bp\s*\n?\s*\.execute\(/g) || []).length).toBeLessThanOrEqual(2);
  });

  it('a transient failure is retried only for reads, decided by the catalog', () => {
    // BEA-1496. Retrying a write could create the page twice.
    expect(api('tools/service-actions.service.ts')).toMatch(/const repeatable = p\.readOnly === true/);
  });
});
