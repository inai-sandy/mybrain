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

export type LessonKind = 'silent-default' | 'more-pages' | 'cap-hit' | 'ignored-argument' | 'single-object';

export type Lesson = {
  /** Stable within an action, so seeing the same thing twice raises a count instead of adding a row. */
  key: string;
  kind: LessonKind;
  /** Plain English — this is shown to the owner on the tool card and given to Codex. */
  text: string;
  /** The parameter it is about, when it is about one. */
  param?: string;
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
