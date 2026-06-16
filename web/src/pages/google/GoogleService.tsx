import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { SERVICE_BY_KEY } from './registry';
import { SERVICE_LOGOS } from './logos';

type Status = { connected: boolean; email: string | null };

/** A single Google service's internal page: header (back + logo + title) over that service's panel. */
export function GoogleService() {
  const { subpage } = useParams();
  const def = subpage ? SERVICE_BY_KEY[subpage] : undefined;
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    fetch('/api/google/status').then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!def) return <Navigate to="/google" replace />;

  const Logo = SERVICE_LOGOS[def.key];
  const { Panel } = def;
  const connected = !!status?.connected;

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <Link to="/google" className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-700" aria-label="Back to Google">
          <ChevronLeft size={18} />
        </Link>
        <div className="w-9 h-9 flex items-center justify-center"><Logo size={30} /></div>
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold leading-tight truncate">{def.label}</h1>
          <p className="text-zinc-500 text-xs truncate">{def.tagline}</p>
        </div>
      </div>

      {status && !connected ? (
        <div className="rounded-xl border border-amber-300/50 dark:border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
          Google isn’t connected yet. <Link to="/settings" className="font-medium underline hover:text-amber-600">Open Settings → Integrations → Google</Link> to finish the one-time setup, then come back.
        </div>
      ) : (
        <Panel />
      )}
    </div>
  );
}
