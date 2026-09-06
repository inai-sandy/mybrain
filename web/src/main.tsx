import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Service-worker registration + the "Update" toast live in ui/UpdatePrompt.tsx
// (useRegisterSW), mounted inside App. Registering there (not here) keeps a single
// registration and lets the update prompt render in the React tree.

// Are we an installed app? iOS draws a home-screen app UNDER the status bar and expects the page
// to pad itself, but reports no safe-area inset on a device with no notch — so the header lands
// under the clock (the owner's iPad). `--safe-top` in index.css floors the inset when installed;
// this stamps the signal for it. Both checks, because iOS came late to `display-mode` and
// InstallPrompt.tsx already hedges the same call the same way. Done before the first paint.
try {
  const installed =
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as any).standalone === true;
  if (installed) document.documentElement.dataset.standalone = 'yes';
} catch {
  /* never let a detection failure stop the app booting */
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
