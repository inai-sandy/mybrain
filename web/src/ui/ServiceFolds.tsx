import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';

/**
 * A long list of outside-service actions, folded by service (BEA-1354).
 *
 * The catalog holds EVERY action of every connected service now — GitHub alone is ~800 lines — and
 * the same list is drawn in the agent's tool picker and on the Flows canvas. Both need the same
 * three things, so they live here once:
 *  - one fold per service, closed by default, with its count and how many are already picked;
 *  - a search box INSIDE each open fold ("Search 781 actions") on top of the page's own;
 *  - a page of `pageSize` rows at a time and a "Show more" button — never hundreds of buttons on a
 *    phone at once.
 * A page-level query opens the folds that match and hides the rest, so a global search still works
 * exactly as it did when the list was short.
 *
 * The row itself is the caller's: `renderItem` gets the item plus its short label (the name without
 * the "GitHub: " prefix, since the fold's header already says which service it is).
 */

export type FoldItem = { id: string; name: string; description?: string; service?: string };

/** How many rows one fold shows before "Show more". Small on purpose — this is read on a phone. */
export const FOLD_PAGE = 40;

/** "GitHub: Create an issue" → { service: "GitHub", label: "Create an issue" }. */
export function splitName(name: string): { service: string; label: string } {
  const i = (name || '').indexOf(': ');
  if (i > 0) return { service: name.slice(0, i), label: name.slice(i + 2) };
  return { service: '', label: name || '' };
}

/** The items of one group, keyed by service, in first-seen order. */
export function groupByService<T extends FoldItem>(items: T[]): { key: string; title: string; items: T[] }[] {
  const out = new Map<string, { key: string; title: string; items: T[] }>();
  for (const it of items || []) {
    const { service } = splitName(it.name);
    const key = it.service || service.toLowerCase() || '_';
    const at = out.get(key) || { key, title: service || it.service || 'Other', items: [] };
    at.items.push(it);
    out.set(key, at);
  }
  return [...out.values()];
}

/** Every word of the search must appear somewhere — "star repository" finds "Star a repository". */
export function matchesWords(text: string, needle: string): boolean {
  const hay = String(text || '').toLowerCase();
  return String(needle || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

const matches = (it: FoldItem, needle: string) => !needle || matchesWords(`${it.name} ${it.description || ''} ${it.id}`, needle);

export function ServiceFolds<T extends FoldItem>({
  items,
  query = '',
  pickedIds,
  pageSize = FOLD_PAGE,
  renderItem,
}: {
  items: T[];
  /** The page's own search — folds that match open, the rest hide. */
  query?: string;
  /** Ids already ticked, for the "· 2 picked" count on a closed fold. */
  pickedIds?: string[];
  pageSize?: number;
  renderItem: (item: T, label: string) => ReactNode;
}) {
  const groups = useMemo(() => groupByService(items), [items]);
  const needle = query.trim().toLowerCase();
  const picked = useMemo(() => new Set(pickedIds || []), [pickedIds]);
  return (
    <div className="space-y-1">
      {groups.map((g) => (
        <ServiceFold key={g.key} title={g.title} items={g.items} needle={needle} picked={picked} pageSize={pageSize} renderItem={renderItem} />
      ))}
    </div>
  );
}

function ServiceFold<T extends FoldItem>({
  title, items, needle, picked, pageSize, renderItem,
}: {
  title: string; items: T[]; needle: string; picked: Set<string>; pageSize: number; renderItem: (item: T, label: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(pageSize);
  const local = q.trim().toLowerCase();

  // The page's search narrows every fold; the fold's own search narrows further.
  const hits = useMemo(() => items.filter((it) => matches(it, needle) && matches(it, local)), [items, needle, local]);
  if (needle && !items.some((it) => matches(it, needle))) return null;
  const isOpen = open || !!needle;
  const pickedHere = items.filter((it) => picked.has(it.id)).length;
  const page = hits.slice(0, shown);
  const left = hits.length - page.length;
  const one = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-[11px] text-zinc-500">
            {needle && hits.length !== items.length ? `${one(hits.length, 'match')} of ${one(items.length, 'action')}` : one(items.length, 'action')}
            {pickedHere > 0 && <span className="text-emerald-600 dark:text-emerald-400"> · {pickedHere} picked</span>}
          </span>
        </span>
        <ChevronDown className={'h-4 w-4 shrink-0 text-zinc-400 transition-transform ' + (isOpen ? 'rotate-180' : '')} />
      </button>

      {isOpen && (
        <div className="border-t border-zinc-100 px-1.5 pb-1.5 pt-1.5 dark:border-zinc-800">
          {items.length > pageSize && (
            <label className="mb-1 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
              <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setShown(pageSize); }}
                placeholder={`Search ${items.length.toLocaleString()} actions`}
                aria-label={`Search ${title}'s actions`}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-base outline-none placeholder:text-zinc-400 sm:text-xs"
              />
              {q && <button type="button" onClick={() => setQ('')} className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600">clear</button>}
            </label>
          )}
          {page.length === 0 && <p className="px-2 py-3 text-center text-xs text-zinc-400">Nothing in {title} matches “{local || needle}”.</p>}
          <div className="space-y-0.5">{page.map((it) => renderItem(it, splitName(it.name).label || it.name))}</div>
          {left > 0 && (
            <button
              type="button"
              onClick={() => setShown((n) => n + pageSize)}
              className="mt-1 w-full rounded-lg py-1.5 text-center text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
            >
              Show {Math.min(pageSize, left)} more · {left.toLocaleString()} left
            </button>
          )}
        </div>
      )}
    </div>
  );
}
