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

/** Ask permission, subscribe the browser, and register the subscription with the server. */
export async function enablePush(): Promise<{ ok: boolean; message?: string }> {
  if (!pushSupported()) return { ok: false, message: 'This browser cannot do notifications. On iPhone, install the app to your Home Screen first.' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, message: 'Notifications were not allowed.' };
  const reg = await navigator.serviceWorker.ready;
  const { key } = await fetch('/api/push/public-key').then((r) => r.json());
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
  const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) return { ok: false, message: d?.message || 'Could not register this device.' };
  return { ok: true };
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
