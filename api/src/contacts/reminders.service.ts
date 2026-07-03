import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { ContactsService } from './contacts.service';
import { PostboxService } from './postbox.service';

/** Default engine for the reminder "Clean up" / draft — a dependable API model (changeable in Settings). */
const REMINDER_FORMAT_DEFAULT: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

/** Verbs that mark a subject as a task/command sentence rather than a clean topic. (BEA-754) */
const COMMAND_LEAD =
  /^(tell|ask|remind|instruct|get|follow[\s-]?up(\s+with)?|check(\s+with)?|nudge|inform|make sure|have|let|chase|push|ping|discuss|share|send|create|prepare|arrange|coordinate|confirm|collect|provide|review|update|finali[sz]e|schedule|organi[sz]e|complete|submit|upload|call|email|message|escalate|clarify|sort out|figure out)\b/i;

/**
 * A reminder subject fills "a gentle reminder about ___", so it must read as a
 * thing ("the socket pins"), not a command ("Ask Srikar to report on socket pins").
 * True when the subject is phrased as an instruction and needs cleaning. (BEA-754)
 */
export function looksCommandLike(subject: string): boolean {
  return COMMAND_LEAD.test((subject || '').trim());
}

/**
 * Deterministic fallback used only when the AI cleaner is unavailable: strip a
 * leading "Tell <Name> to " / "Follow up with <Name> on " command clause so the
 * subject at least stops repeating the instruction. (BEA-754)
 */
export function stripCommandLead(subject: string): string {
  const s = (subject || '').trim();
  const stripped = s.replace(
    /^(tell|ask|remind|instruct|get|follow[\s-]?up(\s+with)?|check(\s+with)?|nudge|inform|make sure|have|let|chase|push|ping)\s+(\S+\s+)?(to|about|on|for|that|regarding|re)\s+/i,
    '',
  );
  return stripped !== s && stripped.trim() ? stripped.trim() : s;
}

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

/**
 * Clean a user-chosen list of "HH:MM" send times: keep only valid 24h times,
 * zero-pad, de-duplicate, sort ascending, cap at 5. Returns [] if none valid
 * (caller then falls back to spreadTimes). (BEA-755)
 */
export function sanitizeTimes(times: unknown): string[] {
  if (!Array.isArray(times)) return [];
  const seen = new Set<string>();
  for (const raw of times) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
    if (!m) continue;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    seen.add(`${String(h).padStart(2, '0')}:${m[2]}`);
  }
  return [...seen].sort().slice(0, 5);
}

/** The user's timezone offset in minutes east of UTC (IST = +330). Configurable. (BEA-734) */
export const REMINDER_TZ_OFFSET = Number(process.env.REMINDER_TZ_OFFSET_MINUTES) || 330;

/**
 * Turn "HH:MM" LOCAL times (in the user's tz) into concrete UTC datetimes for today.
 * e.g. "09:00" IST → today 03:30 UTC. Slots already >2 min in the past are skipped
 * (so a reminder made after a slot doesn't fire that missed nudge immediately). Pure/testable. (BEA-734)
 */
export function localTimesToUtc(times: string[], now: Date, offsetMin = REMINDER_TZ_OFFSET): Date[] {
  const local = new Date(now.getTime() + offsetMin * 60000); // shift into the local calendar day
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const da = local.getUTCDate();
  const out: Date[] = [];
  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    const utc = new Date(Date.UTC(y, mo, da, h, m, 0, 0) - offsetMin * 60000);
    if (utc.getTime() < now.getTime() - 120000) continue; // already >2 min past → skip
    out.push(utc);
  }
  return out;
}

/** Concrete UTC datetimes for today at each local HH:MM (used to seed queued sends). */
/**
 * Schedule `times.length` (= count) nudges as concrete UTC datetimes — fixed TOTAL, spilling
 * across days: fill today's still-future slots first, then roll the rest onto the next day(s)
 * at the same daily slot times. So 3 slots made at 4 PM → 1 today + 2 tomorrow. (BEA-740)
 */
