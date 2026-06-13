import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

// Self-healing updates. The app is an installed PWA, so the browser caches the
// JS bundle offline. If a deploy ever shipped a broken bundle, a cached client
// could get stuck on it — and a frozen page can't even run the code that would
// replace itself. So we register the service worker explicitly and poll for a
// new version often: every minute, whenever the tab regains focus, and when the
// network comes back. With registerType 'autoUpdate' a found update is applied
// and the page reloads automatically — no manual cache clear, ever.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, r) {
    if (!r) return;
    const check = () => r.update().catch(() => undefined);
    setInterval(check, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('online', check);
  },
  onNeedRefresh() {
    // Belt-and-suspenders: if a build ever runs in 'prompt' mode, apply immediately.
    updateSW(true);
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
