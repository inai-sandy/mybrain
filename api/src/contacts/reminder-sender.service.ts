import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';

/**
 * Fires due reminder sends through Postbox (BEA-729). Every minute it picks up
 * queued ReminderSend rows whose time has arrived, for ACTIVE reminders only,
 * and sends the approved template. Paused/done/stopped reminders are skipped
 * (pause already clears queued sends, this is a belt-and-braces check).
 */
@Injectable()
export class ReminderSenderService implements OnModuleInit {
  private readonly log = new Logger('ReminderSender');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn(`tick: ${e?.message}`));
    }, 60_000);
  }

  /** Short subject for the template {{2}}: the reminder's own subject, else the linked task title, else a trimmed message, else "this". */
  private async subjectFor(r: any): Promise<string> {
    if (r.subject?.trim()) return r.subject.trim();
    if (r.taskId) {
      const t = await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { title: true } }).catch(() => null);
      if (t?.title?.trim()) return t.title.trim();
    }
    const msg = (r.message || '').trim();
    if (msg) return msg.length > 60 ? msg.slice(0, 57) + '…' : msg;
    return 'this';
  }

  async tick() {
    if (!this.postbox.isConfigured()) return; // WhatsApp not wired yet — leave sends queued
    const due = await this.prisma.reminderSend.findMany({
      where: { status: 'queued', at: { lte: new Date() } },
      include: { reminder: { include: { contact: true, messages: { where: { direction: 'in' }, take: 1 } } } },
      orderBy: { at: 'asc' },
      take: 25,
    });
    for (const send of due) {
      const r: any = send.reminder;
      if (!r || r.status !== 'active') {
        await this.mark(send.id, 'failed', null, r ? `reminder is ${r.status}` : 'reminder gone');
        continue;
      }
      // Once the contact has replied, the two-way agent handles it — stop firing the same template nudge. (BEA-735)
      if (r.messages && r.messages.length > 0) {
        await this.mark(send.id, 'skipped', null, 'contact replied — agent is handling the conversation');
        continue;
      }
      const number = (r.contact?.whatsappNumber || '').replace(/[^\d]/g, '');
      if (!number) {
        await this.mark(send.id, 'failed', null, 'contact has no WhatsApp number');
        continue;
      }
      const firstName = (r.contact?.name || 'there').trim().split(/\s+/)[0];
      const subject = await this.subjectFor(r);
      const res = await this.postbox.sendReminderTemplate(number, firstName, subject);
      if (res.error) {
        await this.mark(send.id, 'failed', res.wamid, res.error);
        this.log.warn(`send ${send.id} failed: ${res.error}`);
      } else {
        await this.mark(send.id, 'sent', res.wamid, null);
        // record the ACTUAL message the contact received (the rendered reminder_nudge template) on the thread
        const rendered = `Hi ${firstName}, just a gentle reminder about ${subject}. Do let me know where it stands whenever you get a chance. Thanks!`;
        await this.prisma.reminderMessage
          .create({ data: { reminderId: r.id, direction: 'out', body: rendered, wamid: res.wamid || null } })
          .catch(() => undefined);
      }
    }
    if (due.length) this.log.log(`processed ${due.length} due reminder send(s)`);
  }

  private async mark(id: string, status: string, providerId: string | null, error: string | null) {
    await this.prisma.reminderSend
      .update({ where: { id }, data: { status, providerId: providerId || undefined, error: error || undefined } })
      .catch(() => undefined);
  }
}
