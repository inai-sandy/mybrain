import { useEffect, useState } from 'react';
import { User, Plug } from 'lucide-react';

export function Settings({ email }: { email?: string }) {
  const [connectors, setConnectors] = useState<{ name: string; configured: boolean }[]>([]);

  useEffect(() => {
    fetch('/api/connectors')
      .then((r) => (r.ok ? r.json() : { connectors: [] }))
      .then((d) => setConnectors(d.connectors || []))
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Settings</h1>
        <p className="text-zinc-500">Your account and connected services.</p>
      </div>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h2 className="flex items-center gap-2 font-semibold mb-3">
          <User size={18} className="text-emerald-600" /> Account
        </h2>
        <p className="text-sm text-zinc-500">
          Signed in as <span className="text-zinc-900 dark:text-zinc-100 font-medium">{email || '—'}</span>
        </p>
        <p className="text-xs text-zinc-400 mt-2">Change-password is coming soon.</p>
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h2 className="flex items-center gap-2 font-semibold mb-3">
          <Plug size={18} className="text-emerald-600" /> Connectors
        </h2>
        <ul className="space-y-2">
          {connectors.map((c) => (
            <li key={c.name} className="flex items-center justify-between text-sm">
              <span className="capitalize">{c.name}</span>
              <span
                className={
                  'text-xs px-2 py-0.5 rounded-full ' +
                  (c.configured
                    ? 'bg-emerald-500/15 text-emerald-500'
                    : 'bg-zinc-500/15 text-zinc-400')
                }
              >
                {c.configured ? 'Connected' : 'Not set'}
              </span>
            </li>
          ))}
          {connectors.length === 0 && <li className="text-sm text-zinc-400">Loading…</li>}
        </ul>
      </section>
    </div>
  );
}
