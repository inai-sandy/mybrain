import { useNavigate } from 'react-router-dom';

/**
 * Per-job fields shared by the builder form and a job's Settings sheet (BEA-1357):
 *  - where the result goes (Document · Google Sheet, with "append to this sheet"),
 *  - the pinned arguments of a direct-fetch (Social) job.
 * One drawing for both places, so the builder and Settings can never disagree.
 */

/** The task text a Social agent starts with. Anything else = "shape the rows as I say" (server: KEEP_AS_FETCHED). */
export const KEEP_AS_FETCHED = 'Keep every result as fetched.';

export const OUTPUT_DESTS: { value: string; label: string; hint: string }[] = [
  { value: 'document', label: 'Document (in My Brain)', hint: 'The result lands in Documents like every other run.' },
  { value: 'sheet', label: 'Google Sheet', hint: 'A new sheet each run, or appended to one sheet you name. Needs Google Sheets connected in Tools.' },
];

const inp = 'w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900 sm:text-sm';

/** The id inside a pasted Google Sheet link, or the text as typed. Mirrors the server's cleaning. */
export function sheetIdFrom(v: string): string {
  const s = String(v || '').trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(s);
  return m ? m[1] : s;
}

export function OutputDestPicker({ dest, sheetId, onChange, onCommitSheetId, compact }: { dest: string; sheetId: string; onChange: (v: { outputDest: string; sheetId: string }) => void; /** Fires when the owner leaves the sheet field, with the cleaned id — the moment to save it. */ onCommitSheetId?: (id: string) => void; compact?: boolean }) {
  const nav = useNavigate();
  const cur = OUTPUT_DESTS.find((d) => d.value === dest) || OUTPUT_DESTS[0];
  return (
    <div className="space-y-1.5" data-testid="output-dest">
      <label className="block text-xs font-medium text-zinc-500">Where the result goes
        <select value={cur.value} onChange={(e) => onChange({ outputDest: e.target.value, sheetId })} aria-label="Where the result goes" className={inp + ' mt-1'}>
          {OUTPUT_DESTS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </label>
      {cur.value === 'sheet' && (
        <label className="block text-xs text-zinc-500">Append to one sheet <span className="text-zinc-400">(paste its link or id · blank = a new sheet every run)</span>
          <input value={sheetId} onChange={(e) => onChange({ outputDest: cur.value, sheetId: e.target.value })} onBlur={(e) => { const id = sheetIdFrom(e.target.value); onChange({ outputDest: cur.value, sheetId: id }); onCommitSheetId?.(id); }} placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Append to sheet" className={inp + ' mt-1'} />
        </label>
      )}
      {!compact && (
        <p className="text-[11px] text-zinc-400">
          {cur.hint}{cur.value === 'sheet' ? <> Not connected yet? <button type="button" onClick={() => nav('/tools')} className="text-emerald-600 hover:underline">Open Tools</button>. If it is not connected, the run says so and stops — it never quietly skips the sheet.</> : null}
        </p>
      )}
    </div>
  );
}

/** A tool's pinned arguments, editable one field at a time. Keys are the endpoint's own field names. */
export function ToolArgsEditor({ tool, args, onChange, toolName }: { tool: string; args: Record<string, any>; onChange: (next: Record<string, any>) => void; toolName?: string }) {
  const keys = Object.keys(args || {});
  return (
    <div className="space-y-1.5 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700" data-testid="tool-args">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full bg-pink-50 px-2 py-0.5 font-semibold text-pink-700 dark:bg-pink-500/10 dark:text-pink-300">📣 {toolName || 'Social'}</span>
        <code className="truncate text-[11px] text-zinc-400">{tool}</code>
      </div>
      {keys.length === 0 ? (
        <p className="text-[11px] text-zinc-400">This endpoint takes no inputs — it runs as is.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {keys.map((k) => (
            <label key={k} className="block min-w-0 text-xs text-zinc-500">
              <span className="block truncate font-medium">{k}</span>
              <input value={args[k] === null || args[k] === undefined ? '' : Array.isArray(args[k]) ? args[k].join(', ') : String(args[k])} onChange={(e) => onChange({ ...args, [k]: coerce(args[k], e.target.value) })} aria-label={k} className={inp + ' mt-0.5'} />
            </label>
          ))}
        </div>
      )}
      <p className="text-[11px] text-zinc-400">These exact values are sent every run — no AI fills them in.</p>
    </div>
  );
}

/** Keep the type the endpoint was given: a number stays a number, a yes/no stays yes/no, a list stays a list. */
export function coerce(prev: any, v: string): any {
  if (typeof prev === 'number') return v.trim() === '' ? '' : Number.isFinite(Number(v)) ? Number(v) : v;
  if (typeof prev === 'boolean') return /^(true|yes|1)$/i.test(v.trim()) ? true : /^(false|no|0)$/i.test(v.trim()) ? false : v;
  if (Array.isArray(prev)) return v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (prev.length && typeof prev[0] === 'number' && Number.isFinite(Number(x)) ? Number(x) : x));
  return v;
}
