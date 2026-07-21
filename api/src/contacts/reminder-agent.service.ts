import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';
import { ClaimsService } from '../tasks/claims.service';
import { TasksService } from '../tasks/tasks.service';
import { RemindersService, topicFromMessage } from './reminders.service';

/** Watchdog decision for an unanswered inbound of a given age. Pure + unit-tested. (BEA-953) */
export function watchdogAction(ageMs: number, graceMs = 8 * 60_000, escalateMs = 45 * 60_000): 'skip' | 'retry' | 'escalate' {
  if (ageMs < graceMs) return 'skip'; // give the live reply path time
  if (ageMs < escalateMs) return 'retry'; // self-heal
  return 'escalate'; // still stuck after retries → tell the owner
}

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
 * Safety net (BEA-902): true when we owe the contact a first acknowledgment — the agent has NEVER
 * replied to them yet AND their latest message is a bare affirmation. Prevents leaving a "yes/ok"
 * on read. Once the agent has replied once, this returns false (the "don't repeat yourself" rule
 * in the prompt then handles further fillers).
 */
export function needsFirstAck(messages: { direction: string; body: string }[]): boolean {
  const hasAgentReply = messages.some((m, i) => m.direction === 'out' && i > 0 && messages[i - 1].direction === 'in');
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  const affirmative = /^\s*(y+e+s+|yep|yeah|ok(ay)?|sure|done|noted|great|thanks|thank you|will do|👍|✅|🙏)[\s.!]*$/i;
  return !hasAgentReply && !!lastIn && affirmative.test(lastIn.body || '');
}

/**
 * Reliability backstop (BEA-923): the owner wants EVERY reply acknowledged — never leave a contact
 * on read. True when the contact wrote the most recent (non-empty) message and the agent hasn't
 * replied after it. The identical-reply suppression downstream stops repeated acks from spamming.
 */
export function needsAck(messages: { direction: string; body: string }[]): boolean {
  if (!messages.length) return false;
  const last = messages[messages.length - 1];
  return last.direction === 'in' && !!(last.body || '').trim();
}

