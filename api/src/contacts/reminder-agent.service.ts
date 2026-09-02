import { Injectable, Logger, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { promisesLater } from './promise-later';
import { readUpdate, looksLikePartialProgress } from './update-read';
import { TeamUpdatesService } from './team-updates.service';
import { PostboxService } from './postbox.service';
import { ownerFirstName, sendOwnerAlert } from './owner-alert';
import { ClaimsService } from '../tasks/claims.service';
import { DelegationService } from '../tasks/delegation.service';
import { replyWithClaimConfirmation, ambiguousDoneReply, withSystemLine, dailyReceivedLine } from './claim-reply';
import { resolveTap } from './tap-handler';
import { buildPickList, taskIdFromRow } from './pick-list';
import { RecurringService } from '../tasks/recurring.service';
import { isOwedOn, parseSchedule } from '../tasks/schedule';
import { weekdayOf } from '../common/localday';
import { TasksService } from '../tasks/tasks.service';
import { RemindersService, topicFromMessage, dailySubject, REMINDER_TZ_OFFSET } from './reminders.service';
import { PromptsService } from '../prompts/prompts.service';
import { TASK_OPEN, isOpen } from '../tasks/task-status';

/** Watchdog decision for an unanswered inbound of a given age. Pure + unit-tested. (BEA-953) */
export function watchdogAction(ageMs: number, graceMs = 8 * 60_000, escalateMs = 45 * 60_000): 'skip' | 'retry' | 'escalate' {
  if (ageMs < graceMs) return 'skip'; // give the live reply path time
  if (ageMs < escalateMs) return 'retry'; // self-heal
  return 'escalate'; // still stuck after retries → tell the owner
}

/** The inbox line the watchdog writes when a reply has gone unanswered for good. (BEA-1596) */
export function watchdogLine(lastInbound: string, ageMs: number): string {
  const mins = Math.max(1, Math.round(ageMs / 60_000));
  const dur = mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  const quote = String(lastInbound || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `No reply for ${dur} — "${quote}"`;
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
  // NOT "noted that it's done" (BEA-1293). This fires when the model returned nothing to send, so
  // nothing has been recorded — and telling someone their report landed when it did not is the bug
  // that made them stop trusting the replies. The real confirmation is built in `claim-reply.ts`
  // and only ever appears when a claim actually landed.
  if (/\b(done|completed|finished|closed|sorted|resolved)\b/.test(b)) return `Thanks ${who} — I've passed this to Sandeep.`;
  return `Great, thanks ${who}!`;
}

// The BEA-1122 progress guard now lives in update-read.ts, next to the reader that needed it most:
// the review queue was rebuilt on readUpdate (BEA-1159) WITHOUT this guard, and the exact bug the
// guard exists for — "started, working on it" read as a done-claim — came back on the new surface.
// One home means one opinion, everywhere. (BEA-1211)
export { looksLikePartialProgress };

/**
 * How much the agent reads before it answers (BEA-1115). It used to read EVERY message ever
 * exchanged with a contact, so the prompt grew forever — cost and delay climbing every day, and
 * months-old settled chat competing with today's for the model's attention. Tune here; these are
 * the only knobs.
 */
export const THREAD_KEEP = {
  /** Keep going back until this many of THEIR messages are in view. */
  inbound: 4,
  /** Hard cap on the kept slice. Contacts often fire 2-3 messages seconds apart, so a burst must
   *  not be able to swallow the whole window and leave the agent with no prior exchange. */
  maxMessages: 12,
  /** Rows loaded from the DB. Wider than the prompt slice on purpose: the duplicate-reply guard
   *  looks across this span, so trimming the prompt does not weaken anti-repeat protection. */
  recentWindow: 30,
  /** Work they finished this recently is still named, flagged "do not chase again". */
  doneDays: 7,
  doneMax: 6,
  /** Briefings carrying an open task; the most recent one is always added on top of these. */
  briefs: 3,
};

/**
 * The tail of the conversation: walk back from the newest message until `inbound` of THEIR
 * messages are in view, keeping our own replies in between so the agent can still read its own
 * questions. Without our side, "yes" and "the second one" are unanswerable. Pure/testable.
 */
export function trimThread<T extends { direction: string }>(
  messages: T[],
  keep: { inbound: number; maxMessages: number } = THREAD_KEEP,
): T[] {
  let seenIn = 0;
  let start = messages.length; // nothing kept yet
  for (let i = messages.length - 1; i >= 0; i--) {
    const isIn = messages[i].direction === 'in';
    if (isIn && seenIn >= keep.inbound) break; // one of theirs too many — stop before it
    if (messages.length - i > keep.maxMessages) break; // burst guard
    if (isIn) seenIn++;
    start = i;
  }
  return messages.slice(start);
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
    private readonly recurring: RecurringService,
    private readonly tasks: TasksService,
    private readonly prompts: PromptsService,
    private readonly updates: TeamUpdatesService,
    // Last, and @Optional(): the spec harnesses build this service positionally. (BEA-1293)
    @Optional() private readonly delegation?: DelegationService,
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
        select: { contactId: true, createdAt: true, body: true },
      });
      const latestInByContact = new Map<string, { at: Date; body: string }>();
      for (const m of inbound) if (m.contactId && !latestInByContact.has(m.contactId)) latestInByContact.set(m.contactId, { at: m.createdAt, body: String((m as any).body || '') });

      for (const [contactId, last] of latestInByContact) {
        const inAt = last.at;
        const answered = await this.prisma.reminderMessage.count({ where: { contactId, direction: 'out', createdAt: { gt: inAt } } });
        if (answered > 0) { this.escalated.delete(contactId); continue; } // we replied → clear any escalation state
        const action = watchdogAction(now - new Date(inAt).getTime());
        if (action === 'skip') continue;
        this.log.warn(`watchdog: unanswered reply for contact ${contactId} → ${action}`);
        await this.onContactReply(contactId).catch(() => undefined); // retry either way
        if (action === 'escalate' && !this.escalated.has(contactId)) {
          this.escalated.add(contactId);
          // ONE inbox item per escalation, inside the guard, so later ticks never add another.
          // It goes through the same door every "needs you" goes through (BEA-1596); `record()`'s
          // 60 s dedupe also covers a restart that forgets `escalated` within a minute.
          await this.updates
            .record({ contactId, channel: 'system', text: watchdogLine(last.body, now - new Date(inAt).getTime()), forceNeedsYou: true, skipAi: true, why: 'their reply went unanswered and the assistant could not answer it', at: new Date() })
            .catch(() => undefined);
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

  /**
   * What the owner has told the agent about this person. Briefings carrying an OPEN task are what
   * the agent actually reasons about; the most recent briefing is always added on top, so general
   * context ("she's handling the Focus ERP migration") isn't lost just because no task hangs off
   * it. Read directly rather than via BriefingsService — that module depends on this one, and a
   * circular dependency breaks startup. (BEA-1023, BEA-1115)
   */
  private async briefsFor(contactId: string): Promise<string> {
    const pick = { id: true, rawText: true, createdAt: true };
    const [withOpenTask, latest] = await Promise.all([
      this.prisma.briefing
        .findMany({ where: { contactId, tasks: { some: { status: TASK_OPEN } } }, orderBy: { createdAt: 'desc' }, take: THREAD_KEEP.briefs, select: pick })
        .catch(() => [] as any[]),
      this.prisma.briefing
        .findMany({ where: { contactId }, orderBy: { createdAt: 'desc' }, take: 1, select: pick })
        .catch(() => [] as any[]),
    ]);
    const byId = new Map<string, any>();
    for (const b of [...withOpenTask, ...latest]) byId.set(b.id, b);
    return [...byId.values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((r) => `[${new Date(r.createdAt).toISOString().slice(0, 10)}] ${r.rawText}`)
      .join('\n\n');
  }

  private async processContactReply(contactId: string): Promise<void> {
    const contact: any = await this.prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return;
    const number = (contact.whatsappNumber || '').replace(/[^\d]/g, '');
    if (!number || !this.postbox.isConfigured()) return;

    // They have LEFT. (BEA-1307)
    //
    // The scheduled sender was guarded and this was not, which left the worse hole of the two: she
    // messages, and an AI carries on a conversation on the owner's behalf with somebody who no
    // longer works here — chasing, asking for updates, promising to pass things on.
    //
    // Her words are still recorded, and the owner is told so he can answer himself if he wants to.
    // What does not happen is the app deciding to talk to her.
    if (contact.leftAt) {
      this.log.log(`agent: ${contact.name} has left — recorded their message, not replying`);
      const lastIn = await this.prisma.reminderMessage
        .findFirst({ where: { contactId, direction: 'in' }, orderBy: { createdAt: 'desc' }, select: { body: true } })
        .catch(() => null);
      await this.notifyOwner(`${contact.name} (who has left)`, lastIn?.body || '').catch(() => false);
      return;
    }

    // Process a reply for ANY reminder relationship — active, paused, OR done. The conversation must
    // never die just because a reminder was closed or paused. We ALWAYS read + reply; a reminder's
    // status only governs whether WE send scheduled nudges, never whether we answer THEM. (BEA-948)
    const allReminders: any[] = await this.prisma.reminder.findMany({ where: { contactId }, orderBy: { createdAt: 'asc' } });
    if (!allReminders.length) return; // no relationship at all → nothing to do
    const reminders: any[] = allReminders
      .filter((r) => r.status === 'active' || r.status === 'paused') // open items to chase
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); // same numbering as the message (BEA-1041)
    const anchorReminderId: string = (reminders[0] || allReminders[allReminders.length - 1]).id; // where to attach our outbound
    // Only the recent window comes out of the DB — the full history used to be loaded and pasted
    // into every prompt, growing forever. (BEA-1115)
    const recent: any[] = await this.prisma.reminderMessage.findMany({ where: { contactId }, orderBy: { createdAt: 'desc' }, take: THREAD_KEEP.recentWindow });
    // Newest-first out of the DB (so `take` keeps the RECENT end), then put it back in reading
    // order. Sorted explicitly rather than reversed: the order everything below depends on must not
    // rest on the driver's orderBy. Missing timestamps compare equal, so a given order is kept.
    const at = (m: any) => (m?.createdAt ? new Date(m.createdAt).getTime() : 0);
    const messages: any[] = [...recent].sort((a, b) => at(a) - at(b));
    const name = (contact.name || 'them').trim();
    // The model sees a tighter slice than the duplicate-reply guard below, which uses `messages`.
    const thread = trimThread(messages).map((m) => `${m.direction === 'out' ? 'Me' : name}: ${m.body}`).join('\n');

    // They TAPPED a button. (BEA-1300)
    //
    // A tap is a certain answer, so it is settled here — before the model is asked anything. This is
    // the one decision in the whole loop where a guess can silence a chase for work that is still
    // open, and a button press removes the need to guess entirely.
    //
    // Anything not certain returns null and carries on below exactly as before: a typed message, a
    // button we do not recognise, a reply to something that is not one of our nudges.
    const latestIn = [...messages].reverse().find((m) => m.direction === 'in');

    // They picked a ROW from a list we sent. (BEA-1302)
    //
    // The row carried the task's own id, so this is the least ambiguous message the system can
    // receive — more certain even than a Done button, which only narrows to a nudge. Handled first.
    const pickedTaskId = taskIdFromRow(latestIn?.buttonId);
    if (pickedTaskId && (await this.actOnPick(contactId, name, pickedTaskId))) return;

    const tapped = await resolveTap(this.prisma, latestIn);
    if (tapped && (await this.actOnTap(contactId, name, tapped))) return;

    const todayKey = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST, for date wording

    // The whole picture for this person, not just their reminders. Without this the agent answers
    // with half the story and cannot tell which piece of work they mean. (BEA-1023)
    const [briefText, work] = await Promise.all([
      // Read the briefings directly rather than through BriefingsService — that module already
      // depends on this one, and a circular dependency would break the app at startup. (BEA-1023)
      this.briefsFor(contactId),
      // OPEN work first, explicitly (BEA-1189). `orderBy: { status: 'asc' }` sorts the text, and
      // 'done' < 'open' alphabetically — so with take: 40 a long-standing colleague's finished work
      // filled the whole window and their real open tasks never reached the agent at all.
      (async () => {
        const sel = {
          id: true, title: true, note: true, status: true, createdAt: true, completedAt: true, promisedFor: true,
          claims: { where: { status: 'pending' as const }, take: 1, select: { createdAt: true } },
          people: { select: { contact: { select: { name: true } } } },
        };
        const [openRows, doneRows] = await Promise.all([
          this.prisma.task.findMany({ where: { ownerContactId: contactId, status: TASK_OPEN }, orderBy: { createdAt: 'desc' }, take: 40, select: sel }),
          this.prisma.task.findMany({ where: { ownerContactId: contactId, status: 'done' }, orderBy: { completedAt: 'desc' }, take: 20, select: sel }),
        ]);
        return [...openRows, ...doneRows];
      })().catch(() => [] as any[]),
    ]);
    const openWork = (work as any[]).filter((t) => isOpen(t));
    // Recently finished work is still named so the agent cannot chase something they just did —
    // narrowed from 21 days to 7, since older completions are noise by now. (BEA-1115)
    const doneRecently = (work as any[])
      .filter((t) => t.status === 'done' && t.completedAt && Date.now() - new Date(t.completedAt).getTime() < THREAD_KEEP.doneDays * 86400000)
      .slice(0, THREAD_KEEP.doneMax);
    const days = (d: any) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
    const workLines = openWork
      .map((t) => {
        const bits = [`open ${days(t.createdAt)} day(s)`];
        if (t.promisedFor) bits.push(`they promised ${t.promisedFor}`);
        if (t.claims?.length) bits.push('they say it is done — waiting on Sandeep to confirm');
        const others = (t.people || []).map((p: any) => p.contact.name).filter(Boolean);
        if (others.length) bits.push(`also involves ${others.join(', ')}`);
        return `- ${t.title}${t.note ? ` (${t.note})` : ''} [${bits.join('; ')}]`;
      })
      .join('\n');
    // Which of these are standing daily reports? They can never be "done", so the model must be
    // told which numbers they are — otherwise it reports one finished and the chase dies. (BEA-1118)
    const itemTaskIds = reminders.map((r: any) => r.taskId).filter(Boolean) as string[];
    const recurringTaskIds = new Set<string>();
    if (itemTaskIds.length) {
      const rows = await this.prisma.task
        .findMany({ where: { id: { in: itemTaskIds }, kind: 'recurring' }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      for (const r of rows) recurringTaskIds.add(r.id);
    }
    const items: { n: number; reminderId: string; taskId: string | null; subject: string; recurring: boolean }[] = [];
    for (let i = 0; i < reminders.length; i++) {
      items.push({
        n: i + 1,
        reminderId: reminders[i].id,
        taskId: reminders[i].taskId || null,
        subject: await this.subjectFor(reminders[i]),
        recurring: !!reminders[i].taskId && recurringTaskIds.has(reminders[i].taskId),
      });
    }
    const itemList = items.length
      ? items.map((it, i) => `${it.n}. ${it.subject}${it.recurring ? ' [daily report — owed every working day, never "done"]' : ''}${reminders[i].notes?.trim() ? ` — context Sandeep gave: ${reminders[i].notes.trim()}` : ''}`).join('\n')
      : '(no open reminders right now — this is an ongoing conversation; keep it warm, acknowledge what they share, and pass anything important to Sandeep)';

    // Sandeep's transparent AI assistant — identifies itself, uses the notes as context, and
    // escalates to Sandeep when it can't answer, instead of impersonating him. (BEA-765/766)
    const tmpl = await this.prompts.get('people.chaseAgent');
    const header = items.length
      ? `Open item(s) you're following up on:`
      : `There are no open reminders right now — this is an ongoing WhatsApp conversation with ${name}:`;
    const prompt =
      tmpl.replace(/\{\{name\}\}/g, name).replace(/\{\{today\}\}/g, todayKey) +
      `\n\n${header}\n${itemList}\n` +
      `${briefText ? `\nWhat Sandeep told you about ${name} (his own words, most recent first):\n${briefText}\n` : ''}${workLines ? `\nEverything ${name} currently owes Sandeep:\n${workLines}\n` : ''}${doneRecently.length ? `\nRecently finished and confirmed (do NOT chase these again):\n${doneRecently.map((t: any) => `- ${t.title}`).join('\n')}\n` : ''}` +
      `\nConversation so far:\n${thread}`;

    const raw = await this.reminders.voiceComplete(prompt, 'reminder-agent', 700);
    const parsed: any = this.parseJson(raw) || {};
    // Someone saying "done" is a CLAIM, not a completion. Record it against the exact task, with
    // their own words as the evidence, and leave the task open until the owner confirms. Only the
    // numbers the model was sure about arrive here; anything ambiguous it asks about instead. (BEA-1024)
    const lastIn = [...messages].reverse().find((m) => m.direction === 'in')?.body || '';
    const claimed: string[] = [];
    /** Task titles whose claim genuinely landed — what the confirmation line names. (BEA-1293) */
    const claimedTitles: string[] = [];
    // A daily report satisfies TODAY, and is owed again tomorrow. Recorded against the day, never
    // as a claim — so it never reaches the owner's review list and can never close the chase.
    // Independent of "done": Jayanth's real updates are figures and names, they never say
    // "finished". (BEA-1118)
    // Every reply becomes ONE update with a read, so nothing they say is invisible and anything
    // needing him opens a review item that only HE can close. (BEA-1159)
    if (lastIn) {
      const anyReport = items.some((it) => it.recurring);
      await this.updates
        .record({ contactId, text: lastIn, channel: 'whatsapp', taskId: items.find((it) => it.taskId)?.taskId || null, isReport: anyReport })
        .catch(() => undefined);
    }

    const reported: string[] = [];
    /** Task ids whose standing report landed today — what the acknowledgement names. (BEA-1295) */
    const reportedTaskIds: string[] = [];
    // "Update sheet sending 12 clock" is a promise, not a report. On 27 Jul that message arrived
    // 50 seconds AFTER a share-page tick and the board still said received. The later message
    // wins, so it un-marks the day and the chase resumes. (BEA-1152)
    if (lastIn && promisesLater(lastIn)) {
      const today = this.recurring.today();
      for (const it of items) {
        if (!it.taskId || !it.recurring) continue;
        const undone = await this.recurring.markNotReceived(it.taskId, today, lastIn, contactId, { source: 'whatsapp' });
        if (undone) this.log.log(`agent: ${name} said "${lastIn.slice(0, 60)}" — ${it.subject} is still owed today`);
      }
    }
    if (Array.isArray(parsed.statusToday) && parsed.statusToday.length && lastIn) {
      const today = this.recurring.today();
      for (const n of parsed.statusToday) {
        const item = items.find((it) => it.n === Number(n));
        if (!item?.taskId || !item.recurring) continue; // only daily items have a day to satisfy
        // A message promising it for later is never today's report, whatever the model decided.
        if (promisesLater(lastIn)) continue;
        await this.recurring.markReceived(item.taskId, today, lastIn, contactId, { source: 'whatsapp' });
        reported.push(item.subject);
        reportedTaskIds.push(item.taskId);
      }
      if (reported.length) this.log.log(`agent: ${name} sent today's ${reported.join('; ')}`);
    }
    if (Array.isArray(parsed.done) && parsed.done.length && lastIn) {
      for (const n of parsed.done) {
        const item = items.find((it) => it.n === Number(n));
        if (!item?.taskId) continue; // a chase with no task behind it has nothing to claim
        // The model was told never to mark a daily report finished. If it does anyway, treat it as
        // today's status instead of a completion — a wrong call must not be able to end the chase.
        if (item.recurring) {
          if (!promisesLater(lastIn)) {
            await this.recurring.markReceived(item.taskId, this.recurring.today(), lastIn, contactId, { source: 'whatsapp' });
            reported.push(item.subject); // the day is settled — the backstop below must not mark it twice (BEA-1210)
            reportedTaskIds.push(item.taskId);
          }
          continue;
        }
        // A second, deterministic opinion before a claim silences the chase. (BEA-1122)
        if (looksLikePartialProgress(lastIn)) {
          this.log.log(`agent: "${item.subject}" reported done, but the message reads as progress — not claiming`);
          continue;
        }
        // Through the one door (BEA-1296), which also PAUSES the chase rather than merely skipping
        // each send. The owner's rule: "when they say it's done, let us pause the reminders. If I
        // feel the task has been done, I will activate those reminders again." (BEA-1293)
        if (this.delegation?.recordClaim) {
          const res: any = await this.delegation.recordClaim({ taskId: item.taskId, contactId, quote: lastIn, source: 'whatsapp' }).catch(() => null);
          // Only a claim that REALLY landed earns a confirmation naming it. Nothing recorded,
          // nothing said — the whole point of the ticket.
          if (res?.claimed) claimedTitles.push(res.task?.title || item.subject);
          if (res?.claimed) claimed.push(item.subject);
        } else {
          const row = await this.claims.claim({ taskId: item.taskId, contactId, quote: lastIn, source: 'whatsapp' }).catch(() => null);
          if (row) claimed.push(item.subject);
        }
      }
      if (claimed.length) this.log.log(`agent: ${name} says done — ${claimed.join('; ')} (chase paused, waiting on Sandeep)`);
    }

    // Deterministic backstop (BEA-1210): a substantive status message satisfies today even when
    // the model's parse says nothing. On 29 Jul four real reports arrived, every one was read as
    // "status" by readUpdate, and the day's ledger recorded none of them — the model simply didn't
    // fill statusToday, and marking the day depended entirely on it. The same deterministic reader
    // that files the update now also settles the day, so a report can never again arrive and
    // leave "Today's reports" saying waiting/missed.
    if (lastIn && !reported.length && !promisesLater(lastIn)) {
      const recurringItems = items.filter((it) => it.taskId && it.recurring);
      if (recurringItems.length && readUpdate(lastIn, { isReport: true }).reads.includes('status')) {
        const today = this.recurring.today();
        for (const it of recurringItems) {
          await this.recurring.markReceived(it.taskId, today, lastIn, contactId, { source: 'whatsapp' });
          reported.push(it.subject);
          reportedTaskIds.push(it.taskId as string);
        }
        this.log.log(`agent: ${name}'s message reads as a report — settled today's ${reported.join('; ')} (backstop)`);
      }
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

    // Tell the owner BEFORE anything is promised in his name. It used to reply first and notify
    // second, so a contact was told "I'll pass this to Sandeep" before Sandeep knew the
    // conversation existed — and if the notification then failed, they were waiting on something
    // he never heard about. (BEA-1026)
    let reachedOwner = true;
    if (parsed.needsSandeep) {
      // Flag the ITEM it got stuck on, not everything this person owes. (BEA-1297)
      //
      // "Needs you" used to be set on every active chase for the contact, so it said a PERSON needs
      // you and never what about — and each row in Contacts carries its own task line, so the badge
      // appeared against work that was perfectly fine. When the model cannot tell which item it is,
      // the item stays contact-wide (no task), which is honest rather than a guess.
      //
      // The flag IS an inbox row (BEA-1596): their last message, forced to "needs you" because the
      // agent already judged it, on the task of the item it named. The Dashboard and Tasks → Needs
      // you both read that row, and only the owner closing it clears it.
      const stuckItem = items.find((it) => it.n === Number(parsed.needsItem));
      const stuckOn = stuckItem?.reminderId;
      if (lastInBody) {
        await this.updates
          .record({ contactId, text: lastInBody, channel: 'whatsapp', taskId: stuckItem?.taskId || null, forceNeedsYou: true, skipAi: true, why: stuckItem ? `the assistant could not answer this about ${stuckItem.subject}` : 'the assistant could not answer this' })
          .catch(() => undefined);
      }
      reachedOwner = await this.notifyOwner(name, lastInBody, stuckOn ? items.find((it) => it.reminderId === stuckOn)?.subject : null).catch(() => false);
      this.log.log(`agent: needs Sandeep — ${stuckOn ? `about "${items.find((it) => it.reminderId === stuckOn)?.subject}"` : `contact ${contactId} (could not tell which item)`}${reachedOwner ? '' : ' (could NOT reach him)'}`);
      if (!reachedOwner) {
        // Do not promise a reply we cannot guarantee. Say something true instead.
        replyText = `Thanks ${name.split(/\s+/)[0] || ''} — I've noted this down for Sandeep.`.replace(/\s+/g, ' ').trim();
      }
    }

    // A recurring update is still owed and this reply didn't carry it → hand them the door to the
    // structured section on their page, once per conversation stretch. The suppression: if any of
    // the last outbound messages already carried their link, don't paste it again. (BEA-1217)
    if (replyText && reported.length === 0) {
      const owesToday = items.some((it) => it.taskId && it.recurring);
      // Match the DAILY nudge's own link, not any link to their page. The "which one do you mean?"
      // reply (BEA-1294) also carries a `/t/<slug>` link, and a bare '/t/' check let it suppress the
      // real "fill today's update" nudge for the next several turns. (review finding)
      const linkAlreadySent = messages.slice(-12).some((m) => m.direction === 'out' && m.body?.includes('?tab=updates'));
      if (owesToday && !linkAlreadySent) {
        const today = this.recurring.today();
        // Only reports OWED today count — on a rest day or an off-schedule day nothing is due, and
        // "fill today's update" would be the BEA-1147 bug all over again. (review finding)
        const rIds = items.filter((it) => it.taskId && it.recurring).map((it) => it.taskId as string);
        const rTasks = ((await Promise.resolve(this.prisma.task?.findMany?.({ where: { id: { in: rIds } }, select: { id: true, scheduleDays: true } })).catch(() => [])) ?? []) as { id: string; scheduleDays: string | null }[];
        const rest = ((await Promise.resolve(this.recurring.restDays?.()).catch(() => ['Sun'])) ?? ['Sun']) as string[];
        const weekday = weekdayOf(today);
        const owedIds = rTasks.filter((t) => isOwedOn(t.scheduleDays, weekday, rest)).map((t) => t.id);
        const stillWaiting = owedIds.length > 0
          && (await Promise.all(owedIds.map((id) => this.recurring.isReceived(id, today)))).some((r) => !r);
        if (stillWaiting) {
          // Never hand out a link to a page the owner turned OFF — a dead door is worse than none.
          const c = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { shareSlug: true, shareEnabled: true } }).catch(() => null);
          if (c?.shareSlug && c.shareEnabled !== false) replyText += `\n📝 You can fill today's update here: https://mybrain.1site.ai/t/${c.shareSlug}?tab=updates`;
        }
      }
    }

    // Say WHAT was recorded, in our own words, not the model's. (BEA-1293)
    //
    // This is the line the owner asked for: *"you have to reply to them with which task they have
    // finished."* It is appended only when a claim genuinely landed, so it can never tell somebody
    // their report was saved when it was not — and if the model decided to stay quiet, a landed
    // claim overrides that, because going silent on a completion is exactly what lost their trust.
    const confirmed = replyWithClaimConfirmation(replyText, claimedTitles);
    replyText = confirmed.text;
    /** This pass carries a FACT — a claim landed, or today's report arrived. Such a message must
     *  reach them even if the wording matches something sent on an earlier day. (review finding) */
    let carriesFact = confirmed.forceSend;
    if (confirmed.forceSend) parsed.send = true;

    // Today's standing report landed — say so, and say when it comes round again. (BEA-1295)
    //
    // A daily report is never "done", so it never earns the completion line above. Without its own
    // acknowledgement the reporter sends real numbers, hears a generic "thanks", and the chase comes
    // back — which from their side is indistinguishable from being ignored.
    if (reportedTaskIds.length) {
      const ids = [...new Set(reportedTaskIds)];
      const rows: any[] = ((await Promise.resolve(this.prisma.task?.findMany?.({ where: { id: { in: ids } }, select: { id: true, title: true, scheduleDays: true } })).catch(() => [])) ?? []) as any[];
      if (rows.length) {
        // "tomorrow" is only true for a report owed every working day. Rakesh's is Friday-only, and
        // telling him "I'll ask again tomorrow" on a Friday would be a plain untruth.
        // "tomorrow" has to be a day the report is genuinely owed. Its OWN weekdays matter (Rakesh's
        // is Friday-only) and so do the app's rest days — an unscheduled report submitted on a
        // Saturday is not owed on Sunday, so "I'll ask again tomorrow" would be untrue there too.
        // (review finding)
        const rest = ((await Promise.resolve(this.recurring.restDays?.()).catch(() => ['Sun'])) ?? ['Sun']) as string[];
        const tomorrowKey = new Date(new Date(`${this.recurring.today()}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
        const tomorrowWeekday = weekdayOf(tomorrowKey);
        const everyDay = rows.every((t) => !parseSchedule(t.scheduleDays)) && !rest.includes(tomorrowWeekday);
        const line = dailyReceivedLine(rows.map((t) => dailySubject(t.title || '')), everyDay);
        if (line) {
          replyText = withSystemLine(replyText, line);
          parsed.send = true;
          carriesFact = true;
        }
      }
    }

    // They said it is finished — but not WHICH one. (BEA-1294)
    //
    // Deepthi has three open items. A bare "done sir" is genuinely ambiguous, and guessing is not a
    // symmetric mistake: pausing the wrong chase means work everybody believes is finished quietly
    // stops being asked about. So nothing is claimed, nothing is paused, and they get the list AND
    // their own link — the owner asked for both.
    // `isReport: true` on purpose, matching the other place that makes a decision on this signal
    // (the backstop below). Without it the `isQuantityNotClaim` guard never engages, and a long
    // numbers-heavy report containing one word like "dispatched" reads as a bare completion —
    // interrupting a real update with "which one do you mean?". (review finding)
    const readsDone = !!lastIn && readUpdate(lastIn, { isReport: true }).reads.includes('done');
    // `claimed` as well as `claimedTitles`: the legacy fallback path fills only the former, so
    // checking one alone could ask "which one?" about an item just correctly claimed. (review finding)
    if (!claimedTitles.length && !claimed.length && !reported.length && lastIn && readsDone) {
      const open = items.filter((it) => it.taskId && !it.recurring);
      if (open.length > 1) {
        const titles = new Map<string, string>(
          ((await Promise.resolve(this.prisma.task?.findMany?.({ where: { id: { in: open.map((o) => o.taskId as string) } }, select: { id: true, title: true } })).catch(() => [])) ?? [])
            .map((t: any) => [t.id, t.title]),
        );
        const link = (await this.reminders.shareLinkFor?.(contactId).catch(() => null)) || null;

        // One tap instead of typing a number. (BEA-1302)
        //
        // Their message opened the 24-hour window, so a list is deliverable right now. If it cannot
        // be built (two rows would read the same) or cannot be sent (the window shut, Postbox
        // refused), the numbered text below goes instead — a silent failure here means they are
        // never asked at all, so the fallback is tested, not assumed.
        const pick = buildPickList(open.map((it) => ({ id: it.taskId as string, title: titles.get(it.taskId as string) || it.subject })), { name, link });
        if (pick && number) {
          const sent = await this.postbox.sendList?.(number, { body: pick.body, buttonText: pick.buttonText, rows: pick.rows }).catch(() => null);
          if (sent && sent.status !== 'failed') {
            await this.prisma.reminderMessage
              .create({ data: { contactId, direction: 'out', body: [pick.body, ...pick.rows.map((r, i) => `${i + 1}. ${r.title}`)].join('\n'), wamid: sent.wamid || null, status: 'sent' } })
              .catch(() => undefined);
            this.log.log(`agent: ${name} says done but not which — sent a list of ${pick.rows.length}, claimed nothing`);
            return;
          }
          this.log.warn(`agent: list to ${name} failed (${sent?.error || 'no result'}) — falling back to the numbered text`);
        }

        const ask = ambiguousDoneReply(
          open.map((it) => ({ n: it.n, label: titles.get(it.taskId as string) || it.subject })),
          link,
        );
        if (ask) {
          // Normally this REPLACES the model's prose — a generic "thanks!" above a question about
          // which item reads like the app was not listening.
          //
          // But when the same message also needs Sandeep, replacing would throw away the one line
          // that matters: the person raised a real problem and would be answered with "which one do
          // you mean?" and nothing else. A message can be both — `readUpdate` has a label for
          // exactly that combination. In that case the question goes UNDER the reply. (review finding)
          const alsoNeedsHim = !!parsed.needsSandeep || readUpdate(lastIn, { isReport: true }).reads.includes('needs_you');
          replyText = alsoNeedsHim ? withSystemLine(replyText, ask) : ask;
          parsed.send = true;
          // This question is now the LAST line of defence — the list could not be built or could not
          // be sent. Its wording is fixed, so an identical one sent any time in the last 30 messages
          // would have had it silently swallowed, and the person would never be asked at all. That is
          // the worst outcome this whole path exists to avoid. (review finding)
          carriesFact = true;
          this.log.log(`agent: ${name} says done but not which — asked, claimed nothing`);
        }
      }
    }

    // Stay quiet if the agent decided so (BEA-737) or the reply repeats one already sent (BEA-735).
    const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    // The duplicate guard compares against the last 30 messages, which can span weeks. That is
    // right for chit-chat and wrong for a fact: "today's production update is in" carries no date,
    // so an identical line sent last Tuesday would silently swallow today's — and the reporter would
    // hear nothing on the exact day they sent their numbers, which is the bug this ticket exists to
    // fix. A fact-carrying message is only suppressed by an identical one sent TODAY. (review finding)
    const dayKeyOf = (d: any) => (d ? new Date(new Date(d).getTime() + REMINDER_TZ_OFFSET * 60000).toISOString().slice(0, 10) : '');
    const todayKeyLocal = dayKeyOf(new Date());
    const alreadySent = messages.some(
      (m) =>
        m.direction === 'out' &&
        norm(m.body) === norm(replyText) &&
        (!carriesFact || dayKeyOf(m.createdAt) === todayKeyLocal),
    );
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

    // Nothing here clears a "needs you" any more (BEA-1596). It is an inbox row now, and the
    // owner's loop is "it closes ONLY when he closes it" (BEA-1159) — a later cheerful message must
    // never take a real question off his list. Finishing the work closes it (`settleDelegation`).

    // NOTE: the agent no longer auto-closes reminders from a chat (BEA-948). These are often ongoing
    // reporting relationships (e.g. daily production updates) that are never really "done" — closing
    // them silenced the conversation. Only the user closes a reminder now, from the app.
  }

  /**
   * They picked a row from a list. The most certain message this system can receive. (BEA-1302)
   *
   * The row carried the task's own id, so there is nothing to resolve and nothing to interpret.
   * Returns true when it was handled, false if the row pointed at something that is no longer a
   * candidate — then the ordinary path takes over rather than leaving them on read.
   */
  private async actOnPick(contactId: string, name: string, taskId: string): Promise<boolean> {
    const task = await this.prisma.task
      .findUnique({ where: { id: taskId }, select: { id: true, title: true, kind: true, status: true, ownerContactId: true, scheduleDays: true } })
      .catch(() => null);
    const number0 = (await this.prisma.contact.findUnique({ where: { id: contactId }, select: { whatsappNumber: true } }).catch(() => null))?.whatsappNumber;
    const refuse = async (why: string) => {
      // Say so, rather than letting it fall through to a general reply. Someone who tapped a
      // specific choice and got back conversational small talk has no idea their choice did not
      // land — and the row will not resolve as anything else, so nothing downstream would tell
      // them either. (review finding)
      this.log.warn(`agent: ${name} picked a row that is no longer valid — ${why}`);
      const first0 = name.split(/\s+/)[0] || name;
      if (number0) {
        const res = await this.postbox.sendText(String(number0).replace(/[^\d]/g, ''), `Thanks ${first0} — that one is not on your list any more. Sandeep may have changed it.`).catch(() => ({}) as any);
        await this.prisma.reminderMessage
          .create({ data: { contactId, direction: 'out', body: `Thanks ${first0} — that one is not on your list any more. Sandeep may have changed it.`, wamid: res?.wamid || null, status: 'sent' } })
          .catch(() => undefined);
      }
      return true;
    };
    if (!task) return refuse('no such task');
    // A row id from someone else's list must never touch this person's work. `null` counts as a
    // mismatch too: an unowned task is not theirs either, and a task unassigned after the list went
    // out would otherwise sail straight through the guard written to stop exactly that. (review finding)
    if (task.ownerContactId !== contactId) return refuse('owned by someone else');
    const number = (await this.prisma.contact.findUnique({ where: { id: contactId }, select: { whatsappNumber: true } }).catch(() => null))?.whatsappNumber;
    const say = async (text: string) => {
      if (!text || !number) return;
      const res = await this.postbox.sendText(String(number).replace(/[^\d]/g, ''), text).catch(() => ({}) as any);
      await this.prisma.reminderMessage
        .create({ data: { contactId, direction: 'out', body: text, wamid: res?.wamid || null, status: 'sent' } })
        .catch(() => undefined);
    };
    const first = name.split(/\s+/)[0] || name;

    if (task.status === 'done') {
      await say(`Thanks ${first} — that one is already closed.`);
      return true;
    }
    if (task.kind === 'recurring') {
      await this.recurring.markReceived(task.id, this.recurring.today(), 'Picked from the list', contactId, { source: 'whatsapp' }).catch(() => undefined);
      const rest = ((await Promise.resolve(this.recurring.restDays?.()).catch(() => ['Sun'])) ?? ['Sun']) as string[];
      const tomorrow = weekdayOf(new Date(new Date(`${this.recurring.today()}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10));
      const everyDay = !parseSchedule(task.scheduleDays) && !rest.includes(tomorrow);
      await say(dailyReceivedLine([dailySubject(task.title || '')], everyDay));
      return true;
    }
    const res: any = await this.delegation?.recordClaim?.({ taskId: task.id, contactId, quote: 'Picked from the list', source: 'whatsapp' }).catch(() => null);
    if (!res?.claimed) {
      await say(`Thanks ${first} — Sandeep already has that one to check.`);
      return true;
    }
    await say(replyWithClaimConfirmation('', [res.task?.title || task.title]).text);
    this.log.log(`agent: ${name} picked "${task.title}" from the list — claimed exactly, no model`);
    return true;
  }

  /**
   * Act on a tap, and say something true back. (BEA-1300)
   *
   * Returns true when the tap fully settled the exchange, so the caller stops — no model call, no
   * invented wording. Returns false when it did not, and the ordinary path takes over: several jobs
   * on one nudge still needs a question, and that question is written where it already lives.
   */
  private async actOnTap(contactId: string, name: string, tapped: Awaited<ReturnType<typeof resolveTap>>): Promise<boolean> {
    if (!tapped) return false;
    const number = (await this.prisma.contact.findUnique({ where: { id: contactId }, select: { whatsappNumber: true } }).catch(() => null))?.whatsappNumber;
    const say = async (text: string) => {
      if (!text || !number) return;
      const res = await this.postbox.sendText(String(number).replace(/[^\d]/g, ''), text).catch(() => ({}) as any);
      await this.prisma.reminderMessage
        .create({ data: { contactId, reminderId: tapped.reminderIds[0] || null, direction: 'out', body: text, wamid: res?.wamid || null, status: 'sent' } })
        .catch(() => undefined);
    };
    const first = name.split(/\s+/)[0] || name;

    // Nothing left to act on — the work was finished or the chase closed between the nudge and the
    // tap. Answer them rather than leaving it on read, but change nothing.
    if (!tapped.tasks.length) {
      await say(`Thanks ${first} — nothing pending on that one now.`);
      return true;
    }

    if (tapped.meaning === 'working') {
      // Progress, never a claim. The chase carries on untouched — that is the whole point of the
      // button existing separately from Done.
      await say(`Thanks ${first} — I've let Sandeep know you're still on it.`);
      this.log.log(`agent: ${name} tapped "still working" on ${tapped.tasks.length} item(s) — nothing claimed`);
      return true;
    }

    if (tapped.meaning === 'will-reply') {
      await say(`Sure ${first} — go ahead, I'm reading.`);
      return true;
    }

    // Done. A standing daily report can never be finished, so a tap settles TODAY and says so.
    const daily = tapped.tasks.filter((t) => t.kind === 'recurring');
    const oneOff = tapped.tasks.filter((t) => t.kind !== 'recurring');

    // A tap that could mean more than one piece of work is not an answer, it is a narrower question.
    // Nothing is claimed and nothing is paused — the ordinary path below asks which. (BEA-1294)
    //
    // MIXED counts as ambiguous too: one daily report and one one-off on the same nudge used to fall
    // through to claiming the one-off, silently dropping the report and closing the exchange, so the
    // question was never asked either. That is the exact mistake this ticket exists to remove, made
    // by the code meant to remove it. (review finding)
    if (oneOff.length > 1 || (oneOff.length === 1 && daily.length > 0)) return false;

    if (!oneOff.length && daily.length) {
      const today = this.recurring.today();
      for (const t of daily) await this.recurring.markReceived(t.id, today, 'Tapped Done', contactId, { source: 'whatsapp' }).catch(() => undefined);
      // "tomorrow" only when tomorrow is genuinely owed — the same rule the ordinary path applies.
      // Rakesh's report is Friday-only, and telling him "I'll ask again tomorrow" on a Friday is a
      // plain untruth. BEA-1295 fixed that wording once; skipping the check here would undo it.
      const rest = ((await Promise.resolve(this.recurring.restDays?.()).catch(() => ['Sun'])) ?? ['Sun']) as string[];
      const tomorrow = weekdayOf(new Date(new Date(`${today}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10));
      const everyDay = daily.every((t) => !parseSchedule(t.scheduleDays)) && !rest.includes(tomorrow);
      await say(dailyReceivedLine(daily.map((t) => dailySubject(t.title || '')), everyDay));
      this.log.log(`agent: ${name} tapped done on ${daily.length} daily report(s) — today settled`);
      return true;
    }

    const task = oneOff[0];
    const res: any = await this.delegation?.recordClaim?.({ taskId: task.id, contactId, quote: 'Tapped Done', source: 'whatsapp' }).catch(() => null);
    if (!res?.claimed) {
      // Already waiting on the owner — going quiet is right, saying it twice is not.
      await say(`Thanks ${first} — Sandeep already has that one to check.`);
      return true;
    }
    await say(replyWithClaimConfirmation('', [res.task?.title || task.title]).text);
    this.log.log(`agent: ${name} tapped done on "${task.title}" — claimed exactly, no model`);
    return true;
  }

  /**
   * WhatsApp the owner when the agent is stuck (BEA-767) — through the one owner road: the approved
   * template first, never free text alone (BEA-1362). Free text only delivers inside the 24-hour
   * window after the owner last wrote to the number, and Postbox cannot tell us when it does not.
   */
  private async notifyOwner(contactName: string, lastMsg: string, about?: string | null): Promise<boolean> {
    // `owner.whatsapp` is the number this road always read; the Settings page saves the same
    // number as `alerts.whatsappNumber`, so that is the fallback when the older key is not set.
    const owner = (
      (await this.prisma.setting.findUnique({ where: { key: 'owner.whatsapp' } }))?.value ||
      (await this.prisma.setting.findUnique({ where: { key: 'alerts.whatsappNumber' } }))?.value ||
      ''
    ).replace(/[^\d]/g, '');
    if (!owner || !this.postbox.isConfigured()) return false;
    const snippet = lastMsg ? `"${lastMsg.replace(/\s+/g, ' ').trim().slice(0, 200)}"` : '';
    // Name the work when we know it — the app now does, and "needs you about the Elleys PCBs" is
    // answerable from a phone in a way that "needs you" is not. (review finding)
    const topic = about ? ` about ${about}` : '';
    const r = await sendOwnerAlert(this.postbox, owner, {
      firstName: await ownerFirstName(this.prisma),
      headline: `⚠ ${contactName} messaged and needs you${topic}`,
      detail: `${snippet ? `${snippet} · ` : ''}Open My Brain to reply.`,
      path: '/reminders',
    }).catch(() => ({ sent: false, error: 'failed' }) as any);
    if (!r?.sent) this.log.warn(`owner not told about ${contactName}: ${r?.error || 'unknown reason'}`);
    return !!r?.sent;
  }
}
