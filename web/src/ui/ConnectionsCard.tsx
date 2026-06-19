import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, X, ChevronDown } from 'lucide-react';

type ConnItem = { type: string; id: string; title: string; link: string };
type Conn = { id: string; summary: string; items: ConnItem[]; status: string };

/** "Noticed in your brain" — proactive cross-type connections the index surfaced. Non-naggy: hidden when empty. (BEA-358) */
export function ConnectionsCard() {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    fetch('/api/connections')
      .then((r) => r.json())
      .then((d) => {
        const list: Conn[] = Array.isArray(d) ? d : [];
        setConns(list);
        const newIds = list.filter((c) => c.status === 'new').map((c) => c.id);
        if (newIds.length) fetch('/api/connections/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: newIds }) }).catch(() => undefined);
      })
      .catch(() => setConns([]));
  }, []);

  async function dismiss(id: string) {
    setConns((cs) => (cs || []).filter((c) => c.id !== id));
    await fetch(`/api/connections/${id}/dismiss`, { method: 'PATCH' }).catch(() => undefined);
  }

  if (!conns || conns.length === 0) return null;

  return (
    <section className="rounded-xl border border-violet-300/40 dark:border-violet-500/30 bg-gradient-to-br from-violet-500/5 to-transparent overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-violet-500/[0.04]">
        <Sparkles size={14} className="shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">Noticed in your brain</span>
        <span className="shrink-0 text-[11px] tabular-nums text-violet-500/80">{conns.length}</span>
        <ChevronDown size={16} className={'shrink-0 text-violet-500/70 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>
      {open && (
      <div className="space-y-2.5 px-4 pb-4">
        {conns.slice(0, 4).map((c) => (
          <div key={c.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-700 dark:text-zinc-200 leading-snug">{c.summary}</p>
              {c.items?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.items.map((it, i) => (
                    <Link key={i} to={it.link} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border border-zinc-200 dark:border-zinc-700 hover:border-violet-400 hover:text-violet-600 truncate max-w-[170px] transition">
                      {it.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => dismiss(c.id)} aria-label="Dismiss" className="shrink-0 p-1 rounded text-zinc-300 dark:text-zinc-600 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}
