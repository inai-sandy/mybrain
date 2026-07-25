/** Web Push client helper (BEA-1088) — subscribe this device to phone notifications. */

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported';
}

function b64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * Every step below waits on something we do not control — the browser's permission prompt, its
 * push service, our server. Any of them can stay pending forever, and a pending step means the
 * button that called us spins with no explanation (BEA-1093). So NOTHING here is awaited without
 * a cap: each step either finishes or comes back as TIMED_OUT with its own plain-English reason.
 */
const TIMED_OUT = Symbol('timed-out');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Caps, in ms. The permission one is generous — a real prompt is waiting on a human. */
const T = {
  permission: 45_000,
  swReady: 8_000,
  serverKey: 15_000,
  getSub: 10_000,
  subscribe: 20_000,
  register: 15_000,
  /** Backstop so this function is bounded even if a step is added later without its own cap. */
  overall: 120_000,
};

type Result = { ok: boolean; message?: string };

/**
 * Ask permission, subscribe the browser, and register the subscription with the server.
 * Never throws and never hangs — every failure comes back as a plain-English message naming the
 * step that failed, so the button that called it can always show a toast instead of dying
 * silently, and a stall is diagnosable rather than a mystery spinner (BEA-1089, BEA-1093).
 */
export async function enablePush(): Promise<Result> {
  const run = async (): Promise<Result> => {
    if (!pushSupported()) return { ok: false, message: 'This browser cannot do notifications. On iPhone, add the app to your Home Screen first, then open it from there.' };
    if (Notification.permission === 'denied') {
      return { ok: false, message: isSafari()
        ? 'Notifications are blocked for this site. In Safari: Settings → Websites → Notifications → find mybrain.1site.ai → Allow, then reload and try again.'
        : 'Notifications are blocked for this site in your browser settings. Allow them there, then try again.' };
    }

    // Older Safari only supports the callback style of requestPermission — accept both (BEA-1111).
    const askPermission = () => new Promise<NotificationPermission>((resolve) => {
      try {
        const maybe = Notification.requestPermission((v) => resolve(v));
        if (maybe && typeof (maybe as any).then === 'function') (maybe as Promise<NotificationPermission>).then(resolve);
      } catch { resolve(Notification.permission); }
    });
    const perm = await withTimeout(askPermission(), T.permission);
    if (perm === TIMED_OUT) return { ok: false, message: 'Your browser never answered the permission request. Look for a bell or lock icon next to the address bar and choose Allow, then try again. (step: permission)' };
    if (perm !== 'granted') return { ok: false, message: 'Notifications were not allowed.' };

    // serviceWorker.ready can wait forever if the app is still installing — cap it so the tap can't hang.
    const reg = await withTimeout(navigator.serviceWorker.ready, T.swReady);
    if (reg === TIMED_OUT || !reg) return { ok: false, message: 'The app is still setting itself up. Close and reopen it, then try again. (step: service worker)' };

    const keyRes = await withTimeout(fetch('/api/push/public-key').then((r) => r.json()).catch(() => ({} as { key?: string })), T.serverKey);
    if (keyRes === TIMED_OUT) return { ok: false, message: 'Could not reach My Brain to set this up. Check your connection and try again. (step: server key)' };
    const key = (keyRes as { key?: string })?.key;
    if (!key) return { ok: false, message: 'Notifications are not set up on the server yet.' };

    // Reuse an existing subscription if this device already has one (avoids a duplicate-subscribe error).
    const existing = await withTimeout(reg.pushManager.getSubscription(), T.getSub);
    if (existing === TIMED_OUT) return { ok: false, message: 'Your browser stopped responding about notifications. Close and reopen it, then try again. (step: existing subscription)' };

    let sub = existing;
    if (!sub) {
      // The one step that leaves the machine: it asks Google's (Chrome) or Apple's (Safari) push
      // service for an endpoint. Unreachable service = pending forever, which is what BEA-1093 hit.
      const fresh = await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) }), T.subscribe);
      if (fresh === TIMED_OUT) return { ok: false, message: 'Your browser could not reach its notification service. A VPN, firewall or content blocker is the usual cause — turn it off and try again. On a Mac, also check System Settings → Notifications and allow your browser. (step: subscribe)' };
      sub = fresh;
    }
    if (!sub) return { ok: false, message: 'Your browser did not give this device a notification address. Close and reopen it, then try again. (step: subscribe)' };

    const posted = await withTimeout(
      fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) })
        .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({} as any)) })),
      T.register,
    );
    if (posted === TIMED_OUT) return { ok: false, message: 'Could not save this device. Check your connection and try again. (step: register)' };
    if (!posted.ok || posted.body?.ok === false) return { ok: false, message: posted.body?.message || 'Could not register this device.' };
    return { ok: true };
  };

  try {
    const r = await withTimeout(run(), T.overall);
    if (r === TIMED_OUT) return { ok: false, message: 'Turning on notifications took too long. Close and reopen the app, then try again.' };
    return r;
  } catch (e: any) {
    // Surface the REAL reason — Safari's subscribe errors were vanishing into vagueness (BEA-1111).
    const why = [e?.name, e?.message].filter(Boolean).join(': ') || 'unknown error';
    return { ok: false, message: `Could not turn on notifications (${why}).${isSafari() ? ' In Safari, also check Settings → Websites → Notifications.' : ''}` };
  }
}

/** Safari (not Chrome/Edge/Firefox pretending) — drives the Safari-specific guidance (BEA-1111). */
export function isSafari(): boolean {
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/chrome|chromium|crios|android|edg|fxios/i.test(ua);
}

/** What THIS browser truly reports — the Settings diagnostics line (BEA-1111). */
export async function pushDiagnostics(): Promise<{ browser: string; permission: string; subscribedHere: boolean }> {
  const ua = navigator.userAgent;
  const browser = isSafari() ? 'Safari' : /edg/i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : 'this browser';
  const permission = pushSupported() ? Notification.permission : 'unsupported';
  const subscribedHere = await pushEnabledHere().catch(() => false);
  return { browser, permission, subscribedHere };
}

export async function disablePush(): Promise<{ ok: boolean }> {
  if (!pushSupported()) return { ok: true };
  // Capped like enablePush — a stalled service worker must not freeze the Settings toggle (BEA-1093).
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, T.swReady);
    if (reg === TIMED_OUT || !reg) return { ok: true };
    const sub = await withTimeout(reg.pushManager.getSubscription(), T.getSub);
    if (sub === TIMED_OUT || !sub) return { ok: true };
    await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  } catch {
    /* turning it off must never fail loudly — the device just stays subscribed server-side */
  }
  return { ok: true };
}

/**
 * Is THIS device currently subscribed? Answers false rather than hanging — Settings keeps its
 * toggle disabled while this is unresolved, so a stalled check used to kill the button (BEA-1093).
 */
export async function pushEnabledHere(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, T.swReady);
    if (reg === TIMED_OUT || !reg) return false;
    const sub = await withTimeout(reg.pushManager.getSubscription(), T.getSub);
    return sub !== TIMED_OUT && !!sub;
  } catch {
    return false;
  }
}
