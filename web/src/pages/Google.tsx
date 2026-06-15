import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Search, Download, Check, Loader2, RefreshCw } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Status = { connected: boolean; email: string | null; gws: boolean; bridge: boolean };
type Email = { id: string; from: string; subject: string; date: string; snippet: string };

export function Google() {
  const [status, setStatus] = useState<Status | null>(null);
  const [q, setQ] = useState('');
  const [emails, setEmails] = useState<Email[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<Record<string, boolean>>({});
  const [imported, setImported] = useState<Record<string, boolean>>({});
  const toast = useToast();

  useEffect(() => {
    fetch('/api/google/status').then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

  async function loadEmails() {
    setLoading(true);
    try {
      const r = await fetch('/api/google/gmail' + (q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''));
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load emails');
      setEmails(d.messages || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load emails');
    } finally {
      setLoading(false);
    }
  }

  async function importEmail(id: string) {
    setImporting((p) => ({ ...p, [id]: true }));
    try {
      const r = await fetch(`/api/google/gmail/${id}/import`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Could not import');
      setImported((p) => ({ ...p, [id]: true }));
      toast('success', 'Imported to Capture');
    } catch (e: any) {
      toast('error', e.message || 'Could not import');
    } finally {
      setImporting((p) => ({ ...p, [id]: false }));
    }
  }

  const connected = !!status?.connected;

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2"><span className="text-blue-500">🟦</span> Google</h1>
        <p className="text-zinc-500 text-sm">Pull your Gmail, Drive, Docs &amp; Sheets into your brain.</p>
      </div>

      {status && !connected ? (
        <div className="rounded-xl border border-amber-300/50 dark:border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
          Google isn’t connected yet. <Link to="/settings" className="font-medium underline hover:text-amber-600">Open Settings → Integrations → Google</Link> and run the one-time <code className="rounded bg-amber-500/10 px-1">gws auth</code> step on your server, then come back.
        </div>
      ) : connected ? (
        <p className="text-sm text-zinc-500">Connected{status?.email ? ` as ${status.email}` : ''}.</p>
      ) : null}

      {/* Gmail */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h2 className="font-semibold flex items-center gap-2 mb-3"><Mail size={16} className="text-rose-500" /> Gmail</h2>
        <div className="flex gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadEmails()}
              placeholder="Search (e.g. from:srikar, is:starred, has:attachment)…"
              className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </div>
          <button onClick={loadEmails} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Load
          </button>
        </div>
        {emails === null ? (
          <p className="text-sm text-zinc-400">Tap <b>Load</b> to fetch your recent emails{connected ? '' : ' (after connecting Google)'}.</p>
        ) : emails.length ? (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {emails.map((m) => (
              <li key={m.id} className="flex items-start gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{m.subject}</div>
                  <div className="text-xs text-zinc-400 truncate">{m.from.replace(/<.*>/, '').trim() || m.from}</div>
                  {m.snippet && <div className="text-xs text-zinc-500 line-clamp-1 mt-0.5">{m.snippet}</div>}
                </div>
                <button onClick={() => importEmail(m.id)} disabled={importing[m.id] || imported[m.id]} className={'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] disabled:opacity-60 ' + (imported[m.id] ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500 hover:text-emerald-600')}>
                  {importing[m.id] ? <Loader2 size={11} className="animate-spin" /> : imported[m.id] ? <><Check size={11} /> Saved</> : <><Download size={11} /> Import</>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-400">No emails found.</p>
        )}
      </section>
    </div>
  );
}
