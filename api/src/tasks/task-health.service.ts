import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { localDayKey } from '../common/localday';
import { parseSchedule, daysFromTitle } from './schedule';

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
export class TaskHealthService implements OnModuleInit {
  private readonly log = new Logger('TaskHealth');
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram?: TelegramService, // optional + LAST — spec files construct positionally
  ) {}

  onModuleInit() {
    // Checked every 30 minutes, but it only actually runs once per day, after 22:00 local. A fixed
    // nightly timer would drift with restarts; this survives them.
    this.timer = setInterval(() => void this.maybeRunNightly().catch(() => undefined), 30 * 60_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private async maybeRunNightly() {
    const now = new Date();
    const day = localDayKey(now);
    if (this.lastRunDay === day) return;
    const localHour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
    if (localHour < 22) return;
    this.lastRunDay = day;
    await this.runAndReport();
  }

  /** Run every check and tell the owner if — and only if — something is wrong. */
  async runAndReport(): Promise<{ findings: HealthFinding[]; told: boolean }> {
    const findings = await this.check();
    if (!findings.length) {
      this.log.log('nightly health check: all clear');
      return { findings, told: false };
    }
    const told = await this.tell(findings);
    this.log.warn(`nightly health check: ${findings.length} problem(s)${told ? ' — owner told' : ''}`);
    return { findings, told };
  }

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
      where: { kind: 'recurring', status: { not: 'done' } },
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

    return out;
  }

  /** A check that cannot read its table must not take the whole report down with it. */
  private async q<T>(fn: () => Promise<T[]>): Promise<T[]> {
    try { return (await fn()) || []; } catch (e: any) { this.log.warn(`health check query failed: ${e?.message ?? e}`); return []; }
  }

  /** One plain-English message. Nothing is sent when everything is fine. */
  private async tell(findings: HealthFinding[]): Promise<boolean> {
    if (!this.telegram?.ownerChatId) return false;
    const owner = await this.telegram.ownerChatId().catch(() => null);
    if (!owner) return false;
    const lines = findings.map((f) => {
      const eg = f.examples.length ? `\n   ${f.examples.map((e) => `· ${e}`).join('\n   ')}` : '';
      return `• <b>${f.count}</b> ${f.what} — ${f.where}${eg}`;
    });
    const body = `🩺 <b>Tasks health check</b>\n\nI found ${findings.length === 1 ? 'one thing' : `${findings.length} things`} worth a look:\n\n${lines.join('\n\n')}\n\nI have changed nothing — these are just the ones to check.`;
    await this.telegram.send(owner, body).catch(() => undefined);
    return true;
  }
}
