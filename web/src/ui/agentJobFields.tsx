import { useEffect, useMemo, useState } from 'react';
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

export function OutputDestPicker({ dest, sheetId, sheetAppend, onChange, onCommitSheetId, onCommitSheetAppend, compact }: { dest: string; sheetId: string; /** "Keep adding" (BEA-1374): one sheet, made on the first run, then appended to. Only meaningful with no sheetId. */ sheetAppend?: boolean; onChange: (v: { outputDest: string; sheetId: string; sheetAppend: boolean }) => void; /** Fires when the owner leaves the sheet field, with the cleaned id — the moment to save it. */ onCommitSheetId?: (id: string) => void; /** Fires when the keep-adding switch flips — the moment to save it. */ onCommitSheetAppend?: (on: boolean) => void; compact?: boolean }) {
  const nav = useNavigate();
  const cur = OUTPUT_DESTS.find((d) => d.value === dest) || OUTPUT_DESTS[0];
  const append = !!sheetAppend;
  return (
    <div className="space-y-1.5" data-testid="output-dest">
      <label className="block text-xs font-medium text-zinc-500">Where the result goes
        <select value={cur.value} onChange={(e) => onChange({ outputDest: e.target.value, sheetId, sheetAppend: append })} aria-label="Where the result goes" className={inp + ' mt-1'}>
          {OUTPUT_DESTS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </label>
      {cur.value === 'sheet' && (
        <label className="block text-xs text-zinc-500">Append to one sheet <span className="text-zinc-400">(paste its link or id · blank = {append ? 'one sheet, made on the first run' : 'a new sheet every run'})</span>
          <input value={sheetId} onChange={(e) => onChange({ outputDest: cur.value, sheetId: e.target.value, sheetAppend: append })} onBlur={(e) => { const id = sheetIdFrom(e.target.value); onChange({ outputDest: cur.value, sheetId: id, sheetAppend: append }); onCommitSheetId?.(id); }} placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Append to sheet" className={inp + ' mt-1'} />
        </label>
      )}
      {cur.value === 'sheet' && !sheetId.trim() && (
        <label className="flex cursor-pointer items-center justify-between gap-3 py-0.5" data-testid="sheet-append">
          <span className="text-xs text-zinc-500">Keep adding to one sheet <span className="text-zinc-400">— made on the first run, then every run appends; rows already there (same id / link) are skipped</span></span>
          <input type="checkbox" checked={append} onChange={(e) => { onChange({ outputDest: cur.value, sheetId, sheetAppend: e.target.checked }); onCommitSheetAppend?.(e.target.checked); }} className="h-5 w-9 shrink-0 accent-emerald-600" aria-label="Keep adding to one sheet" />
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

// ---- planning blocks (BEA-1369) ----------------------------------------------------------------

/** The Social page's page cap — their Google-indexed searches stop at 11. */
export const MAX_PAGES = 11;
export const MAX_TAKE = 50;

/** What the pages field and the creators editor read off a know-how card (BEA-1368). Null = not loaded / not known. */
export type ActionCard = { paging?: { how?: string; field?: string; pageSize?: number }; cost?: { credits?: { typical?: number } }; params?: { name: string; required?: boolean; type?: string }[]; fields?: { path: string; kind: string }[]; hasDateField?: boolean } | null;

/** One know-how card, fetched once per id (a small in-memory cache — the server caches 10 min too). Never throws; unknown → null. */
const cardCache = new Map<string, Promise<ActionCard>>();
export function fetchActionCard(id: string): Promise<ActionCard> {
  if (!id || !/^svc:/.test(id)) return Promise.resolve(null);
  let p = cardCache.get(id);
  if (!p) {
    p = Promise.resolve()
      .then(() => fetch(`/api/tools/knowledge/${encodeURIComponent(id)}`))
      .then((r: any) => (r && r.ok ? r.json() : null))
      .then((d: any) => (d && typeof d === 'object' && d.actionId ? d : null))
      .catch(() => null);
    cardCache.set(id, p);
  }
  return p;
}
export function useActionCard(id: string): ActionCard {
  const [card, setCard] = useState<ActionCard>(null);
  useEffect(() => {
    let live = true;
    setCard(null);
    fetchActionCard(id).then((c) => { if (live) setCard(c); });
    return () => { live = false; };
  }, [id]);
  return card;
}

/** Credits one call of this action usually costs — the card's typical, else 1 (and the hint says it is a default). */
export function creditsPerCall(card: ActionCard): { n: number; known: boolean } {
  const n = Number(card?.cost?.credits?.typical);
  return Number.isFinite(n) && n > 0 ? { n, known: true } : { n: 1, known: false };
}

/** 1..11 — anything else is 1 (or the cap). */
export function clampPages(v: any): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGES);
}

/** Is this `toolArgs` value a creators-first source (BEA-1369)? */
export function isCreatorsArgs(a: any): boolean {
  return !!a && typeof a === 'object' && a.kind === 'creators' && !!a.find && typeof a.find === 'object' && !!a.then && typeof a.then === 'object';
}

/** ≈ credits for one source per run: pages × per page. Plain words, and honest when the per-page cost is a default. */
export function pagesCostHint(pages: number, per: { n: number; known: boolean }): string {
  const total = pages * per.n;
  return `≈ ${total} credit${total === 1 ? '' : 's'} per run${pages > 1 ? ` (${pages} pages × ${per.n})` : ''}${per.known ? '' : ' — about 1 a page until a run shows the real cost'}`;
}

/** ≈ credits for a creators-first source per run: the finder once + one call per creator. */
export function creatorsCostHint(take: number, finder: { n: number; known: boolean }, then: { n: number; known: boolean }): string {
  const total = finder.n + take * then.n;
  return `≈ ${total} credit${total === 1 ? '' : 's'} per run (1 finder call + ${take} × ${then.n})${finder.known && then.known ? '' : ' — about 1 a call until a run shows the real cost'}`;
}

/** A tool's pinned arguments, editable one field at a time. Keys are the endpoint's own field names. A creators-first source (BEA-1369) draws its own editor. */
export function ToolArgsEditor({ tool, args, onChange, toolName, onRemove }: { tool: string; args: Record<string, any>; onChange: (next: Record<string, any>) => void; toolName?: string; /** Shown as a Remove link when a job has more than one source (BEA-1359). */ onRemove?: () => void }) {
  if (isCreatorsArgs(args)) return <CreatorsSourceEditor tool={tool} args={args} onChange={onChange} toolName={toolName} onRemove={onRemove} />;
  return <PlainSourceEditor tool={tool} args={args} onChange={onChange} toolName={toolName} onRemove={onRemove} />;
}

function PlainSourceEditor({ tool, args, onChange, toolName, onRemove }: { tool: string; args: Record<string, any>; onChange: (next: Record<string, any>) => void; toolName?: string; onRemove?: () => void }) {
  // `_pages` (BEA-1369) is a planning key, not an argument — drawn as its own field, never sent to the vendor.
  const keys = Object.keys(args || {}).filter((k) => !k.startsWith('_'));
  const card = useActionCard(tool);
  const pages = clampPages(args?._pages);
  // The pages field shows when the action pages (the card says cursor/page), or until the card has answered.
  const canPage = !card || (card.paging?.how && card.paging.how !== 'none');
  const per = creditsPerCall(card);
  return (
    <div className="space-y-1.5 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700" data-testid="tool-args">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full bg-pink-50 px-2 py-0.5 font-semibold text-pink-700 dark:bg-pink-500/10 dark:text-pink-300">📣 {toolName || 'Social'}</span>
        <code className="min-w-0 truncate text-[11px] text-zinc-400">{tool}</code>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove source ${toolName || tool}`} title="Remove this source" className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">Remove</button>
        )}
      </div>
      {keys.length === 0 && !canPage ? (
        <p className="text-[11px] text-zinc-400">This endpoint takes no inputs — it runs as is.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {keys.map((k) => (
            <label key={k} className="block min-w-0 text-xs text-zinc-500">
              <span className="block truncate font-medium">{k}</span>
              <input value={args[k] === null || args[k] === undefined ? '' : Array.isArray(args[k]) ? args[k].join(', ') : String(args[k])} onChange={(e) => onChange({ ...args, [k]: coerce(args[k], e.target.value) })} aria-label={k} className={inp + ' mt-0.5'} />
            </label>
          ))}
          {canPage && (
            <label className="block min-w-0 text-xs text-zinc-500" data-testid="pages-field">
              <span className="block truncate font-medium">pages <span className="font-normal text-zinc-400">· 1–{MAX_PAGES}</span></span>
              <input type="number" inputMode="numeric" min={1} max={MAX_PAGES} value={pages} onChange={(e) => { const n = clampPages(e.target.value); const next = { ...args }; if (n > 1) next._pages = n; else delete next._pages; onChange(next); }} aria-label="pages" className={inp + ' mt-0.5'} />
            </label>
          )}
        </div>
      )}
      <p className="text-[11px] text-zinc-400">These exact values are sent every run — no AI fills them in.{canPage ? ` ${pagesCostHint(pages, per)}${pages > 1 ? '; it follows the vendor\'s cursor page by page, de-dupes items by id and stops early on an empty page.' : '.'}` : ''}</p>
    </div>
  );
}

/** A platform's endpoints, from `/api/social/platforms/:slug` — for the creators editor's "then" picker. */
export function usePlatformActions(slug: string): { id: string; name: string; schema?: any; tags?: string[] }[] | null {
  const [list, setList] = useState<{ id: string; name: string; schema?: any; tags?: string[] }[] | null>(null);
  useEffect(() => {
    if (!slug) { setList([]); return; }
    let live = true;
    setList(null);
    Promise.resolve()
      .then(() => fetch(`/api/social/platforms/${encodeURIComponent(slug)}`))
      .then((r: any) => (r && r.ok ? r.json() : null))
      .then((d: any) => { if (live) setList(Array.isArray(d?.actions) ? d.actions : []); })
      .catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, [slug]);
  return list;
}

/** The argument of a per-creator action that names the creator — handle, username, user_id… the first that fits, else its first required one. */
export function creatorParamOf(schema: any): string {
  const props = Object.keys(schema?.properties || {});
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  const hit = props.find((p) => /^(handle|username|user_name|screen_name|user_id|userid|user|profile|channel|creator|account|id)$/i.test(p)) || props.find((p) => /handle|user|name|id/i.test(p));
  return hit || required[0] || props[0] || 'handle';
}

/** The creator field the finder's items usually carry for that argument. */
export function creatorFieldFor(param: string): string {
  return /id/i.test(param) && !/handle|name/i.test(param) ? 'id' : 'username';
}

/**
 * The creators-first source (BEA-1369): find creators once, then run one action per creator.
 * Stored as `{ kind:'creators', find:{ actionId, args, take }, then:{ actionId, argsFrom:{ <param>: <creator field> }, keepDays } }`.
 */
export function CreatorsSourceEditor({ tool, args, onChange, toolName, onRemove }: { tool: string; args: Record<string, any>; onChange: (next: Record<string, any>) => void; toolName?: string; onRemove?: () => void }) {
  const find = args.find || {};
  const then = args.then || {};
  const platform = String(find.actionId || tool).replace(/^svc:/, '').split('.')[0];
  const actions = usePlatformActions(platform);
  const finderCard = useActionCard(String(find.actionId || tool));
  const thenCard = useActionCard(String(then.actionId || ''));
  const take = Math.min(MAX_TAKE, Math.max(1, Math.floor(Number(find.take)) || 10));
  const findArgs: Record<string, any> = find.args && typeof find.args === 'object' ? find.args : {};
  const argsFrom: Record<string, string> = then.argsFrom && typeof then.argsFrom === 'object' ? then.argsFrom : {};
  const [param, field] = Object.entries(argsFrom)[0] || ['', ''];
  const thenAction = (actions || []).find((a) => a.id === then.actionId) || null;
  const thenParams = useMemo(() => Object.keys(thenAction?.schema?.properties || {}), [thenAction]);
  const setFind = (patch: any) => onChange({ ...args, find: { ...find, ...patch } });
  const setThen = (patch: any) => onChange({ ...args, then: { ...then, ...patch } });
  const hasDate = thenCard ? !!thenCard.hasDateField : null;
  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700" data-testid="creators-source">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full bg-pink-50 px-2 py-0.5 font-semibold text-pink-700 dark:bg-pink-500/10 dark:text-pink-300">📣 Find creators → their posts</span>
        <code className="min-w-0 truncate text-[11px] text-zinc-400" title={`${String(find.actionId || tool)} → ${String(then.actionId || '?')}`}>{String(find.actionId || tool)} → {String(then.actionId || '?')}</code>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove source ${toolName || tool}`} title="Remove this source" className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">Remove</button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {Object.keys(findArgs).map((k) => (
          <label key={k} className="block min-w-0 text-xs text-zinc-500">
            <span className="block truncate font-medium">find creators · {k}</span>
            <input value={findArgs[k] === null || findArgs[k] === undefined ? '' : String(findArgs[k])} onChange={(e) => setFind({ args: { ...findArgs, [k]: coerce(findArgs[k], e.target.value) } })} aria-label={`find ${k}`} className={inp + ' mt-0.5'} />
          </label>
        ))}
        <label className="block min-w-0 text-xs text-zinc-500">
          <span className="block truncate font-medium">how many creators <span className="font-normal text-zinc-400">· up to {MAX_TAKE}</span></span>
          <input type="number" inputMode="numeric" min={1} max={MAX_TAKE} value={take} onChange={(e) => setFind({ take: Math.min(MAX_TAKE, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })} aria-label="how many creators" className={inp + ' mt-0.5'} />
        </label>
        <label className="block min-w-0 text-xs text-zinc-500">
          <span className="block truncate font-medium">then, for each creator</span>
          <select value={String(then.actionId || '')} onChange={(e) => { const a = (actions || []).find((x) => x.id === e.target.value); const p = a ? creatorParamOf(a.schema) : param; setThen({ actionId: e.target.value, argsFrom: { [p]: field || creatorFieldFor(p) } }); }} aria-label="then, for each creator" className={inp + ' mt-0.5'} disabled={actions === null}>
            <option value="">{actions === null ? 'Loading…' : 'Pick one…'}</option>
            {(actions || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="block min-w-0 text-xs text-zinc-500 sm:col-span-2">
          <span className="block truncate font-medium">its argument <span className="font-normal text-zinc-400">← the creator's field that fills it</span></span>
          <div className="mt-0.5 grid grid-cols-[1fr_auto_1fr] items-center gap-1">
            {thenParams.length ? (
              <select value={param} onChange={(e) => setThen({ argsFrom: { [e.target.value]: field || creatorFieldFor(e.target.value) } })} aria-label="per-creator argument" className={inp + ' min-w-0'}>
                {!thenParams.includes(param) && param && <option value={param}>{param}</option>}
                {thenParams.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              <input value={param} onChange={(e) => setThen({ argsFrom: { [e.target.value]: field } })} placeholder="handle" aria-label="per-creator argument" className={inp + ' min-w-0'} />
            )}
            <span className="shrink-0 text-zinc-400">←</span>
            <input value={field} onChange={(e) => setThen({ argsFrom: { [param || 'handle']: e.target.value } })} placeholder="username" aria-label="creator field" className={inp + ' min-w-0'} />
          </div>
        </label>
        <label className="block min-w-0 text-xs text-zinc-500">
          <span className="block truncate font-medium">keep the last N days <span className="font-normal text-zinc-400">· blank = keep all</span></span>
          <input type="number" inputMode="numeric" min={1} value={then.keepDays === undefined || then.keepDays === null ? '' : String(then.keepDays)} onChange={(e) => { const n = Math.floor(Number(e.target.value)); const next = { ...then }; if (e.target.value.trim() === '' || !Number.isFinite(n) || n < 1) delete next.keepDays; else next.keepDays = n; onChange({ ...args, then: next }); }} placeholder="30" aria-label="keep the last days" className={inp + ' mt-0.5'} />
        </label>
      </div>
      <p className="text-[11px] text-zinc-400">
        Finds creators once, takes the first {take}, then fetches each one directly — {creatorsCostHint(take, creditsPerCall(finderCard), creditsPerCall(thenCard))}. A creator that fails is said and skipped.
        {then.keepDays ? (hasDate === false ? ` These items carry no date, so "last ${then.keepDays} days" cannot be applied — every item is kept and the run says so.` : ` Only items from the last ${then.keepDays} days are kept${hasDate === null ? ' (when the items carry a date)' : ''}.`) : ''}
      </p>
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
