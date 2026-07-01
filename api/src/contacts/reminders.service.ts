import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { ContactsService } from './contacts.service';

/** Default engine for the reminder "Clean up" / draft — a dependable API model (changeable in Settings). */
const REMINDER_FORMAT_DEFAULT: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

/**
 * Spread `count` reminder times evenly across the working day (09:00–16:30 local), as "HH:MM" strings.
 * 1 → [09:00]; 3 → [09:00, 12:45, 16:30]; capped at 5. (BEA-720)
 */
export function spreadTimes(count: number): string[] {
  const n = Math.max(1, Math.min(5, Math.round(count || 1)));
  const startMin = 9 * 60; // 09:00
  const endMin = 16 * 60 + 30; // 16:30
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = n === 1 ? startMin : Math.round(startMin + ((endMin - startMin) * i) / (n - 1));
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

/** Concrete UTC datetimes for today at each HH:MM (used to seed queued sends; tz refined in P4). */
function sendsForToday(times: string[]): Date[] {
  const now = new Date();
  return times.map((t) => {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(now);
    d.setUTCHours(h, m, 0, 0);
    return d;
  });
}

@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly contacts: ContactsService,
  ) {}

  // ---- "Clean up" engine picker (own Settings model; defaults to a reliable API model). (BEA-731) ----

  /** The engine that rewrites reminder messages. Own picker; defaults to Sonnet so it's reliable out of the box. */
  async formatModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'reminder.llm' } });
    if (!row) return REMINDER_FORMAT_DEFAULT;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : REMINDER_FORMAT_DEFAULT;
    } catch {
      return REMINDER_FORMAT_DEFAULT;
    }
  }

  async setFormatModel(provider: string, model: string) {
    const cfg = this.llm.agentConfig(provider, model);
    await this.prisma.setting.upsert({
      where: { key: 'reminder.llm' },
      create: { key: 'reminder.llm', value: JSON.stringify(cfg) },
      update: { value: JSON.stringify(cfg) },
    });
    return cfg;
  }

  listFormatModels() {
    return this.llm.listOpenRouterModels(['anthropic/', 'openai/', 'google/']);
  }

  /** Run the chosen engine with one auto-retry on an empty result — so Clean up rarely no-ops. */
  private async formatComplete(prompt: string, label: string): Promise<string> {
    const cfg = await this.formatModel();
    for (let i = 0; i < 2; i++) {
      const t = await this.llm.completeWith(cfg, prompt, 200, i === 0 ? label : `${label}-retry`).catch(() => null);
      if (t && t.trim()) return t.trim();
    }
    return '';
  }

  /** Suggestions = every OPEN task that names a person (`party`), resolved to a contact (BEA-721). */
  async suggestions() {
    const tasks = await this.prisma.task.findMany({
      where: { status: 'open', AND: [{ party: { not: null } }] },
      orderBy: [{ pinned: 'desc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, title: true, party: true, dueDate: true, pinned: true },
    });
    const withParty = tasks.filter((t) => (t.party || '').trim());
    const activeByTask = new Map<string, boolean>();
    const active = await this.prisma.reminder.findMany({ where: { status: 'active', NOT: { taskId: null } }, select: { taskId: true } });
    active.forEach((r) => r.taskId && activeByTask.set(r.taskId, true));
    const out = [];
    for (const t of withParty) {
      const contact = await this.contacts.findByName(t.party);
      out.push({
        task: { id: t.id, title: t.title, party: t.party, dueDate: t.dueDate, pinned: t.pinned },
        contact: contact || null,
        noNumber: !contact || !contact.whatsappNumber,
        hasActiveReminder: activeByTask.has(t.id),
      });
    }
    return { suggestions: out };
  }

  /**
   * Draft/clean a short reminder message in the user's voice — plain English, human, not a bot (BEA-721).
   * Two modes: reformat the user's own rough words (`userInput`), or draft from a task title.
   */
  async draftMessage(input: { taskId?: string; taskTitle?: string; contactName?: string; userInput?: string }) {
    const who = (input.contactName || 'them').trim();
    const firstName = who.split(' ')[0];

    // Mode 1 — the user typed their own rough words; tidy them into a proper message.
    const raw = input.userInput?.trim();
    if (raw) {
      const prompt = `I want to send a WhatsApp reminder to ${who}. Here are my rough words for what to say:\n\n"${raw}"\n\nRewrite it as the actual message I'd send.\n\nRules:\n- Sound EXACTLY like a real person texting a colleague — warm, friendly, casual. NEVER like a bot or AI.\n- Plain, simple English. Short sentences. 1-2 sentences max.\n- Greet them by first name if it fits. Don't sign off with my name.\n- No emojis unless natural. No "Dear", no formal language.\n- Keep my meaning — don't add anything I didn't ask for.\nReturn ONLY the message text, nothing else.`;
      const text = await this.formatComplete(prompt, 'reminder-format');
      const msg = (text || '').trim().replace(/^["']|["']$/g, '');
      return { message: msg || raw };
    }

    // Mode 2 — no words yet; draft from the linked task.
    let title = input.taskTitle?.trim();
    if (!title && input.taskId) {
      const t = await this.prisma.task.findUnique({ where: { id: input.taskId }, select: { title: true } }).catch(() => null);
      title = t?.title;
    }
    if (!title) throw new BadRequestException('Type what you want to say, or link a task, so I can draft the message');
    const prompt = `Write a short WhatsApp message I'd send to ${who} to gently chase this task: "${title}".\n\nRules:\n- Sound EXACTLY like a real person texting a colleague — warm, friendly, casual. NEVER like a bot or AI.\n- Plain, simple English. Short sentences. 1-2 sentences max.\n- Greet them by first name if a name is given. Don't sign off with my name.\n- No emojis unless natural. No "Dear", no formal language.\nReturn ONLY the message text, nothing else.`;
    const text = await this.formatComplete(prompt, 'reminder-draft');
    const msg = (text || '').trim().replace(/^["']|["']$/g, '');
    return { message: msg || `Hi ${firstName}, just checking in on "${title}" — any update when you get a chance?` };
  }

  private parse(s: any): string[] {
    try {
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  }
  private shape(r: any) {
    return { ...r, times: this.parse(r.times) };
  }

  async list(status?: string) {
    const where: any = status ? { status } : {};
    const rows = await this.prisma.reminder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { contact: true, sends: { orderBy: { at: 'asc' } } },
    });
    // join the task title best-effort
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    const tasks = taskIds.length ? await this.prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true, status: true } }) : [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return { reminders: rows.map((r) => ({ ...this.shape(r), task: r.taskId ? taskMap.get(r.taskId) || null : null })) };
  }

  /** Replace a reminder's queued sends with fresh ones for the given times. */
  private async reseed(reminderId: string, times: string[]) {
    await this.prisma.reminderSend.deleteMany({ where: { reminderId, status: 'queued' } });
    const sends = sendsForToday(times);
    if (sends.length) await this.prisma.reminderSend.createMany({ data: sends.map((at) => ({ reminderId, at })) });
  }

  async create(input: { contactId?: string; taskId?: string; message?: string; count?: number }) {
    if (!input.contactId) throw new BadRequestException('Pick a contact');
    const contact = await this.prisma.contact.findUnique({ where: { id: input.contactId } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (!input.message?.trim()) throw new BadRequestException('Write the reminder message');
    const count = Math.max(1, Math.min(5, Math.round(input.count || 1)));
    const times = spreadTimes(count);
    const r = await this.prisma.reminder.create({
      data: { contactId: input.contactId, taskId: input.taskId || null, message: input.message.trim(), count, times: JSON.stringify(times), status: 'active' },
    });
    await this.reseed(r.id, times);
    return this.get(r.id);
  }

  async get(id: string) {
    const r = await this.prisma.reminder.findUnique({ where: { id }, include: { contact: true, sends: { orderBy: { at: 'asc' } } } });
    if (!r) throw new NotFoundException('Reminder not found');
    const task = r.taskId ? await this.prisma.task.findUnique({ where: { id: r.taskId }, select: { id: true, title: true, status: true } }).catch(() => null) : null;
    return { ...this.shape(r), task };
  }

  async update(id: string, patch: { message?: string; count?: number; status?: string }) {
    const cur = await this.prisma.reminder.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Reminder not found');
    const data: any = {};
    if (patch.message !== undefined) {
      if (!patch.message.trim()) throw new BadRequestException('The message cannot be empty');
      data.message = patch.message.trim();
    }
    let times: string[] | null = null;
    if (patch.count !== undefined) {
      const count = Math.max(1, Math.min(5, Math.round(patch.count)));
      data.count = count;
      times = spreadTimes(count);
      data.times = JSON.stringify(times);
    }
    if (patch.status !== undefined && ['active', 'paused', 'done', 'stopped'].includes(patch.status)) data.status = patch.status;
    await this.prisma.reminder.update({ where: { id }, data });
    // Keep today's queued sends in sync with the reminder's state.
    const targetStatus: string = data.status ?? cur.status;
    if (targetStatus === 'active') {
      // active (incl. resuming or a count change) → make sure today's sends are queued
      await this.reseed(id, times || this.parse(cur.times));
    } else {
      // paused / stopped / done → clear any still-queued sends so nothing goes out
      await this.prisma.reminderSend.deleteMany({ where: { reminderId: id, status: 'queued' } });
    }
    return this.get(id);
  }

  /** Pause = reversible off switch: keep the reminder, hold today's sends (BEA-720). */
  async pause(id: string) {
    return this.update(id, { status: 'paused' });
  }

  /** Resume a paused reminder — re-queue today's sends. */
  async resume(id: string) {
    return this.update(id, { status: 'active' });
  }

  async stop(id: string) {
    return this.update(id, { status: 'stopped' });
  }

  async remove(id: string) {
    await this.prisma.reminder.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Reminder not found');
    });
    return { ok: true };
  }
}
