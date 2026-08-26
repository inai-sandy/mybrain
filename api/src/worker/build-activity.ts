/**
 * WHAT A BUILD TOUCHED, IN PLAIN WORDS (BEA-1492).
 *
 * A build can now make any call at all — read, create, send, delete (BEA-1491, and the gate exemption
 * that finished it). That is the right trade, and he chose it twice. What was missing beside it was
 * any way for HIM to see what a build actually did: the calls were written to his ledger with an empty
 * run id, so answering "what did that build touch?" meant querying the database by time window.
 *
 * Freedom without visibility is just hoping. This is the visibility half.
 *
 * Pure on purpose — it takes rows and returns words, so it can be tested without a database and reused
 * wherever the build is shown.
 */

export type BuildCall = { action: string; ok: boolean; error?: string | null };

export type BuildActivity = {
  total: number;
  /** One line per kind, most consequential first. */
  lines: string[];
  /** True when the build changed something in his accounts. */
  changed: boolean;
  failed: number;
};

type Kind = 'deleted' | 'sent' | 'created' | 'changed' | 'read';

/** The verb half of an action id, which is what says whether it changes anything. */
export function verbOf(actionId: string): string {
  const id = String(actionId || '');
  const tail = id.startsWith('svc:') ? id.slice(4) : id;
  const dot = tail.indexOf('.');
  return (dot >= 0 ? tail.slice(dot + 1) : tail).toLowerCase();
}

/** The service half, for saying "Gmail" rather than the whole id. */
export function serviceOf(actionId: string): string {
  const id = String(actionId || '');
  const tail = id.startsWith('svc:') ? id.slice(4) : id;
  const dot = tail.indexOf('.');
  const slug = dot >= 0 ? tail.slice(0, dot) : tail;
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : slug;
}

/**
 * What kind of thing was this?
 *
 * Matched on WHOLE WORDS of the action name, never substrings. The first version of this used
 * substring patterns and classified `fetch_emails` as a SEND, because `_email` appears inside
 * `_emails` — which would have told him a build sent four messages when it had only read his inbox.
 * Action names are underscore-separated words, so compare them as words.
 *
 * Ordered most-consequential first, because a name can carry two verbs and the worse reading should
 * win: `delete_draft_message` is a delete, not a message.
 */
const WORDS: Record<Exclude<Kind, 'read'>, string[]> = {
  deleted: ['delete', 'remove', 'archive', 'trash', 'destroy', 'revoke', 'clear'],
  sent: ['send', 'post', 'reply', 'broadcast', 'notify', 'dispatch', 'publish'],
  created: ['create', 'add', 'insert', 'upload', 'new'],
  changed: ['update', 'edit', 'patch', 'set', 'move', 'rename', 'append', 'write', 'batch'],
};

export function kindOf(actionId: string): Kind {
  const words = new Set(verbOf(actionId).split(/[^a-z0-9]+/).filter(Boolean));
  for (const k of ['deleted', 'sent', 'created', 'changed'] as const) {
    if (WORDS[k].some((w) => words.has(w))) return k;
  }
  return 'read';
}

const ORDER: Kind[] = ['deleted', 'sent', 'created', 'changed', 'read'];
const WORD: Record<Kind, string> = {
  deleted: 'deleted or archived',
  sent: 'sent',
  created: 'created',
  changed: 'changed',
  read: 'read',
};

/** "Gmail ×4, Notion ×2" — what was touched, not a wall of ids. */
function services(calls: BuildCall[]): string {
  const n = new Map<string, number>();
  for (const c of calls) {
    const s = serviceOf(c.action) || 'Something';
    n.set(s, (n.get(s) || 0) + 1);
  }
  return [...n.entries()].map(([s, c]) => (c > 1 ? `${s} ×${c}` : s)).join(', ');
}

/**
 * The whole summary. Empty in, honest empty out — "made no calls at all" is a real answer about a
 * build, and one worth seeing, because a build that never looked is exactly the one to distrust.
 */
export function buildActivity(calls: BuildCall[]): BuildActivity {
  const rows = (calls || []).filter((c) => c && c.action);
  if (!rows.length) return { total: 0, lines: ['Made no calls at all — it did not try anything before writing the program.'], changed: false, failed: 0 };

  const by = new Map<Kind, BuildCall[]>();
  for (const c of rows) {
    const k = kindOf(c.action);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(c);
  }

  const lines: string[] = [];
  for (const k of ORDER) {
    const got = by.get(k);
    if (!got?.length) continue;
    const bad = got.filter((c) => !c.ok).length;
    lines.push(`${got.length} ${WORD[k]} — ${services(got)}${bad ? ` (${bad} failed)` : ''}`);
  }

  return {
    total: rows.length,
    lines,
    changed: ORDER.slice(0, 4).some((k) => (by.get(k)?.length || 0) > 0),
    failed: rows.filter((c) => !c.ok).length,
  };
}
