/**
 * What a tool taught us by being used (BEA-1409, "Brief First" 5/6).
 *
 * The owner asked the sharpest question of the whole redesign: *"How does Codex know about all the
 * tools we are using and the actions each tool has?"*
 *
 * Three things feed it. Two are automatic and complete — the vendor's own schema, and real saved
 * answers. The third is **35 hand-written notes** in `knowledge-notes.ts`, against thousands of
 * available actions. The Gmail trap (`max_results` defaults to **1**) is known only because it cost
 * him a night and then a human typed it in. A tool nobody has used has no notes at all, so the first
 * agent on it is guaranteed to be wrong, and he ends up back in Claude Code. That loop is what this
 * file ends.
 *
 * Two rules make it trustworthy:
 *
 * 1. **No model ever writes a lesson.** Every one is derived here, mechanically, from what was asked
 *    and what came back. A model inventing know-how would be exactly as wrong as the bug it is meant
 *    to prevent, and far more convincing.
 * 2. **Structure only, never content.** A lesson may name a parameter, a field path, a count, or the
 *    shape of an answer. It may never carry a value out of one. That is what makes it safe to learn
 *    from Gmail, WhatsApp and every other service whose answers are deliberately never kept —
 *    which matters, because those are precisely the ones with no notes.
 */

export type LessonKind = 'silent-default' | 'more-pages' | 'cap-hit' | 'ignored-argument' | 'single-object' | 'shape';

export type Lesson = {
  /** Stable within an action, so seeing the same thing twice raises a count instead of adding a row. */
  key: string;
  kind: LessonKind;
  /** Plain English — this is shown to the owner on the tool card and given to Codex. */
  text: string;
  /** The parameter it is about, when it is about one. */
  param?: string;
  /** For a `shape` lesson: where the things are, and what one of them carries. Paths only. */
  shape?: LearnedShape;
};

/**
 * The shape of an answer, learned by looking at a real one (BEA-1415).
 *
 * **Paths and types. Never a value.** That is the whole reason this can exist for Gmail, WhatsApp
 * and Slack — whose answers are deliberately never kept, and which are therefore exactly the tools
 * that had no saved answer for Codex to write a reading recipe from. The first version of the recipe
 * work missed that completely: it helped the tools the app already read well, and could not help the
 * one that started the whole conversation.
 */
export type LearnedShape = {
  /** Dotted path to the list of things. Empty when the answer IS one thing. */
  listPath: string;
  /** Every field one item carries, as a path and a rough type. */
  fields: { path: string; kind: string }[];
  /** How many things that one answer held — so a recipe can be checked against it later. */
  items: number;
};

export type LessonInput = {
  actionId: string;
  service: string;
  /** The arguments as they were really sent. */
  args: Record<string, any>;
  /** The arguments the caller asked for, before any were dropped for not being in the schema. */
  asked?: Record<string, any>;
  /** The action's own input schema (`{ properties, required }`). */
  schema?: any;
  /** The whole answer. Read for shape and counts only — never for values. */
  data: any;
};

/** Services we never learn from at all. Structure is safe, but a vault is a vault. */
export const NO_LESSON_SERVICES = new Set(['vault']);

/** Names that mean "how many do you want". The Gmail bug lives behind the first of these. */
const COUNT_PARAM_RE = /^(max_?results?|limit|count|per_?page|page_?size|num|n|top|size)$/i;

/** Where a "there is more" marker lives, across the vendors we have met. */
const CURSOR_KEYS = ['nextPageToken', 'next_page_token', 'nextCursor', 'next_cursor', 'cursor', 'next_max_id', 'end_cursor', 'paging_token', 'after', 'next'];

/** Keys whose value is a list of things, as opposed to a list of parts of one thing. */
const LIST_KEYS = ['items', 'data', 'results', 'messages', 'posts', 'rows', 'records', 'entries', 'list', 'edges', 'files', 'emails', 'threads'];

