/* Web Push handler (BEA-1088) — imported into the generated service worker via workbox
 * importScripts. Shows the notification and routes a tap to the right screen. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { /* non-JSON push — show defaults */ }
  e.waitUntil(
    self.registration.showNotification(d.title || 'My Brain', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: d.url || '/agent' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/agent';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});
