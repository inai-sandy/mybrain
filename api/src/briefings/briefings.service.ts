import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';
import { RemindersService } from '../contacts/reminders.service';
import { MemoryService } from '../memory/memory.service';
import { looseJsonParse } from '../common/llm-json';

const DEFAULT_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

export type DraftTask = {
  title: string;
  note?: string;
  category?: string;
  priority?: 'high' | 'medium' | 'low';
  estimateMin?: number;
};

/**
 * Briefings — you tell the story about a person once, and it becomes their work. (BEA-1020)
 *
 * Two steps on purpose. `draft` reads your words and PROPOSES tasks without saving anything;
 * `create` saves the briefing and the tasks you actually approved. Nothing is written to your
 * task list until you've seen it, because an AI split of a rambling paragraph is a guess and
 * guesses belong in front of you, not in your data.
 */
@Injectable()
export class BriefingsService {
  private readonly log = new Logger('BriefingsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tasks: TasksService,
    private readonly reminders: RemindersService,
    private readonly memory: MemoryService,
  ) {}

  private async model(): Promise<LlmConfig> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: 'briefing.llm' } });
      if (row?.value) {
        const v = JSON.parse(row.value);
        if (v?.provider && v?.model) return v;
      }
    } catch { /* fall through to the default */ }
    return DEFAULT_MODEL;
  }

  private async contactOrThrow(contactId: string) {
    const c = await this.prisma.contact.findUnique({ where: { id: contactId } });
    if (!c) throw new NotFoundException('Contact not found');
    return c;
  }

  /**
   * Tidy a dictated briefing: fix the rambling, keep the meaning, change no facts. The owner taps
   * this BEFORE "Read it", so what gets saved is the version he approved on screen. If the model
   * is down, his words come back untouched — tidying must never lose or invent anything. (BEA-1039)
   */
  async tidy(contactId: string, text: string): Promise<{ text: string }> {
    const contact = await this.contactOrThrow(contactId);
    const raw = String(text || '').trim();
    if (!raw) throw new BadRequestException('Nothing to tidy yet');
    const tmpl = await this.prompts.get('people.briefingTidy');
    const prompt = `${tmpl.replace(/\{\{name\}\}/g, contact.name)}\n\n${raw.slice(0, 8000)}`;
    try {
      const out = await this.llm.completeWith(await this.model(), prompt, 1200, 'briefing-tidy');
      const cleaned = String(out || '').trim();
      return { text: cleaned || raw };
    } catch {
      return { text: raw }; // the AI being down never eats his words
    }
  }

  /** Propose the tasks hidden in a briefing. Saves NOTHING — the owner reviews first. */
  async draft(contactId: string, text: string): Promise<{ summary: string; tasks: DraftTask[] }> {
    const contact = await this.contactOrThrow(contactId);
    const raw = String(text || '').trim();
    if (!raw) throw new BadRequestException('Tell me what is going on with them first');

    const tmpl = await this.prompts.get('delegation.brief');
    const prompt = `${tmpl}\n\nThe person: ${contact.name}\n\nWhat Sandeep said:\n${raw.slice(0, 8000)}`;
    let out: any = null;
    try {
      const res = await this.llm.completeWith(await this.model(), prompt, 1600, 'briefing-draft');
      out = looseJsonParse(res);
    } catch (e: any) {
      this.log.warn(`briefing draft failed: ${e?.message ?? e}`);
    }

    // The AI being unavailable must never lose what you said. Fall back to one task holding the
    // whole briefing — you can split it by hand, and nothing is dropped on the floor.
    if (!out || !Array.isArray(out.tasks) || !out.tasks.length) {
      return { summary: raw.replace(/\s+/g, ' ').slice(0, 140), tasks: [{ title: raw.replace(/\s+/g, ' ').slice(0, 160), note: raw.slice(0, 500) }] };
    }

    const tasks: DraftTask[] = out.tasks
      .map((t: any) => ({
        title: String(t?.title || '').trim().slice(0, 160),
        note: t?.note ? String(t.note).trim().slice(0, 500) : undefined,
        category: t?.category ? String(t.category).trim().slice(0, 40) : undefined,
        priority: ['high', 'medium', 'low'].includes(t?.priority) ? t.priority : 'medium',
        estimateMin: Number.isFinite(Number(t?.estimateMin)) ? Math.max(1, Math.round(Number(t.estimateMin))) : undefined,
      }))
      .filter((t: DraftTask) => !!t.title)
      .slice(0, 20);

    if (!tasks.length) return { summary: raw.replace(/\s+/g, ' ').slice(0, 140), tasks: [{ title: raw.replace(/\s+/g, ' ').slice(0, 160), note: raw.slice(0, 500) }] };
    const summary = String(out.summary || '').trim().slice(0, 200) || `${tasks.length} thing${tasks.length === 1 ? '' : 's'} for ${contact.name}`;
    return { summary, tasks };
  }

  /** Save the briefing and create exactly the tasks the owner approved. */
  async create(contactId: string, input: { text?: string; summary?: string; tasks?: DraftTask[]; chase?: { times?: string[] } | null }) {
    const contact = await this.contactOrThrow(contactId);
    const raw = String(input?.text || '').trim();
    if (!raw) throw new BadRequestException('Tell me what is going on with them first');
    const approved = (input?.tasks || []).map((t) => ({ ...t, title: String(t?.title || '').trim().slice(0, 160) })).filter((t) => t.title);
    if (!approved.length) throw new BadRequestException('Keep at least one task, or cancel');

    // Chase times are the owner's call — he said the frequency stays his decision.
    const chaseTimes = (input?.chase?.times || []).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t))).slice(0, 8);

    const briefing = await this.prisma.briefing.create({
      data: { contactId, rawText: raw.slice(0, 8000), summary: (input?.summary || '').trim().slice(0, 200) || null },
    });

    const created: any[] = [];
    for (const t of approved) {
      const row = await this.tasks.create({
        title: t.title,
        note: t.note,
        category: t.category,
        priority: t.priority,
        estimateMin: t.estimateMin,
        ownerContactId: contactId, // every task from a briefing belongs to that person (BEA-1019)
        briefingId: briefing.id,
        auto: true,
      });
      if (!row) continue;
      created.push(row);
      // Set the chase in the same step, so work handed out is work being followed up. A chase
      // repeats every day until you confirm the task done. (BEA-1021)
      if (chaseTimes.length) {
        await this.reminders
          .create({ contactId, taskId: row.id, subject: row.title, message: `Following up on: ${row.title}`, times: chaseTimes, repeat: 'daily' })
          .catch((e: any) => this.log.warn(`chase for "${row.title}" not created: ${e?.message ?? e}`));
      }
    }
    this.log.log(`briefing for ${contact.name}: ${created.length} task(s) created${chaseTimes.length ? `, chased at ${chaseTimes.join(', ')}` : ''}`);
    // Into the brain: the briefing itself, and this person's rolling "where things stand". (BEA-1031)
    this.memory.indexBriefing(briefing.id).catch(() => undefined);
    this.memory.reindexContact(contactId).catch(() => undefined);
    return this.shape(await this.prisma.briefing.findUnique({ where: { id: briefing.id }, include: { tasks: true } }));
  }

  /** Every briefing for a person, newest first. */
  async list(contactId: string) {
    await this.contactOrThrow(contactId);
    const rows = await this.prisma.briefing.findMany({
      where: { contactId },
      orderBy: { createdAt: 'desc' },
      include: { tasks: { select: { id: true, title: true, status: true } } },
    });
    return { briefings: rows.map((r) => this.shape(r)) };
  }

  /** Standing context for one person — what the agent reads before it replies to them. */
  async contextFor(contactId: string, limit = 5): Promise<string> {
    const rows = await this.prisma.briefing.findMany({ where: { contactId }, orderBy: { createdAt: 'desc' }, take: limit });
    if (!rows.length) return '';
    return rows
      .map((r) => `[${r.createdAt.toISOString().slice(0, 10)}] ${r.rawText}`)
      .join('\n\n');
  }

  /**
   * Edit the wording of a briefing. Deliberately does NOT re-create tasks — fixing a typo in the
   * story must never silently duplicate someone's workload.
   */
  async update(id: string, patch: { rawText?: string; summary?: string }) {
    const cur = await this.prisma.briefing.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Briefing not found');
    const data: any = {};
    if (patch.rawText !== undefined) {
      const t = String(patch.rawText || '').trim();
      if (!t) throw new BadRequestException('A briefing needs some words');
      data.rawText = t.slice(0, 8000);
    }
    if (patch.summary !== undefined) data.summary = String(patch.summary || '').trim().slice(0, 200) || null;
    const row = await this.prisma.briefing.update({ where: { id }, data, include: { tasks: { select: { id: true, title: true, status: true } } } });
    this.memory.indexBriefing(id).catch(() => undefined); // edited words, refreshed doc (BEA-1031)
    return this.shape(row);
  }

  /** Delete a briefing. The tasks it created SURVIVE — they are real work, not part of the note. */
  async remove(id: string) {
    const cur = await this.prisma.briefing.findUnique({ where: { id }, include: { tasks: { select: { id: true } } } });
    if (!cur) throw new NotFoundException('Briefing not found');
    await this.memory.deleteDoc((cur as any).supermemoryId, (cur as any).ragId).catch(() => undefined); // (BEA-1031)
    await this.prisma.briefing.delete({ where: { id } }); // Task.briefingId is cleared, tasks stay
    return { ok: true, keptTasks: cur.tasks.length };
  }

  private shape(b: any) {
    return {
      id: b.id,
      contactId: b.contactId,
      rawText: b.rawText,
      summary: b.summary,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      tasks: (b.tasks || []).map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
      taskCount: (b.tasks || []).length,
      openCount: (b.tasks || []).filter((t: any) => t.status !== 'done').length,
    };
  }
}
