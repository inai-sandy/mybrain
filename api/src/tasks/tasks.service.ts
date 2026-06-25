import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { MemoryService } from '../memory/memory.service';

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

  /** Build the searchable text for a task and (re-)index it into the brain. Fire-and-forget:
   *  indexing must never block or fail a task operation. (BEA-331)
   *  ONLY finished tasks belong in memory — open tasks are working state and re-indexing them on every
   *  rollover/progress update was creating endless duplicates. So for a non-done task we instead REMOVE
   *  any memory docs it has and clear the stored ids. (BEA-546) */
  private indexTask(t: any): void {
    if (!t?.id) return;
    if (t.status !== 'done') {
      if (t.supermemoryId || t.ragId) {
        this.memory.deleteDoc(t.supermemoryId, t.ragId).catch(() => undefined);
        this.prisma.task.update({ where: { id: t.id }, data: { supermemoryId: null, ragId: null } }).catch(() => undefined);
      }
      return;
    }
    const tags = JSON.parse((t.tags as string) || '[]');
    const parts = [
      t.title,
      t.note || '',
      t.category ? `Category: ${t.category}` : '',
      `Status: ${t.status === 'done' ? 'done' : 'open'}${t.progress ? ` (${t.progress}%)` : ''}`,
      t.day ? `Day: ${t.day}` : '',
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

  /** Carry a closed day's still-open tasks forward to `toDay` (flagged via rolloverCount). Called by closeDay. */
  async rollDayForward(fromDay: string, toDay: string): Promise<{ rolled: number }> {
    if (!fromDay || !toDay || fromDay >= toDay) return { rolled: 0 };
    const open = await this.prisma.task.findMany({ where: { status: 'open', day: fromDay } });
    for (const t of open) {
      const upd = await this.prisma.task.update({ where: { id: t.id }, data: { day: toDay, rolloverCount: (t.rolloverCount || 0) + 1 } });
      this.indexTask(upd);
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
    const created = [];
    for (const c of crafted.tasks) {
      const title = String(c.title || '').trim().slice(0, 160);
      if (!title) continue;
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
    return { dumpId: d.id, question: undefined, tasks: created };
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

  /** Today's tasks + the day's dump status (for the Today screen). */
  async today() {
    const tz = await this.tz();
    const day = this.dayKey(tz);
    const rows = await this.prisma.task.findMany({ where: { day } });
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
    const rows = await this.prisma.task.findMany({ orderBy: { createdAt: 'desc' }, take: 2000 });
    return rows.map((t) => this.shape(t));
  }

  /** All tasks planned/finished on one day (for the history calendar). */
  async forDay(day: string) {
    const rows = await this.prisma.task.findMany({ where: { day } });
    return this.sortTasks(rows).map((t) => this.shape(t));
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
    const spellings = [canonical, ...Object.keys(aliases).filter((k) => aliases[k] === canonical)];
    const res = spellings.map((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    const hit = (txt?: string | null) => !!txt && res.some((re) => re.test(txt));
    const rows = await this.prisma.task.findMany({ take: 5000 });
    const matched = rows.filter((t) => hit(t.title) || hit(t.note));
    return this.sortTasks(matched).map((t) => this.shape(t));
  }

  /** Manually add a single task (no dump). */
  async create(data: { title?: string; category?: string; tags?: string[]; priority?: string; sphere?: string; estimateMin?: number; note?: string; pinned?: boolean; reminderCount?: number }) {
    const title = String(data.title || '').trim().slice(0, 160);
    if (!title) return null;
    const tz = await this.tz();
    const priority = this.normPriority(data.priority);
    const sphere = this.normSphere(data.sphere);
    const reminderCount = Number.isFinite(data.reminderCount as any) ? Math.max(0, Math.min(4, Math.round(Number(data.reminderCount)))) : 0;
    const reminders = this.computeReminders(reminderCount, priority);
    const t = await this.prisma.task.create({
      data: {
        title,
        category: data.category ? String(data.category).trim().slice(0, 40) : null,
        tags: Array.isArray(data.tags) && data.tags.length ? JSON.stringify(data.tags.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 5)) : null,
        priority,
        sphere,
        estimateMin: Number.isFinite(data.estimateMin as any) ? Math.max(1, Math.round(Number(data.estimateMin))) : null,
        note: data.note ? String(data.note).trim().slice(0, 500) : null,
        pinned: !!data.pinned,
        reminderCount,
        reminders: reminders.length ? JSON.stringify(reminders) : null,
        day: this.dayKey(tz),
      },
    });
    this.indexTask(t);
    return this.shape(t);
  }

  /** Create a task that's already DONE on a given day (used by the daily wrap-up to log work done "in the flow"). */
  async createDoneTask(title: string, category: string | null, day: string) {
    const t = String(title || '').trim().slice(0, 160);
    if (!t) return null;
    const row = await this.prisma.task.create({
      data: { title: t, category: category ? String(category).trim().slice(0, 40) : null, priority: 'medium', sphere: 'work', day, status: 'done', progress: 100, completedAt: new Date() },
    });
    this.indexTask(row);
    return this.shape(row);
  }

  async update(id: string, data: { title?: string; category?: string; tags?: string[]; priority?: string; sphere?: string; estimateMin?: number; note?: string; pinned?: boolean; reminderCount?: number; progress?: number }) {
    const t = await this.prisma.task.findUnique({ where: { id } });
    if (!t) return null;
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
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 160) : t.title,
        category: data.category !== undefined ? (data.category ? String(data.category).trim().slice(0, 40) : null) : t.category,
        tags: data.tags !== undefined ? (Array.isArray(data.tags) && data.tags.length ? JSON.stringify(data.tags.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 5)) : null) : t.tags,
        priority,
        sphere,
        estimateMin: data.estimateMin !== undefined ? (Number.isFinite(data.estimateMin as any) ? Math.max(1, Math.round(Number(data.estimateMin))) : null) : t.estimateMin,
        note: data.note !== undefined ? (data.note ? String(data.note).trim().slice(0, 500) : null) : t.note,
        pinned: data.pinned !== undefined ? !!data.pinned : t.pinned,
        reminderCount,
        reminders: reminders.length ? JSON.stringify(reminders) : null,
        progress,
        ...statusFromProgress,
      },
    });
    this.indexTask(upd);
    return this.shape(upd);
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
        progress: done ? 100 : t.progress, // mark-open keeps prior progress
        completedAt: done ? new Date() : null,
        actualMin: done ? (Number.isFinite(actualMin as any) ? Math.max(1, Math.round(Number(actualMin))) : t.actualMin) : null,
      },
    });
    this.indexTask(upd);
    if (done) await this.spawnFollowUp(t, followUpDate);
    return this.shape(upd);
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
