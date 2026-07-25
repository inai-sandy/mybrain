import { describe, expect, it, vi, afterEach } from 'vitest';
import { enablePush, disablePush, pushEnabledHere } from './push';

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

/**
 * BEA-1093: the spinner ran forever because only serviceWorker.ready was capped — the permission
 * prompt, the browser's push service and both fetches could all stay pending. Every step now has
 * a cap AND names itself in the message, so a stall is diagnosable instead of a mystery spinner.
 */
describe('enablePush — every step is capped (BEA-1093)', () => {
  const NEVER = new Promise(() => {});
  /** A registration whose pushManager behaves as told; anything omitted resolves normally. */
  function readySW(pushManager: any) {
    setSW({ ready: Promise.resolve({ pushManager }) });
  }
  function keyServed() {
    g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ key: 'BBBB' }) }));
  }

  it('permission prompt never answered → names the step and tells them where to look', async () => {
    vi.useFakeTimers();
    stubSupported('default');
    g.Notification.requestPermission = vi.fn(() => NEVER);
    const p = enablePush();
    await vi.advanceTimersByTimeAsync(45_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/step: permission/i);
    expect(r.message).toMatch(/bell or lock icon/i);
  });

  it('server key request never answers → names the step, no hang', async () => {
    vi.useFakeTimers();
    stubSupported('granted');
    readySW({ getSubscription: async () => null });
    g.fetch = vi.fn(() => NEVER);
    const p = enablePush();
    await vi.advanceTimersByTimeAsync(15_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/step: server key/i);
  });

  it('checking for an existing subscription never answers → names the step, no hang', async () => {
    vi.useFakeTimers();
    stubSupported('granted');
    readySW({ getSubscription: () => NEVER });
    keyServed();
    const p = enablePush();
    await vi.advanceTimersByTimeAsync(10_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/step: existing subscription/i);
  });

  it('the browser push service never answers → blames VPN/firewall, names the step (the real bug)', async () => {
    vi.useFakeTimers();
    stubSupported('granted');
    readySW({ getSubscription: async () => null, subscribe: () => NEVER });
    keyServed();
    const p = enablePush();
    await vi.advanceTimersByTimeAsync(20_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/step: subscribe/i);
    expect(r.message).toMatch(/VPN, firewall or content blocker/i);
  });

  it('registering the device never answers → names the step, no hang', async () => {
    vi.useFakeTimers();
    stubSupported('granted');
    readySW({ getSubscription: async () => null, subscribe: async () => ({ toJSON: () => ({ endpoint: 'e' }) }) });
    let call = 0;
    g.fetch = vi.fn(() => {
      call += 1;
      return call === 1 ? Promise.resolve({ ok: true, json: async () => ({ key: 'BBBB' }) }) : NEVER;
    });
    const p = enablePush();
    await vi.advanceTimersByTimeAsync(15_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/step: register/i);
  });

  it('the happy path still works end to end', async () => {
    stubSupported('granted');
    readySW({ getSubscription: async () => null, subscribe: async () => ({ toJSON: () => ({ endpoint: 'e', keys: {} }) }) });
    g.fetch = vi.fn(async (url: string) =>
      String(url).includes('public-key')
        ? { ok: true, json: async () => ({ key: 'BBBB' }) }
        : { ok: true, json: async () => ({ ok: true }) },
    );
    const r = await enablePush();
    expect(r).toEqual({ ok: true });
  });
});

describe('the Settings toggle can never be frozen (BEA-1093)', () => {
  it('pushEnabledHere answers false instead of hanging on a stalled service worker', async () => {
    vi.useFakeTimers();
    stubSupported('granted');
    setSW({ ready: new Promise(() => {}) });
    const p = pushEnabledHere();
    await vi.advanceTimersByTimeAsync(8_100);
    expect(await p).toBe(false);
  });

  it('disablePush gives up instead of hanging on a stalled service worker', async () => {
    vi.useFakeTimers();
    stubSupported('granted');
    setSW({ ready: new Promise(() => {}) });
    const p = disablePush();
    await vi.advanceTimersByTimeAsync(8_100);
    expect(await p).toEqual({ ok: true });
  });
});

/** BEA-1111: Safari support — callback-style permission + honest diagnostics. */
describe('Safari hardening (BEA-1111)', () => {
  it('supports callback-style Notification.requestPermission (old Safari)', async () => {
    stubSupported('default');
    // callback style: returns undefined, calls the callback instead of returning a promise
    g.Notification.requestPermission = vi.fn((cb?: (v: string) => void) => { cb?.('default'); return undefined; });
    const r = await enablePush();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not allowed/i); // resolved via the callback, no hang
  });

  it('pushDiagnostics reports the true permission state', async () => {
    stubSupported('denied');
    const { pushDiagnostics } = await import('./push');
    const d = await pushDiagnostics();
    expect(d.permission).toBe('denied');
    expect(typeof d.browser).toBe('string');
    expect(d.subscribedHere).toBe(false);
  });
});