function isPlainObject(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The list in an answer, and the key it sat under. Top level only — a bio's links are not the list. */
export function listIn(data: any): { key: string; items: any[] } | null {
  if (Array.isArray(data)) return { key: '', items: data };
  if (!isPlainObject(data)) return null;
  for (const k of LIST_KEYS) {
    if (Array.isArray((data as any)[k])) return { key: k, items: (data as any)[k] };
  }
  // A single wrapper (`{ success, data: {...} }`) — look one level in, and no further.
  for (const k of Object.keys(data)) {
    const v = (data as any)[k];
    if (isPlainObject(v)) {
      for (const kk of LIST_KEYS) if (Array.isArray(v[kk])) return { key: `${k}.${kk}`, items: v[kk] };
    }
  }
  return null;
}

/** The "there is another page" marker, if the answer carries one. Its NAME only — never its value. */
export function cursorIn(data: any): string {
  const look = (o: any, prefix = ''): string => {
    if (!isPlainObject(o)) return '';
    for (const k of CURSOR_KEYS) {
      const v = (o as any)[k];
      if (v !== undefined && v !== null && v !== '' && v !== false) return `${prefix}${k}`;
    }
    return '';
  };
  const top = look(data);
  if (top) return top;
  if (isPlainObject(data)) {
    for (const k of ['paging', 'page_info', 'pageInfo', 'meta', 'data']) {
      const found = look((data as any)[k], `${k}.`);
      if (found) return found;
    }
  }
  return '';
}

function schemaProps(schema: any): Record<string, any> {
  return isPlainObject(schema?.properties) ? schema.properties : {};
}

/** The vendor's stated maximum for a parameter, when it states one. */
function maxOf(prop: any): number | null {
  for (const k of ['maximum', 'max', 'exclusiveMaximum']) {
    const n = Number(prop?.[k]);
    if (Number.isFinite(n) && n > 0) return k === 'exclusiveMaximum' ? n - 1 : n;
  }
  return null;
}

function defaultOf(prop: any): number | null {
  const n = Number(prop?.default);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A path segment that is really a VALUE — an id, an e-mail, a phone number — is never written down. */
const VALUEY_SEGMENT = /@|^\+?\d[\d\s().-]{6,}$|^[0-9a-f]{16,}$|^\d{6,}$/i;

/** How deep into an item a path may go. Deeper than this is a payload, not a shape. */
const SHAPE_DEPTH = 4;
/** How many field paths are worth writing down for one action. */
const SHAPE_FIELDS = 60;

function kindOf(v: any): string {
  if (v === null || v === undefined) return 'empty';
  if (Array.isArray(v)) return 'list';
  switch (typeof v) {
    case 'number': return 'number';
    case 'boolean': return 'bool';
    case 'string': return /^https?:\/\//i.test(v) ? 'url' : 'text';
    default: return 'object';
  }
}

/**
 * Walk ONE item and write down every path it carries. Paths and types only.
 *
 * A list of `{name, value}` pairs — headers, custom fields, properties, the shape half the world's
 * APIs use — is written down by the NAMES it holds (`payload.headers.Subject`), because that is how
 * a recipe has to ask for it, and because the alternative (`payload.headers.0.value`) is exactly the
 * useless column the general reader already produces.
 */
export function fieldsOfItem(item: any, prefix = '', depth = 0, out: { path: string; kind: string }[] = []): { path: string; kind: string }[] {
  if (depth > SHAPE_DEPTH || out.length >= SHAPE_FIELDS || !item || typeof item !== 'object') return out;
  if (Array.isArray(item)) {
    // A name/value list: record the names, which is how a recipe reaches into it.
    const named = item.filter((x) => x && typeof x === 'object' && ('name' in x || 'key' in x));
    if (named.length) {
      for (const n of named.slice(0, 20)) {
        const name = String((n as any).name ?? (n as any).key ?? '');
        if (!name || VALUEY_SEGMENT.test(name)) continue;
        out.push({ path: `${prefix}${prefix ? '.' : ''}${name}`, kind: kindOf((n as any).value ?? (n as any).text ?? (n as any).content) });
        if (out.length >= SHAPE_FIELDS) return out;
      }
      return out;
    }
    // An ordinary list inside an item: one level, through its first entry.
    if (item.length && item[0] && typeof item[0] === 'object') fieldsOfItem(item[0], `${prefix}${prefix ? '.' : ''}0`, depth + 1, out);
    return out;
  }
  for (const [k, v] of Object.entries(item)) {
    if (out.length >= SHAPE_FIELDS) break;
    // A key that is itself a value (an object keyed by e-mail or id) is a payload, not a shape.
    if (VALUEY_SEGMENT.test(k)) continue;
    const path = `${prefix}${prefix ? '.' : ''}${k}`;
    if (v && typeof v === 'object') {
      out.push({ path, kind: kindOf(v) });
      fieldsOfItem(v, path, depth + 1, out);
    } else {
      out.push({ path, kind: kindOf(v) });
    }
  }
  return out;
}

/**
 * The shape of a whole answer: where the things are, and what one of them carries.
 *
 * Every field seen across the first few items is kept, not just the first item's — a subject line
 * missing from item 1 and present on item 2 is ordinary, and a recipe written from item 1 alone
 * would leave the column out.
 */
export function shapeOf(data: any): LearnedShape | null {
  const list = listIn(data);
  const items = list ? list.items : data && typeof data === 'object' ? [data] : [];
  if (!items.length) return null;
  const seen = new Map<string, string>();
  for (const it of items.slice(0, 5)) {
    for (const f of fieldsOfItem(it)) if (!seen.has(f.path)) seen.set(f.path, f.kind);
    if (seen.size >= SHAPE_FIELDS) break;
  }
  if (!seen.size) return null;
  return { listPath: list ? list.key : '', fields: [...seen].map(([path, kind]) => ({ path, kind })), items: items.length };
}

/**
 * Everything this one call taught us. Pure, cheap, and it runs on every successful call — including
 * the ones whose answers we are not allowed to keep.
 */
export function lessonsFrom(input: LessonInput): Lesson[] {
  const out: Lesson[] = [];
  const service = String(input.service || '').toLowerCase();
  if (NO_LESSON_SERVICES.has(service)) return out;

  const args = isPlainObject(input.args) ? input.args : {};
  const props = schemaProps(input.schema);
  const list = listIn(input.data);
  const cursor = cursorIn(input.data);
  const n = list ? list.items.length : null;
  const action = String(input.actionId || '').replace(/^svc:/, '');

  // ---- 1. the silent default: THE Gmail bug, learned without anybody typing a note ----------------
  for (const [name, prop] of Object.entries(props)) {
    if (!COUNT_PARAM_RE.test(name)) continue;
    const asked = args[name];
    const wasSent = asked !== undefined && asked !== null && asked !== '';
    const dflt = defaultOf(prop);
    if (!wasSent && n !== null && n > 0 && (n === 1 || (dflt !== null && n === dflt))) {
      // One row back while the answer itself says there is more is the whole tell. Without the
      // cursor it may honestly be all there was, and a lesson that fails a good run is worse than none.
      if (cursor) {
        out.push({
          key: `silent-default:${name}`,
          kind: 'silent-default',
          param: name,
          text: `\`${name}\` was left out and only ${n} came back, while the answer says there is another page (\`${cursor}\`). This action's own default is small${dflt ? ` (${dflt})` : ''} — always set \`${name}\`, and page for the rest.`,
        });
      }
    }
    // ---- 3. asked for N, got exactly the vendor's ceiling ---------------------------------------
    const cap = maxOf(prop);
    if (wasSent && cap !== null && n !== null && n === cap && Number(asked) >= cap) {
      out.push({
        key: `cap-hit:${name}`,
        kind: 'cap-hit',
        param: name,
        text: `${cap} is the most this action will give in one call — \`${name}\` was set to ${Number(asked)} and exactly ${cap} came back. Page for anything beyond that.`,
      });
    }
  }

  // ---- 2. there is more, and this is how you ask for it -------------------------------------------
  if (cursor) {
    out.push({
      key: `more-pages:${cursor}`,
      kind: 'more-pages',
      // The cursor's NAME, machine-readable, so the pager can follow what we learned instead of the
      // app's guess (BEA-1415). The name only — never its value.
      param: cursor,
      text: `This action pages: the answer carries \`${cursor}\`${n !== null ? `, and one page held ${n}` : ''}. Keep asking until it stops coming back.`,
    });
  }

  // ---- 4. an argument that was quietly dropped -----------------------------------------------------
  // `runDetailed` keeps only arguments the schema names, so a misspelt one vanishes without a word
  // and the call runs without it. That is written down in CLAUDE.md as a trap; here it teaches itself.
  const known = new Set(Object.keys(props));
  if (known.size) {
    for (const name of Object.keys(isPlainObject(input.asked) ? input.asked! : {})) {
      if (known.has(name) || name.startsWith('_')) continue;
      out.push({
        key: `ignored-argument:${name}`,
        kind: 'ignored-argument',
        param: name,
        text: `\`${name}\` is not something this action takes, so it was dropped and the call ran without it. Check the spelling against its own list.`,
      });
    }
  }

  // ---- 6. the SHAPE: where the things are and what they carry ---------------------------------------
  // Paths and types only, so this works for Gmail and WhatsApp, whose answers are never kept — and
  // which are therefore exactly the tools with nothing for Codex to write a reading recipe from.
  const shape = shapeOf(input.data);
  if (shape) {
    out.push({
      key: 'shape',
      kind: 'shape',
      shape,
      text: `Its answer holds ${shape.items} thing${shape.items === 1 ? '' : 's'}${shape.listPath ? ` at \`${shape.listPath}\`` : ' as one record'}, each carrying ${shape.fields.slice(0, 8).map((f) => `\`${f.path}\``).join(', ')}${shape.fields.length > 8 ? ` and ${shape.fields.length - 8} more` : ''}.`,
    });
  }

  // ---- 5. one object where a list was expected — the BEA-1377 shape --------------------------------
  if (!list && isPlainObject(input.data) && /search|list|posts|feed|emails|messages|results/i.test(action)) {
    out.push({
      key: 'single-object',
      kind: 'single-object',
      text: 'This answers with one object, not a list, even though its name sounds like a search. Read it as a single row.',
    });
  }

  return out;
}


/**
 * The name of the ARGUMENT you send a cursor back in, from the name of the field it arrived in
 * (BEA-1415). Vendors almost never use the same word for both — Gmail answers `nextPageToken` and
 * expects `page_token`; Instagram answers `next_max_id` and expects `next_max_id`.
 *
 * The same mapping `pagingOf()` has always used, lifted out so the learned cursor and the guessed
 * one can never drift apart.
 */
export function cursorParamFor(answerKey: string): string {
  const k = String(answerKey || '').split('.').pop() || '';
  if (/max_id/i.test(k)) return 'next_max_id';
  if (/token/i.test(k)) return 'page_token';
  if (/page_id/i.test(k)) return 'next_page_id';
  return 'cursor';
}
