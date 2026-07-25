import { describe, expect, it } from 'vitest';
import { toastMs } from './Toast';

/**
 * BEA-1093: errors now carry a real explanation (why notifications wouldn't turn on, which step
 * failed). At the old flat 3.5s a long one disappeared before it could be read. These lock in
 * that an error gets reading time and a success still gets out of the way.
 */
describe('toastMs — errors stay long enough to read', () => {
  it('a success is still a quick glance', () => {
    expect(toastMs('success', 'Saved')).toBe(3500);
    expect(toastMs('success', 'x'.repeat(300))).toBe(3500);
  });

  it('a short error still gets a comfortable minimum', () => {
    expect(toastMs('error', 'Failed')).toBe(6000);
  });

  it('the real push-failure message gets far more than the old 3.5s', () => {
    const real =
      'Your browser could not reach its notification service. A VPN, firewall or content blocker is the usual cause — turn it off and try again. On a Mac, also check System Settings → Notifications and allow your browser. (step: subscribe)';
    const ms = toastMs('error', real);
    expect(ms).toBeGreaterThan(10_000);
    expect(ms).toBeLessThanOrEqual(15_000);
  });

  it('never stays up forever, however long the message', () => {
    expect(toastMs('error', 'x'.repeat(5000))).toBe(15_000);
  });
});
