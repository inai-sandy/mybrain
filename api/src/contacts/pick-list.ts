/**
 * Turning "which one do you mean?" into something you tap. (BEA-1302)
 *
 * BEA-1294 made an ambiguous "done" safe: nothing is claimed, and the person is sent their open
 * items as a numbered list with a link to their page. Safe, but it asks them to type a number or
 * open a browser — and the whole reason this run exists is that a message they have to interpret
 * is a message that goes wrong.
 *
 * Now that a tap carries its own id, the same moment can be one tap: Deepthi taps Done, her tap
 * opens the 24-hour window, and a list of exactly her three jobs comes back. She taps one. Done.
 *
 * The wording lives here, apart from the sending, because the rules about it are worth testing on
 * their own — particularly the one that decides when a list is NOT good enough.
 */

/** The prefix on every row id, so a tap can be told apart from any other list this app might send. */
export const TASK_ROW = 'task:';

/** WhatsApp's own limits, mirrored so a list is never built that Postbox will refuse. */
export const PICK_LIMITS = { rows: 10, title: 24 } as const;

export type PickRow = { id: string; title: string; description?: string };

/** The task id behind a tapped row, or null if this row was not one of ours. */
export function taskIdFromRow(rowId?: string | null): string | null {
  const s = String(rowId || '').trim();
  return s.startsWith(TASK_ROW) ? s.slice(TASK_ROW.length) || null : null;
}

/**
 * Shorten a job title to fit a row, keeping the part that tells it apart from the others.
 *
 * Cutting from the front is deliberate. "Keep finished tested stock at 250 units, finished
 * untested at 100" and "Keep 150 units of each SKU ready for Beacon" share their opening words, so
 * a plain cut from the left would produce two rows reading "Keep finished tested…" and "Keep 150
 * units of…" — better, but a near-miss of the same shape is exactly what this is meant to prevent.
 * So the caller checks the result for collisions and falls back to text if any remain.
 */
export function rowTitle(title: string, max: number = PICK_LIMITS.title): string {
  const s = String(title || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  // Prefer a clean word boundary, but never at the cost of losing most of the label.
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.trim()}…`;
}

export type PickList = {
  /** The question, including the "there are more" line when there is one. */
  body: string;
  buttonText: string;
  rows: PickRow[];
  /**
   * Said out loud when there were more jobs than a list can carry — and carried in the BODY, not
   * the footer.
   *
   * A footer is capped at 60 characters and truncated silently, so "The rest are on your page:
   * https://mybrain.1site.ai/t/deepthi-a6r8" arrived as a broken, unclickable link. The note existed
   * precisely so nothing was dropped quietly, and it was being dropped quietly. The body has 1024
   * characters; the link survives there. (review finding)
   */
  note?: string;
};

/**
 * Build the list, or return null when a list would be worse than the text version.
 *
 * Returns null when there is nothing to choose between (fewer than two jobs), or when two rows
 * would read the same after shortening. A list whose rows cannot be told apart is not a question,
 * it is a coin toss — and the caller has a numbered text version that has room to say more.
 */
export function buildPickList(
  tasks: { id: string; title: string }[],
  opts: { name?: string; link?: string | null } = {},
): PickList | null {
  const real = (tasks || []).filter((t) => t?.id && String(t.title || '').trim());
  if (real.length < 2) return null;

  const shown = real.slice(0, PICK_LIMITS.rows);
  const rows: PickRow[] = shown.map((t) => ({
    id: `${TASK_ROW}${t.id}`,
    title: rowTitle(t.title),
    // The full title goes in the description, which has three times the room. A shortened title is
    // a label; this is what they actually read before deciding.
    ...(rowTitle(t.title) !== t.title.trim() ? { description: t.title.trim() } : {}),
  }));

  // Two rows reading the same is the failure this exists to prevent, arriving by another door.
  if (new Set(rows.map((r) => r.title.toLowerCase())).size !== rows.length) return null;

  const dropped = real.length - shown.length;
  const first = String(opts.name || '').trim().split(/\s+/)[0];
  const note = dropped
    ? `That's ${shown.length} of ${real.length}. The rest are on your page${opts.link ? `: ${opts.link}` : '.'}`
    : undefined;
  const question = `${first ? `Thanks ${first}! ` : ''}Which one is done?`;
  return {
    body: note ? `${question}\n\n${note}` : question,
    buttonText: 'Choose one',
    rows,
    ...(note ? { note } : {}),
  };
}
