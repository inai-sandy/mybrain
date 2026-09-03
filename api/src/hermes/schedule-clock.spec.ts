import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_TZ, badTimezoneSentence, guardedTick, isValidTz, resetScheduleClock, safeTz } from './schedule-clock';
import { plumbingClassOf } from '../agent/failure-words';
import { resetOpsAlerts, setOpsAlertTransport } from '../push/ops-alert';

/**
 * Protect the clock (BEA-1605) — the shared helper, and the lock that BOTH schedulers use it
 * rather than a second copy.
 */

function logStub() {
  const said = { error: [] as string[], warn: [] as string[] };
  return { said, log: { error: (m: string) => said.error.push(m), warn: (m: string) => said.warn.push(m), log: () => undefined, debug: () => undefined, verbose: () => undefined } as any };
}

afterEach(() => {
  resetScheduleClock();
  resetOpsAlerts();
  setOpsAlertTransport(null);
});

describe('safeTz — the zone the tick runs in', () => {
  it('a zone Intl knows is used as-is; nothing, blank or a non-string is the default', () => {
    const { said, log } = logStub();
    expect(safeTz('Europe/London', 'T', log)).toBe('Europe/London');
    expect(safeTz(undefined, 'T', log)).toBe(DEFAULT_TZ);
    expect(safeTz('', 'T', log)).toBe(DEFAULT_TZ);
    expect(safeTz(42, 'T', log)).toBe(DEFAULT_TZ);
    expect(said.warn).toHaveLength(0); // a missing setting is not a bad one
  });

  it('a zone Intl rejects falls back to Asia/Kolkata and warns ONCE per scheduler, naming the value', () => {
    expect(isValidTz('Asia/Kolkatta')).toBe(false);
    const { said, log } = logStub();
    expect(safeTz('Asia/Kolkatta', 'AgentScheduler', log)).toBe(DEFAULT_TZ);
    expect(safeTz('Asia/Kolkatta', 'AgentScheduler', log)).toBe(DEFAULT_TZ);
    expect(safeTz('Asia/Kolkatta', 'AgentScheduler', log)).toBe(DEFAULT_TZ);
    expect(said.warn).toHaveLength(1);
    expect(said.warn[0]).toContain('"Asia/Kolkatta"');
    expect(said.warn[0]).toContain(DEFAULT_TZ);
    safeTz('Asia/Kolkatta', 'FlowScheduler', log); // the other ticker says it once in its own log too
    expect(said.warn).toHaveLength(2);
    safeTz('Mars/Olympus', 'AgentScheduler', log); // a different bad value is its own warning
    expect(said.warn).toHaveLength(3);
  });

  it('phones home ONCE through the ops-alert seam, under a class the classifier chose (never a hand-named one)', async () => {
    const sent: string[] = [];
    setOpsAlertTransport({ sendOps: async (t: string) => { sent.push(t); return { sent: true }; } });
    const { log } = logStub();
    safeTz('Asia/Kolkatta', 'AgentScheduler', log);
    safeTz('Asia/Kolkatta', 'FlowScheduler', log); // both tickers read the same bad row — one alert for the app
    await new Promise((r) => setImmediate(r)); // the alert leg is fire-and-forget
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('plumbing: bad-timezone');
    expect(sent[0]).toContain('Asia/Kolkatta');
    // The sentence and the classifier's regex are locked together: re-word one and this says so.
    expect(plumbingClassOf(badTimezoneSentence('Asia/Kolkatta'))).toBe('bad-timezone');
  });
});

describe('guardedTick — a throw is logged, never swallowed, and never stops the next tick', () => {
  it('logs the first failure with its message; the same message again is not repeated (the 60 s flood guard)', async () => {
    const { said, log } = logStub();
    const boom = async () => { throw new Error('database is locked'); };
    await guardedTick('AgentScheduler', log, boom);
    await guardedTick('AgentScheduler', log, boom);
    await guardedTick('AgentScheduler', log, boom);
    expect(said.error).toHaveLength(1);
    expect(said.error[0]).toContain('AgentScheduler tick failed: database is locked');
    await guardedTick('AgentScheduler', log, async () => { throw new Error('something else'); });
    expect(said.error).toHaveLength(2); // a distinct message is said
    await guardedTick('AgentScheduler', log, () => { throw new Error('thrown before the promise'); }); // a sync throw too
    expect(said.error).toHaveLength(3);
  });

  it('a tick that completes forgets — the same failure after a recovery is said again', async () => {
    const { said, log } = logStub();
    const boom = async () => { throw new Error('database is locked'); };
    await guardedTick('FlowScheduler', log, boom);
    await guardedTick('FlowScheduler', log, async () => 1); // recovered
    await guardedTick('FlowScheduler', log, boom);
    expect(said.error).toHaveLength(2);
  });

  it('never throws out, whatever the tick did', async () => {
    const { log } = logStub();
    await expect(guardedTick('X', log, async () => { throw 'a bare string'; })).resolves.toBeUndefined();
    await expect(guardedTick('X', log, async () => { throw undefined; })).resolves.toBeUndefined();
  });
});

describe('both schedulers use the ONE helper (source lock — the import statement, not a comment)', () => {
  const IMPORT = /^import \{[^}]*\bguardedTick\b[^}]*\bsafeTz\b[^}]*\} from '(\.\.\/hermes|\.)\/schedule-clock';$/m;
  it.each([
    ['AgentScheduler', join(__dirname, 'agent-scheduler.service.ts')],
    ['FlowScheduler', join(__dirname, '..', 'flows', 'flow-scheduler.service.ts')],
  ])('%s imports guardedTick + safeTz from schedule-clock and has no swallowing catch or bare zone default of its own', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(IMPORT);
    expect(src).toMatch(/guardedTick\('(AgentScheduler|FlowScheduler)', this\.log, \(\) => this\.tick\(\)\)/); // the timer goes through it
    expect(src).toMatch(/safeTz\(\(r as any\)\?\.value, '(AgentScheduler|FlowScheduler)', this\.log\)/); // and the zone
    expect(src).not.toMatch(/\.catch\(\(\) => undefined\)/); // the old silent swallow is gone
    expect(src).not.toMatch(/\|\| 'Asia\/Kolkata'/); // the old bare default is gone — the helper owns it
    expect(src).not.toMatch(/new Intl\.DateTimeFormat\(undefined/); // no second validator
  });
});
