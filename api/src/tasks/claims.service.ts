import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Claims — someone SAYING a piece of work is finished. (BEA-1024)
 *
 * The rule the whole delegation loop rests on: **a claim is not a completion.** Anyone can say
 * they're done; only the owner decides that they are. So a claim never touches the task's status —
 * it records who said it, their exact words, and waits. While it waits, the chase for that task
 * goes quiet (nagging someone about work they say they've finished is how you lose people), but it
 * does NOT stop, so a rejection brings the chase straight back.
 */
@Injectable()
export class ClaimsService {
  private readonly log = new Logger('ClaimsService');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record that someone says a task is done. Idempotent per task: a second "it's done" while one
   * is already waiting updates the words rather than stacking duplicate rows in the review list.
   */
  async claim(input: { taskId: string; contactId?: string | null; quote: string; source?: string }) {
    const task = await this.prisma.task.findUnique({ where: { id: input.taskId }, select: { id: true, status: true, title: true } });
    if (!task) return null;
    if (task.status === 'done') return null; // already finished — nothing to claim
    const quote = String(input.quote || '').trim().slice(0, 1000) || '(no message)';
    const source = ['whatsapp', 'page', 'owner'].includes(String(input.source)) ? String(input.source) : 'whatsapp';

    const open = await this.prisma.taskClaim.findFirst({ where: { taskId: input.taskId, status: 'pending' } });
    if (open) {
      return this.prisma.taskClaim.update({ where: { id: open.id }, data: { quote, source, contactId: input.contactId || open.contactId } });
    }
    const row = await this.prisma.taskClaim.create({ data: { taskId: input.taskId, contactId: input.contactId || null, quote, source } });
    this.log.log(`claim on "${task.title}" — waiting for the owner`);
    return row;
  }

  /** Withdraw a claim that has not been decided yet (they un-ticked it on their page). */
  async withdraw(taskId: string) {
    const open = await this.prisma.taskClaim.findFirst({ where: { taskId, status: 'pending' } });
    if (!open) return { ok: false };
    await this.prisma.taskClaim.delete({ where: { id: open.id } });
    return { ok: true };
  }

  /** Is this task waiting on the owner's decision? Used to keep the chase quiet meanwhile. */
  async isPending(taskId: string): Promise<boolean> {
    return (await this.prisma.taskClaim.count({ where: { taskId, status: 'pending' } })) > 0;
  }

  /** Every claim waiting on the owner, oldest first — the review list. (feeds BEA-1025) */
  async pending() {
    const rows = await this.prisma.taskClaim.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      include: {
        contact: { select: { id: true, name: true } },
        task: {
          select: {
            id: true, title: true, note: true, status: true, createdAt: true, ownerContactId: true,
            // the live chase, so a rejection can be sent straight back on the same thread
            chases: { where: { status: { in: ['active', 'paused'] } }, take: 1, select: { id: true } },
          },
        },
      },
    });
    // A task deleted under a claim leaves nothing to decide on.
    return rows.filter((r) => r.task).map((r) => this.shape(r));
  }

  /** The claim currently waiting on a set of tasks, keyed by task id. */
  async pendingFor(taskIds: string[]) {
    if (!taskIds.length) return new Map<string, any>();
    const rows = await this.prisma.taskClaim.findMany({
      where: { status: 'pending', taskId: { in: taskIds } },
      include: { contact: { select: { id: true, name: true } } },
    });
    return new Map(rows.map((r) => [r.taskId, this.shape(r)]));
  }

  private shape(r: any) {
    return {
      id: r.id,
      taskId: r.taskId,
      task: r.task ? { id: r.task.id, title: r.task.title, note: r.task.note, openedAt: r.task.createdAt } : undefined,
      chaseId: r.task?.chases?.[0]?.id || null,
      contact: r.contact ? { id: r.contact.id, name: r.contact.name } : null,
      source: r.source,
      quote: r.quote,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      openDays: r.task?.createdAt ? Math.max(0, Math.floor((Date.now() - new Date(r.task.createdAt).getTime()) / 86400000)) : null,
    };
  }

  /**
   * The owner's decision. Confirm marks the work genuinely done (which stops its chase, via
   * TasksService.setDone). Reject reopens it and lets the chase pick straight back up, with a
   * reason he can send on. This is the ONLY place a claim becomes a completion. (BEA-1024)
   */
  async decide(id: string, confirm: boolean, reason?: string) {
    const claim = await this.prisma.taskClaim.findUnique({ where: { id }, include: { task: { select: { id: true, title: true } } } });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.status !== 'pending') return { ok: false, message: 'That one has already been decided.' };
    await this.prisma.taskClaim.update({
      where: { id },
      data: { status: confirm ? 'confirmed' : 'rejected', reason: confirm ? null : (reason || '').trim().slice(0, 500) || null, decidedAt: new Date() },
    });
    this.log.log(`claim on "${claim.task?.title}" ${confirm ? 'confirmed' : 'rejected'} by the owner`);
    return { ok: true, taskId: claim.taskId, confirmed: confirm };
  }

  async get(id: string) {
    const r = await this.prisma.taskClaim.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Claim not found');
    return r;
  }
}