/** A short, varied, context-aware acknowledgment used when the model returns nothing to send. */
export function ackLine(name: string, lastIn: string): string {
  const who = (name || '').trim() || 'there';
  const b = (lastIn || '').toLowerCase();
  if (/\b(find|attach|shar(e|ing)|sheet|sent|sending|here'?s|link)\b|https?:\/\//.test(b)) return `Thanks ${who}, got it — I'll pass this on to Sandeep.`;
  if (/\b(done|completed|finished|closed|sorted|resolved)\b/.test(b)) return `Great, thanks ${who} — noted that it's done!`;
  return `Great, thanks ${who}!`;
}

/**
 * The two-way "replies like you" reminder agent (BEA-730 / Postbox C2). When a contact
 * replies (stored by the Postbox callback), it reads the whole thread, answers back in the
 * user's voice (Indian English), and — when the matter is clearly resolved — records the
 * outcome and closes the REMINDER (never the underlying task). Stateless per turn: the
 * conversation lives in ReminderMessage, so it survives restarts and is naturally multi-turn.
 */
@Injectable()
export class ReminderAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ReminderAgent');
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogRunning = false;
  private readonly escalated = new Set<string>(); // contacts already escalated this stuck-episode (deduped in-memory)

  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
    private readonly reminders: RemindersService,
    private readonly claims: ClaimsService,
    private readonly tasks: TasksService,
  ) {}

  // Self-healing watchdog (BEA-953): every 10 min, catch any contact reply we haven't answered —
  // auto-retry it (heals transient failures), and if it's still stuck, flag it loudly + ping the owner.
  onModuleInit() {
    this.watchdogTimer = setInterval(() => {
      this.watchdogTick().catch((e) => this.log.warn(`watchdog: ${e?.message}`));
    }, 10 * 60_000);
  }
  onModuleDestroy() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
  }

  /** Find replies we owe, retry them, and escalate the ones that stay stuck. */
  async watchdogTick(): Promise<void> {
    if (this.watchdogRunning || !this.postbox.isConfigured()) return;
    this.watchdogRunning = true;
    try {
      const now = Date.now();
      const since = new Date(now - 24 * 60 * 60 * 1000); // WhatsApp free-window is 24h anyway
      const inbound = await this.prisma.reminderMessage.findMany({
        where: { direction: 'in', createdAt: { gte: since }, contactId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { contactId: true, createdAt: true },
      });
      const latestInByContact = new Map<string, Date>();
      for (const m of inbound) if (m.contactId && !latestInByContact.has(m.contactId)) latestInByContact.set(m.contactId, m.createdAt);

      for (const [contactId, inAt] of latestInByContact) {
        const answered = await this.prisma.reminderMessage.count({ where: { contactId, direction: 'out', createdAt: { gt: inAt } } });
        if (answered > 0) { this.escalated.delete(contactId); continue; } // we replied → clear any escalation state
        const action = watchdogAction(now - new Date(inAt).getTime());
        if (action === 'skip') continue;
        this.log.warn(`watchdog: unanswered reply for contact ${contactId} → ${action}`);
        await this.onContactReply(contactId).catch(() => undefined); // retry either way
        if (action === 'escalate' && !this.escalated.has(contactId)) {
          this.escalated.add(contactId);
          await this.prisma.reminder.updateMany({ where: { contactId, status: { in: ['active', 'paused'] }, needsOwner: false }, data: { needsOwner: true } }).catch(() => undefined);
          const contact = await this.prisma.contact.findUnique({ where: { id: contactId } }).catch(() => null);
          await this.notifyOwner(contact?.name || 'A contact', 'their reply is waiting and I have not been able to answer').catch(() => undefined);
        }
      }
    } finally {
      this.watchdogRunning = false;
    }
  }

  private async subjectFor(r: any): Promise<string> {
    if (r.subject?.trim()) return r.subject.trim();
    if (r.taskId) {
      const t = await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { title: true } }).catch(() => null);
      if (t?.title?.trim()) return t.title.trim();
    }
    return topicFromMessage(r.message);
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

    // Process a reply for ANY reminder relationship — active, paused, OR done. The conversation must
    // never die just because a reminder was closed or paused. We ALWAYS read + reply; a reminder's
    // status only governs whether WE send scheduled nudges, never whether we answer THEM. (BEA-948)
    const allReminders: any[] = await this.prisma.reminder.findMany({ where: { contactId }, orderBy: { createdAt: 'asc' } });
    if (!allReminders.length) return; // no relationship at all → nothing to do
    const reminders: any[] = allReminders.filter((r) => r.status === 'active' || r.status === 'paused'); // open items to chase
    const anchorReminderId: string = (reminders[0] || allReminders[allReminders.length - 1]).id; // where to attach our outbound
    const messages: any[] = await this.prisma.reminderMessage.findMany({ where: { contactId }, orderBy: { createdAt: 'asc' } });
    const name = (contact.name || 'them').trim();
    const thread = messages.map((m) => `${m.direction === 'out' ? 'Me' : name}: ${m.body}`).join('\n');

    const todayKey = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST, for date wording
    const items: { n: number; reminderId: string; taskId: string | null; subject: string }[] = [];
    for (let i = 0; i < reminders.length; i++) items.push({ n: i + 1, reminderId: reminders[i].id, taskId: reminders[i].taskId || null, subject: await this.subjectFor(reminders[i]) });
    const itemList = items.length
      ? items.map((it, i) => `${it.n}. ${it.subject}${reminders[i].notes?.trim() ? ` — context Sandeep gave: ${reminders[i].notes.trim()}` : ''}`).join('\n')
      : '(no open reminders right now — this is an ongoing conversation; keep it warm, acknowledge what they share, and pass anything important to Sandeep)';

    // Sandeep's transparent AI assistant — identifies itself, uses the notes as context, and
    // escalates to Sandeep when it can't answer, instead of impersonating him. (BEA-765/766)
    const prompt = `You are the AI assistant for Sandeep (your boss — the person you represent, and NOT the person you are texting).
You are texting ${name} on WhatsApp on Sandeep's behalf. In THIS chat, the person you are replying to is ${name}; Sandeep is not here.
${items.length ? `Open item(s) you're following up on:` : `There are no open reminders right now — this is an ongoing WhatsApp conversation with ${name}:`}
${itemList}

Conversation so far:
${thread}

Write the assistant's next single reply to whatever ${name} just said.
Rules:
- If you address them by name at all, use "${name}" — NEVER call them "Sandeep". Sandeep is your boss, not the person in this chat. Using no name is better than the wrong one. (You may still mention Sandeep in the third person, e.g. "I'll check with Sandeep".)
- Warm, natural, plain Indian English. You ARE Sandeep's AI assistant — do NOT pretend to be Sandeep. If they ask who you are, tell them you're Sandeep's AI assistant helping him keep track, and he'll jump in when needed.
- Warmly invite them to reply or ask anything they want to discuss.
- ENGAGE with what they actually said. When ${name} shares concrete details — quantities, hours, numbers, a status, a problem or a blocker — acknowledge the SPECIFICS: reflect the real figures/facts back so they know you truly read it, and ask ONE useful follow-up or offer help. NEVER reply to a detailed update with just "Perfect!" or "Got it".
- Concise and natural — usually 1 to 3 sentences, ONE message.
- Use the context Sandeep gave (above) to answer their questions when you can.
- If they ask something you don't know, that needs Sandeep's own decision, or is outside these items: set "needsSandeep": true, and reply that you'll pass it to Sandeep and he'll get back to them. NEVER make up an answer.
- ALWAYS reply to their message — set "send": true. NEVER leave them on read; a plain "yes"/"ok"/"thanks" or a shared file/link still gets a brief warm reply.
- Set "send": false ONLY in the rare case where your OWN immediately-previous message was already a short acknowledgment AND their new message adds literally nothing — otherwise ALWAYS send.
- FINISHED WORK: if ${name}'s LATEST message clearly says one of the numbered items above is COMPLETE, list those numbers in "done". Be strict — only when they plainly state it is finished/sent/paid/submitted/handed over. A promise ("I'll do it tomorrow"), a partial update ("almost there", "working on it") or a question is NOT finished, so leave "done" empty. If it is not obvious WHICH numbered item they mean, put nothing in "done" and ASK them which one in your reply — never guess.
- Never tell them the work is closed. Sandeep confirms it himself; you can say you have passed it to him to check.
- A PROMISED DATE: if they commit to a specific day for one of the numbered items ("I'll do it Friday", "by the 5th", "tomorrow"), put it in "promise" as {"item": <number>, "date": "YYYY-MM-DD"}. Today is ${todayKey}. Only a REAL date — "soon", "will do", "as early as possible" are NOT dates, so leave "promise" null. Never a date in the past.

