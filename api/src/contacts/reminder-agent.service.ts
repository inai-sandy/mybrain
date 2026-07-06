import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';
import { RemindersService } from './reminders.service';

/**
 * Safety net (BEA-899): the reply is SENT TO the contact, so it must never address them by the
 * OWNER's name. Rewrites owner-name greetings/sign-offs ("Hi Sandeep", "thanks … Sandeep!") to the
 * contact's first name (or drops the name), while KEEPING legitimate third-person mentions
 * ("I'll pass it to Sandeep", "Sandeep will get back to you").
 */
export function fixOwnerVocative(text: string, ownerName: string, contactName: string): string {
  const owner = (ownerName || '').trim();
  if (!owner || !text) return text;
  const first = (contactName || '').trim().split(/\s+/)[0];
  const rep = first && first.toLowerCase() !== 'them' ? first : '';
  const O = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text;
  // Greeting at the start: "Hi/Hello/Hey/Dear Sandeep"
  out = out.replace(new RegExp(`^(\\s*(?:hi|hello|hey|dear)\\s+)${O}\\b`, 'i'), (_m, g) => `${g}${rep}`.replace(/\s+$/, rep ? '' : ''));
  // Greeting/ack word immediately before the name: "thanks Sandeep", "got it, Sandeep"
  out = out.replace(new RegExp(`\\b(hi|hello|hey|thanks|thank you|got it|sure|okay|ok|great|cheers|noted)([ ,]+)${O}\\b`, 'gi'), (_m, g, sep) => (rep ? `${g}${sep}${rep}` : g));
  // Sentence-ending vocative: "…the update Sandeep!" — unless it's a 3rd-person reference ("…to Sandeep.").
  out = out.replace(new RegExp(`([ ,]+)${O}([!.?])`, 'gi'), (m, sep, punct, offset: number, str: string) => {
    const before = str.slice(Math.max(0, offset - 18), offset).toLowerCase();
    if (/\b(to|with|for|ask|tell|let|pass|by|and|of|know|reach|check)\s*$/.test(before)) return m; // keep 3rd-person mention
    return rep ? `${sep}${rep}${punct}` : `${punct}`;
  });
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([!.?,])/g, '$1').trim();
}

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
  /** Per-contact serialization so a burst of replies runs the agent one turn at a time. (BEA-788) */
  private replyChains = new Map<string, Promise<void>>();

  async onContactReply(contactId: string): Promise<void> {
    // A contact often sends 2-3 messages a couple of seconds apart. Running the agent concurrently
    // makes it send two replies (neither turn sees the other's outbound row). Chain them per contact
    // so each turn sees the previous reply and de-dupes correctly. (BEA-788)
    const prev = this.replyChains.get(contactId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.processContactReply(contactId));
    this.replyChains.set(contactId, next);
    next.catch(() => undefined).finally(() => { if (this.replyChains.get(contactId) === next) this.replyChains.delete(contactId); });
    return next;
  }

  private async processContactReply(contactId: string): Promise<void> {
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
    const prompt = `You are the AI assistant for Sandeep (your boss — the person you represent, and NOT the person you are texting).
You are texting ${name} on WhatsApp on Sandeep's behalf. In THIS chat, the person you are replying to is ${name}; Sandeep is not here. Following up on ${items.length === 1 ? 'this open item' : 'these open items'}:
${itemList}

Conversation so far:
${thread}

Write the assistant's next single reply to whatever ${name} just said.
Rules:
- If you address them by name at all, use "${name}" — NEVER call them "Sandeep". Sandeep is your boss, not the person in this chat. Using no name is better than the wrong one. (You may still mention Sandeep in the third person, e.g. "I'll check with Sandeep".)
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
    // Never let a reply go out addressing the contact by the owner's name (BEA-899).
    const replyText = fixOwnerVocative((parsed.reply || '').trim(), 'Sandeep', name);

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
    } else {
      // The agent handled this exchange without getting stuck — clear any prior "needs you" flag so
      // the badge doesn't stay stuck until the owner happens to type a manual message. (BEA-786)
      await this.prisma.reminder.updateMany({ where: { contactId, needsOwner: true }, data: { needsOwner: false } }).catch(() => undefined);
    }

    // Close only the items the contact actually resolved.
    const byN = new Map(items.map((it) => [it.n, it.reminderId]));
    for (const it of Array.isArray(parsed.items) ? parsed.items : []) {
      if (it?.resolved && byN.has(it.n)) {
        const rid = byN.get(it.n)!;
        await this.prisma.reminder
          .update({ where: { id: rid }, data: { status: 'done', needsOwner: false, feedback: (it.outcome || 'Resolved').trim() } })
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
