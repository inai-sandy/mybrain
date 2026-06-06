import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from './ui/Toast';
import { AppShell } from './ui/AppShell';
import { Login } from './ui/Login';
import { Dashboard } from './pages/Dashboard';
import { Capture } from './pages/Capture';
import { Tasks } from './pages/Tasks';
import { Settings } from './pages/Settings';
import { Viewer } from './pages/Viewer';
import { DocDetail } from './pages/DocDetail';
import { ChatDoc } from './pages/ChatDoc';

type AuthState = 'loading' | 'anon' | 'authed';

export default function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [email, setEmail] = useState('');

  async function refresh() {
    try {
      const r = await fetch('/api/auth/me');
      if (r.ok) {
        const d = await r.json();
        setEmail(d.user?.email || '');
        setAuth('authed');
      } else setAuth('anon');
    } catch {
      setAuth('anon');
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuth('anon');
  }

  useEffect(() => {
    refresh();
  }, []);

  if (auth === 'loading') {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-400 flex items-center justify-center">Loading…</div>
    );
  }
  if (auth === 'anon') return <Login onSignedIn={refresh} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/view/:id" element={<Viewer />} />
        <Route element={<AppShell email={email} onSignOut={logout} />}>
          <Route index element={<Dashboard />} />
          <Route path="capture" element={<Capture />} />
          <Route path="doc/:id" element={<DocDetail />} />
          <Route path="chat/:id" element={<ChatDoc />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="settings" element={<Settings email={email} />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
