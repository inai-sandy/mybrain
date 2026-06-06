import { useEffect, useState } from 'react';

type AuthState = 'loading' | 'anon' | 'authed';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [email, setEmail] = useState('');

  async function refresh() {
    try {
      const r = await fetch('/api/auth/me');
      if (r.ok) {
        const d = await r.json();
        setEmail(d.user?.email || '');
        setAuth('authed');
      } else {
        setAuth('anon');
      }
    } catch {
      setAuth('anon');
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (auth === 'loading') {
    return (
      <Shell>
        <p className="text-zinc-400">Loading…</p>
      </Shell>
    );
  }
  if (auth === 'anon') return <Login onSignedIn={refresh} />;
  return <Home email={email} onSignedOut={() => setAuth('anon')} />;
}

function Shell({ children }: { children: React.ReactNode }) {
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
      if (r.ok) {
        onSignedIn();
      } else {
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
    <Shell>
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
    </Shell>
  );
}

function Home({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    onSignedOut();
  }
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2 font-bold">
          <span className="text-xl">🧠</span> My Brain
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <span className="hidden sm:inline">{email}</span>
          <button onClick={logout} className="rounded-lg border border-zinc-700 px-3 py-1 hover:bg-zinc-800">
            Sign out
          </button>
        </div>
      </header>
      <main className="max-w-3xl mx-auto p-6">
        <h1 className="text-3xl font-extrabold mb-2">Welcome back</h1>
        <p className="text-zinc-400">
          Your second brain is ready. Capture, tasks, and search are coming as we build them out.
        </p>
      </main>
    </div>
  );
}
