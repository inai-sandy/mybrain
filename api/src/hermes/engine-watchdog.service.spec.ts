import { EngineWatchdog } from './engine-watchdog.service';

describe('EngineWatchdog.shouldRestart (BEA-632)', () => {
  const TEN_MIN = 10 * 60_000;

  it('does not restart before enough consecutive failures', () => {
    expect(EngineWatchdog.shouldRestart(1, 1_000_000, 0)).toBe(false);
    expect(EngineWatchdog.shouldRestart(2, 1_000_000, 0)).toBe(false);
  });

  it('restarts after 3 consecutive failures when none happened recently', () => {
    expect(EngineWatchdog.shouldRestart(3, 1_000_000, 0)).toBe(true);
  });

  it('rate-limits: will not restart again within 10 minutes of the last one', () => {
    const now = 100 * 60_000;
    expect(EngineWatchdog.shouldRestart(5, now, now - (TEN_MIN - 1))).toBe(false); // 9m59s ago → blocked
    expect(EngineWatchdog.shouldRestart(5, now, now - TEN_MIN)).toBe(true); // exactly 10m ago → allowed
  });
});
