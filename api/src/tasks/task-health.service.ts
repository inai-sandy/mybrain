import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseSchedule, daysFromTitle } from './schedule';
import { TASK_OPEN } from './task-status';

/**
 * The nightly health check (BEA-1190).
 *
 * Six bugs in tasks and reminders were fixed on one day. Three were reported; three were silent and
 * would never have been — and the one that reached real people (seven colleagues still being chased
 * about work closed weeks earlier) was found by running these very queries by hand.
 *
 * So this exists to move the finding off the owner. It checks the things that must always be true,
 * and speaks ONLY when one of them isn't. Silence has to mean healthy, or the message becomes noise
 * and gets ignored — which would be worse than not having it.
 *
 * It reports. It never fixes: a wrong repair applied unattended at 3am beats the bug it was aimed at.
 *
 * This service only CHECKS. Telling the owner lives in `TaskHealthNotifier` over in the telegram
 * module, because that module already depends on this one — wiring it the other way round would be
 * a circular dependency, and Nest refuses to start on one (it did: the first deploy of this rolled
 * back on the health check).
 */

export type HealthFinding = {
  key: string;
  /** What is wrong, in the owner's words. */
  what: string;
  count: number;
  /** A few examples so the message is concrete, not just a number. */
  examples: string[];
  /** Where to go and deal with it. */
  where: string;
};

const HOUR = 3600_000;

@Injectable()
export class TaskHealthService {
  private readonly log = new Logger('TaskHealth');

  constructor(private readonly prisma: PrismaService) {}

