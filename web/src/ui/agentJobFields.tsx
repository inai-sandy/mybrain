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

// ---- Watch / Alert (BEA-1358) ------------------------------------------------------------------

/** How a direct-fetch job treats its result: fetch every time · watch for changes · alert when… */
export const JOB_MODES: { value: string; label: string; hint: string }[] = [
  { value: 'run', label: 'Fetch every time', hint: 'Every run writes the whole result — rows to a sheet or a document.' },
  { value: 'watch', label: 'Watch for changes', hint: 'The first run stores a baseline. After that, every run says ONLY what changed — new posts by id, followers before → after, a bio that changed. Nothing changed = nothing written, nothing sent.' },
  { value: 'alert', label: 'Alert when…', hint: 'Watch, plus a condition. When it comes true you get a message (Telegram, and WhatsApp when your number is set). A number threshold pushes once — not again while it stays over the line.' },
];

export type ThresholdDraft = { field: string; dir: 'above' | 'below'; value: string };

export const EMPTY_THRESHOLD: ThresholdDraft = { field: '', dir: 'above', value: '' };

/** The server's `{field?, dir, value}` → the form's draft. */
export function thresholdDraftOf(t: any): ThresholdDraft {
  if (!t || typeof t !== 'object') return EMPTY_THRESHOLD;
  return { field: String(t.field || ''), dir: t.dir === 'below' ? 'below' : 'above', value: t.value === undefined || t.value === null ? '' : String(t.value) };
}

/** The form's draft → what the server stores, or null when there is no number. */
export function thresholdOfDraft(d: ThresholdDraft): { field?: string; dir: 'above' | 'below'; value: number } | null {
  const n = Number(String(d.value).replace(/[,\s]/g, ''));
  if (String(d.value).trim() === '' || !Number.isFinite(n)) return null;
  return { ...(d.field.trim() ? { field: d.field.trim() } : {}), dir: d.dir, value: n };
}

export function WatchModePicker({ mode, condition, threshold, onChange, compact }: {
  mode: string;
  condition: string;
  threshold: ThresholdDraft;
  onChange: (v: { mode: string; condition: string; threshold: ThresholdDraft }) => void;
  compact?: boolean;
}) {
  const cur = JOB_MODES.find((m) => m.value === mode) || JOB_MODES[0];
  const set = (patch: Partial<{ mode: string; condition: string; threshold: ThresholdDraft }>) => onChange({ mode, condition, threshold, ...patch });
  return (
    <div className="space-y-1.5" data-testid="job-mode">
      <label className="block text-xs font-medium text-zinc-500">Each run
        <select value={cur.value} onChange={(e) => set({ mode: e.target.value })} aria-label="Each run" className={inp + ' mt-1'}>
          {JOB_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      {!compact && <p className="text-[11px] text-zinc-400">{cur.hint}</p>}
      {cur.value === 'alert' && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-500/30 dark:bg-amber-500/5" data-testid="alert-fields">
          <label className="block text-xs text-zinc-500">Alert me when… <span className="text-zinc-400">(plain English — judged over what changed)</span>
            <input value={condition} onChange={(e) => set({ condition: e.target.value })} placeholder="e.g. a new post mentions a price · followers dropped · any post is a paid partnership" aria-label="Alert condition" className={inp + ' mt-1'} />
          </label>
          <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1.4fr_auto_1fr]">
            <label className="col-span-2 block min-w-0 text-xs text-zinc-500 sm:col-span-1">…or a number <span className="text-zinc-400">(field · blank = the main one)</span>
              <input value={threshold.field} onChange={(e) => set({ threshold: { ...threshold, field: e.target.value } })} placeholder="follower_count" aria-label="Threshold field" className={inp + ' mt-1'} />
            </label>
            <label className="block text-xs text-zinc-500">goes
              <select value={threshold.dir} onChange={(e) => set({ threshold: { ...threshold, dir: e.target.value === 'below' ? 'below' : 'above' } })} aria-label="Threshold direction" className={inp + ' mt-1'}>
                <option value="above">above</option>
                <option value="below">below</option>
              </select>
            </label>
            <label className="block min-w-0 text-xs text-zinc-500">this value
              <input value={threshold.value} onChange={(e) => set({ threshold: { ...threshold, value: e.target.value } })} inputMode="numeric" placeholder="10000" aria-label="Threshold value" className={inp + ' mt-1'} />
            </label>
          </div>
          <p className="text-[11px] text-zinc-400">Either one fires the alert. A number is judged without any AI and pushes once per crossing; the sentence is judged by one small AI call over the change. Leave both blank to be told about any change.</p>
        </div>
      )}
    </div>
  );
}
