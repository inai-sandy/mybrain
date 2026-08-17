/**
 * A prompt-sized slice of a service's actions (BEA-1354).
 *
 * The catalog now holds EVERY action of every connected service — GitHub alone is ~800 lines. A
 * picker can page through that; a prompt cannot carry it, and pasting it would turn "which action
 * did he ask for?" into a 40,000-token question on every message. So wherever a model is shown
 * service actions to choose from, it is shown the ones that fit the owner's own words first — a
 * plain keyword match, no model call — with the vendor's "most used" mark as the tie-break, cut to
 * a fixed number per service. Everything that is not a service action passes through untouched.
 *
 * Deliberately dumb: it ranks, it never decides. The model still picks, and only from ids that were
 * really offered.
 */

export type ShortlistTool = {
  id: string;
  name: string;
  description?: string;
  service?: string;
  important?: boolean;
};

/** How many actions of one service a prompt is shown when nothing narrower was asked for. */
export const DEFAULT_PER_SERVICE = 40;

/** Words that carry no meaning for matching an action name — the usual grammar plus request filler. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'you', 'your', 'our', 'are', 'was',
  'were', 'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will', 'please', 'want', 'need', 'make',
  'get', 'let', 'just', 'now', 'then', 'about', 'what', 'which', 'when', 'where', 'how', 'all', 'any',
  'some', 'one', 'new', 'not', 'but', 'its', 'via', 'use', 'using', 'run', 'thing', 'things', 'something',
]);

/** The words of a message worth matching on: lower-case, 3+ letters, no filler, plural trimmed. */
export function keywords(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    // "issues" should find "issue"; "repositories" should still find "repository" via the stem.
    const w = raw.endsWith('ies') ? raw.slice(0, -3) + 'y' : raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    if (w.length >= 3) seen.add(w);
  }
  return [...seen];
}

/** How well one action matches the words: name hits count for three, anywhere else for one. */
export function matchScore(tool: ShortlistTool, words: string[]): number {
  if (!words.length) return 0;
  const name = String(tool.name || '').toLowerCase();
  const rest = `${tool.description || ''} ${String(tool.id || '').replace(/[._:-]+/g, ' ')}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (name.includes(w)) score += 3;
    else if (rest.includes(w)) score += 1;
  }
  return score;
}

/**
 * ONE service's actions, best match first: by keyword score, then the vendor's mark, then the
 * order they came in. Stable, so two equal actions never swap places between calls.
 */
export function rankActions<T extends ShortlistTool>(actions: T[], text: string): T[] {
  const words = keywords(text);
  return actions
    .map((t, i) => ({ t, i, s: matchScore(t, words) }))
    .sort((a, b) => b.s - a.s || Number(!!b.t.important) - Number(!!a.t.important) || a.i - b.i)
    .map((x) => x.t);
}

/**
 * A whole tool list cut down for a prompt: every non-service tool as it was, and for each service
 * only its top `perService` actions for these words. Order: non-service tools first (in their own
 * order), then services in the order they first appeared.
 */
export function shortlistForPrompt<T extends ShortlistTool>(tools: T[], text: string, perService = DEFAULT_PER_SERVICE): T[] {
  const plain: T[] = [];
  const byService = new Map<string, T[]>();
  for (const t of tools || []) {
    const svc = t.service && String(t.id || '').startsWith('svc:') ? t.service : '';
    if (!svc) { plain.push(t); continue; }
    const list = byService.get(svc) || [];
    list.push(t);
    byService.set(svc, list);
  }
  const out = [...plain];
  for (const list of byService.values()) out.push(...rankActions(list, text).slice(0, Math.max(1, perService)));
  return out;
}
