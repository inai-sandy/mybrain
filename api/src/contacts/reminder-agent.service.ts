import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { promisesLater } from './promise-later';
import { readUpdate } from './update-read';
import { TeamUpdatesService } from './team-updates.service';
import { PostboxService } from './postbox.service';
import { ClaimsService } from '../tasks/claims.service';
import { RecurringService } from '../tasks/recurring.service';
import { TasksService } from '../tasks/tasks.service';
import { RemindersService, topicFromMessage } from './reminders.service';
import { PromptsService } from '../prompts/prompts.service';

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

/** Words that plainly mean the whole thing is finished — these beat any progress signal. */
const CLEARLY_COMPLETE =
  /\b(all done|fully (done|completed|uploaded|sent)|100\s*%|completed all|finished all|everything (is )?(done|completed|uploaded|sent)|it is (completed|complete|done)|its? (completed|complete|done))\b/i;

/** "so far" / "up to now" / "remaining" / "working on it" — a report of progress, not of completion. */
const PROGRESS_WORDS =
  /\b(so far|till now|till date|up\s?to\s?(now|know|date)|as of now|in progress|work(ing)? on it|almost|partially|partial|remaining|balance|pending|yet to|not yet|will (finish|complete|do)|started|ongoing)\b/i;

/** "45 of 120", "45 out of 120", "45/120" — short of the total. */
function shortOfTotal(text: string): boolean {
  const re = /(\d[\d,]*)\s*(?:\/|of|out of)\s*(\d[\d,]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const a = Number(m[1].replace(/,/g, ''));
    const b = Number(m[2].replace(/,/g, ''));
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0 && a < b) return true;
  }
  return false;
}

/**
 * Does this message read as PROGRESS rather than completion? (BEA-1122)
 *
 * The prompt already tells the model that a partial update is not finished, and it still read
 * "Total we have 120 BOMs to upload, upto know we uploaded 45 BOMs" as done — which filed a claim,
 * silenced the chase, and left the person un-chased for two days. Wording alone was not enough, so
 * this is a deterministic second opinion: when a message plainly reports progress, a "done" from
 * the model is refused. Erring this way only costs an extra nudge; erring the other way loses the
 * chase entirely.
 */
export function looksLikePartialProgress(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (CLEARLY_COMPLETE.test(t)) return false; // they said it outright — believe them
  if (shortOfTotal(t)) return true;
  if (PROGRESS_WORDS.test(t)) return true;
  // Present continuous with no completion word: "we are using it and updating the data" is an
  // ongoing state, not a finished job.
  if (/\b(is|are|am)\s+\w+ing\b/i.test(t)) return true;
  return false;
}

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
        .findMany({ where: { contactId, tasks: { some: { status: { not: 'done' } } } }, orderBy: { createdAt: 'desc' }, take: THREAD_KEEP.briefs, select: pick })
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
          this.prisma.task.findMany({ where: { ownerContactId: contactId, status: { not: 'done' } }, orderBy: { createdAt: 'desc' }, take: 40, select: sel }),
          this.prisma.task.findMany({ where: { ownerContactId: contactId, status: 'done' }, orderBy: { completedAt: 'desc' }, take: 20, select: sel }),
        ]);
        return [...openRows, ...doneRows];
      })().catch(() => [] as any[]),
    ]);
    const openWork = (work as any[]).filter((t) => t.status !== 'done');
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
          }
          continue;
        }
        // A second, deterministic opinion before a claim silences the chase. (BEA-1122)
        if (looksLikePartialProgress(lastIn)) {
          this.log.log(`agent: "${item.subject}" reported done, but the message reads as progress — not claiming`);
          continue;
        }
        const row = await this.claims.claim({ taskId: item.taskId, contactId, quote: lastIn, source: 'whatsapp' }).catch(() => null);
        if (row) claimed.push(item.subject);
      }
      if (claimed.length) this.log.log(`agent: ${name} says done — ${claimed.join('; ')} (waiting on Sandeep)`);
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
      await this.prisma.reminder.updateMany({ where: { contactId, status: 'active' }, data: { needsOwner: true } }).catch(() => undefined);
      reachedOwner = await this.notifyOwner(name, lastInBody).catch(() => false);
      this.log.log(`agent: flagged contact ${contactId} — needs Sandeep${reachedOwner ? '' : ' (could NOT reach him)'}`);
      if (!reachedOwner) {
        // Do not promise a reply we cannot guarantee. Say something true instead.
        replyText = `Thanks ${name.split(/\s+/)[0] || ''} — I've noted this down for Sandeep.`.replace(/\s+/g, ' ').trim();
      }
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
    if (!parsed.needsSandeep) {
      // The agent handled this exchange without getting stuck — clear any prior "needs you" flag so
      // the badge doesn't stay stuck until the owner happens to type a manual message. (BEA-786)
      await this.prisma.reminder.updateMany({ where: { contactId, needsOwner: true }, data: { needsOwner: false } }).catch(() => undefined);
    }

    // NOTE: the agent no longer auto-closes reminders from a chat (BEA-948). These are often ongoing
    // reporting relationships (e.g. daily production updates) that are never really "done" — closing
    // them silenced the conversation. Only the user closes a reminder now, from the app.
  }

  /** WhatsApp Sandeep when the agent is stuck: nice free-text in-window, template fallback cold. (BEA-767) */
  private async notifyOwner(contactName: string, lastMsg: string): Promise<boolean> {
    const owner = ((await this.prisma.setting.findUnique({ where: { key: 'owner.whatsapp' } }))?.value || '').replace(/[^\d]/g, '');
    if (!owner || !this.postbox.isConfigured()) return false;
    const snippet = lastMsg ? `: "${lastMsg.replace(/\s+/g, ' ').trim().slice(0, 200)}"` : '';
    const res = await this.postbox.sendText(owner, `⚠ ${contactName} messaged and needs you${snippet}. Open My Brain to reply.`);
    if (!res.error) return true;
    // Outside the 24h free-text window → fall back to the approved template so it still lands.
    const fb = await this.postbox.sendReminderTemplate(owner, 'Sandeep', `${contactName}, who needs your reply in My Brain`).catch(() => ({ error: 'failed' }) as any);
    return !fb?.error;
  }
}
