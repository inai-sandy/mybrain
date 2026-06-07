import { ReactNode, useMemo, useState } from 'react';

export type Column<T> = {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  align?: 'left' | 'right';
  render?: (row: T) => ReactNode;
};

export type Filter = {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  match?: (row: any, value: string) => boolean;
};

/**
 * Standard list: search, sortable columns, filters, pagination, total count,
 * loading + empty states, and an optional mobile card layout.
 */
export type SortOption = { label: string; key: string; dir: 1 | -1 };

export function DataTable<T extends Record<string, any>>({
  columns,
  rows,
  loading = false,
  searchable = true,
  filters = [],
  pageSize = 10,
  emptyText = 'Nothing here yet.',
  renderCard,
  cardsOnly = false,
  gridClassName,
  sortOptions = [],
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  searchable?: boolean;
  filters?: Filter[];
  pageSize?: number;
  emptyText?: string;
  renderCard?: (row: T) => ReactNode;
  cardsOnly?: boolean;
  gridClassName?: string;
  sortOptions?: SortOption[];
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let r = rows;
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter((row) => columns.some((c) => String(row[c.key] ?? '').toLowerCase().includes(s)));
    }
    for (const f of filters) {
      const val = active[f.key];
      if (!val) continue;
      r = f.match ? r.filter((row) => f.match!(row, val)) : r.filter((row) => String(row[f.key]) === val);
    }
    if (sort) {
      r = [...r].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * sort.dir);
    }
    return r;
  }, [rows, q, active, sort, columns, filters]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const inputCls =
    'rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500';

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {searchable && (
          <input
            aria-label="Search"
            placeholder="Search…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            className={inputCls + ' col-span-2 w-full min-w-0 sm:flex-none sm:w-64'}
          />
        )}
        {filters.map((f) => (
          <select
            key={f.key}
            aria-label={f.label}
            value={active[f.key] || ''}
            onChange={(e) => {
              setActive((a) => ({ ...a, [f.key]: e.target.value }));
              setPage(0);
            }}
            className={inputCls + ' w-full min-w-0 sm:w-auto'}
          >
            <option value="">{f.label}: all</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
        {sortOptions.length > 0 && (
          <select
            aria-label="Sort"
            value={sort ? `${sort.key}:${sort.dir}` : ''}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':');
              setSort(key ? { key, dir: Number(dir) as 1 | -1 } : null);
            }}
            className={inputCls + ' w-full min-w-0 sm:w-auto'}
          >
            <option value="">Sort: default</option>
            {sortOptions.map((s) => (
              <option key={s.label} value={`${s.key}:${s.dir}`}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Cards (mobile always; all sizes when cardsOnly) */}
      {renderCard && (
        <div className={cardsOnly ? gridClassName || 'grid gap-3 sm:grid-cols-2' : 'sm:hidden space-y-2'}>
          {loading ? (
            <div className="py-10 text-center text-zinc-400 sm:col-span-2" data-testid="dt-loading">Loading…</div>
          ) : pageRows.length === 0 ? (
            <div className="py-10 text-center text-zinc-400 sm:col-span-2" data-testid="dt-empty">{emptyText}</div>
          ) : (
            pageRows.map((row, i) => <div key={i}>{renderCard(row)}</div>)
          )}
        </div>
      )}

      {/* Desktop table (hidden in cardsOnly mode) */}
      {!cardsOnly && (
      <div className={(renderCard ? 'hidden sm:block ' : '') + 'overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800'}>
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900 text-left">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={'px-3 py-2 font-semibold text-zinc-500 dark:text-zinc-400 select-none ' + (c.align === 'right' ? 'text-right' : '')}
                >
                  {c.sortable ? (
                    <button
                      className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-white"
                      onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
                    >
                      {c.label}
                      {sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-zinc-400" data-testid="dt-loading">
                  Loading…
                </td>
              </tr>
            ) : pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-zinc-400" data-testid="dt-empty">
                  {emptyText}
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => (
                <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                  {columns.map((c) => (
                    <td key={c.key} className={'px-3 py-2 ' + (c.align === 'right' ? 'text-right' : '')}>
                      {c.render ? c.render(row) : String(row[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      )}

      <div className="flex items-center justify-between mt-3 text-sm text-zinc-500">
        <span data-testid="dt-count">{loading ? '' : `${filtered.length} ${filtered.length === 1 ? 'result' : 'results'}`}</span>
        {!loading && pages > 1 && (
          <div className="flex items-center gap-2">
            <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 disabled:opacity-40">
              Prev
            </button>
            <span>
              {safePage + 1}/{pages}
            </span>
            <button disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)} className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 disabled:opacity-40">
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