  /** Every invariant that must hold. Plain counts — no AI, cheap enough to run whenever. */
  async check(): Promise<HealthFinding[]> {
    const out: HealthFinding[] = [];
    const add = (f: HealthFinding) => { if (f.count > 0) out.push(f); };
    const titles = (rows: any[], pick: (r: any) => string) => rows.slice(0, 4).map((r) => (pick(r) || '').slice(0, 48)).filter(Boolean);

    // The one that actually messaged people about finished work.
    const chasingDone = await this.q(() => this.prisma.reminder.findMany({
      where: { status: { in: ['active', 'paused'] }, task: { status: 'done' } },
      select: { task: { select: { title: true, party: true } } },
      take: 50,
    }));
    add({
      key: 'chase-on-finished-work',
      what: 'still chasing someone about work you already finished',
      count: chasingDone.length,
      examples: titles(chasingDone, (r) => `${r.task?.party || 'someone'}: ${r.task?.title || ''}`),
      where: 'Tasks → Delegated',
    });

    // A chase with nothing behind it can never be finished — not by them, not by him. Saying "done"
    // records nothing, and there is no task in his list to tick. Nine of his 24 live chases were in
    // this state, and it is the single biggest reason his team kept being nudged after reporting
    // work complete. (BEA-1292)
    const noTask = await this.q(() => this.prisma.reminder.findMany({
      where: { status: { in: ['active', 'paused'] }, taskId: null },
      select: { subject: true, contact: { select: { name: true } } },
      take: 50,
    }));
    add({
      key: 'chase-without-task',
      what: 'chases with no work behind them — nobody can mark these done',
      count: noTask.length,
      examples: titles(noTask, (r) => `${r.contact?.name || 'someone'}: ${r.subject || ''}`),
      where: 'Reminders → Nothing to finish',
    });

    const stuck = await this.q(() => this.prisma.reminderSend.findMany({ where: { status: 'sending' }, select: { id: true }, take: 20 }));
    add({ key: 'send-stuck', what: 'messages stuck mid-send', count: stuck.length, examples: [], where: 'Tasks → Delegated' });

    const overdue = await this.q(() => this.prisma.reminderSend.findMany({
      where: { status: 'queued', at: { lt: new Date(Date.now() - 3 * HOUR) } },
      select: { id: true }, take: 20,
    }));
    add({ key: 'send-overdue', what: 'messages queued but never sent (over 3 hours late)', count: overdue.length, examples: [], where: 'Tasks → Delegated' });

    const doubleChased = await this.q(async () => {
      const g = await this.prisma.reminder.groupBy({ by: ['taskId'], where: { status: 'active', taskId: { not: null } }, _count: { id: true } });
      return (g as any[]).filter((x) => x._count.id > 1);
    });
    add({ key: 'double-chase', what: 'tasks being chased twice over', count: doubleChased.length, examples: [], where: 'Tasks → Delegated' });

    const noNumber = await this.q(() => this.prisma.reminder.findMany({
      where: { status: 'active', contact: { whatsappNumber: null } },
      select: { subject: true, contact: { select: { name: true } } }, take: 20,
    }));
    add({
      key: 'chase-no-number',
      what: 'chases that can never send — the person has no WhatsApp number',
      count: noNumber.length,
      examples: titles(noNumber, (r) => `${r.contact?.name || 'someone'}: ${r.subject || ''}`),
      where: 'Contacts',
    });

    // Tasks in a state they should not be able to reach.
    const openAt100 = await this.q(() => this.prisma.task.findMany({ where: { progress: 100, status: 'open' }, select: { title: true }, take: 20 }));
    add({ key: 'open-at-100', what: 'tasks at 100% that never closed', count: openAt100.length, examples: titles(openAt100, (r) => r.title), where: 'Tasks' });

    // A standing report that names a weekday but has no schedule is chased every working day —
    // which is how a Friday report got chased on a Monday (BEA-1147).
    const recurring = await this.q(() => this.prisma.task.findMany({
      where: { kind: 'recurring', status: TASK_OPEN },
      select: { title: true, scheduleDays: true }, take: 100,
    }));
    const wrongDay = recurring.filter((t: any) => !parseSchedule(t.scheduleDays) && daysFromTitle(t.title || ''));
    add({
      key: 'recurring-no-schedule',
      what: 'standing reports that name a day but are asked for every working day',
      count: wrongDay.length,
      examples: titles(wrongDay, (r) => r.title),
      where: 'Tasks → Daily',
    });

    const oldClaims = await this.q(() => this.prisma.taskClaim.findMany({
      where: { status: 'pending', createdAt: { lt: new Date(Date.now() - 14 * 24 * HOUR) } },
      select: { task: { select: { title: true } } }, take: 20,
    }));
    add({
      key: 'claims-stale',
      what: 'people have said work is done and it has waited over two weeks for you',
      count: oldClaims.length,
      examples: titles(oldClaims, (r) => r.task?.title),
      where: 'Tasks → Needs you',
    });

    const autoOff = await this.q(() => this.prisma.reminder.findMany({
      where: { status: 'paused', pausedAuto: true },
      select: { subject: true, contact: { select: { name: true } } }, take: 20,
    }));
    add({
      key: 'chase-auto-off',
      what: 'chases the app switched off by itself and nobody turned back on',
      count: autoOff.length,
      examples: titles(autoOff, (r) => `${r.contact?.name || 'someone'}: ${r.subject || ''}`),
      where: 'Tasks → Delegated',
    });

    // A broken check must never look like a healthy app. (BEA-1298)
    //
    // The notifier does `check().catch(() => [])`, so anything thrown here becomes an empty list and
    // the owner is told "all clear" on a night when nothing was actually checked. Silence is this
    // feature's entire signal, so it has to be earned — a failure is reported AS a finding.
    try {
    // Messages that outlived the person they belong to. (BEA-1309)
    //
    // A real foreign key now makes this impossible going forward, and seven such rows were sitting
    // in the live database before it existed — unreachable by any screen and undeletable by any
    // code. If one ever appears again, something has bypassed the constraint and is worth knowing.
    const orphanMsgs = await this.q(async () => {
      const rows = await this.prisma.reminderMessage.findMany({ where: { contactId: { not: null } }, select: { contactId: true }, take: 5000 });
      const ids = [...new Set(rows.map((r: any) => r.contactId))] as string[];
      if (!ids.length) return [];
      const live = new Set((await this.prisma.contact.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c: any) => c.id));
      return rows.filter((r: any) => !live.has(r.contactId));
    });
    add({
      key: 'orphan-messages',
      what: 'chat messages belonging to a contact that no longer exists',
      count: orphanMsgs.length,
      examples: [],
      where: 'Tell Claude',
    });

    for (const f of await this.agreementChecks(titles)) add(f);
    } catch (e: any) {
      this.log.error(`agreement checks could not run: ${e?.message ?? e}`);
      out.push({
        key: 'health-check-broken',
        what: 'I could not finish checking — treat tonight\'s silence as unknown, not healthy',
        count: 1,
        examples: [String(e?.message ?? e).slice(0, 120)],
        where: 'Tell Claude',
      });
    }

