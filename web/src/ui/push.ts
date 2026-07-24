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
 * Ask permission, subscribe the browser, and register the subscription with the server.
 * Never throws and never hangs — every failure comes back as a plain-English message so the
 * button that called it can always show a toast instead of dying silently (BEA-1089).
 */
export async function enablePush(): Promise<{ ok: boolean; message?: string }> {
  try {
    if (!pushSupported()) return { ok: false, message: 'This browser cannot do notifications. On iPhone, add the app to your Home Screen first, then open it from there.' };
    if (Notification.permission === 'denied') return { ok: false, message: 'Notifications are blocked for this site in your browser settings. Allow them there, then try again.' };
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, message: 'Notifications were not allowed.' };
    // serviceWorker.ready can wait forever if the app is still installing — cap it so the tap can't hang.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    if (!reg) return { ok: false, message: 'The app is still setting itself up. Close and reopen it, then try again.' };
    const keyRes = await fetch('/api/push/public-key');
    const { key } = await keyRes.json().catch(() => ({} as { key?: string }));
    if (!key) return { ok: false, message: 'Notifications are not set up on the server yet.' };
    // reuse an existing subscription if this device already has one (avoids a duplicate-subscribe error).
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) }));
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d?.ok === false) return { ok: false, message: d?.message || 'Could not register this device.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'Could not turn on notifications. Try reopening the app.' };
  }
}

export async function disablePush(): Promise<{ ok: boolean }> {
  if (!pushSupported()) return { ok: true };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return { ok: true };
}

/** Is THIS device currently subscribed? */
export async function pushEnabledHere(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}
