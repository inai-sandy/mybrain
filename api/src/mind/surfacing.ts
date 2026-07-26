/**
 * When is the Lab allowed to tell you something? (BEA-1142)
 *
 * Before this, it wasn't. Most findings carried evidence from ONE day: the engine saw a single
 * Tuesday and stated a trait about the person. That is the root of "60% of the time it's wrong" —
 * one day is a mood, not a pattern. Of 28 findings the owner judged 23 and refuted 16.
 *
 * So a finding now has to hold up on THREE SEPARATE DAYS before it is shown as something the Lab
 * believes. Under that it still exists and still collects evidence — it just doesn't get to make a
 * claim yet. Two exceptions, both the owner's own doing: anything he confirmed, and anything he
 * pinned. His word beats the counter.
 */
export const MIN_DAYS_TO_SURFACE = 3;

/** The Prisma `where` for "the Lab is confident enough to say this out loud". */
export const surfacedWhere = {
  status: { not: 'retired' },
  NOT: { validated: 'refuted' },
  OR: [
    { daysSeen: { gte: MIN_DAYS_TO_SURFACE } },
    { validated: 'confirmed' }, // you already told us it's true
    { pinned: true }, // you asked to keep it
  ],
};

/** Same rule, for rows already in memory. */
export function isSurfaced(f: { daysSeen?: number; validated?: string | null; pinned?: boolean; status?: string }): boolean {
  if (f.status === 'retired' || f.validated === 'refuted') return false;
  return (f.daysSeen ?? 1) >= MIN_DAYS_TO_SURFACE || f.validated === 'confirmed' || !!f.pinned;
}
