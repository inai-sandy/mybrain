import { MAX_COLUMNS, MAX_ROWS, Table, tableOf } from './rows';

/**
 * How to read ONE tool's answer (BEA-1415).
 *
 * ## The hole this fills
 *
 * `tableOf()` is one reader for every vendor on earth. An answer shaped in a way it has not met
 * comes out as *"fetched 12 answers but recognised 0 rows"* — a real failure that **self-repair
 * cannot touch**, because the reader lives in the app and not in the worker. Every new tool with an
 * odd shape means the owner comes back to Claude Code, which is exactly the loop he asked to end.
 *
 * ## Why a recipe and not code
 *
 * The obvious fix is to hand the worker the raw answer and let Codex write the reading in
 * JavaScript. Rejected, twice over:
 *
 *  - The owner's Gmail message bodies would leave the app for a worker process. A wider exposure
 *    than today, for no gain. Here the answer never moves: the worker sends the recipe IN, and the
 *    app applies it to data it already holds.
 *  - Model-written reading code can **quietly** drop rows. Zero rows is loud and gets fixed. Wrong
 *    rows are silent, and silent is the failure this whole project exists to end. A recipe is small
 *    enough to check mechanically before it ever runs.
 *
 * ## The rules, all checkable
 *
 *  1. **Every path must exist** in the real answer. A made-up path is refused with a plain reason.
 *  2. **Reading is not filtering.** N items in the answer must produce N rows. Dropping things is
 *     the keep/ignore step's job, further down, where the owner can see it happen.
 *  3. **A recipe only wins when it reads MORE** than the app's own reader did. If they agree,
 *     nothing has changed; if the app read 0 and the recipe reads 12, the recipe was worth having,
 *     and the run says so.
 *
 * Pure. No Nest, no Prisma.
 */

export type ReadRecipe = {
  /** Dotted path to the list of things, e.g. `data.messages`. Empty = the answer IS one thing. */
  listPath?: string;
  /** Column name → dotted path INSIDE one item. */
  columns: Record<string, string>;
  /** Which column is the stable id, for de-duping across pages. Must be one of `columns`. */
  idField?: string;
  /** Set by the app, never by Codex: this recipe could not be used, and why. */
  refusedWhy?: string;
};

export type RecipeCheck = { ok: boolean; why?: string; items?: number };

/** Follow a dotted path. Arrays are indexed numerically (`headers.0.value`); missing = undefined. */
export function at(value: any, path: string): any {
  const parts = String(path || '').split('.').filter(Boolean);
  let cur = value;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(p);
      // A path INTO an array without an index means "the same field on every item" — used for the
      // Gmail-style `payload.headers.Subject`, which is really a list of {name,value} pairs.
      if (!Number.isInteger(i)) return byName(cur, p);
      cur = cur[i];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as any)[p];
  }
  return cur;
}

/**
 * `[{name:'Subject', value:'…'}, …]` read by name — the shape half the world's APIs use for
 * headers, custom fields and properties. Without this a recipe cannot name a Gmail subject at all.
 */
function byName(list: any[], want: string): any {
  const key = want.toLowerCase();
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const n = String((it as any).name ?? (it as any).key ?? (it as any).id ?? '').toLowerCase();
    if (n === key) return (it as any).value ?? (it as any).text ?? (it as any).content;
  }
  return undefined;
}

/** The items a recipe would read, and the path it found them at. */
export function itemsFor(data: any, recipe: ReadRecipe): { items: any[]; from: string } {
  const path = String(recipe?.listPath || '').trim();
  if (!path) {
    const one = data === undefined || data === null ? [] : [data];
    return { items: one, from: '' };
  }
  const found = at(data, path);
  if (Array.isArray(found)) return { items: found, from: path };
  // A path that resolves to one object is a single-record answer — legitimate, and the BEA-1377 case.
  if (found && typeof found === 'object') return { items: [found], from: path };
  return { items: [], from: path };
}

/**
 * May this recipe be used on this answer? Checked against the REAL answer, every run — never once at
 * build time and then trusted, because a vendor changes shape without telling anybody.
 */
