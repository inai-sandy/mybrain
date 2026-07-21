import { BadRequestException, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { whereForDayRule } from './day-rule';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { MemoryService } from '../memory/memory.service';
import { matchContact, contactSpellings } from '../contacts/person-identity';
import { MentionResolution, exactMatches, linkableIds, resolveMentions } from './mentions';

const jarr = (s?: string | null): string[] => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

/** Load the owner and the @mentioned people alongside a task, so `shape` can return them. (BEA-1019) */
const PEOPLE_INCLUDE = {
  ownerContact: { select: { id: true, name: true } },
  people: { select: { contact: { select: { id: true, name: true } } } },
  // The claim waiting on the owner, if any — so "they say it's done" shows wherever tasks
  // are listed, not only in the review list. (BEA-1024)
  claims: {
    where: { status: 'pending' },
    take: 1,
    orderBy: { createdAt: 'desc' },
    select: { id: true, quote: true, source: true, createdAt: true, contact: { select: { id: true, name: true } } },
  },
} as const;

/** Normalized title key for dedupe — lowercase, punctuation-stripped, whitespace-collapsed. (BEA-933) */
export function normTitleKey(title?: string | null): string {
  return String(title || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const DEFAULT_TASKS_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };
const DEFAULT_TZ = 'Asia/Kolkata';

type CraftedTask = {
  title: string;
  category?: string;
  tags?: string[];
  priority?: string;
  estimateMin?: number;
  note?: string;
  pinned?: boolean;
};

@Injectable()
export class TasksService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;
  private readonly log = new Logger('TasksService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly memory: MemoryService,
  ) {}

  /**
   * Build the searchable text for a task and (re-)index it into the brain. Fire-and-forget:
   * indexing must never block or fail a task operation. (BEA-331)
   *
   * BOTH open and finished tasks are recorded, so "I created 4 today and finished 3" is answerable
   * for either half. (BEA-1015)
   *
   * This used to be done-only: it DELETED an open task's docs on every change (BEA-546), because the
   * nightly rollover re-stamped `day` and so changed each open task's text every night, producing
   * endless duplicates. Worse, `MemoryService.reconcile` re-adds any row missing its ids with no status
   * filter — so open tasks were deleted and re-added in a loop, invisible to search in between, which
   * made the same question give different answers. BEA-1014 stopped the nightly re-stamping, so the
   * duplicate risk is gone and both sides can now agree. `indexEntity` replaces the previous doc via
   * prevSupermemoryId/prevRagId, so a re-index updates in place rather than piling up.
   */
  private indexTask(t: any): void {
    if (!t?.id) return;
    const tags = JSON.parse((t.tags as string) || '[]');
    // Index the TRUE dates. `day` is re-stamped to today for anything still open, so on its own it made
    // the answer model state the wrong date for tasks (EMO said "opened on 20 July" for a task added on
    // 12 July). Give it when the task was added and when it was finished. (BEA-1013)
    const ymd = (d: any) => { try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; } };
    const added = ymd(t.createdAt);
    const carried = Number(t.rolloverCount || 0);
    const parts = [
      t.title,
      t.note || '',
      t.category ? `Category: ${t.category}` : '',
      added ? `Added: ${added}` : '',
      t.status === 'done'
        ? `Completed: ${ymd(t.completedAt) || t.day || 'date unknown'}`
        : [`Still open${t.progress ? ` (${t.progress}%)` : ''}`, carried > 0 ? `carried forward ${carried} time${carried === 1 ? '' : 's'} since it was added` : ''].filter(Boolean).join(', '),
    ].filter(Boolean);
    this.memory
      .indexEntity({
        refType: 'task',
        refId: t.id,
        title: `Task: ${t.title}`.slice(0, 120),
        content: `Task — ${parts.join('\n')}`,
        tags: ['task', t.sphere || 'work', ...(t.category ? [String(t.category).toLowerCase()] : []), ...tags].slice(0, 6),
        prevSupermemoryId: t.supermemoryId,
        prevRagId: t.ragId,
      })
      .catch(() => undefined);
  }

  /** Remove a task's docs from the brain (best-effort) before/around deletion. */
  private unindexTask(t: any): void {
    if (!t) return;
    this.memory.deleteDoc(t.supermemoryId, t.ragId).catch(() => undefined);
  }

  onModuleInit() {
    // No automatic midnight rollover anymore: a day's open tasks stay on that day until the day is
    // CLOSED (DailyService.closeDay), which then rolls the leftovers forward via rollDayForward().
    // This keeps task credit truthful to the day the work actually belonged to.
    // One-time cleanup: clear the open-task duplicates that earlier builds wrote to memory. (BEA-546)
    setTimeout(() => this.runOnceMemoryCleanup().catch((e) => this.log.warn(`open-task purge: ${e?.message ?? e}`)), 20000);
    // One-time deep sweep: remove ORPHAN task docs left in the stores by past churn. (BEA-548)
    setTimeout(() => this.runOnceOrphanSweep().catch((e) => this.log.warn(`orphan sweep: ${e?.message ?? e}`)), 45000);
    // One-time REBUILD: wipe every task doc and re-index only the done tasks (clears all dups). (BEA-549)
    setTimeout(() => this.runOnceRebuild().catch((e) => this.log.warn(`task memory rebuild: ${e?.message ?? e}`)), 70000);
    // One-time DISCIPLINE: stop indexing junk (Vault, day summaries, portrait) + purge it. (BEA-551)
    setTimeout(() => this.runOnceMemoryDiscipline().catch((e) => this.log.warn(`memory discipline: ${e?.message ?? e}`)), 95000);
    // One-time: turn typed person names into REAL contact links. Exact matches only. (BEA-1019)
    setTimeout(() => this.runOnceLinkParties().catch((e) => this.log.warn(`party link backfill: ${e?.message ?? e}`)), 30000);
  }

  /** Passthrough: stop indexing low-value sources + purge them. (BEA-551) */
  purgeLowValueSources() {
    return this.memory.purgeLowValueSources();
  }

  private async runOnceMemoryDiscipline(): Promise<void> {
    const key = 'tasks.memoryDisciplineV1';
    const seen = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    if (seen?.value) return;
    const r = await this.memory.purgeLowValueSources();
    await this.prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(r) }, update: { value: JSON.stringify(r) } }).catch(() => undefined);
    this.log.log(`memory discipline: purged vault=${r.vault} daysummary=${r.daysummary} portrait=${r.portrait} docs (no longer indexed)`);
  }

  /**
   * One-time: turn the typed `party` text on existing tasks into a REAL owner link. (BEA-1019)
   *
   * Deliberately conservative. A name is linked only when it matches exactly one contact by name or
   * alias — no fuzzy matching, no first-name guessing. Anything ambiguous or unrecognised is left
   * exactly as it was and listed for the owner to sort out by hand. Nothing is deleted or rewritten:
   * this only fills in a column that was previously empty.
   */
  async linkExistingParties(dryRun = false): Promise<{ linked: number; unmatched: { party: string; taskIds: string[]; reason: string }[] }> {
    const contacts = await this.allContacts();
    const rows = await this.prisma.task.findMany({
      where: { ownerContactId: null, NOT: { party: null } },
      select: { id: true, party: true },
    });
    const unmatched = new Map<string, { party: string; taskIds: string[]; reason: string }>();
    let linked = 0;
    for (const r of rows) {
      const text = String(r.party || '').trim();
      if (!text) continue;
      const hits = exactMatches(contacts, text);
      if (hits.length === 1) {
        if (!dryRun) {
          await this.prisma.task
            .update({ where: { id: r.id }, data: { ownerContactId: hits[0].id, party: hits[0].name.slice(0, 80) } })
            .catch(() => undefined);
        }
        linked++;
      } else {
        const reason = hits.length > 1 ? `${hits.length} contacts share this name` : 'no contact with this name';
        const key = text.toLowerCase();
        const e = unmatched.get(key) || { party: text, taskIds: [], reason };
        e.taskIds.push(r.id);
        unmatched.set(key, e);
      }
    }
    return { linked, unmatched: [...unmatched.values()] };
  }

  /** What the backfill could not resolve — shown to the owner instead of being guessed. (BEA-1019) */
  async unlinkedParties() {
    return (await this.linkExistingParties(true)).unmatched;
  }

  private async runOnceLinkParties(): Promise<void> {
    const key = 'tasks.linkPartiesV1';
    const seen = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    if (seen?.value) return;
    const r = await this.linkExistingParties();
    await this.prisma.setting
      .upsert({ where: { key }, create: { key, value: JSON.stringify(r) }, update: { value: JSON.stringify(r) } })
      .catch(() => undefined);
    this.log.log(`party→contact backfill: linked ${r.linked}, left alone ${r.unmatched.length} name(s) for review`);
  }

  /** Wipe every task doc from both stores, then re-index EVERY task → one clean doc each. (BEA-549)
   *  Open tasks are included since BEA-1015 — rebuilding done-only would silently drop the open half
   *  of the record back out of the brain. */
  async rebuildTaskMemory(): Promise<{ deleted: { sm: number; rag: number }; reindexed: number }> {
    const deleted = await this.memory.deleteAllTaskDocs();
    await this.prisma.task.updateMany({ data: { supermemoryId: null, ragId: null } });
    const all = await this.prisma.task.findMany({});
    for (const t of all) this.indexTask(t); // enqueues a fresh doc each, drained async
    return { deleted, reindexed: all.length };
  }

  private async runOnceRebuild(): Promise<void> {
    const key = 'tasks.rebuiltTaskMemoryV1';
    const seen = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    if (seen?.value) return;
    const r = await this.rebuildTaskMemory();
    await this.prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(r) }, update: { value: JSON.stringify(r) } }).catch(() => undefined);
    this.log.log(`task memory rebuild: wiped sm=${r.deleted.sm} rag=${r.deleted.rag} task docs, re-indexing ${r.reindexed} done tasks`);
  }

  /** Passthrough: delete orphan task docs from the stores (deletion only). (BEA-548) */
  purgeOrphanTaskDocs() {
    return this.memory.purgeOrphanTaskDocs();
  }

  private async runOnceOrphanSweep(): Promise<void> {
    const key = 'tasks.purgedOrphanDocsV1';
    const seen = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    if (seen?.value) return;
    const r = await this.memory.purgeOrphanTaskDocs();
    await this.prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(r) }, update: { value: JSON.stringify(r) } }).catch(() => undefined);
    this.log.log(`orphan sweep: removed ${r.smDeleted} SuperMemory + ${r.ragDeleted} RAG stray task docs (scanned sm=${r.smScanned} rag=${r.ragScanned})`);
  }

  /** Delete the memory docs of every non-done task that still has them (deletion only — no AI). (BEA-546) */
  async purgeOpenTaskMemory(): Promise<{ purged: number }> {
    const open = await this.prisma.task.findMany({
      where: { status: { not: 'done' }, OR: [{ NOT: { supermemoryId: null } }, { NOT: { ragId: null } }] },
      select: { id: true, supermemoryId: true, ragId: true },
    });
    for (const t of open) {
      await this.memory.deleteDoc(t.supermemoryId, t.ragId).catch(() => undefined);
      await this.prisma.task.update({ where: { id: t.id }, data: { supermemoryId: null, ragId: null } }).catch(() => undefined);
    }
    return { purged: open.length };
  }

  /** Run the open-task memory purge ONCE (guarded by a Setting flag). */
  private async runOnceMemoryCleanup(): Promise<void> {
    const key = 'tasks.purgedOpenMemoryV1';
    const seen = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    if (seen?.value) return;
    const r = await this.purgeOpenTaskMemory();
    await this.prisma.setting.upsert({ where: { key }, create: { key, value: String(r.purged) }, update: { value: String(r.purged) } }).catch(() => undefined);
    this.log.log(`memory cleanup: removed ${r.purged} open-task docs (open tasks are no longer indexed)`);
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  /**
   * A closed day's still-open tasks stay ON THE DAY THEY WERE ADDED — we only count the carry. (BEA-1014)
   *
   * This used to re-stamp `day` to the new day, which made every open task claim it was created today
   * (a task added 42 days ago read as "added today"), destroyed the record of what each day actually
   * produced, and — because a task's indexed text changed every night — created the duplicate churn
   * that forced open tasks out of memory entirely. Open tasks are carried forward by the QUERY
   * (`day <= today`) instead, so nothing moves and the history stays true.
   */
  async rollDayForward(fromDay: string, toDay: string): Promise<{ rolled: number }> {
    if (!fromDay || !toDay || fromDay >= toDay) return { rolled: 0 };
    // Everything still open when the day closes has been carried — not only what was ADDED that day.
    // `day: fromDay` was right while the rollover re-stamped `day` to today (every open task matched
    // every night), but BEA-1014 stopped the re-stamping so a task keeps the day it was added. The
    // query then matched only that single day: on live data 42 of 44 open tasks were skipped and their
    // carried number froze while the task kept ageing. (BEA-1016)
    const open = await this.prisma.task.findMany({ where: { status: 'open', day: { lte: fromDay } } });
    for (const t of open) {
      const rolloverCount = (t.rolloverCount || 0) + 1;
      await this.prisma.task.update({ where: { id: t.id }, data: { rolloverCount } });
      // Re-index so the brain's "carried forward N times" stays true. The count changes every night and
      // nothing else touches a task that is merely being carried, so without this the brain keeps
      // whatever number was written the last time the task happened to be edited. One doc per task is
      // guaranteed (BEA-1015), so this updates in place instead of piling up.
      this.indexTask({ ...t, rolloverCount });
    }
    return { rolled: open.length };
  }

  /** Smart-spaced reminder times (local HH:MM) for a task, weighted by priority. Delivery wired in the Telegram phase. */
  private computeReminders(count: number, priority: string): string[] {
    const n = Math.max(0, Math.min(4, Math.round(count || 0)));
    if (!n) return [];
    const schedule: Record<string, string[]> = {
      high: ['09:30', '12:00', '15:00', '17:30'],
      medium: ['11:00', '15:00', '18:00', '20:00'],
      low: ['16:00', '19:00', '20:30', '21:00'],
    };
    return (schedule[priority] || schedule.medium).slice(0, n);
  }

  // ---- config (the Tasks engine runs on its own model, default Sonnet) ----

  async getModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.llm' } });
    if (!row) return DEFAULT_TASKS_MODEL;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : DEFAULT_TASKS_MODEL;
    } catch {
      return DEFAULT_TASKS_MODEL;
    }
  }

  async setModel(provider: string, model: string): Promise<LlmConfig> {
    const value = JSON.stringify({ provider, model });
    await this.prisma.setting.upsert({ where: { key: 'tasks.llm' }, create: { key: 'tasks.llm', value }, update: { value } });
    return { provider, model } as LlmConfig;
  }

  /** OpenAI + Anthropic models only, for the Settings picker. */
  async listModels() {
    return this.llm.listOpenRouterModels(['openai/', 'anthropic/']);
  }

  private async tz(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } });
    return row?.value || DEFAULT_TZ;
  }

  /**
   * The instant a local day begins, as a UTC Date — so "finished today" can be judged by completedAt
   * rather than by the (no longer re-stamped) day field. (BEA-1014)
   */
  private dayStart(day: string, tz: string): Date {
    // Derive the boundary from the zone's real offset, to the MINUTE. This used to walk in whole hours
    // and floor to the hour, which cannot represent India's +05:30: local midnight 18:30Z was reported
    // as 19:00Z, so anything finished in the first 30 minutes after midnight failed the
    // `completedAt >= dayStart` test and silently vanished from Today. (BEA-1017)
    const midnightUtc = Date.parse(`${day}T00:00:00Z`);
    const off = this.tzOffsetMinutes(tz, new Date(midnightUtc));
    const t = new Date(midnightUtc - off * 60000);
    // The offset in force AT that instant can differ from the one at the UTC probe (a DST change lands
    // between them), so resolve once more against the real instant.
    const off2 = this.tzOffsetMinutes(tz, t);
    return off2 === off ? t : new Date(midnightUtc - off2 * 60000);
  }

  /** Minutes `tz` is ahead of UTC at a given instant (IST = 330). Falls back to UTC if the zone is bad. */
  private tzOffsetMinutes(tz: string, at: Date): number {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(at);
      const p: Record<string, string> = {};
      for (const { type, value } of parts) p[type] = value;
      const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      // Compare on whole seconds — formatToParts has no milliseconds, so the raw difference would
      // otherwise carry `at`'s millisecond remainder into the offset.
      return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
    } catch {
      return 0;
    }
  }

  /** Local day key (YYYY-MM-DD) in the user's timezone. */
  private dayKey(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  // ---- brain dump -> tasks ----

  private async craft(dump: string): Promise<{ question?: string; tasks: CraftedTask[] } | null> {
    const tmpl = await this.prompts.get('tasks.dump');
    const prompt = `${tmpl}\n\nBrain-dump:\n${dump.slice(0, 8000)}`;
    const text = await this.llm.completeWith(await this.getModel(), prompt, 2000, 'task-dump');
    if (!text) return null;
    try {
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const tasks: CraftedTask[] = Array.isArray(json.tasks) ? json.tasks : [];
      const question = typeof json.question === 'string' && json.question.trim() ? json.question.trim() : undefined;
      return { question, tasks };
    } catch {
      return null;
    }
  }

  private normSphere(x?: string): string {
    return String(x || '').toLowerCase().trim() === 'personal' ? 'personal' : 'work';
  }

  private normPriority(p?: string): string {
    const v = String(p || '').toLowerCase();
    return v === 'high' || v === 'low' ? v : 'medium';
  }

  /** Process a brain-dump: save it, extract tasks via Sonnet, persist them for today. */
  async dump(rawText: string, source = 'app') {
    const clean = (rawText || '').trim();
    if (!clean) return { dumpId: null, question: 'What is on your mind this morning?', tasks: [] };
    const tz = await this.tz();
    const day = this.dayKey(tz);
    const crafted = await this.craft(clean);

    if (!crafted) {
      // LLM unavailable — keep the dump as a single task so nothing is lost.
      const d = await this.prisma.brainDump.create({ data: { day, rawText: clean, source, taskCount: 1 } });
      const t = await this.prisma.task.create({ data: { title: clean.split('\n')[0].slice(0, 120) || 'Task', day, dumpId: d.id, note: clean.length > 120 ? clean : null } });
      this.indexTask(t);
      return { dumpId: d.id, question: undefined, tasks: [this.shape(t)] };
    }

    // A clarifying question with no tasks — record the dump, ask the user for more.
    if (crafted.question && (!crafted.tasks || crafted.tasks.length === 0)) {
      const d = await this.prisma.brainDump.create({ data: { day, rawText: clean, source, question: crafted.question, taskCount: 0 } });
      return { dumpId: d.id, question: crafted.question, tasks: [] };
    }

    const pinnedSeen = { n: 0 };
    const d = await this.prisma.brainDump.create({ data: { day, rawText: clean, source, taskCount: crafted.tasks.length } });
    // Don't re-create tasks that already exist as open ones — re-dumping the same thing was piling
    // up duplicates. Skip a new task whose normalized title already exists (open, or added just now). (BEA-933)
    const existingOpen = await this.prisma.task.findMany({ where: { status: 'open' }, select: { title: true } });
    const seenTitles = new Set(existingOpen.map((t) => normTitleKey(t.title)));
    const created = [];
    let skipped = 0;
    for (const c of crafted.tasks) {
      const title = String(c.title || '').trim().slice(0, 160);
      if (!title) continue;
      const key = normTitleKey(title);
      if (key && seenTitles.has(key)) { skipped++; continue; } // duplicate of an existing open task
      seenTitles.add(key);
      const pinned = !!c.pinned && pinnedSeen.n < 3;
      if (pinned) pinnedSeen.n++;
      const t = await this.prisma.task.create({
        data: {
          title,
          category: c.category ? String(c.category).trim().slice(0, 40) : null,
          tags: Array.isArray(c.tags) && c.tags.length ? JSON.stringify(c.tags.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 5)) : null,
          priority: this.normPriority(c.priority),
          sphere: this.normSphere((c as any).sphere),
          estimateMin: Number.isFinite(c.estimateMin) ? Math.max(1, Math.round(Number(c.estimateMin))) : null,
          note: c.note ? String(c.note).trim().slice(0, 500) : null,
          pinned,
          day,
          dumpId: d.id,
        },
      });
      this.indexTask(t);
      created.push(this.shape(t));
    }
    return { dumpId: d.id, question: undefined, tasks: created, skipped };
  }

  // ---- task CRUD ----

  private shape(t: any) {
    return {
      id: t.id,
      title: t.title,
      note: t.note,
      category: t.category,
      tags: t.tags ? (() => { try { return JSON.parse(t.tags); } catch { return []; } })() : [],
      priority: t.priority,
      sphere: t.sphere || 'work',
      pinned: t.pinned,
      estimateMin: t.estimateMin,
      actualMin: t.actualMin,
      reminderCount: t.reminderCount,
      reminders: t.reminders ? (() => { try { return JSON.parse(t.reminders); } catch { return []; } })() : [],
      day: t.day,
      promisedFor: t.promisedFor || null,
      promiseSlips: t.promiseSlips || 0,
      // `party` stays the display text so nothing on screen changes. `owner` is the real link — when
      // one exists its name wins, so renaming a contact renames it everywhere. (BEA-1019)
      party: t.ownerContact?.name || t.party || null,
      ownerContactId: t.ownerContactId || null,
      owner: t.ownerContact ? { id: t.ownerContact.id, name: t.ownerContact.name } : null,
      people: Array.isArray(t.people) ? t.people.map((p: any) => ({ id: p.contact.id, name: p.contact.name })) : [],
      // Someone says this is finished and it is waiting on you. NOT done. (BEA-1024)
      claim: Array.isArray(t.claims) && t.claims[0]
        ? { id: t.claims[0].id, quote: t.claims[0].quote, source: t.claims[0].source, at: t.claims[0].createdAt, by: t.claims[0].contact ? { id: t.claims[0].contact.id, name: t.claims[0].contact.name } : null }
        : null,
      dueDate: t.dueDate || null,
      status: t.status,
      progress: t.progress ?? 0,
      followUp: !!t.followUp,
      rolloverCount: t.rolloverCount,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    };
  }

  private sortTasks(rows: any[]) {
    return rows.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1; // open first
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // pinned first
      const pr = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
      if (pr) return pr;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }

  /**
   * Today's tasks + the day's dump status (for the Today screen).
   *
   * Open tasks are carried forward by this QUERY, not by re-stamping their date (BEA-1014): anything
   * still open from today or earlier belongs on Today, while keeping the day it was actually added so
   * the UI can show "added 12 Jul · carried 9 days". Finished tasks are counted on the day they were
   * COMPLETED — otherwise finishing a carried task would silently vanish from today's record.
   */
  async today() {
    const tz = await this.tz();
    const day = this.dayKey(tz);
    // Same definition the history calendar uses, so the two screens can never disagree. (BEA-1018)
    const rows = await this.prisma.task.findMany({ where: await this.whereForDay(day, tz), include: PEOPLE_INCLUDE });
    const dump = await this.prisma.brainDump.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const tasks = this.sortTasks(rows).map((t) => this.shape(t));
    return {
      day,
      dumped: !!dump && dump.taskCount > 0,
      question: dump && dump.taskCount === 0 ? dump.question : null,
      counts: { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length, open: tasks.filter((t) => t.status === 'open').length },
      tasks,
    };
  }

  /** Full task list (all days) for browse/search. */
  async list() {
    const rows = await this.prisma.task.findMany({ orderBy: { createdAt: 'desc' }, take: 2000, include: PEOPLE_INCLUDE });
    return rows.map((t) => this.shape(t));
  }

  /**
   * The ONE definition of what belongs to a given day, shared by every screen and every AI prompt so
   * they can never drift apart again. A day's record is:
   *
   *   - everything FINISHED that day, judged by completedAt — a task added on the 1st and finished on
   *     the 20th is the 20th's work, not the 1st's; and
   *   - everything that was STILL OPEN at the end of that day (added on or before it, and either still
   *     open now or not finished until later).
   *
   * `day` alone can't answer this: since BEA-1014 it is frozen at the day the task was ADDED, so every
   * query keyed to it credited finished work to the wrong date (207 of 290 live tasks) and hid carried
   * tasks completely (Today showed 41 open, History-on-today showed 0). (BEA-1018)
   */
  /**
   * The owner's OWN board. Work handed to someone else lives in /delegated, not here — his task
   * list must stay what HE has to do, or the two get mixed up and neither is trustworthy. (BEA-1029)
   */
  async whereForDay(day: string, tz?: string): Promise<any> {
    const zone = tz || (await this.tz());
    const start = this.dayStart(day, zone);
    const end = this.dayStart(this.dayAdd(day, 1), zone);
    return { AND: [whereForDayRule(day, start, end), { ownerContactId: null }] };
  }

  /** The [start, end) UTC window of a local day — for callers that bucket rows themselves. */
  async dayWindow(day: string, tz?: string): Promise<{ start: Date; end: Date }> {
    const zone = tz || (await this.tz());
    return { start: this.dayStart(day, zone), end: this.dayStart(this.dayAdd(day, 1), zone) };
  }

  /** Local day key for an instant — so callers can bucket a completedAt into the right calendar day. */
  dayKeyOf(d: Date | string, tz: string): string {
    return this.dayKey(tz, new Date(d));
  }

  /** The user's timezone (defaults to India). */
  timezone(): Promise<string> {
    return this.tz();
  }

  /** Add days to a YYYY-MM-DD key. */
  private dayAdd(day: string, n: number): string {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /**
   * All tasks belonging to one day (for the history calendar), presented AS OF that day: a task that was
   * not finished until later reads as open here, with `finishedLater` set so the UI can say when it was
   * actually done. `status` alone is the state TODAY, which would report a task as done on a day it was
   * still sitting open. (BEA-1018)
   */
  async forDay(day: string) {
    const tz = await this.tz();
    const { end } = await this.dayWindow(day, tz);
    const rows = await this.prisma.task.findMany({ where: await this.whereForDay(day, tz), include: PEOPLE_INCLUDE });
    return this.sortTasks(rows).map((t) => {
      const later = t.status === 'done' && t.completedAt && new Date(t.completedAt) >= end;
      const shaped: any = this.shape(t);
      if (!later) return shaped;
      return { ...shaped, status: 'open', progress: 0, finishedLater: this.dayKeyOf(t.completedAt as Date, tz) };
    });
  }

  /**
   * They promised a date. The chase drops to once a day until then — it never pauses, because
   * silence has to keep reaching the owner. Re-promising counts as a slip. (BEA-1022)
   */
  async recordPromise(taskId: string, day: string): Promise<{ ok: boolean; slip?: boolean }> {
    // Shape AND reality: "2026-13-45" matches the pattern but is not a day that exists. A model
    // hallucinating a date must not set a promise. (BEA-1022)
    const d = String(day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false };
    const parsed = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) return { ok: false };
    const t = await this.prisma.task.findUnique({ where: { id: taskId }, select: { promisedFor: true, status: true } });
    if (!t || t.status === 'done') return { ok: false };
    const today = this.dayKey(await this.tz());
    if (d < today) return { ok: false }; // a date in the past is not a promise
    const slip = !!t.promisedFor && t.promisedFor !== d;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { promisedFor: d, promisedAt: new Date(), ...(slip ? { promiseSlips: { increment: 1 } } : {}) },
    });
    this.log.log(`promise on task ${taskId}: ${d}${slip ? ' (re-promised — counted as a slip)' : ''}`);
    return { ok: true, slip };
  }

  /** Contacts in the shape the matchers want. (BEA-1019) */
  private async allContacts() {
    const rows = await this.prisma.contact.findMany({ select: { id: true, name: true, aliases: true } });
    return rows.map((c) => ({ id: c.id, name: c.name, aliases: jarr((c as any).aliases) }));
  }

  /** What the `@names` in a piece of text resolve to — matched, ambiguous, or unknown. (BEA-1019) */
  async resolveMentionText(text: string): Promise<MentionResolution[]> {
    return resolveMentions(text, await this.allContacts());
  }

  /**
   * Work out who owns a task, from an explicit contact id or from the typed `party` text.
   *
   * Typed text is matched EXACTLY (name or alias) and only links when exactly one contact matches.
   * Two matches or none means no link at all — the text is kept as-is. Never guess who someone
   * meant; a task filed against the wrong person is worse than one filed against nobody. (BEA-1019)
   */
  private async resolveOwner(
    contacts: { id: string; name: string; aliases: string[] }[],
    ownerContactId?: string | null,
    party?: string | null,
  ): Promise<{ ownerContactId: string | null; party: string | null } | null> {
    if (ownerContactId !== undefined) {
      if (!ownerContactId) return { ownerContactId: null, party: party ? String(party).trim().slice(0, 80) : null };
      const c = contacts.find((x) => x.id === ownerContactId);
      // An id we don't recognise is a mistake, not a hint. Say so plainly instead of dropping it
      // and quietly leaving the task owned by nobody. (BEA-1019)
      if (!c) throw new BadRequestException('That person is not in your contacts');
      return { ownerContactId: c.id, party: c.name.slice(0, 80) };
    }
    if (party === undefined) return undefined as any; // nothing to change
    const text = party ? String(party).trim().slice(0, 80) : null;
    if (!text) return { ownerContactId: null, party: null };
    const hits = exactMatches(contacts, text);
    return hits.length === 1
      ? { ownerContactId: hits[0].id, party: hits[0].name.slice(0, 80) }
      : { ownerContactId: null, party: text };
  }

  /**
   * Replace a task's @mention links with exactly the ones given. Only names that resolved to one
   * contact are linked; the owner is never also listed as a mention. Additive and idempotent —
   * safe to call on every save. (BEA-1019)
   */
  private async syncPeople(taskId: string, contactIds: string[], ownerContactId?: string | null) {
    const want = [...new Set(contactIds.filter((id) => id && id !== ownerContactId))];
    const have = (await this.prisma.taskPerson.findMany({ where: { taskId }, select: { contactId: true } })).map((r) => r.contactId);
    const add = want.filter((id) => !have.includes(id));
    const drop = have.filter((id) => !want.includes(id));
    if (drop.length) await this.prisma.taskPerson.deleteMany({ where: { taskId, contactId: { in: drop } } });
    for (const contactId of add) {
      await this.prisma.taskPerson.create({ data: { taskId, contactId } }).catch(() => undefined); // unique clash = already linked
    }
  }

  /** The @mentioned contact ids found in a task's own words. */
  private mentionIds(contacts: { id: string; name: string; aliases: string[] }[], ...texts: (string | null | undefined)[]) {
    return linkableIds(resolveMentions(texts.filter(Boolean).join('\n'), contacts));
  }

  /** Every task (any day/status) that names a person — matched against the canonical name and any
   *  learned merge/rename spellings (people.aliases). Word-boundary match so "Ana" ≠ "Banana". */
  async byPerson(name: string) {
    const canonical = String(name || '').trim();
    if (!canonical) return [];
    let aliases: Record<string, string> = {};
    try {
      aliases = JSON.parse((await this.prisma.setting.findUnique({ where: { key: 'people.aliases' } }))?.value || '{}');
    } catch {
      /* ignore */
    }
    // Union of story-taught spellings + the matching Contact's name/aliases, so "Vijay" and
    // "Vijaya Durga" resolve to the same person. (BEA-763)
    const contacts = (await this.prisma.contact.findMany({ select: { id: true, name: true, aliases: true } })).map((c) => ({ id: c.id, name: c.name, aliases: jarr((c as any).aliases) }));
    const contact = matchContact(contacts, canonical);
    const spellSet = new Set<string>([canonical, ...Object.keys(aliases).filter((k) => aliases[k] === canonical)]);
    if (contact) for (const s of contactSpellings(contact)) spellSet.add(s);
    const spellings = [...spellSet].filter(Boolean);
    const res = spellings.map((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    const hit = (txt?: string | null) => !!txt && res.some((re) => re.test(txt));
    const rows = await this.prisma.task.findMany({ take: 5000, include: PEOPLE_INCLUDE });
    // A real link is the truth. The old word-match stays as a safety net for anything not linked
    // yet — a name in a title, or a `party` we could not resolve to one contact. (BEA-1019)
    const linked = (t: any) =>
      !!contact && (t.ownerContactId === contact.id || (t.people || []).some((p: any) => p.contact.id === contact.id));
    const matched = rows.filter((t) => linked(t) || hit(t.title) || hit(t.note) || hit(t.party));
    return this.sortTasks(matched).map((t) => this.shape(t));
  }

  /**
   * Everything handed to someone else. Kept OFF the personal board on purpose — the owner's Tasks
   * screen stays what HE has to do; this is what he is waiting on. (BEA-1029)
   */
  async delegated(contactId?: string) {
    const rows = await this.prisma.task.findMany({
      where: contactId ? { ownerContactId: contactId } : { NOT: { ownerContactId: null } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 2000,
      include: {
        ...PEOPLE_INCLUDE,
        chases: { select: { id: true, status: true, repeat: true, times: true, _count: { select: { sends: true } } } },
      },
    });
    const now = Date.now();
    const stallBy = new Map<string, string[]>((await this.stalling().catch(() => [])).map((s: any) => [s.taskId, s.why]));
    const shaped = rows.map((t: any) => {
      const chase = (t.chases || []).find((c: any) => c.status === 'active') || (t.chases || [])[0] || null;
      const base = this.shape(t);
      return {
        ...base,
        who: t.ownerContact?.name || t.party || 'Someone',
        openDays: Math.max(0, Math.floor((now - new Date(t.createdAt).getTime()) / 86400000)),
        chaseStatus: chase ? chase.status : 'none',
        chaseRepeats: chase?.repeat === 'daily',
        chaseCount: (t.chases || []).reduce((n: number, c: any) => n + (c._count?.sends || 0), 0),
        chaseId: chase?.id || null,
        stalling: stallBy.get(t.id) || null, // why this one isn't moving (BEA-1030)
      };
    });
    return {
      rows: shaped,
      summary: {
        open: shaped.filter((t) => t.status !== 'done').length,
        awaitingYou: shaped.filter((t) => !!t.claim).length,
        chasing: shaped.filter((t) => t.status !== 'done' && t.chaseStatus === 'active').length,
        stalling: shaped.filter((t) => !!t.stalling).length,
      },
    };
  }

  /**
   * Who is stalling. The owner's rule: **three chases with no reply**. Plus a promised date that
   * came and went, and a claim he rejected. Reports only — nothing is ever auto-cancelled. (BEA-1030)
   */
  async stalling() {
    const today = this.dayKey(await this.tz());
    const rows = await this.prisma.task.findMany({
      where: { status: 'open', NOT: { ownerContactId: null } },
      take: 1000,
      select: {
        id: true, title: true, createdAt: true, promisedFor: true, promiseSlips: true, ownerContactId: true,
        ownerContact: { select: { id: true, name: true } },
        claims: { select: { status: true, decidedAt: true } },
        chases: { select: { id: true, sends: { where: { status: { in: ['sent', 'delivered', 'read'] } }, select: { at: true } } } },
      },
    });

    // One query for every inbound message we care about, rather than one per task.
    const contactIds = [...new Set(rows.map((r) => r.ownerContactId).filter(Boolean) as string[])];
    const replies = contactIds.length
      ? await this.prisma.reminderMessage.findMany({
          where: { contactId: { in: contactIds }, direction: 'in' },
          select: { contactId: true, createdAt: true },
        })
      : [];
    const lastReply = new Map<string, number>();
    for (const m of replies) {
      const t = new Date(m.createdAt).getTime();
      const k = m.contactId || '';
      if (!lastReply.has(k) || t > (lastReply.get(k) as number)) lastReply.set(k, t);
    }

    const out: any[] = [];
    for (const r of rows) {
      const sends = r.chases.flatMap((c) => c.sends).map((s) => new Date(s.at).getTime()).sort((a, b) => a - b);
      const heard = lastReply.get(r.ownerContactId || '') || 0;
      // Only chases they have NOT answered since count towards being ignored.
      const unanswered = sends.filter((t) => t > heard).length;
      const rejected = r.claims.some((c) => c.status === 'rejected');
      const missedPromise = !!r.promisedFor && r.promisedFor < today;

      const why: string[] = [];
      if (unanswered >= 3) why.push(`chased ${unanswered} times with no reply`);
      if (missedPromise) why.push(`promised ${r.promisedFor} and it passed`);
      if (rejected) why.push('said it was done, but it wasn\'t');
      if (!why.length) continue;

      out.push({
        taskId: r.id,
        title: r.title,
        who: r.ownerContact?.name || 'Someone',
        contactId: r.ownerContactId,
        openDays: Math.max(0, Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000)),
        unanswered,
        promiseSlips: r.promiseSlips || 0,
        why,
      });
    }
    return out.sort((a, b) => b.openDays - a.openDays);
  }

  /** Manually add a single task (no dump). */
  async create(data: { title?: string; category?: string; tags?: string[]; priority?: string; sphere?: string; estimateMin?: number; note?: string; pinned?: boolean; reminderCount?: number; party?: string; dueDate?: string; auto?: boolean; day?: string; ownerContactId?: string | null; mentions?: string[]; briefingId?: string | null }) {
    const title = String(data.title || '').trim().slice(0, 160);
    if (!title) return null;
    const tz = await this.tz();
    const priority = this.normPriority(data.priority);
    const sphere = this.normSphere(data.sphere);
    const reminderCount = Number.isFinite(data.reminderCount as any) ? Math.max(0, Math.min(4, Math.round(Number(data.reminderCount)))) : 0;
    const reminders = this.computeReminders(reminderCount, priority);
    // Every AUTO-generated task must carry a note. Use the caller's context if given, else write a
    // short AI one-liner so it's never empty. Manually-created tasks stay note-optional. (BEA-955)
    let note = data.note ? String(data.note).trim().slice(0, 500) : null;
    if (!note && data.auto) note = await this.autoNote(title, data.category);
    // Who owns this, and who else it touches. (BEA-1019)
    const contacts = await this.allContacts();
    const owner = (await this.resolveOwner(contacts, data.ownerContactId, data.party ?? null)) || { ownerContactId: null, party: data.party || null };
    const mentioned = [
      ...this.mentionIds(contacts, title, note),
      ...linkableIds((data.mentions || []).map((n) => resolveMentions(`@${n}`, contacts)).flat()),
    ];
    const t = await this.prisma.task.create({
      include: PEOPLE_INCLUDE,
      data: {
        title,
        ownerContactId: owner.ownerContactId,
        briefingId: data.briefingId || null, // the briefing this came from (BEA-1020)
        category: data.category ? String(data.category).trim().slice(0, 40) : null,
        tags: Array.isArray(data.tags) && data.tags.length ? JSON.stringify(data.tags.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 5)) : null,
        priority,
        sphere,
        estimateMin: Number.isFinite(data.estimateMin as any) ? Math.max(1, Math.round(Number(data.estimateMin))) : null,
        note,
        pinned: !!data.pinned,
        reminderCount,
        reminders: reminders.length ? JSON.stringify(reminders) : null,
        party: owner.party,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        day: /^\d{4}-\d{2}-\d{2}$/.test(data.day || '') ? (data.day as string) : this.dayKey(tz),
      },
    });
    this.indexTask(t);
    if (!mentioned.length) return this.shape(t);
    await this.syncPeople(t.id, mentioned, owner.ownerContactId);
    return this.shape(await this.prisma.task.findUnique({ where: { id: t.id }, include: PEOPLE_INCLUDE }));
  }

  /** Create a task that's already DONE on a given day (used by the daily wrap-up to log work done "in the flow"). */
  /** Guarantee auto-generated tasks always carry a note: a short AI one-liner of context. (BEA-955) */
  private async autoNote(title: string, category?: string): Promise<string> {
    const fallback = `Auto-added${category ? ` under ${category}` : ''} — add any details here.`;
    try {
      const model = await this.getModel();
      const prompt = `Write ONE short line (max 12 words) giving context for this task — what it is about or why it matters. No preamble, no quotes.\nTask: "${title}"${category ? `\nArea: ${category}` : ''}`;
      const text = await this.llm.completeWith(model, prompt, 40, 'task-autonote').catch(() => '');
      const line = (text || '').split('\n')[0].replace(/^["']+|["'.]+$/g, '').trim();
      return line || fallback;
    } catch {
      return fallback;
    }
  }

  async createDoneTask(title: string, category: string | null, day: string) {
    const t = String(title || '').trim().slice(0, 160);
    if (!t) return null;
    const row = await this.prisma.task.create({
      data: { title: t, category: category ? String(category).trim().slice(0, 40) : null, priority: 'medium', sphere: 'work', day, status: 'done', progress: 100, completedAt: new Date() },
    });
    this.indexTask(row);
    return this.shape(row);
  }

  async update(id: string, data: { title?: string; category?: string; tags?: string[]; priority?: string; sphere?: string; estimateMin?: number; note?: string; pinned?: boolean; reminderCount?: number; progress?: number; party?: string | null; dueDate?: string | null; ownerContactId?: string | null; mentions?: string[] }) {
    const t = await this.prisma.task.findUnique({ where: { id } });
    if (!t) return null;
    // Owner + @mentions. Only recomputed when something that could carry a name actually changed,
    // so a plain "tick the box" save never disturbs who a task belongs to. (BEA-1019)
    const contacts = await this.allContacts();
    const ownerTouched = data.ownerContactId !== undefined || data.party !== undefined;
    const owner = ownerTouched
      ? await this.resolveOwner(contacts, data.ownerContactId, data.party)
      : { ownerContactId: (t as any).ownerContactId ?? null, party: t.party };
    if (!owner) return null; // an ownerContactId that doesn't exist — reject, don't guess
    const wordsTouched = data.title !== undefined || data.note !== undefined || data.mentions !== undefined;
    const nextTitle = data.title?.trim() ? data.title.trim().slice(0, 160) : t.title;
    const nextNote = data.note !== undefined ? (data.note ? String(data.note).trim().slice(0, 500) : null) : t.note;
    const priority = data.priority !== undefined ? this.normPriority(data.priority) : t.priority;
    const sphere = data.sphere !== undefined ? this.normSphere(data.sphere) : (t as any).sphere || 'work';
    // Recompute reminder times when the count or priority changes.
    const reminderCount = data.reminderCount !== undefined ? Math.max(0, Math.min(4, Math.round(Number(data.reminderCount) || 0))) : t.reminderCount;
    const remindersChanged = data.reminderCount !== undefined || (data.priority !== undefined && data.priority !== t.priority);
    const reminders = remindersChanged ? this.computeReminders(reminderCount, priority) : (t.reminders ? JSON.parse(t.reminders) : []);
    // Progress: snap to the allowed steps. 100 also flips the task to done.
    let progress = t.progress;
    let statusFromProgress: { status?: string; completedAt?: Date | null } = {};
    if (data.progress !== undefined) {
      const allowed = [0, 30, 60, 100];
      const n = Number(data.progress);
      progress = allowed.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), 0);
      if (progress === 100) statusFromProgress = { status: 'done', completedAt: new Date() };
      else if (t.status === 'done') statusFromProgress = { status: 'open', completedAt: null };
    }
    const upd = await this.prisma.task.update({
      where: { id },
      include: PEOPLE_INCLUDE,
      data: {
        title: nextTitle,
        ownerContactId: owner.ownerContactId,
        category: data.category !== undefined ? (data.category ? String(data.category).trim().slice(0, 40) : null) : t.category,
        tags: data.tags !== undefined ? (Array.isArray(data.tags) && data.tags.length ? JSON.stringify(data.tags.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 5)) : null) : t.tags,
        priority,
        sphere,
        estimateMin: data.estimateMin !== undefined ? (Number.isFinite(data.estimateMin as any) ? Math.max(1, Math.round(Number(data.estimateMin))) : null) : t.estimateMin,
        note: nextNote,
        pinned: data.pinned !== undefined ? !!data.pinned : t.pinned,
        reminderCount,
        reminders: reminders.length ? JSON.stringify(reminders) : null,
        party: owner.party,
        dueDate: data.dueDate !== undefined ? (data.dueDate ? new Date(data.dueDate) : null) : t.dueDate,
        progress,
        ...statusFromProgress,
      },
    });
    this.indexTask(upd);
    if (!wordsTouched && !ownerTouched) return this.shape(upd);
    const mentioned = [
      ...this.mentionIds(contacts, nextTitle, nextNote),
      ...linkableIds((data.mentions || []).map((n) => resolveMentions(`@${n}`, contacts)).flat()),
    ];
    await this.syncPeople(id, mentioned, owner.ownerContactId);
    return this.shape(await this.prisma.task.findUnique({ where: { id }, include: PEOPLE_INCLUDE }));
  }

  /** Mark done/undone. On done, capture the one-tap "how long did it really take?" actual,
   *  and optionally spawn a follow-up task for a chosen day (YYYY-MM-DD). */
  async setDone(id: string, done: boolean, actualMin?: number, followUpDate?: string) {
    const t = await this.prisma.task.findUnique({ where: { id } });
    if (!t) return null;
    const upd = await this.prisma.task.update({
      where: { id },
      data: {
        status: done ? 'done' : 'open',
        // Un-checking a done task resets progress to 0 — it was overwritten to 100 when marked done,
        // so "keep prior progress" wrongly left it at 100 and every weighted metric counted the
        // now-open task as fully complete. (A genuinely-open task's progress is left untouched.) (BEA-807)
        progress: done ? 100 : (t.status === 'done' ? 0 : t.progress),
        completedAt: done ? new Date() : null,
        actualMin: done ? (Number.isFinite(actualMin as any) ? Math.max(1, Math.round(Number(actualMin))) : t.actualMin) : null,
      },
    });
    this.indexTask(upd);
    await this.syncChases(id, done);
    if (done) await this.spawnFollowUp(t, followUpDate);
    return this.shape(upd);
  }

  /**
   * A chase exists to get one piece of work finished, so confirming the work stops the chase — and
   * re-opening it starts the chase again. Done here with plain queries rather than by injecting the
   * reminders service, which would make tasks and contacts depend on each other. (BEA-1021)
   */
  private async syncChases(taskId: string, done: boolean) {
    try {
      if (done) {
        const stopped = await this.prisma.reminder.updateMany({ where: { taskId, status: { in: ['active', 'paused'] } }, data: { status: 'done' } });
        if (stopped.count) {
          await this.prisma.reminderSend.deleteMany({ where: { reminder: { taskId }, status: 'queued' } });
          this.log.log(`task ${taskId} confirmed done — stopped ${stopped.count} chase(s)`);
        }
        return;
      }
      // Re-opened: bring a repeating chase back to life. The day rollover re-arms it within a minute.
      const back = await this.prisma.reminder.updateMany({ where: { taskId, status: 'done', repeat: 'daily' }, data: { status: 'active', armedDay: null } });
      if (back.count) this.log.log(`task ${taskId} re-opened — resumed ${back.count} chase(s)`);
    } catch (e: any) {
      this.log.warn(`chase sync for ${taskId}: ${e?.message ?? e}`);
    }
  }

  /** Create a "Follow up: <task>" task dated to the chosen day. The morning Telegram nudge announces it. */
  private async spawnFollowUp(orig: any, followUpDate?: string) {
    const day = (followUpDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const fu = await this.prisma.task.create({
      data: {
        title: `Follow up: ${orig.title}`.slice(0, 160),
        category: orig.category || null,
        priority: orig.priority || 'medium',
        note: orig.note || null,
        day,
        followUp: true,
      },
    });
    this.indexTask(fu);
    return fu;
  }

  async remove(id: string) {
    const t = await this.prisma.task.findUnique({ where: { id } });
    if (t) this.unindexTask(t);
    await this.prisma.task.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  // ---- AI duplicate cleanup ----

  /** Among same-intent open tasks, the one to KEEP: pinned > furthest along > has a note > the original (oldest). */
  private pickKeeper(members: any[]) {
    return members.slice().sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if ((b.progress ?? 0) !== (a.progress ?? 0)) return (b.progress ?? 0) - (a.progress ?? 0);
      const an = a.note ? 1 : 0;
      const bn = b.note ? 1 : 0;
      if (an !== bn) return bn - an;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })[0];
  }

  /** Ask the Tasks model to cluster OPEN tasks that mean the same thing. Returns {keep, remove[]} groups
   *  for the user to review — nothing is deleted here. Conservative by design (this leads to deletion). */
  async findDuplicates() {
    const model = await this.getModel();
    const rows = await this.prisma.task.findMany({ where: { status: 'open' }, orderBy: { createdAt: 'asc' }, take: 2000 });
    if (rows.length < 2) return { groups: [], openCount: rows.length, model };

    const list = rows.map((t) => ({
      id: t.id,
      title: t.title,
      note: t.note ? String(t.note).slice(0, 200) : undefined,
      category: t.category || undefined,
      day: t.day || undefined,
    }));
    const tmpl = await this.prompts.get('tasks.dedupe');
    const prompt = `${tmpl}\n\nOPEN TASKS (JSON):\n${JSON.stringify(list)}`;
    const text = await this.llm.completeWith(model, prompt, 2000, 'task-dedupe');
    if (!text) return { groups: [], openCount: rows.length, model, error: 'ai-unavailable' };

    let raw: any[] = [];
    try {
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      raw = Array.isArray(json.groups) ? json.groups : [];
    } catch {
      raw = [];
    }

    const byId = new Map(rows.map((r) => [r.id, r]));
    const used = new Set<string>();
    const groups: { keep: any; remove: any[] }[] = [];
    for (const g of raw) {
      // De-dup ids within a group, drop unknowns, and never let an id land in two groups.
      const members = Array.from(new Set((Array.isArray(g) ? g : []).map((x) => String(x))))
        .filter((id) => byId.has(id) && !used.has(id))
        .map((id) => byId.get(id));
      if (members.length < 2) continue;
      members.forEach((m) => used.add(m.id));
      const keep = this.pickKeeper(members);
      const remove = members.filter((m) => m.id !== keep.id);
      groups.push({ keep: this.shape(keep), remove: remove.map((m) => this.shape(m)) });
    }
    return { groups, openCount: rows.length, model };
  }

  /** Delete chosen duplicate ids — but ONLY ones still open, so completed history is never touched. */
  async removeDuplicates(ids: string[]) {
    const clean = (Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean).slice(0, 2000);
    if (!clean.length) return { removed: 0 };
    const doomed = await this.prisma.task.findMany({ where: { id: { in: clean }, status: 'open' } });
    doomed.forEach((t) => this.unindexTask(t));
    const res = await this.prisma.task.deleteMany({ where: { id: { in: clean }, status: 'open' } });
    return { removed: res.count };
  }

  /** Index every Task/Story that isn't linked into the brain yet (or re-index all). Idempotent:
   *  indexEntity deletes prior docs first, so re-running never duplicates. Returns counts. (BEA-331) */
  async backfillIndex(opts: { all?: boolean } = {}): Promise<{ tasks: number; stories: number }> {
    const where = opts.all ? {} : { OR: [{ ragId: null }, { supermemoryId: null }] };
    const tasks = await this.prisma.task.findMany({ where });
    for (const t of tasks) this.indexTask(t);
    return { tasks: tasks.length, stories: 0 };
  }
}
