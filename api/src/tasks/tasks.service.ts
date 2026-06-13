import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  onModuleInit() {
    // No automatic midnight rollover anymore: a day's open tasks stay on that day until the day is
    // CLOSED (DailyService.closeDay), which then rolls the leftovers forward via rollDayForward().
    // This keeps task credit truthful to the day the work actually belonged to.
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  /** Carry a closed day's still-open tasks forward to `toDay` (flagged via rolloverCount). Called by closeDay. */
  async rollDayForward(fromDay: string, toDay: string): Promise<{ rolled: number }> {
    if (!fromDay || !toDay || fromDay >= toDay) return { rolled: 0 };
    const open = await this.prisma.task.findMany({ where: { status: 'open', day: fromDay } });
    for (const t of open) {
      await this.prisma.task.update({ where: { id: t.id }, data: { day: toDay, rolloverCount: (t.rolloverCount || 0) + 1 } });
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
    return this.shape(t);
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
    if (done) await this.spawnFollowUp(t, followUpDate);
    return this.shape(upd);
  }

  /** Create a "Follow up: <task>" task dated to the chosen day. The morning Telegram nudge announces it. */
  private async spawnFollowUp(orig: any, followUpDate?: string) {
    const day = (followUpDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    return this.prisma.task.create({
      data: {
        title: `Follow up: ${orig.title}`.slice(0, 160),
        category: orig.category || null,
        priority: orig.priority || 'medium',
        note: orig.note || null,
        day,
        followUp: true,
      },
    });
  }

  async remove(id: string) {
    await this.prisma.task.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }
}
