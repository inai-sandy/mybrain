import { TASK_OPEN } from '../tasks/task-status';

/**
 * "Needs you" has ONE source since BEA-1596: an open `TeamUpdate` with `needsYou: true`. The
 * review inbox, the Contacts board, the Dashboard and every per-chase badge read the filter below —
 * a second hand-written filter is how two screens came to disagree (the Dashboard listed four
 * people while Tasks → Needs you listed none). `Reminder.needsOwner` is retired: the column stays,
 * nothing reads or writes it.
 */

/** Flagged, not closed, and the work not already done. (BEA-1211, BEA-1596) */
export function openNeedsWhere(contactIds?: string[]) {
  return {
    ...(contactIds ? { contactId: { in: contactIds } } : {}),
    needsYou: true,
    closedAt: null,
    OR: [{ taskId: null }, { task: { status: TASK_OPEN } }],
  };
}

export type OpenNeed = { contactId: string; taskId: string | null };

/**
 * Does this chase / this person carry an open "needs you"? An item about a task marks that task's
 * chase; an item about no task in particular marks every chase of that person. (BEA-1297 intent)
 */
export function needsYouFor(open: OpenNeed[], contactId: string | null | undefined, taskId?: string | null): boolean {
  if (!contactId) return false;
  return open.some((u) => u.contactId === contactId && (u.taskId === null || (!!taskId && u.taskId === taskId)));
}