export function scheduleNudges(times: string[], now: Date, offsetMin = REMINDER_TZ_OFFSET, maxDays = 7): Date[] {
  const total = times.length;
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const da = local.getUTCDate();
  const out: Date[] = [];
  for (let day = 0; day < maxDays && out.length < total; day++) {
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      const utc = new Date(Date.UTC(y, mo, da + day, h, m, 0, 0) - offsetMin * 60000);
      if (utc.getTime() > now.getTime() - 60000) out.push(utc); // strictly future (60s grace)
      if (out.length >= total) break;
    }
  }
  return out;
}

function sendsForToday(times: string[]): Date[] {
  return scheduleNudges(times, new Date());
}

@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly contacts: ContactsService,
    private readonly postbox: PostboxService,
  ) {}

  /** Send a manual message to the contact from the chat window (user takes over). Free-text, 24h-window. (BEA-736) */
  async sendManual(id: string, body: string) {
    const r = await this.prisma.reminder.findUnique({ where: { id }, include: { contact: true } });
    if (!r) throw new NotFoundException('Reminder not found');
    const text = (body || '').trim();
    if (!text) throw new BadRequestException('Type a message');
    const number = (r.contact?.whatsappNumber || '').replace(/[^\d]/g, '');
    if (!number) throw new BadRequestException('This contact has no WhatsApp number');
    if (!this.postbox.isConfigured()) throw new BadRequestException('WhatsApp sending is not connected yet');
    const res = await this.postbox.sendText(number, text);
    if (res.error) {
      // Most common: outside the 24h window (WhatsApp only allows free text within 24h of their last reply).
      throw new BadRequestException(
        /window|session|24|re-?open|outside/i.test(res.error)
          ? "You can only send a free message within 24 hours of their last reply. They'll still get the scheduled reminder — you can chat once they reply."
          : res.error,
      );
    }
    const msg = await this.prisma.reminderMessage.create({
      data: { contactId: r.contactId, reminderId: id, direction: 'out', body: text, wamid: res.wamid || null },
    });
    return { id: msg.id, direction: 'out', body: msg.body, at: msg.createdAt };
  }

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

  /** Run the reminder engine (in the user's voice) with one auto-retry on an empty result. Public so the two-way agent (C2) reuses the same voice + engine. */
  async voiceComplete(prompt: string, label: string, maxTokens = 200): Promise<string> {
    const cfg = await this.formatModel();
    for (let i = 0; i < 2; i++) {
      const t = await this.llm.completeWith(cfg, prompt, maxTokens, i === 0 ? label : `${label}-retry`).catch(() => null);
      if (t && t.trim()) return t.trim();
    }
    return '';
  }

  /** The WhatsApp conversation for a reminder (our nudges + replies) + its captured outcome. (BEA-730) */
  async thread(id: string) {
    const r = await this.prisma.reminder.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, contact: { select: { name: true } } },
    });
    if (!r) throw new NotFoundException('Reminder not found');
    return {
      status: r.status,
      feedback: r.feedback,
      contactName: r.contact?.name || null,
      messages: r.messages.map((m) => ({ id: m.id, direction: m.direction, body: m.body, at: m.createdAt })),
    };
  }

  /**
   * One-tap AI backfill (BEA-738): for open tasks with a blank `party`, pull the person each
   * task is chasing out of its title and save it — so they surface as reminder suggestions.
   * Only fills blanks (never overwrites). Returns how many were scanned/updated.
   */
  async scanTasksForPeople(): Promise<{ scanned: number; updated: number }> {
    const tasks = await this.prisma.task.findMany({
      where: { status: 'open', OR: [{ party: null }, { party: '' }] },
      select: { id: true, title: true },
    });
    if (!tasks.length) return { scanned: 0, updated: 0 };
    const ids = new Set(tasks.map((t) => t.id));
    const list = tasks.map((t) => `${t.id} :: ${t.title}`).join('\n');
    const prompt = `Each line below is a task: "<id> :: <title>". For each, if the task is about following up with / chasing / asking / getting something from a SPECIFIC named person, give that person's name exactly as written. If there's no clear individual (or it's a generic role like "the team"), use null.\n\nTasks:\n${list}\n\nReturn ONLY a JSON array, nothing else: [{"id":"<id>","person":"<name or null>"}]`;
    const raw = await this.voiceComplete(prompt, 'task-people-scan', 1500);
    let arr: any[] = [];
    try {
      const m = raw.match(/\[[\s\S]*\]/);
      arr = m ? JSON.parse(m[0]) : [];
    } catch {
      arr = [];
    }
    let updated = 0;
    for (const item of arr) {
      const id = item?.id;
      const person = String(item?.person ?? '').trim();
      if (!ids.has(id) || !person || person.toLowerCase() === 'null') continue;
      await this.prisma.task.update({ where: { id }, data: { party: person } }).catch(() => undefined);
      updated++;
    }
    return { scanned: tasks.length, updated };
  }

  /** A contact's whole conversation + all their reminder items (open + resolved outcomes). (BEA-742) */
  async contactThread(contactId: string) {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { name: true } });
    const [messages, reminders] = await Promise.all([
      this.prisma.reminderMessage.findMany({ where: { contactId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reminder.findMany({ where: { contactId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      contactName: contact?.name || null,
      messages: messages.map((m) => ({ id: m.id, direction: m.direction, body: m.body, at: m.createdAt })),
      items: reminders.map((r) => ({ id: r.id, subject: r.subject, status: r.status, feedback: r.feedback })),
    };
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
      const prompt = `I want to send a WhatsApp reminder to ${who}. Here are my rough words for what to say:\n\n"${raw}"\n\nRewrite it as the actual message I'd send.\n\nRules:\n- Sound EXACTLY like a real person texting a colleague — warm, friendly, casual. NEVER like a bot or AI.\n- Plain, simple English. Short sentences. 1-2 sentences max.\n- Greet them by first name if it fits. Don't sign off with my name.\n- No emojis unless natural. No "Dear", no formal language.\n- Write in natural, warm Indian English — the everyday way an Indian professional texts a colleague or vendor on WhatsApp (not American-sounding, not stiff/formal, and NOT a caricature).\n- Naturally nudge them to reply with the status/update, woven right into the message the way a real person would (e.g. "…do let me know where it stands when you get a chance"). NEVER add it as a separate line or a robotic "Please reply with the status".\n- Keep my meaning — don't add unrelated points (adding the natural reply-nudge is fine).\nReturn ONLY the message text, nothing else.`;
      const text = await this.voiceComplete(prompt, 'reminder-format');
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
    const prompt = `I want to gently chase this on WhatsApp with ${who}. The task (written for myself) is: "${title}".\n\nGive me TWO things:\n1. "message" — the short WhatsApp message I'd actually send. Warm, natural Indian English, the everyday way an Indian professional texts a colleague/vendor. Plain, 1-2 short sentences, NEVER bot-like. Greet by first name, don't sign off with my name. Naturally woven in: ask them to reply with the status/update (not a robotic "please reply").\n2. "subject" — a SHORT noun phrase (3 to 6 words) naming ONLY the thing I'm chasing, to slot into "a gentle reminder about ___". Strip the verb and the person's name. e.g. task "Instruct Raja to create install & reset videos for the magnetic touch panel" → subject "the magnetic touch panel videos". task "Get the status report from Vijay" → subject "the status report".\n\nReturn ONLY JSON, nothing else: {"message":"<message>","subject":"<subject>"}`;
    const raw2 = await this.voiceComplete(prompt, 'reminder-draft', 400);
    let message = '';
    let subject = '';
    try {
      const m = raw2.match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      message = String(j.message || '').trim().replace(/^["']|["']$/g, '');
      subject = String(j.subject || '').trim().replace(/^["']|["']$/g, '');
    } catch {
      /* fall back below */
    }
    return {
      message: message || `Hi ${firstName}, just checking in on "${title}" — any update when you get a chance?`,
      subject: subject || title,
    };
  }

  /**
   * Turn a task-style subject ("Ask Srikar to report on the socket pins") into a
   * short noun phrase ("the socket pins work") that reads well after
   * "a gentle reminder about ___". Clean subjects pass through untouched; only
   * command-like ones are rewritten (AI, with a deterministic fallback). (BEA-754)
   */
  async cleanSubject(source?: string | null, contactName?: string): Promise<string> {
    const raw = (source || '').trim();
    if (!raw || !looksCommandLike(raw)) return raw;
    const who = (contactName || 'them').trim().split(/\s+/)[0];
    const prompt = `Rewrite this into a SHORT noun phrase (3 to 6 words) naming ONLY the thing being chased, to slot into "a gentle reminder about ___". Strip the leading verb and any person's name. No trailing full stop.\n\nTask: "${raw}"\n\nExamples:\n"Instruct Raja to create install & reset videos for the magnetic touch panel" -> "the magnetic touch panel videos"\n"Get the status report from Vijay" -> "the status report"\n"Follow up with ${who} on the Zigbee dongle testing" -> "the Zigbee dongle testing"\n\nReturn ONLY the phrase, nothing else.`;
    const text = await this.voiceComplete(prompt, 'reminder-subject', 60).catch(() => '');
    const clean = (text || '')
      .split('\n')[0]
      .trim()
      .replace(/^["']|["'.]+$/g, '')
      .trim();
    return clean || stripCommandLead(raw);
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

  /** The user's local day key (YYYY-MM-DD) — reminders live for exactly one such day. (BEA-764) */
  todayKey(): string {
    return new Date(Date.now() + REMINDER_TZ_OFFSET * 60000).toISOString().slice(0, 10);
  }

  /** Replace a reminder's queued sends with fresh ones for today, and (re)arm it for THIS day. (BEA-764) */
  private async reseed(reminderId: string, times: string[]) {
    await this.prisma.reminderSend.deleteMany({ where: { reminderId, status: 'queued' } });
    const sends = sendsForToday(times);
    if (sends.length) await this.prisma.reminderSend.createMany({ data: sends.map((at) => ({ reminderId, at })) });
    await this.prisma.reminder.update({ where: { id: reminderId }, data: { armedDay: this.todayKey(), pausedAuto: false } }).catch(() => undefined);
  }

  /** Re-arm every paused reminder for today (the "Send today's chases" button). (BEA-764) */
  async resumeToday() {
    const paused = await this.prisma.reminder.findMany({ where: { status: 'paused' } });
    let armed = 0;
    for (const r of paused) {
      await this.prisma.reminder.update({ where: { id: r.id }, data: { status: 'active' } });
      await this.reseed(r.id, this.parse(r.times));
      armed++;
    }
    return { armed };
  }

  async create(input: { contactId?: string; taskId?: string; subject?: string; message?: string; count?: number; times?: string[] }) {
    if (!input.contactId) throw new BadRequestException('Pick a contact');
    const contact = await this.prisma.contact.findUnique({ where: { id: input.contactId } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (!input.message?.trim()) throw new BadRequestException('Write the reminder message');
    // Explicit chosen slots (BEA-755) win; else spread `count` across the day (back-compat).
    const chosen = sanitizeTimes(input.times);
    if (input.times !== undefined && chosen.length === 0) throw new BadRequestException('Pick at least one send time');
    const times = chosen.length ? chosen : spreadTimes(Math.max(1, Math.min(5, Math.round(input.count || 1))));
    const count = times.length;
    // Clean a command-like subject ("Ask Srikar to …") into a topic ("the …") so the
    // nudge reads "a gentle reminder about the …", not "about Ask Srikar to …". (BEA-754)
    const subject = (await this.cleanSubject(input.subject, contact.name)) || null;
    const r = await this.prisma.reminder.create({
      data: {
        contactId: input.contactId,
        taskId: input.taskId || null,
        subject,
        message: input.message.trim(),
        count,
        times: JSON.stringify(times),
        status: 'active',
      },
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

  async update(id: string, patch: { subject?: string; message?: string; count?: number; status?: string; times?: string[] }) {
    const cur = await this.prisma.reminder.findUnique({ where: { id }, include: { contact: { select: { name: true } } } });
    if (!cur) throw new NotFoundException('Reminder not found');
    const data: any = {};
    if (patch.subject !== undefined) data.subject = (await this.cleanSubject(patch.subject, cur.contact?.name)) || null;
    if (patch.message !== undefined) {
      if (!patch.message.trim()) throw new BadRequestException('The message cannot be empty');
      data.message = patch.message.trim();
    }
    let times: string[] | null = null;
    if (patch.times !== undefined) {
      // Explicit chosen slots (BEA-755).
      const chosen = sanitizeTimes(patch.times);
      if (chosen.length === 0) throw new BadRequestException('Pick at least one send time');
      times = chosen;
      data.times = JSON.stringify(times);
      data.count = times.length;
    } else if (patch.count !== undefined) {
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
