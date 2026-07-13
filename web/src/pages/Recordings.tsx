import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Disc3, Search, Bookmark, Clock } from 'lucide-react';

// Recordings (BEA-975) — long ambient sessions recorded WITHOUT transcription.
// This list is deliberately calm: title (the real time span), duration, marks, status.

type Rec = {
  id: string; title: string | null; day: string; status: string;
  seconds: number; bytes: number; startedAt: string;
  _count?: { marks: number; chunks: number };
};

export function fmtDur(s: number): string {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export default function Recordings() {
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [take, setTake] = useState(30);

  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/recordings?take=${take}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
        .then((r) => (r.ok ? r.json() : { recordings: [], total: 0 }))
        .then((d) => { setRows(d.recordings || []); setTotal(d.total || 0); })
        .catch(() => { setRows([]); setTotal(0); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, take]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Recordings</h1>
          <p className="text-sm text-zinc-500">Long sessions, stored as audio — transcribe only what matters. {total ? `${total} total.` : ''}</p>
        </div>
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or day…"
          className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500/50 dark:border-zinc-700 dark:bg-zinc-900" />
      </div>

      {rows === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 py-16 text-center text-sm text-zinc-400 dark:border-zinc-700">
          <div className="mb-2 text-2xl">🎙</div>
          {q ? 'No recordings match.' : 'No recordings yet — open the record tile on EMO Cam to capture your first session.'}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link key={r.id} to={`/recordings/${r.id}`}
              className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 transition hover:border-emerald-500/40 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"><Disc3 size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.title || `Recording · ${r.day}`}</span>
                <span className="mt-0.5 flex items-center gap-3 text-[11px] text-zinc-400">
                  <span className="inline-flex items-center gap-1"><Clock size={11} />{fmtDur(r.seconds)}</span>
                  <span className="inline-flex items-center gap-1"><Bookmark size={11} />{r._count?.marks ?? 0} mark{(r._count?.marks ?? 0) === 1 ? '' : 's'}</span>
                  <span>{(r.bytes / 1048576).toFixed(1)} MB</span>
                  {r.status === 'recording' && <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-1.5 py-0.5 font-semibold text-rose-600 dark:text-rose-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" />Live</span>}
                  {r.status === 'archived' && <span className="rounded-full bg-zinc-500/15 px-1.5 py-0.5 font-semibold text-zinc-500">On home server</span>}
                </span>
              </span>
            </Link>
          ))}
          {total > rows.length && (
            <div className="pt-2 text-center">
              <button onClick={() => setTake((t) => t + 30)} className="rounded-full border border-zinc-200 px-4 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                Load more · {rows.length} of {total}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
