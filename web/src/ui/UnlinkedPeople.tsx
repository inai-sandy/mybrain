import { useEffect, useState } from 'react';
import { UserX, X } from 'lucide-react';

type Unmatched = { party: string; taskIds: string[]; reason: string };

const DISMISSED = 'tasks-unlinked-dismissed';

/**
 * Names typed on tasks that could NOT be matched to exactly one contact.
 *
 * The backfill deliberately refuses to guess, so instead of silently linking the wrong person it
 * shows the leftovers here. Quiet by design: nothing to fix means nothing on screen. (BEA-1019)
 */
export function UnlinkedPeople() {
  const [rows, setRows] = useState<Unmatched[]>([]);
  const [hidden, setHidden] = useState(() => sessionStorage.getItem(DISMISSED) === '1');

  useEffect(() => {
    if (hidden) return;
    fetch('/api/tasks/people/unlinked')
      .then((r) => (r.ok ? r.json() : { unmatched: [] }))
      .then((d) => setRows(d.unmatched || []))
      .catch(() => setRows([]));
  }, [hidden]);

  if (hidden || !rows.length) return null;

  const total = rows.reduce((n, r) => n + r.taskIds.length, 0);

  return (
    <div className="rounded-xl border border-amber-300/50 bg-amber-500/5 p-3 text-sm">
      <div className="flex items-start gap-2">
        <UserX size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {total} {total === 1 ? 'task names' : 'tasks name'} someone who isn't linked to a contact
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Nothing was guessed. Open the task and pick the person, or add them to Contacts first.
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {rows.map((r) => (
              <span
                key={r.party}
                title={r.reason}
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[11px] font-medium"
              >
                {r.party}
                <span className="opacity-60">· {r.taskIds.length}</span>
              </span>
            ))}
          </div>
        </div>
        <button
          onClick={() => { sessionStorage.setItem(DISMISSED, '1'); setHidden(true); }}
          aria-label="Hide"
          className="p-1 text-amber-600/70 hover:text-amber-700 dark:hover:text-amber-300 shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
