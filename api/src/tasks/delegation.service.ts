import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';
import { ClaimsService } from './claims.service';
import { TASK_OPEN } from './task-status';

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

    // Was one ALREADY waiting on the owner? `claim()` is idempotent — a second "it's done" updates
    // the words rather than stacking rows, and returns truthy either way. Without this check every
    // later pass would look like a fresh claim, and the caller would send "✅ I've marked … as done"
    // again and again for one piece of work. (review finding, BEA-1293)
    // Optional-chained + Promise.resolve: spec harnesses pass partial claims stubs, and a missing
    // method must degrade rather than throw inside a path that messages real people.
    const wasAlreadyClaimed = (await Promise.resolve(this.claims.isPending?.(input.taskId)).catch(() => false)) || false;
    const row = await this.claims.claim(input).catch(() => null);

    // A recurring report returns null from claim() by design — it satisfied TODAY, it is not done.
    if (task.kind === 'recurring') {
      return { claimed: false as const, recordedToday: true as const, task };
    }
    if (!row) return { claimed: false as const, task };

    await this.pauseChases(input.taskId, 'they say it is done').catch(() => undefined);
    // Re-affirming something already waiting is not news. The chase is already quiet and the owner
    // already has it — saying it a second time reads as a bot repeating itself.
    if (wasAlreadyClaimed) return { claimed: false as const, alreadyClaimed: true as const, task, claimId: (row as any).id as string };
    return { claimed: true as const, task, claimId: (row as any).id as string };
  }

  /**
   * Hand a piece of work to somebody else. (BEA-1308)
   *
   * A job belonged to whoever it started with, for ever — nothing anywhere ever changed a chase's
   * contact. So "reassigning" moved the task on screen while the OLD person kept getting the
   * WhatsApp messages: the two halves disagreed by construction. It is why Radha's work had nowhere
   * to go and the only options were to pretend it was finished or delete it.
   *
   * The old chase is STOPPED and a fresh one made for the new person, rather than the old row being
   * pointed at somebody else. That row carries real sends and real replies; moving it would make one
   * person's conversation look like another's. History stays whole, which is the point.
   */
  async handOver(taskId: string, toContactId: string, reason?: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true, kind: true, status: true, ownerContactId: true } });
    if (!task) throw new NotFoundException('That work no longer exists.');
    const to = await this.prisma.contact.findUnique({ where: { id: toContactId }, select: { id: true, name: true, leftAt: true, whatsappNumber: true } });
    if (!to) throw new NotFoundException('That person is not in your contacts.');
    if ((to as any).leftAt) throw new BadRequestException(`${to.name} has left, so work cannot be given to them.`);
    if (task.ownerContactId === toContactId) return { ok: true, unchanged: true };
    if (task.status !== TASK_OPEN) throw new BadRequestException('That work has already ended — re-open it first if it needs doing.');

    const from = task.ownerContactId
      ? await this.prisma.contact.findUnique({ where: { id: task.ownerContactId }, select: { id: true, name: true } })
      : null;

    // The live chase, read BEFORE it is stopped, so the new one can inherit its shape — when it is
    // asked for, how often, what it is about. Rebuilding that by hand is how a handover ends with
    // nobody being chased at all.
    const oldChase = await this.prisma.reminder
      .findFirst({ where: { taskId, status: { in: ['active', 'paused'] } }, orderBy: { createdAt: 'desc' } })
      .catch(() => null);

    // The authoritative pair, together and FIRST. Moving the work without writing the record leaves
    // it looking abandoned with nothing to explain it — and undo, which reads that record, could
    // then say the work was never handed over at all.
    await this.inTransaction(async (tx: any) => {
      await tx.task.update({ where: { id: taskId }, data: { ownerContactId: to.id, party: to.name.slice(0, 80) } });
      await tx.taskHandover.create({
        data: { taskId, fromContactId: from?.id ?? null, toContactId: to.id, reason: String(reason || '').trim().slice(0, 300) || null },
      });
    });

    // Everything below is tidy-up on top of a change that has already happened, so each piece is
    // caught on its own: failing to stop a chase must not undo the handover itself.

    // The old person's claim, if any. Not discarded silently and not carried to somebody who never
    // made it: it stops being a question anyone can answer, the same as when work is dropped.
    const claims = await this.prisma.taskClaim
      .updateMany({ where: { taskId, status: 'pending' }, data: { status: 'moot', decidedAt: new Date() } })
      .catch(() => ({ count: 0 }));

    // Stop the old chase. `stopped` = a decision, so nothing offers it back for resuming.
    const stopped = await this.prisma.reminder
      .updateMany({ where: { taskId, status: { in: ['active', 'paused'] } }, data: { status: 'stopped' } })
      .catch(() => ({ count: 0 }));
    await this.prisma.reminderSend.deleteMany({ where: { reminder: { taskId }, status: 'queued' } }).catch(() => undefined);

    // …and start one for the new person. Stopping the old chase without this was the whole bug in a
    // new place: the work moved on screen and simply stopped being asked about, for ever, with
    // nothing anywhere saying so. A daily report was worse — nothing in the app can revive a
    // `stopped` chase, so the standing report would have had to be rebuilt from scratch by hand.
    let chasing = false;
    if (oldChase && to.whatsappNumber) {
      const created = await this.prisma.reminder
        .create({
          data: {
            contactId: to.id,
            taskId,
            subject: oldChase.subject || task.title.slice(0, 80),
            // Written for the person taking it on, not inherited from a message addressed to
            // somebody else. It reads as a handover, never as an accusation about work they have
            // never seen.
            message: `Hi ${to.name.split(/\s+/)[0] || to.name}, this has come over to you${from ? ` from ${from.name.split(/\s+/)[0] || from.name}` : ''}: ${task.title}. Could you let Sandeep know where it stands?`,
            count: oldChase.count,
            times: oldChase.times,
            repeat: oldChase.repeat,
            status: 'active',
            armedDay: null, // the day roll arms it within the minute
          },
        })
        .catch(() => null);
      chasing = !!created;
    }

    this.log.log(`"${task.title}" handed from ${from?.name || 'you'} to ${to.name}${stopped.count ? ` — stopped ${stopped.count} chase(s)` : ''}${chasing ? ', started a new one' : ''}`);
    return {
      ok: true,
      from: from?.name || null,
      to: to.name,
      stoppedChases: stopped.count,
      settledClaims: claims.count,
      hasNumber: !!to.whatsappNumber,
      chasing,
      /** True when there WAS a chase and we could not start a replacement — the caller must say so. */
      chaseNotStarted: !!oldChase && !chasing,
    };
  }

  /**
   * Undo the last handover — hand it straight back. (BEA-1308)
   *
   * Reverses directly rather than calling `handOver` in the other direction. Routing through it
   * wrote a NEW record saying "handed back" and then deleted the real one — so a single undo
   * destroyed the reason the work moved in the first place ("Radha left the organisation") and
   * replaced it with a synthetic line. The whole point of keeping these rows is that the chain
   * survives.
   */
  async undoHandOver(taskId: string) {
    const last = await this.prisma.taskHandover
      .findFirst({ where: { taskId }, orderBy: { at: 'desc' } })
      .catch(() => null);
    if (!last) throw new BadRequestException('That work has not been handed over.');

    const back = last.fromContactId
      ? await this.prisma.contact.findUnique({ where: { id: last.fromContactId }, select: { id: true, name: true, leftAt: true } }).catch(() => null)
      : null;
    // Handing it back to somebody who has since left would undo one problem into another.
    if (last.fromContactId && !back) throw new BadRequestException('The person who had it before is no longer in your contacts.');
    if (back && (back as any).leftAt) throw new BadRequestException(`${back.name} has left, so it cannot go back to them.`);

    await this.inTransaction(async (tx: any) => {
      await tx.task.update({
        where: { id: taskId },
        data: { ownerContactId: back?.id ?? null, party: back?.name?.slice(0, 80) ?? null },
      });
      await tx.taskHandover.delete({ where: { id: last.id } });
    });

    // The chase that was started for the person giving it back stops; nothing is auto-started for
    // whoever gets it, because the chase that existed before the handover is gone and guessing at a
    // replacement is how somebody gets messaged about work they thought was settled.
    const stopped = await this.prisma.reminder
      .updateMany({ where: { taskId, status: { in: ['active', 'paused'] } }, data: { status: 'stopped' } })
      .catch(() => ({ count: 0 }));
    await this.prisma.reminderSend.deleteMany({ where: { reminder: { taskId }, status: 'queued' } }).catch(() => undefined);

    this.log.log(`handover on ${taskId} undone — back to ${back?.name || 'you'}`);
    return { ok: true, to: back?.name ?? null, stoppedChases: stopped.count, chaseNotStarted: stopped.count > 0 };
  }

  /** Run in a real transaction when Prisma offers one; spec harnesses pass partial stubs. */
  private async inTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const run = (this.prisma as any).$transaction;
    if (typeof run !== 'function') return fn(this.prisma);
    return run.call(this.prisma, fn);
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
