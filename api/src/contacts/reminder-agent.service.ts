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
    const itemList = items.map((it, i) => `${it.n}. ${it.subject}${reminders[i].notes?.trim() ? ` — context Sandeep gave: ${reminders[i].notes.trim()}` : ''}`).join('\n');

    // Sandeep's transparent AI assistant — identifies itself, uses the notes as context, and
    // escalates to Sandeep when it can't answer, instead of impersonating him. (BEA-765/766)
    const prompt = `You are Sandeep's AI assistant. You're texting ${name} on WhatsApp on Sandeep's behalf, following up on ${items.length === 1 ? 'this open item' : 'these open items'}:
${itemList}

Conversation so far:
${thread}

Write the assistant's next single reply to whatever ${name} just said.
Rules:
- Warm, natural, plain Indian English. You ARE Sandeep's AI assistant — do NOT pretend to be Sandeep. If they ask who you are, tell them you're Sandeep's AI assistant helping him keep track, and he'll jump in when needed.
- Warmly invite them to reply or ask anything they want to discuss.
- Short — 1-2 sentences, ONE message even if there are several items.
- Use the context Sandeep gave (above) to answer their questions when you can.
- If they ask something you don't know, that needs Sandeep's own decision, or is outside these items: set "needsSandeep": true, and reply that you'll pass it to Sandeep and he'll get back to them. NEVER make up an answer.
- Don't be pushy: if they're only non-committal ("I'll let you know", "ok", "sure") and you've already acknowledged, set "send": false and wait for a real update.

For EACH numbered item, decide if it's now resolved — ONLY if they clearly addressed THAT item (said it's done / gave its final status). Give a one-line outcome for resolved items.

Reply with ONLY this JSON, nothing else:
{"send": true or false, "reply": "<one message — only if send is true>", "needsSandeep": true or false, "items": [{"n": <number>, "resolved": true or false, "outcome": "<one line if resolved>"}]}`;

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

    // The agent couldn't answer → flag the contact's reminders ("needs you") AND WhatsApp Sandeep. (BEA-766/767)
    if (parsed.needsSandeep) {
      await this.prisma.reminder.updateMany({ where: { contactId, status: 'active' }, data: { needsOwner: true } }).catch(() => undefined);
      const lastIn = [...messages].reverse().find((m) => m.direction === 'in')?.body || '';
      await this.notifyOwner(name, lastIn);
      this.log.log(`agent: flagged contact ${contactId} — needs Sandeep`);
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

  /** WhatsApp Sandeep when the agent is stuck: nice free-text in-window, template fallback cold. (BEA-767) */
  private async notifyOwner(contactName: string, lastMsg: string): Promise<void> {
    const owner = ((await this.prisma.setting.findUnique({ where: { key: 'owner.whatsapp' } }))?.value || '').replace(/[^\d]/g, '');
    if (!owner || !this.postbox.isConfigured()) return;
    const snippet = lastMsg ? `: "${lastMsg.replace(/\s+/g, ' ').trim().slice(0, 200)}"` : '';
    const res = await this.postbox.sendText(owner, `⚠ ${contactName} messaged and needs you${snippet}. I said you'll get back to them — open My Brain to reply.`);
    if (res.error) {
      // Outside the 24h free-text window → fall back to the approved template so it still lands.
      await this.postbox.sendReminderTemplate(owner, 'Sandeep', `${contactName}, who needs your reply in My Brain`).catch(() => undefined);
    }
  }
}
