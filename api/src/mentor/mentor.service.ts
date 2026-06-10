import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const MENTOR_AT = '23:59'; // runs just after the Story of the Day (23:58)
const DEFAULT_MENTOR_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };
const DERIVE_EVERY_MS = 3 * 24 * 60 * 60 * 1000;

@Injectable()
export class MentorService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit() {
    this.tick = setInterval(() => this.nightlyTick().catch(() => undefined), 60_000);
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  // ---- time helpers ----
  private async tz(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } });
    return row?.value || DEFAULT_TZ;
  }
  private dayKey(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }
  private dayAdd(day: string, n: number): string {
    const d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  private localHM(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    } catch {
      return d.toISOString().slice(11, 16);
    }
  }

  // ---- model picker ----
  async mentorModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'mentor.llm' } });
    if (!row) return DEFAULT_MENTOR_MODEL;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : DEFAULT_MENTOR_MODEL;
    } catch {
      return DEFAULT_MENTOR_MODEL;
    }
  }
  async setMentorModel(provider: string, model: string) {
    const value = JSON.stringify({ provider, model });
    await this.prisma.setting.upsert({ where: { key: 'mentor.llm' }, create: { key: 'mentor.llm', value }, update: { value } });
    return { provider, model };
  }
  async listModels() {
    return this.tasks.listModels();
  }

  // ---- focus areas ----
  private shapeFocus(f: any) {
    return { id: f.id, title: f.title, description: f.description, source: f.source, status: f.status, createdAt: f.createdAt };
  }

  /** Active + proposed focus areas (archived hidden). */
  async listFocusAreas() {
    const rows = await this.prisma.focusArea.findMany({ where: { status: { not: 'archived' } }, orderBy: { createdAt: 'asc' } });
    const all = rows.map((r) => this.shapeFocus(r));
    return { active: all.filter((f) => f.status === 'active'), proposed: all.filter((f) => f.status === 'proposed') };
  }

  async createFocusArea(title: string, description?: string) {
    const t = String(title || '').trim().slice(0, 120);
    if (!t) return null;
    const row = await this.prisma.focusArea.create({ data: { title: t, description: description ? String(description).trim().slice(0, 400) : null, source: 'user', status: 'active' } });
    return this.shapeFocus(row);
  }

  async updateFocusArea(id: string, data: { title?: string; description?: string; status?: string }) {
    const f = await this.prisma.focusArea.findUnique({ where: { id } });
    if (!f) return null;
    const status = data.status && ['proposed', 'active', 'archived'].includes(data.status) ? data.status : f.status;
    const row = await this.prisma.focusArea.update({
      where: { id },
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 120) : f.title,
        description: data.description !== undefined ? (data.description ? String(data.description).trim().slice(0, 400) : null) : f.description,
        status,
      },
    });
    return this.shapeFocus(row);
  }

  /** Read recent Stories of the Day + task patterns and propose focus areas (added as "proposed" for the user to confirm). */
  async deriveFocusAreas() {
    const [dayStories, stories, recentTasks] = await Promise.all([
      this.prisma.dayStory.findMany({ orderBy: { day: 'desc' }, take: 21 }),
      this.prisma.story.findMany({ orderBy: { createdAt: 'desc' }, take: 21 }),
      this.prisma.task.findMany({ orderBy: { createdAt: 'desc' }, take: 400 }),
    ]);

    // Task pattern: where his time/effort actually goes, by category (a strong signal of real direction).
    const catCount: Record<string, number> = {};
    const catMin: Record<string, number> = {};
    for (const t of recentTasks) {
      const c = (t.category || 'Uncategorized').trim();
      catCount[c] = (catCount[c] || 0) + 1;
      catMin[c] = (catMin[c] || 0) + (t.actualMin || t.estimateMin || 0);
    }
    const catLines = Object.keys(catCount)
      .sort((a, b) => catMin[b] - catMin[a])
      .slice(0, 8)
      .map((c) => `- ${c}: ${catCount[c]} tasks, ~${catMin[c]}m`);

    const corpus =
      `Recent Stories of the Day:\n${dayStories.map((s) => `• (${s.day}) ${s.text.slice(0, 400)}`).join('\n') || '(none yet)'}\n\n` +
      `Recent told stories:\n${stories.map((s) => `• ${s.rawText.slice(0, 240)}`).join('\n') || '(none)'}\n\n` +
      `Where his task effort goes (by category):\n${catLines.join('\n') || '(no task data yet)'}\n\n` +
      `Days of data available: ${dayStories.length} stories. If this is small (under ~5), be especially cautious and propose at most one focus area, or none.`;

    const tmpl = await this.prompts.get('mentor.focus');
    const raw = (await this.llm.completeWith(await this.mentorModel(), `${tmpl}\n\n${corpus}`, 900, 'mentor-focus'))?.trim() || '';
    let proposed: { title: string; description?: string }[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.focusAreas)) proposed = json.focusAreas;
    } catch {
      /* ignore */
    }
    proposed = proposed.filter((p) => p?.title?.trim()).slice(0, 3);

    // A fresh "Suggest" replaces the previous un-confirmed proposals (they're just pending ideas),
    // and we only avoid duplicating focus areas the user has actually CONFIRMED (active).
    await this.prisma.focusArea.deleteMany({ where: { status: 'proposed', source: 'derived' } });
    const active = (await this.prisma.focusArea.findMany({ where: { status: 'active' } })).map((f) => f.title.toLowerCase().trim());
    const created = [];
    for (const p of proposed) {
      const title = String(p.title).trim().slice(0, 120);
      if (active.includes(title.toLowerCase())) continue; // already a confirmed focus
      const row = await this.prisma.focusArea.create({ data: { title, description: p.description ? String(p.description).trim().slice(0, 400) : null, source: 'derived', status: 'proposed' } });
      created.push(this.shapeFocus(row));
    }
    await this.setSetting('mentor.lastDerive', new Date().toISOString());
    return created;
  }

  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  // ---- daily mentor read ----
  private shapeMentorDay(m: any) {
    return { day: m.day, adherenceScore: m.adherenceScore, moodScore: m.moodScore, guidance: m.guidance, createdAt: m.createdAt };
  }

  /** One day's read + the previous existing read's score (for the "vs yesterday" delta). */
  async getDay(day: string) {
    const row = await this.prisma.mentorDay.findUnique({ where: { day } });
    if (!row) return null;
    const prev = await this.prisma.mentorDay.findFirst({ where: { day: { lt: day } }, orderBy: { day: 'desc' } });
    return { ...this.shapeMentorDay(row), prev: prev ? { day: prev.day, adherenceScore: prev.adherenceScore } : null };
  }

  /** Compare the day to the active focus areas, write guidance + an adherence score. */
  async runMentorDay(day: string, force = false) {
    if (!force) {
      const existing = await this.prisma.mentorDay.findUnique({ where: { day } });
      if (existing) return this.shapeMentorDay(existing);
    }
    const [dayStory, told, dayTasks, focus, recent] = await Promise.all([
      this.prisma.dayStory.findUnique({ where: { day } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { day } }),
      this.prisma.focusArea.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } }),
      // strictly PRIOR days, so a re-run never reads its own earlier draft as "yesterday"
      this.prisma.mentorDay.findMany({ where: { day: { lt: day } }, orderBy: { day: 'desc' }, take: 4 }),
    ]);

    const narrative = dayStory?.text || told?.rawText || '';
    if (!narrative && !dayTasks.length) return null; // nothing to mentor on

    const doneList = dayTasks.filter((t) => t.status === 'done').map((t) => `✓ ${t.title}`);
    const openList = dayTasks.filter((t) => t.status !== 'done').map((t) => `○ ${t.title}${(t.progress || 0) > 0 ? ` (${t.progress}%)` : ''}`);
    const focusLines = focus.map((f) => `- ${f.title}${f.description ? `: ${f.description}` : ''}`);
    const yesterday = recent[0] || null; // most recent prior read
    const recentGuide = [...recent].reverse().map((m) => `(${m.day}, score ${m.adherenceScore}) ${m.guidance.slice(0, 300)}`);

    const tmpl = await this.prompts.get('mentor.guidance');
    const prompt =
      `${tmpl}\n\n` +
      `=== HIS FOCUS AREAS ===\n${focusLines.join('\n') || '(none set yet — give general direction and infer what matters)'}\n\n` +
      `=== TODAY (${day}) ===\n` +
      `Story of the Day:\n${narrative.slice(0, 2500) || '(none)'}\n\n` +
      `Finished:\n${doneList.join('\n') || '(none)'}\n\nStill open:\n${openList.join('\n') || '(none)'}\n\n` +
      `=== YESTERDAY ===\n${yesterday ? `Score: ${yesterday.adherenceScore}/100 (${yesterday.day}). Your note to him was:\n${yesterday.guidance.slice(0, 600)}` : '(no prior read — this is your first note to him)'}\n\n` +
      `=== YOUR EARLIER NOTES ===\n${recentGuide.join('\n') || '(none)'}`;

    const raw = (await this.llm.completeWith(await this.mentorModel(), prompt, 1200, 'mentor-guidance'))?.trim() || '';
    let guidance = raw;
    let adherenceScore = dayStory?.moodScore ?? 50;
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (json?.guidance) guidance = String(json.guidance).trim();
      if (Number.isFinite(json?.adherenceScore)) adherenceScore = Math.max(0, Math.min(100, Math.round(Number(json.adherenceScore))));
    } catch {
      /* keep prose as guidance */
    }
    if (!guidance) return null;

    const row = await this.prisma.mentorDay.upsert({
      where: { day },
      create: { day, adherenceScore, moodScore: dayStory?.moodScore ?? null, guidance },
      update: { adherenceScore, moodScore: dayStory?.moodScore ?? null, guidance },
    });
    // Flag it for the nightly Telegram push.
    await this.setSetting('telegram.pushMentor', day).catch(() => undefined);
    return this.shapeMentorDay(row);
  }

  /** Everything the Mentor screen needs: focus areas, latest guidance, and the trend series. */
  async overview(days = 30) {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const span = Math.max(7, Math.min(120, days));
    const start = this.dayAdd(today, -(span - 1));
    const [focus, rows] = await Promise.all([
      this.listFocusAreas(),
      this.prisma.mentorDay.findMany({ where: { day: { gte: start } }, orderBy: { day: 'asc' } }),
    ]);
    const trend = rows.map((m) => ({ day: m.day, adherence: m.adherenceScore, mood: m.moodScore }));
    const latest = rows.length ? this.shapeMentorDay(rows[rows.length - 1]) : null;
    const avgAdherence = rows.length ? Math.round(rows.reduce((s, m) => s + m.adherenceScore, 0) / rows.length) : null;
    return { focusAreas: focus, latest, trend, avgAdherence, days: span };
  }

  // ---- nightly ----

  /** (Re)write a day's read unless one already exists that reflects the FINAL day (written after its
   *  Story of the Day). A daytime "Get guidance now" must never block the end-of-day read, and a
   *  missed 23:59 window (deploy/restart) gets caught up the next day. */
  async ensureFreshRead(day: string): Promise<void> {
    const [read, story] = await Promise.all([
      this.prisma.mentorDay.findUnique({ where: { day } }),
      this.prisma.dayStory.findUnique({ where: { day } }),
    ]);
    if (read && (!story || new Date(read.updatedAt) >= new Date(story.createdAt))) return; // already fresh
    await this.runMentorDay(day, true).catch(() => undefined);
  }

  async nightlyTick(): Promise<void> {
    const tz = await this.tz();
    const day = this.dayKey(tz);

    if (this.localHM(tz) >= MENTOR_AT) {
      // End of day: make sure there are focus areas to mentor against, then write tonight's read.
      const haveAny = await this.prisma.focusArea.count({ where: { status: { not: 'archived' } } });
      const lastDerive = (await this.prisma.setting.findUnique({ where: { key: 'mentor.lastDerive' } }))?.value;
      const dueToDerive = !lastDerive || Date.now() - new Date(lastDerive).getTime() > DERIVE_EVERY_MS;
      if (!haveAny || dueToDerive) await this.deriveFocusAreas().catch(() => undefined);
      await this.ensureFreshRead(day);
    } else {
      // Catch-up: yesterday's read was missed (restart at 23:59) or is stale (a daytime manual
      // run wrote it before the Story of the Day existed) — fix it now.
      await this.ensureFreshRead(this.dayAdd(day, -1));
    }
  }
}
