import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from './ui/Toast';
import { AppShell } from './ui/AppShell';
import { Login } from './ui/Login';
import { Dashboard } from './pages/Dashboard';
import { Capture } from './pages/Capture';
import { Bookmarks } from './pages/Bookmarks';
import { Ideas } from './pages/Ideas';
import { IdeaDetail } from './pages/IdeaDetail';
import { Skills } from './pages/Skills';
import { SkillDetail } from './pages/SkillDetail';
import { Tasks } from './pages/Tasks';
import { Today } from './pages/Today';
import { Activity } from './pages/Activity';
import { Mentor } from './pages/Mentor';
import { Chat } from './pages/Chat';
import { Settings } from './pages/Settings';
import { Viewer } from './pages/Viewer';
import { SkillViewer } from './pages/SkillViewer';
import { DocDetail } from './pages/DocDetail';
import { ChatDoc } from './pages/ChatDoc';

type AuthState = 'loading' | 'anon' | 'authed';

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          {/* Public, no login required — shared links must open for anyone. */}
          <Route path="/view/:id" element={<Viewer />} />
          <Route path="/skill/:id" element={<SkillViewer />} />
          {/* Everything else is behind auth. */}
          <Route path="/*" element={<AuthedApp />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}

function AuthedApp() {
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
    return <div className="min-h-screen bg-zinc-950 text-zinc-400 flex items-center justify-center">Loading…</div>;
  }
  if (auth === 'anon') return <Login onSignedIn={refresh} />;

  return (
    <Routes>
      <Route element={<AppShell email={email} onSignOut={logout} />}>
        <Route index element={<Dashboard />} />
        <Route path="capture" element={<Capture />} />
        <Route path="bookmarks" element={<Bookmarks />} />
        <Route path="ideas" element={<Ideas />} />
        <Route path="ideas/:id" element={<IdeaDetail />} />
        <Route path="skills" element={<Skills />} />
        <Route path="skills/:id" element={<SkillDetail />} />
        <Route path="doc/:id" element={<DocDetail />} />
        <Route path="chat/:id" element={<ChatDoc />} />
        <Route path="today" element={<Today />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="chat" element={<Chat />} />
        <Route path="activity" element={<Activity />} />
        <Route path="mentor" element={<Mentor />} />
        <Route path="settings" element={<Settings email={email} />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}
