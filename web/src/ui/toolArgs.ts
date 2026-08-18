/**
 * `Agent.toolArgs` on the web side (BEA-1374) — a MIRROR of `api/src/social/tool-args.ts`; keep the
 * two in step.
 *
 * Sources are keyed by SOURCE id, so one job can hold five hashtag searches on the same action:
 *   { "<sourceId>": { actionId, args, _pages? } | { kind:'creators', find, then } }
 * A source id is the action id for the first source on that action, then `<action id>#2`, `#3`….
 * The old shape `{ "<svc id>": args }` still reads (source id = action id) — `normaliseToolArgs`.
 *
 * The editors (`ToolArgsEditor`) still think per source in the OLD per-source value (plain args with
 * `_pages` beside them, or a creators block): `sourcesOf()` hands them that, `toolArgsOf()` builds the
 * new shape back for the save.
 */

export type ToolArgsSourceEntry = { actionId: string; args: Record<string, any>; _pages?: number };
export type ToolArgsCreatorsEntry = { kind: 'creators'; find: { actionId: string; args?: Record<string, any>; take?: number }; then: Record<string, any> };
export type ToolArgsEntry = ToolArgsSourceEntry | ToolArgsCreatorsEntry;
export type ToolArgsMap = Record<string, ToolArgsEntry>;

/** One source as the form/Settings hold it: its id, its action, and the editor's value. */
export type SourceRow = { id: string; actionId: string; value: Record<string, any> };

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSvc = (s: any) => typeof s === 'string' && /^svc:[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(s);

export function isCreatorsEntry(v: any): v is ToolArgsCreatorsEntry {
  return isObj(v) && v.kind === 'creators' && isObj(v.find) && isObj(v.then);
}
function isSourceEntry(v: any): v is ToolArgsSourceEntry {
  return isObj(v) && typeof v.actionId === 'string' && isSvc(v.actionId) && (v.args === undefined || isObj(v.args)) && v.kind !== 'creators';
}
function plainArgsOf(args: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!isObj(args)) return out;
  for (const [k, v] of Object.entries(args)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/** `svc:instagram.search_hashtag#2` → `svc:instagram.search_hashtag`. */
export function actionIdOfSourceId(sourceId: string): string {
  return String(sourceId || '').replace(/#\d+$/, '');
}

/** Any `toolArgs` value (old shape, new shape, junk) → the new shape, in stored order. Never throws. */
export function normaliseToolArgs(raw: any): ToolArgsMap {
  const out: ToolArgsMap = {};
  if (!isObj(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!isObj(val)) continue;
    if (isCreatorsEntry(val)) {
      const find = { ...val.find };
      if (!find.actionId || typeof find.actionId !== 'string') find.actionId = actionIdOfSourceId(key);
      out[key] = { ...val, kind: 'creators', find, then: { ...val.then } };
      continue;
    }
    if (isSourceEntry(val)) {
      const entry: ToolArgsSourceEntry = { actionId: val.actionId, args: plainArgsOf(val.args) };
      const pages = val._pages !== undefined ? val._pages : (val.args as any)?._pages;
      if (pages !== undefined && pages !== null) entry._pages = pages;
      out[key] = entry;
      continue;
    }
    const entry: ToolArgsSourceEntry = { actionId: actionIdOfSourceId(key), args: plainArgsOf(val) };
    if (val._pages !== undefined && val._pages !== null) entry._pages = val._pages;
    out[key] = entry;
  }
  return out;
}

/** The action an entry calls first (the finder for a creators block). */
export function entryActionId(entry: ToolArgsEntry): string {
  return isCreatorsEntry(entry) ? String(entry.find?.actionId || '') : String(entry.actionId || '');
}

/** The editor's value for an entry: a creators block as is, else plain args + `_pages` beside them. */
export function legacyValueOf(entry: ToolArgsEntry): Record<string, any> {
  if (isCreatorsEntry(entry)) return entry as any;
  const v: Record<string, any> = { ...plainArgsOf(entry.args) };
  if (entry._pages !== undefined && entry._pages !== null && Number(entry._pages) > 1) v._pages = entry._pages;
  return v;
}

/** A new-shape entry from an action id + the editor's value. */
export function entryOf(actionId: string, value: any): ToolArgsEntry {
  if (isCreatorsEntry(value)) {
    const find = { ...value.find };
    if (!find.actionId) find.actionId = actionId;
    return { ...value, kind: 'creators', find, then: { ...value.then } };
  }
  const entry: ToolArgsSourceEntry = { actionId, args: plainArgsOf(value) };
  if (isObj(value) && value._pages !== undefined && value._pages !== null) entry._pages = value._pages;
  return entry;
}

/** A free source id for this action among `taken`: the action id itself, then `#2`, `#3`… */
export function sourceIdFor(actionId: string, taken: string[]): string {
  const used = new Set<string>(taken);
  if (!used.has(actionId)) return actionId;
  let n = 2;
  while (used.has(`${actionId}#${n}`)) n++;
  return `${actionId}#${n}`;
}

/** The sources of a `toolArgs` value, as rows the editors draw. */
export function sourcesOf(raw: any): SourceRow[] {
  return Object.entries(normaliseToolArgs(raw)).map(([id, e]) => ({ id, actionId: entryActionId(e), value: legacyValueOf(e) }));
}

/** Rows → the `toolArgs` to save (new shape), keyed by each row's id. */
export function toolArgsOf(rows: SourceRow[]): ToolArgsMap {
  const out: ToolArgsMap = {};
  for (const r of rows) out[r.id] = entryOf(r.actionId, r.value);
  return out;
}

/** The action ids a job may call — every source's action (and a creators block's per-creator action), deduped, in order. */
export function toolsOf(rows: SourceRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const ids = isCreatorsEntry(r.value) ? [r.actionId, r.value.then?.actionId] : [r.actionId];
    for (const id of ids) if (id && typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Add a source: a fresh id for its action (`#2` when the action is already there). */
export function addSourceRow(rows: SourceRow[], actionId: string, value: Record<string, any>): SourceRow[] {
  return [...rows, { id: sourceIdFor(actionId, rows.map((r) => r.id)), actionId, value }];
}
