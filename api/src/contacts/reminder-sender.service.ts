import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isOwedOn } from '../tasks/schedule';
import { TASK_SETTING_KEYS, parseClaimGraceDays, claimGraceExpired } from '../tasks/task-settings';
import { weekdayOf } from '../common/localday';
import { PostboxService } from './postbox.service';
import { ContactsService } from './contacts.service';
import { RecurringService } from '../tasks/recurring.service';
import { CHAT_WINDOW_MS, REMINDER_TZ_OFFSET, dailySubject, scheduleOnDay, topicFromMessage } from './reminders.service';

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
    private readonly contacts: ContactsService,
    private readonly recurring: RecurringService,
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
    // A chase attached to a task always says what the task says NOW. The subject used to be a
    // snapshot taken when the reminder was created, so editing the task left the message saying
    // the old thing forever. The live title wins. (BEA-1021)
    if (r.taskId) {
      const t = await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { title: true, kind: true } }).catch(() => null);
      // A daily report is asked for as "today's production update", not "the daily production
      // update" — otherwise the chase reads like it has never been sent before. (BEA-1119)
      if (t?.title?.trim()) return t.kind === 'recurring' ? dailySubject(t.title) : t.title.trim();
    }
    if (r.subject?.trim()) return r.subject.trim();
    return topicFromMessage(r.message);
  }

  /** Is the work behind this chase finished? Returns why, or null if it is still open. (BEA-1021) */
  private async chaseFinished(r: any): Promise<string | null> {
    if (!r.taskId) return null;
    const t = await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { status: true } }).catch(() => null);
    if (!t) return 'the task was deleted';
    return t.status === 'done' ? 'you confirmed it done' : null;
  }

  /**
   * Put today's sends on the board for a repeating chase. Clears anything still queued from
   * yesterday first, so a missed day can never pile up and fire twice. (BEA-1021)
   */
  private async rearmChase(r: any, dayKey: string, now: Date) {
    let times: string[] = [];
    try { const a = JSON.parse(r.times || '[]'); if (Array.isArray(a)) times = a.filter((t) => typeof t === 'string'); } catch { /* fall through */ }
    if (!times.length) times = ['09:00'];
    // They promised a date. Ease off to ONE nudge a day until then — but never go silent, because
    // the owner still has to hear about it if nothing happens. Full rhythm returns on the day
    // itself, with no one needing to do anything. (BEA-1022)
    if (r.taskId) {
      const t = await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { promisedFor: true } }).catch(() => null);
      if (t?.promisedFor && t.promisedFor > dayKey) times = [times.slice().sort()[0]];
    }
    await this.prisma.reminderSend.deleteMany({ where: { reminderId: r.id, status: 'queued' } }).catch(() => undefined);
    const at = scheduleOnDay(times, dayKey, now);
    for (const when of at) {
      await this.prisma.reminderSend.create({ data: { reminderId: r.id, at: when, status: 'queued' } }).catch(() => undefined);
    }
    await this.prisma.reminder.update({ where: { id: r.id }, data: { armedDay: dayKey, pausedAuto: false } }).catch(() => undefined);
  }

  /** The contact's page slug, created on first need so the button always has a live link. (BEA-1041) */
  private async slugFor(contactId: string, name: string): Promise<string> {
    const c = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { shareSlug: true } }).catch(() => null);
    if (c?.shareSlug) return c.shareSlug;
    return this.contacts.share(contactId).then((r) => r.slug).catch(() => 'unavailable');
  }

  /** Stop a chase for good and clear anything still queued. */
  private async stopChase(id: string, why: string) {
    await this.prisma.reminder.update({ where: { id }, data: { status: 'done' } }).catch(() => undefined);
    await this.prisma.reminderSend.deleteMany({ where: { reminderId: id, status: 'queued' } }).catch(() => undefined);
    this.log.log(`chase ${id} stopped — ${why}`);
  }

  /**
   * A new day: re-arm every live chase. (BEA-1160)
   *
   * This used to PAUSE any chase armed on an earlier day, and delete its queued sends — the comment
   * said "active always means will send today". The effect was that someone who simply did not
   * answer stopped being chased, which is the one thing a chase exists to prevent. On the owner's
   * live data it had switched off 23 chases; he had switched off 1.
   *
   * BEA-1021 already fixed this for daily chases — *"A real chase does not die at midnight — that
   * was the whole problem"* — and the same reasoning was never applied to the rest. It is now.
   *
   * The owner's rule: a chase stops when HE stops it, when the task is marked done, or when a claim
   * he hasn't reviewed has sat for his grace period. Never because a day ended.
   */
  async rollDay() {
    const now = new Date();
    const todayKey = new Date(now.getTime() + REMINDER_TZ_OFFSET * 60000).toISOString().slice(0, 10);
    const stale = await this.prisma.reminder.findMany({ where: { status: 'active', OR: [{ armedDay: null }, { armedDay: { lt: todayKey } }] } });
    let rearmed = 0;
    let stopped = 0;
    /** Rows this pass has already decided on, so the second sweep below cannot double-handle one. */
    const handled = new Set<string>();
    for (const r of stale) {
      handled.add(r.id);
      const done = await this.chaseFinished(r);
      if (done) { await this.stopChase(r.id, done); stopped++; continue; }
      const stale2 = await this.claimWentUnreviewed(r, now);
      if (stale2) { await this.stopChase(r.id, stale2); stopped++; continue; }
      // Still has a future send queued — mid-lifecycle (just armed, or spilling to a later day).
      // Leave it alone rather than re-arming on top of itself. (BEA-790)
      const pending = await this.prisma.reminderSend.count({ where: { reminderId: r.id, status: 'queued', at: { gt: now } } });
      if (pending > 0) continue;
      await this.rearmChase(r, todayKey, now);
      rearmed++;
    }
    // Chases paused because somebody CLAIMED the work is done. (BEA-1293)
    //
    // The sweep above only looks at `status: 'active'`, so the moment a claim started pausing the
    // chase these became invisible to it — and with them, the owner's own rule: *"If I am not
    // marking it as done for two straight days, then you can stop it."* A claim he never reviewed
    // would have sat paused forever, which is "stop on done" wearing the word "pause".
    //
    // These are only ever STOPPED here, never re-armed. A pause is his to lift.
    const claimPaused = await this.prisma.reminder.findMany({ where: { status: 'paused', pausedAuto: true, taskId: { not: null } } });
    for (const r of claimPaused) {
      if (handled.has(r.id)) continue; // already dealt with in the sweep above
      const done = await this.chaseFinished(r);
      if (done) { await this.stopChase(r.id, done); stopped++; continue; }
      const unreviewed = await this.claimWentUnreviewed(r, now);
      if (unreviewed) { await this.stopChase(r.id, unreviewed); stopped++; }
    }

    if (stopped) this.log.log(`stopped ${stopped} chase(s) — finished, or a claim you didn't review`);
    if (rearmed) this.log.log(`re-armed ${rearmed} chase(s) for ${todayKey}`);
  }

  /**
   * Has a claim sat waiting for the owner past his grace period? (BEA-1160)
   *
   * His rule: *"If I am not marking it as done for two straight days, then you can stop it."* This
   * is the ONLY time-based stop, and it applies solely to a chase already quiet behind a claim —
   * never to one that is merely unanswered. Silence from the other person is not consent.
   */
  private async claimWentUnreviewed(r: any, now: Date): Promise<string | null> {
    if (!r.taskId) return null;
    const graceDays = parseClaimGraceDays((await this.prisma.setting.findUnique({ where: { key: TASK_SETTING_KEYS.claimGraceDays } }).catch(() => null))?.value);
    if (!graceDays) return null; // "never" — wait for him however long it takes
    const claim = await this.prisma.taskClaim
      .findFirst({ where: { taskId: r.taskId, status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
      .catch(() => null);
    if (!claim || !claimGraceExpired(claim.createdAt, graceDays, now)) return null;
    return `they reported it done ${graceDays} day${graceDays === 1 ? '' : 's'} ago and it wasn't reviewed`;
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
        // A PAUSED chase is not a failure. Since BEA-1293 a chase is paused the moment someone says
        // the work is done, so this is the ordinary, intended path — logging it as "failed" put a
        // red row in front of the owner for the system working correctly.
        const paused = r?.status === 'paused';
        await this.mark(send.id, paused ? 'skipped' : 'failed', null, r ? (paused ? 'paused — they say it is done' : `reminder is ${r.status}`) : 'reminder gone');
        continue;
      }
      const number = (r.contact?.whatsappNumber || '').replace(/[^\d]/g, '');
      if (!number || !r.contactId) {
        await this.mark(send.id, 'failed', null, 'contact has no WhatsApp number');
        continue;
      }
      // Last line of defence: never chase someone about work that is already finished. The day
      // rollover stops a chase, but the task can be confirmed done between rollovers — and sending
      // "where is this?" about something they completed this morning is the worst possible bug in a
      // chasing system. (BEA-1021)
      const finished = await this.chaseFinished(r);
      if (finished) {
        await this.mark(send.id, 'skipped', null, `not sent — ${finished}`);
        await this.stopChase(r.id, finished);
        continue;
      }
      // They say it's done and it's sitting in the owner's review list. Go quiet — nagging someone
      // about work they have already reported finished is how you lose them — but do NOT stop the
      // chase: if the owner rejects the claim it must pick straight back up. (BEA-1024)
      if (r.taskId && (await this.prisma.taskClaim.count({ where: { taskId: r.taskId, status: 'pending' } })) > 0) {
        await this.mark(send.id, 'skipped', null, 'they reported it done — waiting on your review');
        continue;
      }
      // A standing daily report: nothing is owed on a rest day, and once today's has arrived we go
      // quiet until tomorrow. Neither ends the chase — it comes back on the next working day.
      // (BEA-1119)
      if (r.taskId) {
        const task = await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { kind: true, scheduleDays: true } }).catch(() => null);
        if (task?.kind === 'recurring') {
          const today = this.recurring.today();
          // Its OWN days decide, not the global rest day. A Friday report chased on a Monday is the
          // exact message that went to Rakesh at 05:30 on 27 Jul. (BEA-1147)
          if (!isOwedOn(task.scheduleDays, weekdayOf(today), await this.recurring.restDays())) {
            await this.mark(send.id, 'skipped', null, 'not owed today');
            continue;
          }
          if (await this.recurring.isReceived(r.taskId, today)) {
            await this.mark(send.id, 'skipped', null, "today's update already came in");
            continue;
          }
        }
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
      // A reply changes HOW we chase, not WHETHER. The old rule ("replied within 24h → skip")
      // silently killed every chase for a day the moment someone answered once — a chase loop
      // where replying makes the chasing stop is not a chase loop. The owner's call (BEA-1045):
      //   replied < 1h ago  → hold this slot: the two-way agent is (or just was) mid-conversation,
      //                       and a scheduled nudge barging into a live chat reads like a robot;
      //   replied < 24h ago → the WhatsApp session is open, so chase with a PLAIN chat message
      //                       asking for progress instead of re-firing the formal template;
      //   older than 24h    → the session is closed; only a template can be delivered, as before.
      const HOUR = 60 * 60 * 1000;
      const lastIn = await this.prisma.reminderMessage.findFirst({
        where: { contactId, direction: 'in' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const sinceReply = lastIn ? Date.now() - new Date(lastIn.createdAt).getTime() : Infinity;
      if (sinceReply < HOUR) {
        for (const s of g.sends) await this.mark(s.id, 'skipped', null, 'they replied within the hour — the agent is mid-conversation');
        continue;
      }
      const chatOpen = sinceReply < CHAT_WINDOW_MS; // one source of truth, shared with the manual send (BEA-1112)
      const firstName = g.name.trim().split(/\s+/)[0];
      // The SAME order the agent numbers its items in (oldest reminder first), so when she replies
      // "1 and 3 are done" both sides mean the same tasks. (BEA-1041)
      const rems = [...g.reminders.values()].sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const subjects: string[] = [];
      for (const r of rems) subjects.push(await this.subjectFor(r));
      // Up to 3 full titles, then a count — the long tail lives on her page. (BEA-1041)
      const shownList = subjects.slice(0, 3).map((t, i) => `${i + 1}) ${t}`).join(' ')
        + (subjects.length > 3 ? ` and ${subjects.length - 3} more on your list` : '');

      let res: { wamid: string | null; status: string; error: string | null } | null = null;
      let rendered = '';
      // A recurring chase points at the Updates tab on their page — the structured section is
      // where the day's report belongs. (BEA-1217)
      const taskIds = rems.map((r) => r.taskId).filter(Boolean) as string[];
      // Optional-chained: spec harnesses stub a partial Prisma.
      const hasRecurring = taskIds.length
        ? (((await Promise.resolve(this.prisma.task?.count?.({ where: { id: { in: taskIds }, kind: 'recurring' } })).catch(() => 0)) ?? 0) as number) > 0
        : false;
      if (chatOpen) {
        const slug = subjects.length >= 2 || hasRecurring ? await this.slugFor(contactId, g.name) : null;
        rendered = this.postbox.renderProgressNudge(firstName, subjects.length, subjects.length >= 2 ? shownList : subjects[0] || 'this', slug, hasRecurring);
        res = await this.postbox.sendText(g.number, rendered);
        if (res.error) {
          // Our 24h clock and Meta's can disagree by minutes — if the session just closed, plain
          // text bounces. Fall through to the template so the chase never silently dies. (BEA-1045)
          this.log.warn(`progress nudge to ${g.name} failed (${res.error}) — falling back to the template`);
          res = null;
        }
      }
      if (!res) {
        if (subjects.length >= 2) {
          // Two or more items: the numbered template with her page behind an "Open my list" button.
          const slug = await this.slugFor(contactId, g.name);
          res = await this.postbox.sendTaskListTemplate(g.number, firstName, subjects.length, shownList, slug);
          rendered = this.postbox.renderTaskListTemplate(firstName, subjects.length, shownList, slug);
          if (res.error) {
            // Not approved yet, or Meta hiccuped — the single-task template still says something true.
            this.log.warn(`task-list template failed (${res.error}) — falling back to the combined nudge`);
            const combined = joinSubjects(subjects);
            res = await this.postbox.sendReminderTemplate(g.number, firstName, combined);
            rendered = this.postbox.renderReminderTemplate(firstName, combined);
          }
        } else {
          const combined = joinSubjects(subjects);
          res = await this.postbox.sendReminderTemplate(g.number, firstName, combined);
          rendered = this.postbox.renderReminderTemplate(firstName, combined);
        }
      }
      if (res.error) {
        for (const s of g.sends) await this.mark(s.id, 'failed', res.wamid, res.error);
        this.log.warn(`combined send to ${g.name} failed: ${res.error}`);
        continue;
      }
      for (const s of g.sends) await this.mark(s.id, 'sent', res.wamid, null);
      // Store exactly what the template renders — same source as the send, so the
      // chat window can never show a message different from what actually went out. (BEA-753)
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