Reply with ONLY this JSON, nothing else:
{"send": true or false, "reply": "<one message — only if send is true>", "needsSandeep": true or false, "done": [<numbers of items they say are finished, or empty>], "promise": null or {"item": <number>, "date": "YYYY-MM-DD"}}`;

    const raw = await this.reminders.voiceComplete(prompt, 'reminder-agent', 700);
    const parsed: any = this.parseJson(raw) || {};
    // Someone saying "done" is a CLAIM, not a completion. Record it against the exact task, with
    // their own words as the evidence, and leave the task open until the owner confirms. Only the
    // numbers the model was sure about arrive here; anything ambiguous it asks about instead. (BEA-1024)
    const lastIn = [...messages].reverse().find((m) => m.direction === 'in')?.body || '';
    const claimed: string[] = [];
    if (Array.isArray(parsed.done) && parsed.done.length && lastIn) {
      for (const n of parsed.done) {
        const item = items.find((it) => it.n === Number(n));
        if (!item?.taskId) continue; // a chase with no task behind it has nothing to claim
        const row = await this.claims.claim({ taskId: item.taskId, contactId, quote: lastIn, source: 'whatsapp' }).catch(() => null);
        if (row) claimed.push(item.subject);
      }
      if (claimed.length) this.log.log(`agent: ${name} says done — ${claimed.join('; ')} (waiting on Sandeep)`);
    }

    // A promised date eases the chase to once a day until then. (BEA-1022)
    const promise = parsed.promise;
    if (promise && typeof promise === 'object') {
      const item = items.find((it) => it.n === Number(promise.item));
      if (item?.taskId && typeof promise.date === 'string') {
        await this.tasks.recordPromise(item.taskId, promise.date).catch(() => undefined);
      }
    }

    // Never let a reply go out addressing the contact by the owner's name (BEA-899).
    let replyText = fixOwnerVocative((parsed.reply || '').trim(), 'Sandeep', name);
    const lastInBody = [...messages].reverse().find((m) => m.direction === 'in')?.body || '';

    // Reliability backstop (BEA-923): the owner wants every reply acknowledged — never leave a
    // contact on read. If the model still returned nothing but the contact wrote last, send a short
    // context-aware ack. The identical-reply suppression below keeps repeated acks from spamming.
    if ((parsed.send === false || !replyText) && needsAck(messages)) {
      replyText = ackLine(name.split(/\s+/)[0] || name, lastInBody);
      parsed.send = true;
    }

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
        .create({ data: { contactId, reminderId: anchorReminderId, direction: 'out', body: replyText, wamid: res.wamid || null, status: 'sent' } })
        .catch(() => undefined);
    }

    // The agent couldn't answer → flag the contact's reminders ("needs you") AND WhatsApp Sandeep. (BEA-766/767)
    if (parsed.needsSandeep) {
      await this.prisma.reminder.updateMany({ where: { contactId, status: 'active' }, data: { needsOwner: true } }).catch(() => undefined);
      await this.notifyOwner(name, lastInBody);
      this.log.log(`agent: flagged contact ${contactId} — needs Sandeep`);
    } else {
      // The agent handled this exchange without getting stuck — clear any prior "needs you" flag so
      // the badge doesn't stay stuck until the owner happens to type a manual message. (BEA-786)
      await this.prisma.reminder.updateMany({ where: { contactId, needsOwner: true }, data: { needsOwner: false } }).catch(() => undefined);
    }

    // NOTE: the agent no longer auto-closes reminders from a chat (BEA-948). These are often ongoing
    // reporting relationships (e.g. daily production updates) that are never really "done" — closing
    // them silenced the conversation. Only the user closes a reminder now, from the app.
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
