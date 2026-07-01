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

  private parseJson(raw: string): { send?: boolean; reply?: string; resolved?: boolean; outcome?: string } | null {
    if (!raw) return null;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }

  /** Handle one inbound reply on a reminder: reply back, and close it if resolved. */
  async onReply(reminderId: string): Promise<void> {
    const reminder: any = await this.prisma.reminder.findUnique({
      where: { id: reminderId },
      include: { contact: true, messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!reminder || reminder.status !== 'active') return; // only chase active reminders
    const contact = reminder.contact;
    const number = (contact?.whatsappNumber || '').replace(/[^\d]/g, '');
    if (!number || !this.postbox.isConfigured()) return;

    const subject = await this.subjectFor(reminder);
    const name = (contact?.name || 'them').trim();
    const thread = (reminder.messages || [])
      .map((m: any) => `${m.direction === 'out' ? 'Me' : name}: ${m.body}`)
      .join('\n');

    const prompt = `You are me, texting ${name} on WhatsApp to follow up about "${subject}".

Conversation so far:
${thread}

Write my next reply.
Rules:
- Warm, natural Indian English — exactly how a real Indian professional texts a colleague or vendor. NEVER sound like a bot or AI.
- Plain, simple, short — 1-2 sentences.
- Goal: find out where "${subject}" stands. If they've clearly said it's done or given a final status, acknowledge warmly and gently wrap up.
- Mid-conversation: don't re-greet by name every time; just reply naturally. Don't sign off with my name.

Also decide whether to reply at all right now (don't be pushy — a real person doesn't keep chasing):
- Reply if they gave a real update, asked something, or it's resolved (then just a short, warm acknowledgement).
- Do NOT reply (set "send": false) if they're only being non-committal — "I'll let you know", "ok", "sure", "will update you" — and you've already acknowledged, or the chat has naturally wound down. Wait for a real update instead of nudging again.

Then decide if it's now resolved (they gave a clear final status, or it's done). Reply with ONLY this JSON, nothing else:
{"send": true or false, "reply": "<my message to them — only if send is true>", "resolved": true or false, "outcome": "<one short line summarising the result — only if resolved>"}`;

    const raw = await this.reminders.voiceComplete(prompt, 'reminder-agent', 500);
    const parsed = this.parseJson(raw);
    const replyText = (parsed?.reply || '').trim();

    // The agent can choose to stay quiet (send:false) rather than keep pushing. (BEA-737)
    // Never send the same message twice either. (BEA-735)
    const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const alreadySent = (reminder.messages || []).some((m: any) => m.direction === 'out' && norm(m.body) === norm(replyText));
    if (parsed?.send === false || !replyText) {
      this.log.log(`agent: staying quiet (nothing to add / winding down) for reminder ${reminderId}`);
    } else if (alreadySent) {
      this.log.log(`agent: skipping duplicate reply for reminder ${reminderId}`);
    } else {
      const res = await this.postbox.sendText(number, replyText);
      await this.prisma.reminderMessage
        .create({ data: { reminderId, direction: 'out', body: replyText, wamid: res.wamid || null } })
        .catch(() => undefined);
    }

    if (parsed?.resolved) {
      await this.prisma.reminder
        .update({ where: { id: reminderId }, data: { status: 'done', feedback: (parsed.outcome || 'Resolved').trim() } })
        .catch(() => undefined);
      this.log.log(`reminder ${reminderId} resolved: ${parsed.outcome || ''}`);
    }
  }
}
