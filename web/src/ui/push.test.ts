import { describe, expect, it, vi, afterEach } from 'vitest';
import { enablePush } from './push';

/**
 * BEA-1089: the "Get notified on your phone" banner died on tap because enablePush() could throw
 * or hang. These lock in that it now ALWAYS resolves to a friendly {ok,message} — never throws,
 * never hangs — so the button can always show a toast.
 */

const g = globalThis as any;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete g.Notification; delete g.PushManager; g.fetch = undefined; });

function setSW(value: any) {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value });
}
function stubSupported(perm: NotificationPermission) {
  g.Notification = { permission: perm, requestPermission: vi.fn(async () => perm) };
  g.PushManager = function () {};
  setSW({});
}

describe('enablePush — never a dead tap (BEA-1089)', () => {
  it('unsupported browser → friendly message, no throw', async () => {
    // no Notification/PushManager on the global → pushSupported() is false
    setSW(undefined);
    const r = await enablePush();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Home Screen|cannot do notifications/i);
  });

  it('permission already denied → tells them to unblock in settings', async () => {
    stubSupported('denied');
    const r = await enablePush();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/blocked/i);
  });

  it('permission not granted → clear message', async () => {
    stubSupported('default');
    g.Notification.requestPermission = vi.fn(async () => 'default');
    const r = await enablePush();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not allowed/i);
  });

  it('does not hang if the service worker never becomes ready', async () => {
    vi.useFakeTimers();
    stubSupported('granted');
    setSW({ ready: new Promise(() => {}) }); // never resolves
    const p = enablePush();
    await vi.advanceTimersByTimeAsync(8100); // trip the 8s cap
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/still setting|reopen/i);
  });

  it('server has no VAPID key → friendly message, no throw', async () => {
    stubSupported('granted');
    setSW({ ready: Promise.resolve({ pushManager: { getSubscription: async () => null, subscribe: async () => ({ toJSON: () => ({}) }) } }) });
    g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })); // no key field
    const r = await enablePush();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not set up on the server/i);
  });
});
