import { readTap, TapMeaning } from './tap';
import { isOpen } from '../tasks/task-status';

/**
 * Turning a tap into an exact answer. (BEA-1300)
 *
 * The link that makes this possible already existed: when a nudge goes out, its WhatsApp id is
 * written to `ReminderSend.providerId` for **every** chase that nudge covered. So the id of the
 * message someone tapped resolves to the precise set of work it was about — one lookup, no model,
 * no interpretation.
 *
 * Kept as a plain function over Prisma so it can be tested on its own and so the agent stays the
 * only place that decides what to SAY. This decides only what is TRUE.
 */

export type TapResolution = {
  meaning: TapMeaning;
  /** The chases that nudge covered. Empty when the tapped message is not one of ours. */
  reminderIds: string[];
  /** The work behind them, with what is needed to act: id, title, and whether it is a daily report. */
  tasks: { id: string; title: string; kind: string; status: string; scheduleDays?: string | null }[];
};

/**
 * Read the latest inbound message as a tap, and resolve what it was about.
 *
 * Returns null when this was typed, when the button is one we do not recognise, or when the message
 * it answers is not one of ours. All three are ordinary — a person can quote-reply to their own
 * message, and a template can be edited in Meta's console without telling us. In every case the
 * caller falls through to reading the words, which is what happened before this existed.
 */
export async function resolveTap(
  prisma: any,
  lastIn: { buttonId?: string | null; body?: string | null; replyToWamid?: string | null } | undefined,
): Promise<TapResolution | null> {
  const meaning = readTap(lastIn || {});
  if (!meaning) return null;
  if (!lastIn?.replyToWamid) return null; // a tap we cannot place is no better than the words

  // Every chase covered by the nudge they tapped. `providerId` carries the SAME wamid across all of
  // them, which is precisely why a combined nudge can be resolved to its full set rather than to
  // whichever chase happened to be first.
  const sends: any[] = (await Promise.resolve(
    prisma.reminderSend?.findMany?.({
      where: { providerId: lastIn.replyToWamid },
      select: { reminder: { select: { id: true, taskId: true, status: true } } },
    }),
  ).catch(() => [])) ?? [];

  const reminderIds = [...new Set(sends.map((s) => s.reminder?.id).filter(Boolean))] as string[];
  const taskIds = [...new Set(sends.map((s) => s.reminder?.taskId).filter(Boolean))] as string[];
  if (!reminderIds.length) return null; // not one of our nudges — read the words

  const tasks: any[] = taskIds.length
    ? ((await Promise.resolve(
        prisma.task?.findMany?.({ where: { id: { in: taskIds } }, select: { id: true, title: true, kind: true, status: true, scheduleDays: true } }),
      ).catch(() => [])) ?? [])
    : [];

  // Work already finished is not a candidate. A tap arriving after the owner closed something must
  // not reopen it or claim it again — the message simply has nothing left to act on.
  return { meaning, reminderIds, tasks: tasks.filter((t) => isOpen(t)) };
}
