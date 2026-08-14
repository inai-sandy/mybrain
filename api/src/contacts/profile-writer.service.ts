import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { MemoryService } from '../memory/memory.service';
import { localDayKey, localHour } from '../common/localday';
import { isOpen } from '../tasks/task-status';

/** Sunday evening (owner's clock), after the day has settled but before the mentor's 23:59 run. */
const WRITE_HOUR = 21;
/** How much history feeds a profile. */
const LOOKBACK_DAYS = 28;

/**
 * The weekly character-profile writer (BEA-1216).
 *
 * Every Sunday evening it rewrites ONE living profile per contact — who they are, how they work,
 * how reliable they've been — from their real messages, their report ledger, and the owner's own
 * briefings. The same row is upserted and the same brain doc replaced (delete-then-add through
 * MemoryService), so neither the database nor RAG ever grows a duplicate. A contact with no
 * activity in the window is skipped entirely: a profile of silence is junk, and junk never enters
 * the brain.
 *
 * Missed Sundays catch up on the next boot/tick (server down, deploy in the window): if last
 * week's profile is missing for an active contact, it is written then. One attempt per day per
 * run-kind (a Setting brake), so a failing model can't burn tokens every minute.
 */
@Injectable()
export class ProfileWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ProfileWriter');
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    // Optional + LAST: spec harnesses build this positionally with fewer args.
    @Optional() private readonly memory?: MemoryService,
  ) {}

  onModuleInit() {
    this.tick = setInterval(() => this.weeklyTick().catch(() => undefined), 60_000);
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  /** Monday key of the week a day belongs to — the "already written" guard. */
  weekStartOf(day: string): string {
    const d = new Date(day + 'T12:00:00Z');
    const dow = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
    return d.toISOString().slice(0, 10);
  }

  async weeklyTick(now = new Date()): Promise<void> {
    // ONE clock for everything: the fixed local offset localday.ts holds. Mixing it with the
    // tasks.tz Setting could split "which day is it" from "what time is it". (review finding)
    const day = localDayKey(now);
    const dow = new Date(day + 'T12:00:00Z').getUTCDay();
    // One attempt per day — a failed/empty run must not re-query or re-call the model every minute.
    const tried = (await this.prisma.setting?.findUnique({ where: { key: 'profile.weeklyTry' } }).catch(() => null))?.value;
    if (tried === day) return;
    if (dow === 0) {
      // Sunday: wait for the evening WITHOUT burning the day's one attempt on the morning ticks.
      if (localHour(now) < WRITE_HOUR) return;
      await this.markTried(day);
      await this.writeAll(this.weekStartOf(day)).catch((e) => this.log.warn(`weekly write: ${e?.message ?? e}`));
      return;
    }
    // Weekday: one catch-up CHECK per day, whether or not anything turns out to be missing —
    // the unconditional brake is what stops four queries running every minute forever.
    await this.markTried(day);
    const lastWeek = this.weekStartOf(new Date(new Date(day + 'T12:00:00Z').getTime() - 7 * 86400000).toISOString().slice(0, 10));
    const missing = await this.activeContactsMissing(lastWeek);
    if (missing.length) {
      await this.writeAll(lastWeek).catch((e) => this.log.warn(`catch-up write: ${e?.message ?? e}`));
    }
  }

  private async markTried(day: string) {
    await this.prisma.setting
      ?.upsert({ where: { key: 'profile.weeklyTry' }, create: { key: 'profile.weeklyTry', value: day }, update: { value: day } })
      .catch(() => undefined);
  }

  /** Contacts with real signal in the window whose profile hasn't been written for this week yet. */
  private async activeContactsMissing(weekStart: string): Promise<{ id: string; name: string }[]> {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
    const [saidSomething, briefed, existing] = await Promise.all([
      this.prisma.teamUpdate?.findMany({ where: { at: { gte: since } }, select: { contactId: true }, distinct: ['contactId'] }).catch(() => []) ?? [],
      this.prisma.briefing?.findMany({ where: { createdAt: { gte: since } }, select: { contactId: true }, distinct: ['contactId'] }).catch(() => []) ?? [],
      this.prisma.contactProfile?.findMany({ where: { weekStart }, select: { contactId: true } }).catch(() => []) ?? [],
    ]);
    const done = new Set((existing as any[]).map((r) => r.contactId));
    const activeIds = [...new Set([...(saidSomething as any[]), ...(briefed as any[])].map((r) => r.contactId).filter(Boolean))].filter((id) => !done.has(id));
    if (!activeIds.length) return [];
    const rows = await this.prisma.contact.findMany({ where: { id: { in: activeIds } }, select: { id: true, name: true } }).catch(() => []);
    return rows as any[];
  }

  /** Write (or catch up) every due profile for one week. Returns how many were written. */
  async writeAll(weekStart: string): Promise<number> {
    const due = await this.activeContactsMissing(weekStart);
    let written = 0;
    for (const c of due) {
      const ok = await this.writeOne(c.id, weekStart).catch((e) => { this.log.warn(`profile for ${c.name}: ${e?.message ?? e}`); return false; });
      if (ok) written++;
    }
    if (written) this.log.log(`wrote ${written} character profile(s) for week ${weekStart}`);
    return written;
  }

  /** Rewrite ONE contact's living profile and replace its brain doc. */
  async writeOne(contactId: string, weekStart: string): Promise<boolean> {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
    const [contact, prior, updates, briefings, tasks, statusDays] = await Promise.all([
      this.prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, name: true, notes: true, tags: true } }),
      this.prisma.contactProfile?.findUnique({ where: { contactId } }).catch(() => null) ?? null,
      this.prisma.teamUpdate?.findMany({ where: { contactId, at: { gte: since } }, orderBy: { at: 'desc' }, take: 60, select: { text: true, at: true, reads: true } }).catch(() => []) ?? [],
      this.prisma.briefing?.findMany({ where: { contactId }, orderBy: { createdAt: 'desc' }, take: 8, select: { rawText: true } }).catch(() => []) ?? [],
      this.prisma.task?.findMany({ where: { ownerContactId: contactId }, select: { title: true, status: true, kind: true, promiseSlips: true }, take: 60, orderBy: { createdAt: 'desc' } }).catch(() => []) ?? [],
      this.prisma.taskStatusDay?.findMany({ where: { contactId, day: { gte: new Date(since).toISOString().slice(0, 10) } }, select: { status: true } }).catch(() => []) ?? [],
    ]);
    if (!contact) return false;

    const received = (statusDays as any[]).filter((s) => s.status === 'received').length;
    const missed = (statusDays as any[]).filter((s) => s.status === 'missed').length;
    const slips = (tasks as any[]).reduce((n, t) => n + (t.promiseSlips || 0), 0);
    const open = (tasks as any[]).filter((t) => isOpen(t));
    const facts = [
      `Name: ${contact.name}${contact.notes ? ` — ${contact.notes}` : ''}`,
      `Open work (${open.length}): ${open.slice(0, 8).map((t) => t.title).join('; ') || 'none'}`,
      received + missed > 0 ? `Daily-report ledger, last ${LOOKBACK_DAYS} days: ${received} in, ${missed} missed (${Math.round((received / Math.max(1, received + missed)) * 100)}% hit rate)` : 'No daily-report ledger in the window.',
      slips ? `Promises slipped: ${slips}` : 'No slipped promises recorded.',
      (briefings as any[]).length ? `Sandeep's own briefings about them (his words):\n${(briefings as any[]).map((b) => `- ${String(b.rawText).slice(0, 300)}`).join('\n')}` : 'No briefings recorded.',
      (updates as any[]).length
        ? `Their real messages, newest first (last ${LOOKBACK_DAYS} days):\n${(updates as any[]).map((u) => `- [${String(u.at).slice(0, 10)}] ${String(u.text).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')}`
        : 'No messages from them in the window.',
      prior?.text ? `The previous profile (rewrite it — keep what is still true):\n${prior.text}` : 'There is no previous profile — this is the first.',
    ].join('\n\n');

    const tmpl = await this.prompts.get('people.profile');
    const raw = await this.llm.completeHelper('character-profile', `${tmpl.replace(/\{\{name\}\}/g, contact.name)}\n\nThe facts:\n${facts}`, 700, 'character-profile');
    const text = (raw || '').trim();
    // An unusable reply writes NOTHING — a bad profile is worse than last week's good one.
    if (text.length < 60 || !/Who they are/i.test(text)) {
      this.log.warn(`unusable profile reply for ${contact.name} — keeping the previous one`);
      return false;
    }

    const row = await this.prisma.contactProfile?.upsert({
      where: { contactId },
      create: { contactId, text, weekStart },
      update: { text, weekStart },
    });
    // Replace the ONE living brain doc — delete-then-add via the outbox, ids written back. (BEA-1216)
    await this.memory?.indexEntity?.({
      refType: 'contactprofile',
      refId: contactId,
      content: `Character profile — ${contact.name}\n\n${text}`,
      title: `Who ${contact.name} is — character profile`,
      tags: ['people', 'profile', contact.name.toLowerCase().split(/\s+/)[0]],
      prevSupermemoryId: (prior as any)?.supermemoryId || (row as any)?.supermemoryId || null,
      prevRagId: (prior as any)?.ragId || (row as any)?.ragId || null,
    });
    return true;
  }
}
