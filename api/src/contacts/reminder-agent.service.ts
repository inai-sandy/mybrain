import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';
import { RemindersService } from './reminders.service';

/**
 * The two-way "replies like you" reminder agent (BEA-730 / Postbox C2). When a contact
 * replies (stored by the Postbox callback), it reads the whole thread, answers back in the
 * user's voice (Indian English), and — when the matter is clearly resolved — records the
 * outcome and closes the REMINDER (never the underlying task). Stateless per turn: the
 * conversation lives in ReminderMessage, so it survives restarts and is naturally multi-turn.
 */
@Injectable()
export class ReminderAgentService {
  private readonly log = new Logger('ReminderAgent');

  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
    private readonly reminders: RemindersService,
  ) {}

  private async subjectFor(r: any): Promise<string> {
    if (r.subject?.trim()) return r.subject.trim();
    if (r.taskId) {
      const t = await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { title: true } }).catch(() => null);
      if (t?.title?.trim()) return t.title.trim();
    }
    return (r.message || 'this').trim();
  }

  private parseJson(raw: string): any {
    if (!raw) return null;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Handle an inbound reply for a whole CONTACT: one reply covering all their open reminders,
   * closing only the item(s) they actually addressed (partial replies keep the rest open). (BEA-742)
   */
  async onContactReply(contactId: string): Promise<void> {
    const contact: any = await this.prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return;
    const number = (contact.whatsappNumber || '').replace(/[^\d]/g, '');
    if (!number || !this.postbox.isConfigured()) return;

    const reminders: any[] = await this.prisma.reminder.findMany({ where: { contactId, status: 'active' }, orderBy: { createdAt: 'asc' } });
    if (!reminders.length) return;
    const messages: any[] = await this.prisma.reminderMessage.findMany({ where: { contactId }, orderBy: { createdAt: 'asc' } });
    const name = (contact.name || 'them').trim();
    const thread = messages.map((m) => `${m.direction === 'out' ? 'Me' : name}: ${m.body}`).join('\n');

    const items: { n: number; reminderId: string; subject: string }[] = [];
    for (let i = 0; i < reminders.length; i++) items.push({ n: i + 1, reminderId: reminders[i].id, subject: await this.subjectFor(reminders[i]) });
    const itemList = items.map((it) => `${it.n}. ${it.subject}`).join('\n');

    const prompt = `You are me, texting ${name} on WhatsApp to follow up on ${items.length === 1 ? 'this open item' : 'these open items'}:
${itemList}

Conversation so far:
${thread}

Write my next single reply to whatever they just said.
Rules:
- Warm, natural Indian English — exactly how a real Indian professional texts a colleague/vendor. NEVER sound like a bot or AI.
- Plain, short — 1-2 sentences. ONE message, even if there are several items.
- Don't re-greet every time; reply naturally. Don't sign off with my name.
- Don't be pushy: if they're only non-committal ("I'll let you know", "ok", "sure") and you've already acknowledged, set "send": false and wait for a real update.

For EACH numbered item, decide if it's now resolved — ONLY if they clearly addressed THAT item (said it's done / gave its final status). Give a one-line outcome for resolved items.

Reply with ONLY this JSON, nothing else:
{"send": true or false, "reply": "<one message — only if send is true>", "items": [{"n": <number>, "resolved": true or false, "outcome": "<one line if resolved>"}]}`;

    const raw = await this.reminders.voiceComplete(prompt, 'reminder-agent', 700);
    const parsed: any = this.parseJson(raw) || {};
    const replyText = (parsed.reply || '').trim();

    // Stay quiet if the agent decided so (BEA-737) or the reply repeats one already sent (BEA-735).
    const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const alreadySent = messages.some((m) => m.direction === 'out' && norm(m.body) === norm(replyText));
    if (parsed.send === false || !replyText) {
      this.log.log(`agent: staying quiet for contact ${contactId}`);
    } else if (alreadySent) {
      this.log.log(`agent: skipping duplicate reply for contact ${contactId}`);
    } else {
      const res = await this.postbox.sendText(number, replyText);
      await this.prisma.reminderMessage
        .create({ data: { contactId, reminderId: reminders[0].id, direction: 'out', body: replyText, wamid: res.wamid || null } })
        .catch(() => undefined);
    }

    // Close only the items the contact actually resolved.
    const byN = new Map(items.map((it) => [it.n, it.reminderId]));
    for (const it of Array.isArray(parsed.items) ? parsed.items : []) {
      if (it?.resolved && byN.has(it.n)) {
        const rid = byN.get(it.n)!;
        await this.prisma.reminder
          .update({ where: { id: rid }, data: { status: 'done', feedback: (it.outcome || 'Resolved').trim() } })
          .catch(() => undefined);
        this.log.log(`reminder ${rid} resolved: ${it.outcome || ''}`);
      }
    }
  }
}
