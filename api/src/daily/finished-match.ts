/**
 * Which of your still-open tasks does tonight's story say you already finished? (BEA-1146)
 *
 * There was a silent hole here. The wrap-up read the story for finished work, then threw away
 * anything that overlapped a task already on the books — to avoid creating a duplicate. Sensible,
 * except the open task was then left open, and nothing said so. Tell the app "finished the user
 * manuals" and "Update user manuals for Beakn Portal", open 44 days, stayed open on day 45.
 *
 * So the same overlap that used to mean "drop this" now means "tick that one off". Nothing is
 * marked done from this alone — it only decides what comes up pre-ticked for the owner to confirm.
 */

/**
 * Filler that is long enough to slip past a plain length check. A pre-tick that fires wrongly
 * closes a task the owner never did, so the words that carry no meaning must not vote.
 */
const FILLER = new Set([
  'with', 'from', 'that', 'this', 'them', 'then', 'they', 'their', 'have', 'been', 'were', 'will',
  'about', 'into', 'over', 'some', 'more', 'also', 'just', 'when', 'what', 'your', 'ours', 'thing',
  'things', 'today', 'work', 'task', 'tasks', 'done', 'finish', 'finished', 'complete', 'completed',
]);

/** Words worth matching on: long enough to carry meaning, and not filler. */
export function sig(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 3 && !FILLER.has(w)),
  );
}

/**
 * The same overlap test the de-duplicator already used, kept deliberately identical: two tasks are
 * the same work when 60% of the shorter title's significant words appear in the other. Below two
 * words there is nothing to be 60% of, so a single shared word has to do.
 */
export function sameWork(a: string, b: string): boolean {
  const x = sig(a);
  const y = sig(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  const smaller = Math.min(x.size, y.size);
  return smaller >= 2 ? shared / smaller >= 0.6 : shared >= 1;
}

export type OpenTask = { id: string; title: string };

/**
 * Ids of the open tasks the story claims are finished. One story line can only tick ONE task —
 * "finished the manuals" must not close three different manual tasks on a single ambiguous phrase.
 * Where several match, the best overlap wins.
 */
export function matchFinishedToOpen(finishedTitles: string[], open: OpenTask[]): string[] {
  const taken = new Set<string>();
  for (const said of finishedTitles || []) {
    const words = sig(said);
    if (!words.size) continue;
    let best: { id: string; score: number } | null = null;
    for (const t of open) {
      if (taken.has(t.id)) continue;
      if (!sameWork(said, t.title)) continue;
      const other = sig(t.title);
      const shared = [...words].filter((w) => other.has(w)).length;
      const score = shared / Math.min(words.size, other.size || 1);
      if (!best || score > best.score) best = { id: t.id, score };
    }
    if (best) taken.add(best.id);
  }
  return [...taken];
}
