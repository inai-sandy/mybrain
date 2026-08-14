import type { PrismaService } from '../prisma/prisma.service';

/**
 * The one rule that ties delegated work together. (BEA-1296)
 *
 * The owner's complaint was not that any single screen was broken — it was that there were four
 * routes to one outcome. Tasks closed the task and stopped the chase. The claim review closed the
 * claim and left the caller to close the task. The contact's page took a third route. The chase's
 * own nightly sweep took a fourth. Every new surface had to remember the whole list, and one that
 * forgot left a person being chased about work that was finished.
 *
 * So the list lives here, once, and every route runs it.
 *
 * A plain function over Prisma rather than an injectable, deliberately: `TasksService` calls it and
 * `DelegationService` calls `TasksService`, and making this a provider would close that loop into a
 * circular dependency — which Nest refuses to boot on, silently at compile time and loudly at 3am.
 *
 * Everything here is best-effort and independently caught. Failing to clear a badge must never undo
 * the task the owner just marked finished.
 */
export async function settleDelegation(
  prisma: PrismaService,
  taskId: string,
  done: boolean,
  log?: (msg: string) => void,
  /**
   * The work ENDED without being finished. (BEA-1306)
   *
   * It changes one thing, and it matters: a claim waiting on the owner is not confirmed. Confirming
   * means "yes, you finished it" — which is the opposite of what dropping the work says. Nor is it
   * rejected, because that means "no, you didn't", and nobody decided that either. It is settled as
   * `moot`: the question stopped needing an answer.
   */
  ended?: 'done' | 'dropped',
): Promise<void> {
  const say = log || (() => undefined);
  const p: any = prisma;

  // 1. The chase. Confirming the work stops it; re-opening starts a repeating one again.
  //    Plain queries rather than the reminders service, which would make tasks and contacts
  //    depend on each other. (BEA-1021)
  try {
    if (done) {
      // Everything the APP is entitled to switch off: one that was running, and one it paused
      // itself because somebody claimed the work was finished.
      const stopped = await p.reminder?.updateMany?.({
        where: { taskId, status: 'active' },
        data: { status: 'done' },
      });
      const autoPaused = await p.reminder?.updateMany?.({
        where: { taskId, status: 'paused', pausedAuto: true },
        data: { status: 'done' },
      });
      // A chase the OWNER paused by hand is deliberately left alone — it is already silent, so
      // nobody is messaged about finished work either way, and leaving it untouched is what makes
      // re-opening safe: `done` then means "the app stopped this", and only that. Sweeping his
      // pause in here too is what made the two states indistinguishable afterwards. (BEA-1160/1317)
      const n = (stopped?.count || 0) + (autoPaused?.count || 0);
      if (n) {
        await p.reminderSend?.deleteMany?.({ where: { reminder: { taskId }, status: 'queued' } });
        say(`task ${taskId} finished — stopped ${n} chase(s)`);
      }
    } else {
      // Re-opened: bring the chase back to life. The day rollover re-arms it within a minute —
      // `rollDay` sweeps active rows with a null `armedDay`, re-checks the work really is still
      // open, and reseeds the day's sends.
      //
      // Every kind of chase, not only `repeat: 'daily'`. A one-off used to stay stopped for ever,
      // so the job came back open, sitting on somebody, with nobody being asked about it — the
      // original complaint pointing the other way. (BEA-1317)
      //
      // Safe to do broadly because `done` has exactly one author: this function, when the work
      // ended. The owner's own Stop writes `stopped` and their own Pause writes `paused`, and
      // neither is in this query — so nothing he switched off by hand can be resurrected here.
      const back = await p.reminder?.updateMany?.({
        where: { taskId, status: 'done' },
        data: { status: 'active', armedDay: null },
      });
      // …and one the app paused because somebody CLAIMED this finished. Re-opening the work is the
      // owner saying the claim was wrong, so the chase has to pick straight back up — otherwise
      // "pause on done" would quietly become "stop on done", which is the bug it was meant to fix.
      // A chase the owner paused by hand (`pausedAuto: false`) is left alone. (BEA-1293)
      const woke = await p.reminder?.updateMany?.({
        where: { taskId, status: 'paused', pausedAuto: true },
        data: { status: 'active', pausedAuto: false, armedDay: null },
      });
      const n = (back?.count || 0) + (woke?.count || 0);
      if (n) say(`task ${taskId} re-opened — resumed ${n} chase(s)`);
    }
  } catch (e: any) {
    say(`chase sync for ${taskId}: ${e?.message ?? e}`);
  }

  if (!done) return;

  // 2. The review list. Marking the work finished answers everything it was asking about this task
  //    — otherwise the pending claim kept being swept back in and "I closed it and it came back"
  //    was the result. The tick IS the owner's decision. (BEA-1211)
  try {
    await p.taskClaim?.updateMany?.({
      where: { taskId, status: 'pending' },
      data: { status: ended === 'dropped' ? 'moot' : 'confirmed', decidedAt: new Date() },
    });
    await p.teamUpdate?.updateMany?.({ where: { taskId, closedAt: null }, data: { closedAt: new Date() } });
  } catch (e: any) {
    say(`review settle for ${taskId}: ${e?.message ?? e}`);
  }

  // 3. The "needs you" badge. Nothing cleared this when the work itself was finished, so a flag
  //    raised because the agent got stuck on a task outlived the task by weeks. (BEA-1296)
  try {
    await p.reminder?.updateMany?.({ where: { taskId, needsOwner: true }, data: { needsOwner: false } });
  } catch (e: any) {
    say(`needs-you clear for ${taskId}: ${e?.message ?? e}`);
  }
}
