/** Nuke caches + service workers and hard-reload — used by the version gate and the manual "Update app"
 *  controls. Kept in its own module (no PWA virtual import) so any component can use it without pulling
 *  `virtual:pwa-register` into non-PWA test environments. */
export async function forceUpdate() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* ignore */
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
  location.reload();
}
