/**
 * The one rule for "which tasks belong to a given day", shared by TasksService and by the test doubles
 * that stand in for it. It lives on its own so a screen, a nightly AI prompt and a test can never each
 * carry their own slightly different idea of what a day contains — which is exactly how Today came to
 * report 41 open tasks while History reported 0. (BEA-1018)
 *
 * A day's record is everything FINISHED that day (judged by completedAt, so a task added on the 1st and
 * finished on the 20th is the 20th's work) plus everything that was STILL OPEN at the end of it.
 */
export function whereForDayRule(day: string, start: Date, end: Date): any {
  return {
    OR: [
      { completedAt: { gte: start, lt: end } },
      { day: { lte: day }, OR: [{ status: { not: 'done' } }, { completedAt: { gte: end } }] },
      // A finished task with no completedAt can't be placed by when it was done, so fall back to the day
      // it holds — otherwise it would vanish from history altogether rather than land a day off.
      { status: 'done', completedAt: null, day },
    ],
  };
}

/**
 * Evaluate a Prisma `where` against a plain object. Used by the unit tests' in-memory doubles: hand-rolled
 * fakes silently ignored nested shapes, and a fake that cannot see the query cannot catch a wrong one.
 * Covers what the task queries actually use — AND/OR/NOT nesting and gt/gte/lt/lte/not/in/equals.
 */
export function matchesWhere(row: any, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((c) => matchesWhere(row, c));
    if (key === 'AND') return (cond as any[]).every((c) => matchesWhere(row, c));
    if (key === 'NOT') return !matchesWhere(row, cond);
    const v = row[key];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return v != null && new Date(v).getTime() === cond.getTime();
    if (typeof cond !== 'object') return v === cond;
    return Object.entries(cond).every(([op, want]: [string, any]) => {
      const cmp = (a: any) => (a instanceof Date || want instanceof Date ? new Date(a).getTime() : a);
      switch (op) {
        case 'equals': return want === null ? v === null || v === undefined : cmp(v) === cmp(want);
        case 'not': return want === null ? v !== null && v !== undefined : cmp(v) !== cmp(want);
        case 'gt': return v != null && cmp(v) > cmp(want);
        case 'gte': return v != null && cmp(v) >= cmp(want);
        case 'lt': return v != null && cmp(v) < cmp(want);
        case 'lte': return v != null && cmp(v) <= cmp(want);
        case 'in': return (want as any[]).includes(v);
        case 'startsWith': return typeof v === 'string' && v.startsWith(want);
        default: return true;
      }
    });
  });
}
