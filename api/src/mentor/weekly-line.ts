/**
 * The one line the Lab is allowed to send you in a week. (BEA-1144)
 *
 * The Lab's real failure was never the maths — it was that it waited to be visited. It had produced
 * 48 nightly reads, 5 weekly reviews, 29 chains and 13 focus areas, and almost none of it had been
 * read. The owner: "Because I am not understanding, I am not using it."
 *
 * So once a week it comes to him instead. One sentence, one link. And the rule that makes it worth
 * opening: SILENCE BEATS A WEEKLY NOTHING. A message that arrives every Sunday regardless of whether
 * there is anything to say trains you to ignore it within a month. If nothing crossed the bar this
 * week, nothing is sent — and that costs nothing, because everything here is picked from what the
 * weekly review already wrote. No extra AI call.
 */

export type WeeklyPick = { line: string; source: 'action' | 'experiment' | 'pattern' };

export type PickInput = {
  /** Findings the Lab actually believes — 3+ separate days, or you confirmed them. */
  findings: { action?: string | null; statement?: string; daysSeen?: number; validated?: string | null }[];
  /** This week's review, if one was written. */
  review: { pattern?: string | null; experiment?: string | null } | null;
  /** The line sent last week — never send the same sentence twice in a row. */
  lastSent?: string | null;
};

const clean = (s: unknown): string => String(s || '').replace(/\s+/g, ' ').trim();

/** Same thing said twice? Compare on letters only, so punctuation drift doesn't sneak a repeat through. */
function sameAs(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  return !!x && x === y;
}

/**
 * Pick the single most useful thing, best first:
 *   1. The action on the finding with the most days behind it — it names a thing and asks for a move.
 *   2. The experiment the weekly review proposed for next week.
 *   3. The pattern the weekly review noticed.
 * Returns null when there is nothing worth the interruption.
 */
export function pickWeeklyLine(input: PickInput): WeeklyPick | null {
  const last = clean(input.lastSent);

  const withAction = (input.findings || [])
    .filter((f) => f.validated !== 'refuted' && clean(f.action).length >= 8)
    .sort((a, b) => (b.daysSeen ?? 1) - (a.daysSeen ?? 1));

  const candidates: WeeklyPick[] = [];
  for (const f of withAction) candidates.push({ line: clean(f.action), source: 'action' });
  const exp = clean(input.review?.experiment);
  if (exp.length >= 8) candidates.push({ line: exp, source: 'experiment' });
  const pat = clean(input.review?.pattern);
  if (pat.length >= 8) candidates.push({ line: pat, source: 'pattern' });

  for (const c of candidates) {
    if (last && sameAs(c.line, last)) continue; // said that last week
    if (c.line.length > 300) continue; // a paragraph is not a line
    return c;
  }
  return null;
}

/** How the message reads. Short enough to take in from a lock screen. */
export function weeklyMessage(pick: WeeklyPick): string {
  const lead = pick.source === 'action' ? 'One thing worth doing this week' : pick.source === 'experiment' ? 'Worth trying this week' : 'What I noticed this week';
  return `🧪 ${lead}:\n${pick.line}\n\nThe why: https://mybrain.1site.ai/lab`;
}