    return out;
  }

  /**
   * Does the app still agree with itself about delegated work? (BEA-1298)
   *
   * Where things stand is worked out from several separate columns — the task's status, the chase's
   * status, whether a claim is waiting, whether the owner was flagged. They are meant to move
   * together, and BEA-1296 made every change go through one door so that they do.
   *
   * Run against live data on 2026-08-14, ten of these came back clean and one had a single harmless
   * leftover. That is the point: the owner and I dropped a planned rebuild because the evidence did
   * not support it, and kept this instead. It is a fraction of the work and it says, every night,
   * whether that decision still holds.
   *
   * Every check is a contradiction — a state the app should not be able to reach — never a matter
   * of taste. A check that fires on something merely unusual would turn the whole report into noise,
   * and noise gets ignored, which is worse than not having it.
   */
  private async agreementChecks(titles: (rows: any[], pick: (r: any) => string) => string[]): Promise<HealthFinding[]> {
    const found: HealthFinding[] = [];
    const push = (f: HealthFinding) => { if (f.count > 0) found.push(f); };
    // Name the WORK, not the nudge. A chase's `subject` is a short topic written for a WhatsApp
    // sentence ("the videos"); the task title is the thing the owner would recognise in his own
    // list ("Add all videos to the Beacon Hub"). Prefer it wherever both exist.
    const who = (r: any) => `${r.contact?.name || r.ownerContact?.name || 'someone'}: ${r.task?.title || r.title || r.subject || ''}`;

    // They said it is finished and it is sitting in the review list — so the chase should be quiet.
    // Being chased about work you have already reported finished is what loses people. (BEA-1293)
    const chasingClaimed = await this.q(() => this.prisma.reminder.findMany({
      where: { status: 'active', task: { claims: { some: { status: 'pending' } } } },
      select: { subject: true, contact: { select: { name: true } }, task: { select: { title: true } } },
      take: 50,
    }));
    push({
      key: 'chasing-claimed-work',
      what: 'still chasing someone about work they have already reported finished',
      count: chasingClaimed.length,
      examples: titles(chasingClaimed, who),
      where: 'Tasks → Needs you',
    });

    // A chase the APP switched off while the work is still open and nobody claimed it. `stopped` is
    // the owner's own hand and is left alone; `done` means the app decided, and the reasons it may
    // decide are: the task finished, or a claim went unreviewed. Neither holds here.
    const silentlyOff = await this.q(async () => {
      const rows = await this.prisma.reminder.findMany({
        where: { status: 'done', taskId: { not: null }, task: { status: TASK_OPEN, claims: { none: { status: 'pending' } } } },
        select: { taskId: true, subject: true, contact: { select: { name: true } }, task: { select: { title: true } } },
        take: 50,
      });
      // A sibling chase still running means the work is covered — this row is a merged duplicate.
      const live = await this.prisma.reminder.findMany({
        where: { taskId: { in: rows.map((r: any) => r.taskId as string) }, status: { in: ['active', 'paused'] } },
        select: { taskId: true },
      });
      const covered = new Set(live.map((r: any) => r.taskId));
      return rows.filter((r: any) => !covered.has(r.taskId));
    });
    push({
      key: 'chase-silently-off',
      what: 'work still open, nobody said it was done, and the chase switched itself off',
      count: silentlyOff.length,
      examples: titles(silentlyOff, who),
      where: 'Tasks → Delegated',
    });

    // Confirming a claim IS the completion. A confirmed claim over an open task means the two halves
    // came apart — the review list looks settled while the work is still counted as owed.
    const confirmedButOpen = await this.q(() => this.prisma.task.findMany({
      where: { status: TASK_OPEN, claims: { some: { status: 'confirmed' } } },
      select: { title: true, ownerContact: { select: { name: true } } },
      take: 50,
    }));
    push({
      key: 'confirmed-but-open',
      what: 'you confirmed the work was finished but the task never closed',
      count: confirmedButOpen.length,
      examples: titles(confirmedButOpen, who),
      where: 'Tasks → Delegated',
    });

    // A review item still asking for the owner's attention on work that is over. Finishing a task
    // closes its open updates (`settleDelegation`), so an open one on a done task means the two
    // halves came apart. The inbox is the one "needs you" source since BEA-1596. (BEA-1297)
    const staleNeedsYou = await this.q(() => this.prisma.teamUpdate.findMany({
      where: { needsYou: true, closedAt: null, task: { status: 'done' } },
      select: { text: true, contact: { select: { name: true } }, task: { select: { title: true } } },
      take: 50,
    }));
    push({
      key: 'needs-you-on-finished-work',
      what: '"needs you" items sitting on work that is already over',
      count: staleNeedsYou.length,
      examples: titles(staleNeedsYou, who),
      where: 'Tasks → Needs you',
    });

    // A standing report can never be finished — closing one kills its chase for good and tomorrow's
    // update is never asked for again. (BEA-1118)
    const recurringDone = await this.q(() => this.prisma.task.findMany({
      where: { kind: 'recurring', status: 'done' },
      select: { title: true, ownerContact: { select: { name: true } } },
      take: 50,
    }));
    push({
      key: 'recurring-marked-done',
      what: 'standing daily reports closed for good — they will never be asked for again',
      count: recurringDone.length,
      examples: titles(recurringDone, who),
      where: 'Tasks → Daily',
    });

    // …and for the same reason one can never be waiting on a yes/no decision.
    const recurringInReview = await this.q(() => this.prisma.taskClaim.findMany({
      where: { status: 'pending', task: { kind: 'recurring' } },
      select: { task: { select: { title: true, ownerContact: { select: { name: true } } } } },
      take: 50,
    }));
    push({
      key: 'recurring-in-review',
      what: 'daily reports sitting in your review list, which can never be answered',
      count: recurringInReview.length,
      examples: titles(recurringInReview, (r) => `${r.task?.ownerContact?.name || 'someone'}: ${r.task?.title || ''}`),
      where: 'Tasks → Needs you',
    });

    // Messages still on the board for a chase that is off. The sender refuses to send them, so they
    // are harmless in themselves — but they mean a stop did not clean up after itself, and the next
    // one might not either.
    const orphanQueued = await this.q(() => this.prisma.reminderSend.findMany({
      where: { status: 'queued', reminder: { status: { not: 'active' } } },
      select: { reminder: { select: { subject: true, contact: { select: { name: true } } } } },
      take: 50,
    }));
    push({
      key: 'queued-for-stopped-chase',
      what: 'messages still queued for chases that are switched off',
      count: orphanQueued.length,
      examples: titles(orphanQueued, (r) => `${r.reminder?.contact?.name || 'someone'}: ${r.reminder?.subject || ''}`),
      where: 'Tasks → Delegated',
    });

    return found;
  }

  /** A check that cannot read its table must not take the whole report down with it. */
  private async q<T>(fn: () => Promise<T[]>): Promise<T[]> {
    try { return (await fn()) || []; } catch (e: any) { this.log.warn(`health check query failed: ${e?.message ?? e}`); return []; }
  }

  /** One plain-English message for the owner. Returns '' when there is nothing worth saying. */
  message(findings: HealthFinding[]): string {
    if (!findings.length) return '';
    const lines = findings.map((f) => {
      const eg = f.examples.length ? `\n   ${f.examples.map((e) => `· ${e}`).join('\n   ')}` : '';
      return `• <b>${f.count}</b> ${f.what} — ${f.where}${eg}`;
    });
    return `🩺 <b>Tasks health check</b>\n\nI found ${findings.length === 1 ? 'one thing' : `${findings.length} things`} worth a look:\n\n${lines.join('\n\n')}\n\nI have changed nothing — these are just the ones to check.`;
  }
}
