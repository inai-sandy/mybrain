import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Service-worker registration + the "Update" toast live in ui/UpdatePrompt.tsx
// (useRegisterSW), mounted inside App. Registering there (not here) keeps a single
// registration and lets the update prompt render in the React tree.

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
