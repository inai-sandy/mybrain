import { useEffect, useState } from 'react';

export default function App() {
  const [status, setStatus] = useState<string>('checking…');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setStatus(d.status))
      .catch(() => setStatus('offline'));
  }, []);

  const ok = status === 'ok';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="text-center max-w-lg">
        <div className="text-6xl mb-4">🧠</div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-3">My Brain</h1>
        <p className="text-zinc-400 mb-8 leading-relaxed">
          Your private second brain — research, bookmarks, highlights &amp; tasks, in one place.
        </p>
        <span
          className={
            'inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm font-semibold ' +
            (ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400')
          }
        >
          <span className="w-2 h-2 rounded-full bg-current" />
          API: {status}
        </span>
      </div>
    </div>
  );
}
