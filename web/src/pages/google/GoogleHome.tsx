import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { SERVICES } from './registry';
import { SERVICE_LOGOS, type GoogleServiceKey } from './logos';

type Status = { connected: boolean; email: string | null };
type Hints = { connected: boolean; gmailUnread: number | null; calendarNext: { summary: string; start: string | null } | null; tasksOpen: number | null };

export function GoogleHome() {
  const [status, setStatus] = useState<Status | null>(null);
  const [hints, setHints] = useState<Hints | null>(null);

  useEffect(() => {
    fetch('/api/google/status').then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
    fetch('/api/google/hints').then((r) => (r.ok ? r.json() : null)).then((h) => h && setHints(h)).catch(() => undefined);
  }, []);

  const connected = !!status?.connected;

  function hintFor(key: GoogleServiceKey): string | null {
    if (!hints || !hints.connected) return null;
    if (key === 'gmail') return hints.gmailUnread != null ? `${hints.gmailUnread} unread` : null;
    if (key === 'calendar') return hints.calendarNext ? `Next: ${hints.calendarNext.summary}` : null;
    if (key === 'tasks') return hints.tasksOpen != null ? `${hints.tasksOpen} open` : null;
    return null;
  }

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Google</h1>
          <p className="text-zinc-500 text-sm">Tap a service to open it.</p>
        </div>
        {connected ? (
          <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 text-emerald-600 px-3 py-1 text-xs font-medium">
            <CheckCircle2 size={13} /> Connected{status?.email ? ` · ${status.email}` : ''}
          </span>
        ) : status ? (
          <Link to="/settings" className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 text-amber-600 px-3 py-1 text-xs font-medium hover:bg-amber-500/20">Not connected — set up</Link>
        ) : null}
      </div>

      {status && !connected && (
        <div className="rounded-xl border border-amber-300/50 dark:border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
          Google isn’t connected yet. <Link to="/settings" className="font-medium underline hover:text-amber-600">Open Settings → Integrations → Google</Link> to finish the one-time setup, then come back.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {SERVICES.map((s) => {
          const Logo = SERVICE_LOGOS[s.key];
          const hint = hintFor(s.key);
          return (
            <Link
              key={s.key}
              to={`/google/${s.key}`}
              className="group rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-col items-center text-center gap-2 transition hover:shadow-md hover:-translate-y-0.5 hover:border-zinc-300 dark:hover:border-zinc-700"
            >
              <div className="w-12 h-12 flex items-center justify-center"><Logo size={40} /></div>
              <div className="text-sm font-semibold">{s.label}</div>
              <div className={'text-[11px] leading-tight line-clamp-2 ' + (hint ? 'text-emerald-600 font-medium' : 'text-zinc-400')}>{hint || s.tagline}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
