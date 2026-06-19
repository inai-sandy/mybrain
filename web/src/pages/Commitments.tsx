import { useEffect, useMemo, useState } from 'react';
import { Handshake, Lightbulb, Check, X, RefreshCw, Search, Clock, AlertTriangle, Trash2 } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Commitment = { id: string; text: string; party: string | null; dueDate: string | null; status: string; confirmed: boolean; overdue?: boolean; sourceDay: string; createdAt: string };
type Decision = { id: string; text: string; context: string | null; sourceDay: string; createdAt: string };

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
] as const;

function fmtDate(d: string | null): string {
  if (!d) return '';
  const t = new Date(`${d}T00:00:00`);
  return isNaN(+t) ? d : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function Commitments() {
  const toast = useToast();
  const [commitments, setCommitments] = useState<Commitment[] | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'overdue' | 'done' | 'all'>('open');
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);

  async function load() {
    try {
      const [c, d] = await Promise.all([
        fetch('/api/accountability/commitments').then((r) => r.json()),
        fetch('/api/accountability/decisions').then((r) => r.json()),
      ]);
      setCommitments(Array.isArray(c) ? c : []);
      setDecisions(Array.isArray(d) ? d : []);
    } catch {
      setCommitments([]);
      setDecisions([]);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function patch(id: string, body: any) {
    setCommitments((cs) => (cs || []).map((c) => (c.id === id ? { ...c, ...body, ...(body.status === 'done' ? { overdue: false } : {}) } : c)));
    await fetch(`/api/accountability/commitments/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
  }
  async function delCommitment(id: string) {
    setCommitments((cs) => (cs || []).filter((c) => c.id !== id));
    await fetch(`/api/accountability/commitments/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  async function delDecision(id: string) {
    setDecisions((ds) => (ds || []).filter((d) => d.id !== id));
    await fetch(`/api/accountability/decisions/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  async function scan() {
    setScanning(true);
    try {
      const r = await fetch('/api/accountability/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const d = await r.json();
      toast('success', `Scanned today — ${d.commitments || 0} new commitment${d.commitments === 1 ? '' : 's'}, ${d.decisions || 0} decision${d.decisions === 1 ? '' : 's'}`);
      await load();
    } catch {
      toast('error', 'Could not scan today');
    } finally {
      setScanning(false);
    }
  }

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    let list = commitments || [];
    if (filter === 'open') list = list.filter((c) => c.status === 'open');
    else if (filter === 'overdue') list = list.filter((c) => c.overdue);
    else if (filter === 'done') list = list.filter((c) => c.status === 'done');
    if (needle) list = list.filter((c) => `${c.text} ${c.party || ''}`.toLowerCase().includes(needle));
    return list;
  }, [commitments, filter, needle]);

  const counts = useMemo(() => {
    const cs = commitments || [];
    return { open: cs.filter((c) => c.status === 'open').length, overdue: cs.filter((c) => c.overdue).length, done: cs.filter((c) => c.status === 'done').length, all: cs.length };
  }, [commitments]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2">
            <Handshake size={22} className="text-emerald-500" /> Commitments
          </h1>
          <p className="text-zinc-500">Promises and decisions your brain pulled from your days — so nothing slips.</p>
        </div>
        <button onClick={scan} disabled={scanning} className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 transition">
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} /> Scan today
        </button>
      </div>

      {/* Commitments */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition ' + (filter === f.id ? 'bg-emerald-600 text-white border-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500')}
            >
              {f.label}
              <span className={'tabular-nums ' + (filter === f.id ? 'text-emerald-100' : 'text-zinc-400')}>{counts[f.id]}</span>
            </button>
          ))}
          <div className="relative ml-auto">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-8 pr-3 py-1.5 text-sm w-40 focus:w-56 outline-none focus:border-emerald-500 transition-all" />
          </div>
        </div>

        {commitments === null ? (
          <div className="text-sm text-zinc-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center text-sm text-zinc-500">
            {(commitments || []).length === 0 ? 'No commitments yet — they appear as you tell your day’s story. Tap “Scan today” to check now.' : 'Nothing here for this filter.'}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((c) => {
              const done = c.status === 'done';
              return (
                <div key={c.id} className={'rounded-xl border bg-white dark:bg-zinc-900 p-3.5 flex items-start gap-3 ' + (c.overdue ? 'border-red-400/40 dark:border-red-500/30' : 'border-zinc-200 dark:border-zinc-800')}>
                  <button
                    onClick={() => patch(c.id, { status: done ? 'open' : 'done' })}
                    title={done ? 'Mark not done' : 'Mark done'}
                    className={'shrink-0 mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center transition ' + (done ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-zinc-300 dark:border-zinc-600 hover:border-emerald-500')}
                  >
                    {done && <Check size={13} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={'text-sm ' + (done ? 'line-through text-zinc-400' : 'text-zinc-800 dark:text-zinc-100')}>{c.text}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {c.party && <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border border-zinc-200 dark:border-zinc-700">{c.party}</span>}
                      {c.dueDate && (
                        <span className={'text-[10px] px-2 py-0.5 rounded-full border inline-flex items-center gap-1 ' + (c.overdue ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border-zinc-200 dark:border-zinc-700')}>
                          {c.overdue ? <AlertTriangle size={10} /> : <Clock size={10} />} {fmtDate(c.dueDate)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1">
                    {!done && (
                      <button onClick={() => patch(c.id, { status: 'dropped' })} title="Drop" className="p-1.5 rounded-lg text-zinc-400 hover:text-amber-600 hover:bg-amber-500/10">
                        <X size={15} />
                      </button>
                    )}
                    <button onClick={() => delCommitment(c.id)} title="Delete" className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-500/10">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Decisions */}
      <section className="space-y-2 pt-2">
        <h2 className="text-sm font-bold text-zinc-500 flex items-center gap-1.5">
          <Lightbulb size={15} className="text-amber-500" /> Decisions {decisions && <span className="text-zinc-400 tabular-nums">{decisions.length}</span>}
        </h2>
        {decisions === null ? (
          <div className="text-sm text-zinc-400">Loading…</div>
        ) : decisions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-5 text-center text-sm text-zinc-500">No decisions captured yet.</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {decisions.map((d) => (
              <div key={d.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5 flex items-start gap-2.5 group">
                <Lightbulb size={15} className="shrink-0 mt-0.5 text-amber-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-zinc-800 dark:text-zinc-100">{d.text}</div>
                  {d.context && <div className="text-[11px] text-zinc-400 mt-0.5">{d.context}</div>}
                  <div className="text-[10px] text-zinc-400 mt-1">{fmtDate(d.sourceDay)}</div>
                </div>
                <button onClick={() => delDecision(d.id)} title="Delete" className="shrink-0 p-1 rounded text-zinc-300 dark:text-zinc-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
