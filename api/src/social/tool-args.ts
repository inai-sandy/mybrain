import { isServiceToolId } from '../tools/service-provider';

/**
 * `Agent.toolArgs` — the storage of a Social job's sources (BEA-1374).
 *
 * The shape is keyed by SOURCE id, not action id, so one job can hold five `search_hashtag`
 * sources with five hashtags:
 *
 *   { "<sourceId>": { actionId: "svc:instagram.search_hashtag", args: { hashtag: "smarthome" }, _pages?: 3 }
 *   | { kind: "creators", find: { actionId, args, take }, then: { actionId, argsFrom, args?, keepDays? } } }
 *
 * A source id is the action id for the first source on that action, then `<action id>#2`, `#3`…
 * (`sourceIdFor`) — readable in a node id (`src:svc:instagram.search_hashtag#2`) and stable across
 * saves. `Agent.tools` keeps meaning "the action ids this job may call" (deduped); the sources are
 * the truth for what runs.
 *
 * The OLD shape `{ "<svc id>": args }` (BEA-1357→1369, `_pages` beside the args) is read
 * transparently: `normaliseToolArgs()` turns it into the new one (source id = the action id) — every
 * reader goes through it, and a save writes the new shape back. Nothing in the database has to move.
 *
 * Mirrored on the web side in `web/src/ui/toolArgs.ts` — keep the two in step.
 */

export type ToolArgsSourceEntry = { actionId: string; args: Record<string, any>; _pages?: number };
export type ToolArgsCreatorsEntry = { kind: 'creators'; find: { actionId: string; args?: Record<string, any>; take?: number }; then: { actionId?: string; argsFrom?: Record<string, string>; args?: Record<string, any>; keepDays?: number } };
export type ToolArgsEntry = ToolArgsSourceEntry | ToolArgsCreatorsEntry;
export type ToolArgsMap = Record<string, ToolArgsEntry>;

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Is this value a creators-first block (either shape — the block itself did not change)? */
export function isCreatorsEntry(v: any): v is ToolArgsCreatorsEntry {
  return isObj(v) && v.kind === 'creators' && isObj(v.find) && isObj(v.then);
}

/** Is this value already a new-shape source entry (`{ actionId, args }`)? */
export function isSourceEntry(v: any): v is ToolArgsSourceEntry {
  return isObj(v) && typeof v.actionId === 'string' && isServiceToolId(v.actionId) && (v.args === undefined || isObj(v.args)) && v.kind !== 'creators';
}

/** The pinned arguments a source sends — the planning keys (`_pages`) taken out. */
export function plainArgsOf(args: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!isObj(args)) return out;
  for (const [k, v] of Object.entries(args)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/** `svc:instagram.search_hashtag#2` → `svc:instagram.search_hashtag`; a plain id is itself. */
export function actionIdOfSourceId(sourceId: string): string {
  return String(sourceId || '').replace(/#\d+$/, '');
}

/**
 * The one reader. Any `toolArgs` value (old shape, new shape, a mix, junk) → the new shape, in the
 * order the entries were stored. Never throws; not an object → `{}`.
 */
export function normaliseToolArgs(raw: any): ToolArgsMap {
  const out: ToolArgsMap = {};
  if (!isObj(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!isObj(val)) continue;
    if (isCreatorsEntry(val)) {
      // The block is the same in both shapes; the finder's id was the key in the old one.
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
    // Old shape: the key IS the action id and the value is the args (with `_pages` beside them).
    const entry: ToolArgsSourceEntry = { actionId: actionIdOfSourceId(key), args: plainArgsOf(val) };
    if (val._pages !== undefined && val._pages !== null) entry._pages = val._pages;
    out[key] = entry;
  }
  return out;
}

/** The action id an entry calls first (the finder for a creators block). */
export function entryActionId(entry: ToolArgsEntry): string {
  return isCreatorsEntry(entry) ? String(entry.find?.actionId || '') : String(entry.actionId || '');
}

/** Every action id the map calls (sources, finders, per-creator actions), deduped, in order. */
export function actionIdsOf(map: ToolArgsMap): string[] {
  const out: string[] = [];
  for (const e of Object.values(map)) {
    const ids = isCreatorsEntry(e) ? [e.find?.actionId, e.then?.actionId] : [e.actionId];
    for (const id of ids) if (id && typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The action ids a job may call: the map's actions ∪ the tools it already lists (a source id that slipped in is dropped), deduped. */
export function toolsFor(map: ToolArgsMap, tools?: any): string[] {
  const keep: string[] = [];
  if (Array.isArray(tools)) for (const t of tools) if (typeof t === 'string' && t && !(isServiceToolId(actionIdOfSourceId(t)) && /#\d+$/.test(t))) keep.push(t);
  const out: string[] = [];
  for (const t of [...keep, ...actionIdsOf(map)]) if (!out.includes(t)) out.push(t);
  return out;
}

/** A free source id for this action: the action id itself, then `#2`, `#3`… */
export function sourceIdFor(actionId: string, taken: string[]): string {
  const used = new Set<string>(taken);
  if (!used.has(actionId)) return actionId;
  let n = 2;
  while (used.has(`${actionId}#${n}`)) n++;
  return `${actionId}#${n}`;
}

/**
 * The value the argument editors and the old readers understand: a creators block as is, else the
 * plain args with `_pages` beside them (the OLD per-source value). The inverse of one `normaliseToolArgs`
 * entry, for code that still thinks per action.
 */
export function legacyValueOf(entry: ToolArgsEntry): Record<string, any> {
  if (isCreatorsEntry(entry)) return entry as any;
  const v: Record<string, any> = { ...plainArgsOf(entry.args) };
  if (entry._pages !== undefined && entry._pages !== null && Number(entry._pages) > 1) v._pages = entry._pages;
  return v;
}

/** A new-shape entry from an action id + the editor's value (plain args + `_pages`, or a creators block). */
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
