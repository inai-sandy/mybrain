import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { readUpdate, readLabel, type Read, type ReadResult } from './update-read';
import { TASK_OPEN } from '../tasks/task-status';


/**
 * Everything the owner's team says, and the inbox of what needs him. (BEA-1159)
 *
 * His loop, in his words:
 *
 *   "We send a WhatsApp reminder. If they need my help, it will land in the review section. I will
 *    message them in the review section, and if the help is done, I will close it."
 *
 * So an update opens when they say something that needs him, he replies from inside review and it
 * goes out on WhatsApp, and it closes ONLY when he closes it. The old `needsOwner` flag was cleared
 * by the next reply the agent could handle — a "Kk sir" erased the record that someone asked for
 * help. Nothing here is ever cleared by a later message.
 */
@Injectable()
export class TeamUpdatesService {
  private readonly log = new Logger('TeamUpdates');

  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
    // Optional and LAST: spec harnesses build this service positionally with fewer args.
    @Optional() private readonly llm?: LlmService,
    @Optional() private readonly prompts?: PromptsService,
  ) {}

  /**
   * The AI second opinion on one reply (BEA-1213). The word-rules in update-read stay the floor;
   * the model may only move what they were unsure about:
   *
   * - A completion claim ("done") ALWAYS reaches the owner — the never-guess rule. Not negotiable.
   * - The model may RAISE a message the rules read as chat/status — it caught a need the words hid.
   *   Wrong costs one glance.
   * - The model may STAND DOWN a flagged message only in the short, figure-free politeness class
   *   ("No problem sir" trips the problem-word rule every time). A real problem is long or carries
   *   figures, and those keep their deterministic floor — wrong there costs a stopped line.
   * - No model, no answer, bad answer → the deterministic read stands. This must never break intake.
   */
  private async secondOpinion(text: string, r: ReadResult, isReport: boolean): Promise<{ needsYou: boolean; why: string | null }> {
    const out = { needsYou: r.needsYou, why: r.why };
    if (!this.llm || !this.prompts) return out;
    if (r.reads.includes('done')) return out; // the floor: a claim always reaches him
    const t = text.trim();
    if (r.reads.length === 1 && r.reads[0] === 'chat' && t.length < 12) return out; // "Kk sir" needs no model
    try {
      const tmpl = await this.prompts.get('people.reviewRead');
      const prompt = tmpl
        .replace(/\{\{message\}\}/g, t.slice(0, 1500))
        .replace(/\{\{report\}\}/g, isReport ? 'This person owes Sandeep a standing daily report.\n' : '');
      const raw = await this.llm.completeHelper('review-read', prompt, 80, 'review-read');
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      if (typeof parsed?.needsYou !== 'boolean') return out;
      if (parsed.needsYou && !out.needsYou) {
        return { needsYou: true, why: String(parsed.why || 'this needs your eyes').trim().slice(0, 120) || 'this needs your eyes' };
      }
      if (!parsed.needsYou && out.needsYou && t.length <= 25 && !/\d/.test(t)) {
        this.log.log(`AI stood down "${t.slice(0, 40)}" — politeness, not a problem`);
        return { needsYou: false, why: null };
      }
      return out;
    } catch {
      return out;
    }
  }

  /**
   * Record what someone said, whatever channel it came through. Returns the row, or null when
   * there is nothing worth keeping.
   */
  async record(input: { contactId: string; text: string; channel: 'whatsapp' | 'link'; taskId?: string | null; at?: Date; isReport?: boolean; skipAi?: boolean }) {
    const text = String(input.text || '').trim();
    if (!text || !input.contactId) return null;
    const at = input.at ?? new Date();

    // Never record the same message twice — the agent and the webhook can both see one reply.
    const dupe = await this.prisma.teamUpdate
      .findFirst({ where: { contactId: input.contactId, text, at: { gte: new Date(at.getTime() - 60_000), lte: new Date(at.getTime() + 60_000) } }, select: { id: true } })
      .catch(() => null);
    if (dupe) return null;

    const r = readUpdate(text, { isReport: !!input.isReport });
    // The word-rules propose, the AI seconds, and the merge rules in secondOpinion decide. (BEA-1213)
    // Backfill passes skipAi: hundreds of historical messages need no model round-trip each.
    const read = input.skipAi ? { needsYou: r.needsYou, why: r.why } : await this.secondOpinion(text, r, !!input.isReport);
    const row = await this.prisma.teamUpdate
      .create({
        data: {
          contactId: input.contactId,
          taskId: input.taskId || null,
          channel: input.channel,
          text: text.slice(0, 4000),
          reads: JSON.stringify(r.reads),
          needsYou: read.needsYou,
          why: read.why,
          at,
        },
      })
      .catch((e) => { this.log.warn(`record: ${e?.message}`); return null; });
    if (row && read.needsYou) this.log.log(`needs you — ${read.why}: "${text.replace(/\s+/g, ' ').slice(0, 70)}"`);
    return row;
  }

  /** Everything waiting on him, oldest first — the ones that have been ignored longest matter most. */
  async inbox() {
    const rows = await this.prisma.teamUpdate.findMany({
      // A message about a task that is already DONE has nothing left to review — the base filter
      // never looked at the task at all, so completed work sat in the inbox forever. (BEA-1211)
      where: { needsYou: true, closedAt: null, OR: [{ taskId: null }, { task: { status: TASK_OPEN } }] },
      orderBy: { at: 'asc' },
      take: 100,
      include: {
        contact: { select: { id: true, name: true, whatsappNumber: true } },
        task: { select: { id: true, title: true, status: true } },
      },
    });
    const items = [] as any[];
    for (const u of rows) {
      // A chase that is paused matters here: he replies, and then nothing follows up. (BEA-1160)
      const paused = u.taskId
        ? await this.prisma.reminder.count({ where: { taskId: u.taskId, status: 'paused' } }).catch(() => 0)
        : 0;
      const reads = safeReads(u.reads);

      /**
       * One row PER TASK when they say something is finished. (BEA-1159)
       *
       * The owner: *"Split by task. They might be only doing one task."* Deepthi has two open jobs
       * — the geyser components and the PCB order — and one message covering both. A single yes/no
       * over the whole message means ruling on one and never seeing the other. Split, he can say
       * yes to the geyser and no to the PCB, and the PCB keeps being chased.
       *
       * Only for a "done" claim. A problem is one thing to read, not a decision per task.
       */
      if (reads.includes('done')) {
        const theirTasks = await this.prisma.task
          .findMany({ where: { ownerContactId: u.contactId, status: TASK_OPEN, kind: { not: 'recurring' } }, select: { id: true, title: true, status: true }, orderBy: { createdAt: 'asc' }, take: 12 })
          .catch(() => [] as any[]);
        if (theirTasks.length > 1) {
          const done = new Set(safeIds((u as any).answered));
          /**
           * Only the jobs they actually named. Srikar has four open — one "done" from him should
           * not put four rows in front of the owner, three of them about work nobody mentioned.
           * Reuses the same title-overlap test the close-day tick-off uses. (BEA-1146)
           *
           * When nothing matches we have no signal at all, so every job is shown rather than
           * silently dropping the lot. And a job wrongly left out simply keeps being chased, which
           * is the safe way for this to be wrong.
           */
          const named = (theirTasks as any[]).filter((t) => messageNames(u.text, t.title));
          const scope = named.length ? named : (theirTasks as any[]);
          for (const t of scope.filter((t) => !done.has(t.id))) {
            const c = await this.prisma.taskClaim
              .findFirst({ where: { taskId: t.id, status: 'pending' }, orderBy: { createdAt: 'desc' }, select: { id: true } })
              .catch(() => null);
            items.push({
              id: `${u.id}::${t.id}`,
              claimId: c?.id || null,
              perTask: true,
              text: u.text,
              channel: u.channel,
              at: u.at,
              openDays: Math.max(0, Math.floor((Date.now() - new Date(u.at).getTime()) / 86400000)),
              reads,
              label: 'is this one done?',
              why: u.why,
              contact: u.contact,
              task: t,
              chasePaused: paused > 0,
              canReply: !!u.contact?.whatsappNumber,
            });
          }
          continue;
        }
      }
      // A "they say it's done" item is a DECISION, not just something to read: he has to say yes
      // or no, and saying no is what puts the chase back on. Without the claim id the screen can
      // only offer "close it", which decides nothing and leaves the task open for good. (BEA-1159)
      const claim = await this.pendingClaimFor(u.contactId, u.taskId);
      items.push({
        claimId: claim?.id || null,
        id: u.id,
        text: u.text,
        channel: u.channel,
        at: u.at,
        openDays: Math.max(0, Math.floor((Date.now() - new Date(u.at).getTime()) / 86400000)),
        reads,
        label: readLabel(reads),
        why: u.why,
        contact: u.contact,
        task: u.task || (claim?.taskId ? await this.prisma.task.findUnique({ where: { id: claim.taskId }, select: { id: true, title: true, status: true } }).catch(() => null) : null),
        chasePaused: paused > 0,
        canReply: !!u.contact?.whatsappNumber,
      });
    }
    // A pending claim must ALWAYS be answerable. Closing an update without deciding used to orphan
    // it: the claim stayed pending, which keeps the chase quiet, so the person sat un-chased with
    // no way for him to rule on it. Any claim not already represented above is added here. (BEA-1159)
    const covered = new Set(items.map((i) => i.claimId).filter(Boolean));
    const orphans = await this.prisma.taskClaim
      .findMany({
        // Same rule as the base list: a claim on work that is already done needs no yes/no — the
        // unfiltered sweep was resurrecting items for tasks the owner had long closed. (BEA-1211)
        where: { status: 'pending', task: { status: TASK_OPEN } },
        orderBy: { createdAt: 'asc' },
        include: { contact: { select: { id: true, name: true, whatsappNumber: true } }, task: { select: { id: true, title: true, status: true } } },
      })
      .catch(() => [] as any[]);
    for (const c of orphans as any[]) {
      if (covered.has(c.id)) continue;
      // ONE item per situation (BEA-1221). If this contact already has an open item with no
      // decision on it, the claim attaches THERE — Yes/No replaces "Sorted, close it", and
      // deciding resolves both. Two rows for one person is how Ashish's count stuck at 1.
      // Only a host about the SAME task (or about no task at all) may take the claim — gluing a
      // claim for task B onto a problem about task A would make Yes/No decide the wrong thing
      // while showing the wrong title. (review finding)
      const host = items.find((i) => i.contact?.id === c.contactId && !i.claimId && !i.perTask && (!i.task || i.task.id === c.taskId));
      if (host) {
        host.claimId = c.id;
        host.task = host.task || c.task || null;
        host.label = `${host.label} — and says something is done`;
        covered.add(c.id);
        continue;
      }
      items.push({
        id: `claim:${c.id}`,
        claimId: c.id,
        text: c.quote || 'They marked this finished on their page.',
        channel: c.source === 'page' ? 'link' : 'whatsapp',
        at: c.createdAt,
        openDays: Math.max(0, Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000)),
        reads: ['done'],
        label: readLabel(['done']),
        why: 'they say it is finished',
        contact: c.contact,
        task: c.task,
        chasePaused: false,
        canReply: !!c.contact?.whatsappNumber,
      });
    }
    items.sort((a, b) => +new Date(a.at) - +new Date(b.at));
    return { items, count: items.length };
  }

  /**
   * He replies from inside review. It goes out on WhatsApp and lands in their thread, so the
   * conversation stays in one place rather than him hopping to Chats to answer.
   */
  async reply(id: string, text: string) {
    const body = String(text || '').trim();
    if (!body) return { ok: false, message: 'Nothing to send' };
    const u = await this.prisma.teamUpdate.findUnique({ where: { id }, include: { contact: { select: { id: true, name: true, whatsappNumber: true } } } });
    if (!u) return { ok: false, message: 'That is not there any more' };
    const number = (u.contact?.whatsappNumber || '').replace(/[^\d]/g, '');
    if (!number) return { ok: false, message: `${u.contact?.name || 'They'} has no WhatsApp number` };
    if (!this.postbox.isConfigured()) return { ok: false, message: 'WhatsApp is not connected' };

    const res = await this.postbox.sendText(number, body);
    if (res.status === 'failed') {
      this.log.warn(`review reply to ${u.contact?.name} failed: ${res.error}`);
      return { ok: false, message: 'Could not send that — they may be outside the 24-hour window' };
    }
    // Into their thread, so the person's page shows it alongside everything else.
    await this.prisma.reminderMessage
      .create({ data: { contactId: u.contactId, direction: 'out', body, wamid: res.wamid || null, status: 'sent' } })
      .catch(() => undefined);
    // Replying does NOT close it. Only he closes it, when the problem is actually solved.
    return { ok: true };
  }

  /**
   * The claim this update is a decision about, if there is one. (BEA-1159)
   *
   * By task when we know it. When we don't — a WhatsApp reply often names no task, and the
   * backfill couldn't know either — fall back to the contact's pending claims, but ONLY when there
   * is exactly one. With two open, guessing would mark the wrong job finished, and the screen shows
   * the task title next to the buttons so he can always see what he is ruling on.
   */
  private async pendingClaimFor(contactId: string, taskId: string | null) {
    if (taskId) {
      const byTask = await this.prisma.taskClaim
        .findFirst({ where: { taskId, status: 'pending' }, orderBy: { createdAt: 'desc' }, select: { id: true, taskId: true } })
        .catch(() => null);
      if (byTask) return byTask;
    }
    const open = await this.prisma.taskClaim
      .findMany({ where: { contactId, status: 'pending' }, select: { id: true, taskId: true }, take: 2 })
      .catch(() => [] as any[]);
    return open.length === 1 ? open[0] : null;
  }

  /**
   * He rules on a claim: yes it's done, or no it isn't. (BEA-1159)
   *
   * His rule: *"If I say it's done, that means you don't need to chase them again."* And the other
   * way round — saying it isn't finished must put the chase straight back on. A pending claim keeps
   * the chase quiet, so leaving one undecided is what made "quiet" indistinguishable from "finished".
   *
   * The decision itself runs through the existing claims path, which already marks the task done on
   * a yes and reopens it on a no. This only connects the review screen to it and closes the item.
   */
  async decide(
    id: string,
    confirm: boolean,
    decider: (claimId: string, confirm: boolean) => Promise<any>,
    setTaskDone?: (taskId: string, done: boolean) => Promise<any>,
    /** The exact claim shown on screen (BEA-1221) — beats re-deriving it, which fails when the
     *  contact holds more than one pending claim. */
    knownClaimId?: string,
  ) {
    /**
     * A per-task row is `<updateId>::<taskId>`. (BEA-1159)
     *
     * "Yes" on a task that has a claim decides that claim. On one that has none — they said "all
     * done" and only one claim was ever raised — it marks that task done directly, which is the
     * same end state and the same thing that stops its chase.
     *
     * "No" on a task with a claim rejects it, which is what puts the chase back on. On one with no
     * claim there is nothing to reject: it was never marked done, so the chase is already running.
     * Either way the row goes, because he has answered it.
     */
    if (id.includes('::')) {
      const [updateId, taskId] = id.split('::');
      const claim = await this.prisma.taskClaim
        .findFirst({ where: { taskId, status: 'pending' }, orderBy: { createdAt: 'desc' }, select: { id: true } })
        .catch(() => null);
      if (claim) await decider(claim.id, confirm);
      else if (confirm && setTaskDone) await setTaskDone(taskId, true);
      await this.markTaskAnswered(updateId, taskId);
      return { ok: true, confirmed: confirm };
    }

    // A claim with no update of its own is shown as `claim:<id>` — deciding it needs no row.
    if (id.startsWith('claim:')) {
      const claimId = id.slice(6);
      const still = await this.prisma.taskClaim.findFirst({ where: { id: claimId, status: 'pending' }, select: { id: true } }).catch(() => null);
      if (!still) return { ok: false, message: 'That has already been decided' };
      await decider(claimId, confirm);
      return { ok: true, confirmed: confirm };
    }
    const u = await this.prisma.teamUpdate.findUnique({ where: { id }, select: { id: true, taskId: true, contactId: true, reads: true } });
    if (!u) return { ok: false, message: 'That is not there any more' };
    const claim = (knownClaimId
      // Scoped to THIS contact — a stale tab must not decide someone else's claim. (review finding)
      ? await this.prisma.taskClaim.findFirst({ where: { id: knownClaimId, status: 'pending', contactId: u.contactId }, select: { id: true, taskId: true } }).catch(() => null)
      : null) || (await this.pendingClaimFor(u.contactId, u.taskId));
    if (!claim) return { ok: false, message: 'That has already been decided' };
    await decider(claim.id, confirm);
    // The claim is answered — but a message that RAISED A PROBLEM is not cleared by ruling on a
    // claim (never-guess): it stays until he closes it himself. Only a pure claim message leaves
    // the inbox here. (BEA-1221 review)
    const stillOpen = safeReads(u.reads).includes('needs_you');
    if (!stillOpen) await this.prisma.teamUpdate.update({ where: { id }, data: { closedAt: new Date() } }).catch(() => undefined);
    return { ok: true, confirmed: confirm, stillOpen };
  }

  /**
   * He has ruled on one task of a split update. The update itself only closes once every one of
   * their open tasks has been answered — otherwise answering the geyser job would take the PCB job
   * off his list too, which is the exact thing splitting exists to prevent.
   */
  private async markTaskAnswered(updateId: string, taskId: string) {
    const u = await this.prisma.teamUpdate.findUnique({ where: { id: updateId }, select: { contactId: true, answered: true } }).catch(() => null);
    if (!u) return;
    const answered = new Set(safeIds(u.answered));
    answered.add(taskId);
    // Still-open jobs of theirs that he has NOT answered yet. Only when none are left does the
    // message itself close — otherwise ruling on the geyser job would take the PCB job off his
    // list too, which is the exact thing splitting exists to prevent.
    const left = await this.prisma.task
      .count({ where: { ownerContactId: u.contactId, status: TASK_OPEN, kind: { not: 'recurring' }, NOT: { id: { in: [...answered] } } } })
      .catch(() => 0);
    await this.prisma.teamUpdate
      .update({ where: { id: updateId }, data: { answered: JSON.stringify([...answered]), ...(left === 0 ? { closedAt: new Date() } : {}) } })
      .catch(() => undefined);
  }

  /** He closes it — the only way an item leaves the inbox. */
  async close(id: string) {
    const u = await this.prisma.teamUpdate.findUnique({ where: { id }, select: { id: true, closedAt: true, contactId: true } });
    if (!u) return { ok: false };
    if (u.closedAt) return { ok: true, alreadyClosed: true };
    await this.prisma.teamUpdate.update({ where: { id }, data: { closedAt: new Date() } });
    // Closing a message never decides a claim (never-guess) — but he must HEAR that one is still
    // waiting, or the count looks stuck for no reason. (BEA-1221)
    const pending = ((await Promise.resolve(
      this.prisma.taskClaim?.count?.({ where: { contactId: u.contactId, status: 'pending', task: { status: TASK_OPEN } } }),
    ).catch(() => 0)) ?? 0) as number;
    return { ok: true, pendingClaim: pending > 0 };
  }

  /** Re-open, for the times he closes one by mistake. */
  async reopen(id: string) {
    await this.prisma.teamUpdate.update({ where: { id }, data: { closedAt: null } }).catch(() => undefined);
    return { ok: true };
  }

  /**
   * Everything already said, brought in once. (BEA-1159)
   *
   * Without this the inbox opens empty on day one and reads as broken, while Radha's two blockers
   * and Swathi's three link notes stay exactly as invisible as they have been. Their original
   * timestamps are kept, so the story reads in the order it actually happened.
   *
   * Anything already recorded is skipped, so running it twice is safe.
   */
  async backfill(): Promise<{ fromLink: number; fromWhatsApp: number; fromReports: number; needsYou: number }> {
    let fromLink = 0;
    let fromWhatsApp = 0;
    let fromReports = 0;
    let needsYou = 0;
    const count = (row: any) => { if (row) { if (row.needsYou) needsYou++; return true; } return false; };

    // Their own words on their link, currently welded to a claim and shown nowhere.
    const claims = await this.prisma.taskClaim.findMany({
      where: { source: 'page' },
      select: { contactId: true, taskId: true, quote: true, createdAt: true, task: { select: { kind: true } } },
    }).catch(() => [] as any[]);
    for (const c of claims as any[]) {
      const words = String(c.quote || '').trim();
      // The share page's own defaults are not messages — they are what it writes when they type nothing.
      if (!words || /^(Ticked it off on their page|Sent today's update)$/.test(words)) continue;
      if (!c.contactId) continue;
      if (count(await this.record({ contactId: c.contactId, text: words, channel: 'link', taskId: c.taskId, at: c.createdAt, isReport: c.task?.kind === 'recurring', skipAi: true }))) fromLink++;
    }

    // What satisfied a day's report — Radha's blockers live here, recorded as a green tick.
    const days = await this.prisma.taskStatusDay.findMany({
      where: { status: 'received', NOT: { quote: null } },
      select: { contactId: true, taskId: true, quote: true, signalAt: true, createdAt: true, source: true },
    }).catch(() => [] as any[]);
    for (const d of days as any[]) {
      const words = String(d.quote || '').trim();
      if (!words || /^(Ticked it off on their page|Sent today's update)$/.test(words)) continue;
      if (!d.contactId) continue;
      if (count(await this.record({ contactId: d.contactId, text: words, channel: d.source === 'page' ? 'link' : 'whatsapp', taskId: d.taskId, at: d.signalAt || d.createdAt, isReport: true, skipAi: true }))) fromReports++;
    }

    // Their recent WhatsApp replies, so a person's page reads as one story from day one.
    const msgs = await this.prisma.reminderMessage.findMany({
      where: { direction: 'in', NOT: { contactId: null } },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: { contactId: true, body: true, createdAt: true },
    }).catch(() => [] as any[]);
    for (const m of msgs as any[]) {
      if (!m.contactId || !String(m.body || '').trim()) continue;
      if (count(await this.record({ contactId: m.contactId, text: m.body, channel: 'whatsapp', at: m.createdAt, isReport: true, skipAi: true }))) fromWhatsApp++;
    }

    this.log.log(`backfill: ${fromLink} from links, ${fromReports} from reports, ${fromWhatsApp} from WhatsApp — ${needsYou} need you`);
    return { fromLink, fromWhatsApp, fromReports, needsYou };
  }

  /** One person's whole story, in time order — both channels in one thread. */
  async forContact(contactId: string, take = 60) {
    const rows = await this.prisma.teamUpdate.findMany({
      where: { contactId },
      orderBy: { at: 'desc' },
      take,
      include: { task: { select: { id: true, title: true } } },
    });
    return rows
      .map((u) => ({ id: u.id, text: u.text, channel: u.channel, at: u.at, reads: safeReads(u.reads), label: readLabel(safeReads(u.reads)), needsYou: u.needsYou, closedAt: u.closedAt, task: u.task }))
      .reverse();
  }
}

/** A corrupt reads column must never break the inbox — an unreadable row is just "they said something". */
/**
 * Does this message actually talk about that job? (BEA-1159)
 *
 * Two of the job's own distinctive words have to appear. One is not enough: Srikar's four jobs all
 * start "Share a clear update on…", so a single shared word would match every one of them and put
 * four rows in front of the owner for a message about one.
 */
const FILLER = new Set([
  'all', 'and', 'the', 'for', 'with', 'from', 'that', 'this', 'send', 'share', 'update', 'updates',
  'status', 'clear', 'give', 'please', 'done', 'finished', 'completed', 'received', 'next', 'month',
  'day', 'today', 'work', 'task', 'tasks', 'plan', 'details', 'report',
]);

/**
 * Words worth matching on. Three letters, not four: PCB, OT, QC and KYC are all real job names.
 * A trailing "s" is dropped on both sides — Deepthi wrote "PCBs also sent" about a job called
 * "Send status update on the PCB order", and without this it matched nothing at all.
 */
function words(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3 && !FILLER.has(w))
      .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
  );
}

function messageNames(text: string, title: string): boolean {
  const said = words(text);
  const job = [...words(title)];
  if (!job.length || !said.size) return false;
  const shared = job.filter((w) => said.has(w)).length;
  // Two shared words for a job with a wordy title, but a short one like "Send status update on the
  // PCB order" only has "pcb" and "order" to give — demanding two there would hide it completely.
  return shared >= Math.min(2, Math.ceil(job.length / 2));
}

/** Task ids he has already ruled on for this message. Unreadable means none — he sees it again. */
function safeIds(raw: string | null | undefined): string[] {
  try {
    const a = JSON.parse(String(raw || '[]'));
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safeReads(raw: string): Read[] {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? (a as Read[]) : [];
  } catch {
    return [];
  }
}
