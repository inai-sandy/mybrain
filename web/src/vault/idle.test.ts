import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchIdle } from './idle';

function fakeTarget() {
  const handlers: Record<string, ((e?: any) => void)[]> = {};
  return {
    addEventListener: (e: string, h: any) => {
      (handlers[e] ||= []).push(h);
    },
    removeEventListener: (e: string, h: any) => {
      handlers[e] = (handlers[e] || []).filter((x) => x !== h);
    },
    fire: (e: string) => (handlers[e] || []).forEach((h) => h()),
    count: (e: string) => (handlers[e] || []).length,
  };
}

describe('watchIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onIdle after the timeout with no activity', () => {
    const t = fakeTarget();
    const onIdle = vi.fn();
    watchIdle(onIdle, 1000, t as any);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('activity resets the countdown', () => {
    const t = fakeTarget();
    const onIdle = vi.fn();
    watchIdle(onIdle, 1000, t as any);
    vi.advanceTimersByTime(900);
    t.fire('mousemove'); // reset
    vi.advanceTimersByTime(900);
    expect(onIdle).not.toHaveBeenCalled(); // 900 since reset, not yet idle
    vi.advanceTimersByTime(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('cleanup removes listeners and cancels the timer', () => {
    const t = fakeTarget();
    const onIdle = vi.fn();
    const stop = watchIdle(onIdle, 1000, t as any);
    expect(t.count('keydown')).toBe(1);
    stop();
    expect(t.count('keydown')).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
