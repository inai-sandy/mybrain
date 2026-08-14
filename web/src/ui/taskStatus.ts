/**
 * What state a piece of work is in, for the screens. (BEA-1306)
 *
 * Mirrors `api/src/tasks/task-status.ts`. It exists because the API sweep alone was not enough: the
 * web read `status !== 'done'` in a dozen places meaning "still open", and a dropped task therefore
 * showed up as open, was counted as open, and — worst — tapping its tick sent `{ done: true }` and
 * recorded it as FINISHED. The lie the whole change removes, put back by the screens.
 */
export type TaskState = 'open' | 'done' | 'dropped';

export const isOpen = (t?: { status?: string | null } | null) => t?.status === 'open';
export const isDone = (t?: { status?: string | null } | null) => t?.status === 'done';
export const isDropped = (t?: { status?: string | null } | null) => t?.status === 'dropped';
/** Ended, either way — finished or dropped. Neither is still owed. */
export const isClosed = (t?: { status?: string | null } | null) => isDone(t) || isDropped(t);

/**
 * What a tick on this row should do.
 *
 * `dropped` reopens rather than completes: a dropped task tapped as "done" would be recorded as an
 * achievement, which is exactly what dropping it said it was not.
 */
export const tickMeans = (t?: { status?: string | null } | null): boolean => !isDone(t) && !isDropped(t);
