import { ReactNode, useMemo, useState } from 'react';

export type Column<T> = {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
};

/**
 * Standard data table: search, sortable columns, pagination, total count,
 * loading + friendly empty states. The base every list in the app reuses.
 */
export function DataTable<T extends Record<string, any>>({
  columns,
  rows,
  loading = false,
  searchable = true,
  pageSize = 10,
  emptyText = 'Nothing here yet.',
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  searchable?: boolean;
  pageSize?: number;
  emptyText?: string;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let r = rows;
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter((row) => columns.some((c) => String(row[c.key] ?? '').toLowerCase().includes(s)));
    }
    if (sort) {
      r = [...r].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * sort.dir);
    }
    return r;
  }, [rows, q, sort, columns]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  return (
    <div>
      {searchable && (
        <input
          aria-label="Search"
          placeholder="Search…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
          className="mb-3 w-full sm:w-64 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
      )}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900 text-left">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="px-3 py-2 font-semibold text-zinc-500 dark:text-zinc-400 select-none">
                  {c.sortable ? (
                    <button
                      className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-white"
                      onClick={() =>
                        setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))
                      }
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
                    <td key={c.key} className="px-3 py-2">
                      {c.render ? c.render(row) : String(row[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-sm text-zinc-500">
        <span data-testid="dt-count">{loading ? '' : `${filtered.length} ${filtered.length === 1 ? 'result' : 'results'}`}</span>
        {!loading && pages > 1 && (
          <div className="flex items-center gap-2">
            <button
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 disabled:opacity-40"
            >
              Prev
            </button>
            <span>
              {safePage + 1}/{pages}
            </span>
            <button
              disabled={safePage >= pages - 1}
              onClick={() => setPage(safePage + 1)}
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
