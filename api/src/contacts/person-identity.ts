/**
 * One person = one Contact, unified by aliases. These pure helpers are the single place that
 * decides whether a name (from a task, a story mention, a reminder party) refers to a Contact,
 * and expands a Contact to every spelling to search for. Used across contacts/daily/tasks. (BEA-763)
 */

export type PersonContact = { id: string; name: string; aliases?: string[] };

/** Normalise a name for matching: trimmed, lowercased, single-spaced. */
export function norm(s?: string | null): string {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Every spelling of a contact: their name + all aliases (originals, de-duped, non-empty). */
export function contactSpellings(c: PersonContact): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [c.name, ...(c.aliases || [])]) {
    const t = String(s || '').trim();
    if (t && !seen.has(norm(t))) { seen.add(norm(t)); out.push(t); }
  }
  return out;
}

/** The contact a name refers to — matched by its name OR any alias (case-insensitive), else null. */
export function matchContact<T extends PersonContact>(contacts: T[], name: string): T | null {
  const n = norm(name);
  if (!n) return null;
  return contacts.find((c) => contactSpellings(c).some((s) => norm(s) === n)) || null;
}

/** Names to search for given a query: the matching contact's full spelling set, else just the name. */
export function spellingsForName(contacts: PersonContact[], name: string): string[] {
  const c = matchContact(contacts, name);
  if (c) return contactSpellings(c);
  const t = String(name || '').trim();
  return t ? [t] : [];
}

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/**
 * Cheap 0–1 similarity for fuzzy alias suggestions (no deps): exact, containment ("vijay" ⊂
 * "vijaya durga"), shared name token, or a strong first-name prefix. ≥0.55 is worth suggesting.
 */
export function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const ta = new Set(x.split(' '));
  const tb = new Set(y.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  if (inter) return 0.6 + 0.2 * (inter / Math.max(ta.size, tb.size));
  const fa = x.split(' ')[0];
  const fb = y.split(' ')[0];
  const p = commonPrefix(fa, fb);
  if (p >= 4 && (p >= fa.length - 1 || p >= fb.length - 1)) return 0.55;
  return 0;
}