export function checkRecipe(recipe: ReadRecipe, data: any): RecipeCheck {
  if (!recipe || typeof recipe !== 'object') return { ok: false, why: 'There is no recipe.' };
  const cols = recipe.columns && typeof recipe.columns === 'object' ? recipe.columns : null;
  if (!cols || !Object.keys(cols).length) return { ok: false, why: 'The recipe names no columns, so it would read nothing.' };
  if (Object.keys(cols).length > MAX_COLUMNS) return { ok: false, why: `The recipe names ${Object.keys(cols).length} columns, and ${MAX_COLUMNS} is the most a table may have.` };

  const { items, from } = itemsFor(data, recipe);
  if (!items.length) {
    return { ok: false, why: from ? `Nothing was found at "${from}" in the answer.` : 'The answer was empty.', items: 0 };
  }

  // Rule 1: every path has to exist. Checked on a handful of items, not just the first — a field
  // that is missing on item 1 and present on item 2 is normal, and refusing that would be wrong.
  const looked = items.slice(0, 20);
  const missing: string[] = [];
  for (const [name, path] of Object.entries(cols)) {
    if (!String(path || '').trim()) { missing.push(name); continue; }
    const anywhere = looked.some((it) => at(it, path) !== undefined);
    if (!anywhere) missing.push(`${name} (${path})`);
  }
  if (missing.length) {
    return { ok: false, why: `The recipe asks for ${missing.join(', ')}, and nothing at ${missing.length === 1 ? 'that path' : 'those paths'} exists in the answer.`, items: items.length };
  }

  if (recipe.idField && !cols[recipe.idField]) {
    return { ok: false, why: `The recipe says "${recipe.idField}" is the id, but it does not read a column by that name.` };
  }
  return { ok: true, items: items.length };
}

/**
 * Read the answer with the recipe. Only ever called after `checkRecipe` passed.
 *
 * **Reading is not filtering** (rule 2): every item becomes a row, even one whose every field is
 * empty. Anything else is a quiet drop, and a quiet drop is the thing the owner cannot see.
 */
export function applyRecipe(data: any, recipe: ReadRecipe): Table {
  const { items } = itemsFor(data, recipe);
  const columns = Object.keys(recipe.columns).slice(0, MAX_COLUMNS);
  const rows = items.slice(0, MAX_ROWS).map((it) => columns.map((c) => cellOf(at(it, recipe.columns[c]))));
  return { columns, rows, itemCount: items.length, listKey: recipe.listPath || undefined };
}

/** One cell, as a table holds it: a scalar as itself, anything else as short JSON. */
function cellOf(v: any): any {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  try {
    return JSON.stringify(v).slice(0, 700);
  } catch {
    return String(v);
  }
}

export type ReadOutcome = {
  table: Table;
  /** 'recipe' = the tool's own recipe read it; 'app' = the app's general reader did. */
  by: 'recipe' | 'app';
  /** Why a recipe was not used, when one was offered. Shown on the run, never swallowed. */
  why?: string;
  /** What the app's own reader made of it, for the step that explains a win. */
  appRows?: number;
};

/**
 * Read an answer, preferring the tool's own recipe.
 *
 * **A recipe that passes its checks wins.** That is a deliberate change from the first version of
 * this file, which let a recipe win only when it read MORE rows than the app's general reader. That
 * rule was wrong, and the Gmail fixture proved it inside an hour: the general reader DOES find
 * Gmail's three messages — it just calls the columns `payload.headers.0.value`. Same row count,
 * useless table, and under a count-based rule the useless one won.
 *
 * Row count is the wrong ruler. What makes a recipe trustworthy is that it was written against the
 * REAL answer and then checked, mechanically, every run: every path exists, nothing is dropped, the
 * id is a column it really reads. Once it has passed all of that it is better informed than a
 * generic guess, by construction.
 *
 * What protects the owner's nine live agents is simpler and stronger than a count: **they have no
 * recipe at all**, so they take the app's reader, untouched. And a new agent's rows are on his
 * screen in the trial before anything is kept.
 */
export function readAnswer(data: any, recipe?: ReadRecipe | null, appReader: (d: any) => Table = defaultReader): ReadOutcome {
  const app = appReader(data);
  if (!recipe) return { table: app, by: 'app' };

  const check = checkRecipe(recipe, data);
  if (!check.ok) return { table: app, by: 'app', why: check.why, appRows: app.rows.length };

  const mine = applyRecipe(data, recipe);
  // The one guard that still bites: a recipe reading fewer rows than the answer holds items is
  // filtering, and filtering here is invisible to him. Dropping things is the keep/ignore step's
  // job, further down, where he can see it happen.
  if (mine.rows.length < Math.min(check.items || 0, MAX_ROWS)) {
    return { table: app, by: 'app', why: `The recipe read ${mine.rows.length} rows out of ${check.items} things — reading may not drop anything.`, appRows: app.rows.length };
  }
  return { table: mine, by: 'recipe', appRows: app.rows.length };
}

/** The app's general reader — one reader for every vendor, and the ruler a recipe must beat. */
function defaultReader(data: any): Table {
  return tableOf(data);
}

/** The line the owner reads when a recipe changed the outcome — or was refused. */
export function readNote(out: ReadOutcome): string {
  if (out.by === 'recipe') {
    const same = out.appRows === out.table.rows.length;
    return `Read with this tool's own recipe — ${out.table.rows.length} row${out.table.rows.length === 1 ? '' : 's'}${same ? '' : `, where the general reader managed ${out.appRows ?? 0}`}.`;
  }
  if (out.why) return `This tool's recipe was not used: ${out.why} Read the usual way instead.`;
  return '';
}
