import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';
import { REMINDER_TZ_OFFSET } from './reminders.service';

/** Join subject phrases into one natural list: "A" / "A and B" / "A, B and C". (BEA-742) */
export function joinSubjects(subjects: string[]): string {
  const s = subjects.map((x) => (x || '').trim()).filter(Boolean);
  if (s.length === 0) return 'this';
  if (s.length === 1) return s[0];
  if (s.length === 2) return `${s[0]} and ${s[1]}`;
  return `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`;
}

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
  /** Re-entrancy guard: a slow Postbox call can make one tick outlast the 60s timer, so two ticks
   *  could overlap and re-send the same queued rows. This ensures only one tick runs at a time. (BEA-775) */
  private sending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
  ) {}

  onModuleInit() {
    // A row claimed 'sending' whose process died mid-send is orphaned — fail it rather than risk a
    // re-send (at-most-once). Any 'sending' row at boot is definitively orphaned. (BEA-775)
    this.reclaimOrphanSends().catch(() => undefined);
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn(`tick: ${e?.message}`));
    }, 60_000);
  }

  /** Fail sends left mid-flight ('sending') by a restart, so they never double-send. (BEA-775) */
  async reclaimOrphanSends(): Promise<number> {
    const res = await this.prisma.reminderSend.updateMany({ where: { status: 'sending' }, data: { status: 'failed', error: 'interrupted before delivery could be confirmed' } });
    if (res.count) this.log.warn(`failed ${res.count} orphaned in-flight send(s) on boot`);
    return res.count;
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

  /** One-day lifecycle: at each new local day, auto-pause reminders armed on an earlier day so
   *  "active" always means "will send today". They stay put until the user re-arms them. (BEA-764) */
  async rollDay() {
    const now = new Date();
    const todayKey = new Date(now.getTime() + REMINDER_TZ_OFFSET * 60000).toISOString().slice(0, 10);
    const stale = await this.prisma.reminder.findMany({ where: { status: 'active', OR: [{ armedDay: null }, { armedDay: { lt: todayKey } }] } });
    let paused = 0;
    for (const r of stale) {
      // Never pause a reminder that still has a FUTURE send queued — it's mid-lifecycle (just armed,
      // or spilling to a later day). This also protects a freshly-created reminder whose armedDay write
      // was swallowed (null), which used to get auto-paused within 60s and its sends deleted. (BEA-790)
      const pending = await this.prisma.reminderSend.count({ where: { reminderId: r.id, status: 'queued', at: { gt: now } } });
      if (pending > 0) continue;
      await this.prisma.reminder.update({ where: { id: r.id }, data: { status: 'paused', pausedAuto: true } }).catch(() => undefined);
      await this.prisma.reminderSend.deleteMany({ where: { reminderId: r.id, status: 'queued' } }).catch(() => undefined);
      paused++;
    }
    if (paused) this.log.log(`auto-paused ${paused} reminder(s) at day rollover`);
  }

  async tick() {
    if (this.sending) return; // never let two ticks overlap — that re-sent the same rows (BEA-775)
    this.sending = true;
    try {
      await this.tickInner();
    } finally {
      this.sending = false;
    }
  }

  private async tickInner() {
    await this.rollDay(); // roll the day first, so nothing armed for a past day fires
    if (!this.postbox.isConfigured()) return; // WhatsApp not wired yet — leave sends queued
    const due = await this.prisma.reminderSend.findMany({
      where: { status: 'queued', at: { lte: new Date() } },
      include: { reminder: { include: { contact: true } } },
      orderBy: { at: 'asc' },
      take: 50,
    });
    if (!due.length) return;
    // Claim these rows ('queued' → 'sending') BEFORE the slow Postbox calls, so a later tick or a
    // restart can never pick them up and send the same message again. (BEA-775)
    await this.prisma.reminderSend.updateMany({ where: { id: { in: due.map((d) => d.id) }, status: 'queued' }, data: { status: 'sending' } });

    // Group due sends by CONTACT — a contact with several reminders gets ONE combined nudge. (BEA-742)
    const groups = new Map<string, { number: string; name: string; sends: any[]; reminders: Map<string, any> }>();
    for (const send of due) {
      const r: any = send.reminder;
      if (!r || r.status !== 'active') {
        await this.mark(send.id, 'failed', null, r ? `reminder is ${r.status}` : 'reminder gone');
        continue;
      }
      const number = (r.contact?.whatsappNumber || '').replace(/[^\d]/g, '');
      if (!number || !r.contactId) {
        await this.mark(send.id, 'failed', null, 'contact has no WhatsApp number');
        continue;
      }
      let g = groups.get(r.contactId);
      if (!g) {
        g = { number, name: r.contact?.name || 'there', sends: [], reminders: new Map() };
        groups.set(r.contactId, g);
      }
      g.sends.push(send);
      g.reminders.set(r.id, r);
    }

    for (const [contactId, g] of groups) {
      // While a conversation is genuinely LIVE, the two-way agent handles it — don't also fire a
      // template nudge. "Live" = they replied within WhatsApp's 24h session window; older than that
      // the chat is closed, so a NEW reminder must send as normal. Previously this was "ever replied",
      // which silently killed every future reminder to anyone who ever answered once. (BEA-774, was BEA-735)
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const replied = await this.prisma.reminderMessage.count({ where: { contactId, direction: 'in', createdAt: { gte: since } } });
      if (replied > 0) {
        for (const s of g.sends) await this.mark(s.id, 'skipped', null, 'contact replied recently — agent is handling the live conversation');
        continue;
      }
      const firstName = g.name.trim().split(/\s+/)[0];
      const subjects: string[] = [];
      for (const r of g.reminders.values()) subjects.push(await this.subjectFor(r));
      const combined = joinSubjects(subjects);
      const res = await this.postbox.sendReminderTemplate(g.number, firstName, combined);
      if (res.error) {
        for (const s of g.sends) await this.mark(s.id, 'failed', res.wamid, res.error);
        this.log.warn(`combined send to ${g.name} failed: ${res.error}`);
        continue;
      }
      for (const s of g.sends) await this.mark(s.id, 'sent', res.wamid, null);
      // Store exactly what the template renders — same source as the send, so the
      // chat window can never show a message different from what actually went out. (BEA-753)
      const rendered = this.postbox.renderReminderTemplate(firstName, combined);
      await this.prisma.reminderMessage
        .create({ data: { contactId, reminderId: [...g.reminders.keys()][0], direction: 'out', body: rendered, wamid: res.wamid || null, status: 'sent' } })
        .catch(() => undefined);
    }
    this.log.log(`processed ${due.length} due send(s) across ${groups.size} contact(s)`);
  }

  private async mark(id: string, status: string, providerId: string | null, error: string | null) {
    await this.prisma.reminderSend
      .update({ where: { id }, data: { status, providerId: providerId || undefined, error: error || undefined } })
      .catch(() => undefined);
  }
}
