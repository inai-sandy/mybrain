import { useEffect, useState } from 'react';
import { AppShell } from './ui/AppShell';
import { DataTable, Column } from './ui/DataTable';
import { ToastProvider } from './ui/Toast';

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

  useEffect(() => {
    refresh();
  }, []);

  if (auth === 'loading') return <Centered>Loading…</Centered>;
  if (auth === 'anon') return <Login onSignedIn={refresh} />;
  return <Home email={email} onSignedOut={() => setAuth('anon')} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  );
}

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (r.ok) onSignedIn();
      else {
        const d = await r.json().catch(() => ({}));
        setError(d.message || 'Incorrect email or password.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered>
      <div className="text-5xl mb-3">🧠</div>
      <h1 className="text-2xl font-bold mb-6">My Brain</h1>
      <form onSubmit={submit} className="space-y-3 text-left">
        <input
          type="email"
          required
          autoFocus
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 outline-none focus:border-emerald-500"
        />
        <input
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 outline-none focus:border-emerald-500"
        />
        {error && <p className="text-sm text-amber-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 py-2 font-semibold transition-colors"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Centered>
  );
}

type Capture = { title: string; source: string; added: string };

function Home({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    onSignedOut();
  }

  const columns: Column<Capture>[] = [
    { key: 'title', label: 'Title', sortable: true },
    { key: 'source', label: 'Source', sortable: true },
    { key: 'added', label: 'Added', sortable: true },
  ];

  return (
    <AppShell email={email} onSignOut={logout}>
      <h1 className="text-2xl font-extrabold mb-1">Welcome back</h1>
      <p className="text-zinc-500 dark:text-zinc-400 mb-6">
        Your second brain is ready. Capture, tasks, and search land here as we build them out.
      </p>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400 mb-2">Recent captures</h2>
      <DataTable<Capture> columns={columns} rows={[]} emptyText="No captures yet — add your first markdown to get started." />
    </AppShell>
  );
}
