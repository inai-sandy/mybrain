import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';
import { ClaimsService } from './claims.service';

/**
 * The single door for "this delegated work is finished". (BEA-1296)
 *
 * The owner: *"There has to be some link between the Delegated tasks and the reminders and Needs
 * You. If you don't link them properly, when I update in any of these three areas, it has to
 * properly mark the task as done, the reminders have to stop."*
 *
 * Before this, three controllers each wrote the same two lines by hand — decide the claim, then
 * remember to close the task. A fourth surface that wrote only the first line would close the claim
 * and leave the chase running, and nothing would have caught it. That pairing now exists once.
 *
 * Deliberately depends on `TasksService`, never the other way round: `TasksService` reaches the
 * shared rule through the plain `settleDelegation` function, so there is no cycle for Nest to
 * refuse to boot on.
 */
@Injectable()
export class DelegationService {
  private readonly log = new Logger('Delegation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly claims: ClaimsService,
  ) {}

  /**
   * Finish (or re-open) a piece of delegated work. Everything that must move, moves: the task, its
   * chase, any claim waiting on it, the team-update thread, and the "needs you" badge.
   */
  async finishTask(taskId: string, done: boolean, opts?: { actualMin?: number; followUpDate?: string }) {
    return this.tasks.setDone(taskId, done, opts?.actualMin, opts?.followUpDate);
  }

  /**
   * The owner's decision on a claim. Confirming is the ONLY way a claim becomes a completion, and
   * it must close the work in the same breath — a confirmed claim over a still-open task is the
   * exact state that kept people being chased about work they had finished.
   */
  async decideClaim(claimId: string, confirm: boolean, reason?: string) {
    const r = await this.claims.decide(claimId, confirm, reason);
    if (r.ok && (r as any).taskId) await this.finishTask((r as any).taskId, !!(r as any).confirmed);
    return r;
  }

  /** Several obviously-fine claims at once. One bad row must not abandon the rest. (BEA-1025) */
  async decideManyClaims(ids: string[], confirm: boolean) {
    let decided = 0;
    for (const id of ids) {
      const r = await this.decideClaim(id, confirm).catch(() => ({ ok: false }) as any);
      if (r?.ok) decided++;
    }
    return { ok: true, decided, of: ids.length };
  }

  /**
   * Someone says a piece of work is finished — record it and go quiet about it. (BEA-1293)
   *
   * A claim is still not a completion: the task stays open and waits for the owner. What changes
   * here is that the chase is genuinely PAUSED rather than merely skipped on each pass, so both the
   * person and the owner can see that it stopped. Returns what actually happened, so the reply can
   * name it — a message that says "noted" when nothing was recorded is the bug, not the fix.
   */
  async recordClaim(input: { taskId: string; contactId?: string | null; quote: string; source?: string }) {
    const task = await this.prisma.task
      .findUnique({ where: { id: input.taskId }, select: { id: true, title: true, kind: true, status: true } })
      .catch(() => null);
    if (!task) return { claimed: false as const, task: null };

    const row = await this.claims.claim(input).catch(() => null);

    // A recurring report returns null from claim() by design — it satisfied TODAY, it is not done.
    if (task.kind === 'recurring') {
      return { claimed: false as const, recordedToday: true as const, task };
    }
    if (!row) return { claimed: false as const, task };

    await this.pauseChases(input.taskId, 'they say it is done').catch(() => undefined);
    return { claimed: true as const, task, claimId: (row as any).id as string };
  }

  /**
   * Pause every live chase on a task. Distinct from stopping it: the owner's rule is *"pause the
   * reminders. If I feel the task has been done, I will activate those reminders again."* Rejecting
   * the claim brings it straight back, so nothing is lost by going quiet.
   */
  async pauseChases(taskId: string, why: string): Promise<number> {
    const paused = await this.prisma.reminder
      .updateMany({ where: { taskId, status: 'active' }, data: { status: 'paused', pausedAuto: true } })
      .catch(() => ({ count: 0 }));
    if (paused.count) {
      await this.prisma.reminderSend.deleteMany({ where: { reminder: { taskId }, status: 'queued' } }).catch(() => undefined);
      this.log.log(`paused ${paused.count} chase(s) on ${taskId} — ${why}`);
    }
    return paused.count;
  }

  /**
   * Put a paused chase back on — the owner rejected the claim, or switched it back on himself.
   *
   * Only chases the APP paused (`pausedAuto`). One the owner paused with his own hand stays paused:
   * waking it would override a deliberate decision with an automatic one. (BEA-1160)
   */
  async resumeChases(taskId: string): Promise<number> {
    const back = await this.prisma.reminder
      .updateMany({ where: { taskId, status: 'paused', pausedAuto: true }, data: { status: 'active', pausedAuto: false, armedDay: null } })
      .catch(() => ({ count: 0 }));
    if (back.count) this.log.log(`resumed ${back.count} chase(s) on ${taskId}`);
    return back.count;
  }
}
