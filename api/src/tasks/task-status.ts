/**
 * What state a piece of work is in. (BEA-1306)
 *
 * There used to be two: `open` and `done`. So when work ended WITHOUT being finished, the app made
 * you lie — mark it done, and it counts in the finished numbers and the person is thanked for
 * completing it; or delete it, and the record of what was dropped goes with it.
 *
 * It came up the day Radha left the organisation with two jobs open. They were not done. They were
 * not hers. There was nothing to close them as.
 *
 * The idea already existed one table over: `Commitment.status` has been `open | done | dropped`, and has been
 * since long before this. It simply never reached tasks.
 *
 * ## The trap this file exists to close
 *
 * Fifty-four places asked for open work by writing `status: { not: 'done' }`. That reads as "not
 * finished", which was the same thing as "still owed" while there were only two states — and stops
 * being the same thing the moment a third exists. Every one of them would have quietly counted
 * dropped work as still owed: chased, listed, added to what people owe you.
 *
 * So "still owed" is written down ONCE, here, and asked for by name. A test forbids the old phrasing
 * coming back.
 */

export const TASK_OPEN = 'open';
export const TASK_DONE = 'done';
export const TASK_DROPPED = 'dropped';

export type TaskStatus = typeof TASK_OPEN | typeof TASK_DONE | typeof TASK_DROPPED;

/** Every state a task may be in. Anything else is a bug, not a new feature. */
export const TASK_STATUSES: TaskStatus[] = [TASK_OPEN, TASK_DONE, TASK_DROPPED];

/**
 * Work that is still owed — for a Prisma `where`.
 *
 * Deliberately an equality test, not "everything except done". A new state added later is excluded
 * until somebody decides it counts, which is the safe direction: the failure mode of being too
 * narrow is a missing row on a screen, and of being too wide is chasing a real person about work
 * nobody expects any more.
 */
export const OPEN_WORK = { status: TASK_OPEN } as const;

/** Work that has ended, however it ended. Neither is still owed. */
export const CLOSED_WORK = { status: { in: [TASK_DONE, TASK_DROPPED] } } as const;

/** Is this task still owed? */
export function isOpen(t: { status?: string | null } | null | undefined): boolean {
  return t?.status === TASK_OPEN;
}

/** Was this task actually FINISHED? Dropped is not finished, and must never be counted as it. */
export function isDone(t: { status?: string | null } | null | undefined): boolean {
  return t?.status === TASK_DONE;
}

/** Did this task end without being finished? */
export function isDropped(t: { status?: string | null } | null | undefined): boolean {
  return t?.status === TASK_DROPPED;
}

/** Has this task ended, either way? */
export function isClosed(t: { status?: string | null } | null | undefined): boolean {
  return isDone(t) || isDropped(t);
}

/** Only a real status is ever stored — a stray value would silently become a fourth state. */
export function normaliseStatus(s: unknown): TaskStatus {
  const v = String(s ?? '').trim().toLowerCase();
  return (TASK_STATUSES as string[]).includes(v) ? (v as TaskStatus) : TASK_OPEN;
}
