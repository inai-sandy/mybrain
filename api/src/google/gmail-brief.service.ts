import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { GoogleService } from './google.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const BRIEF_AT = '23:58'; // 11:58 PM local — write today's email brief
const BRIEF_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

type BriefItem = { from: string; subject: string; time: string };
export type Brief = { day: string; unread: number | null; summary: string | null; items: BriefItem[]; generated: boolean; generatedAt: string | null };

/** Builds the Gmail "Daily Brief": per-day unread count + an AI summary of that day's important emails.
 *  Runs nightly at 11:58 PM local and on first open; pushes the finished brief to Telegram. */
@Injectable()
export class GmailBriefService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(GmailBriefService.name);
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly google: GoogleService,
  ) {}

  onModuleInit() {
    this.tick = setInterval(() => this.briefTick().catch(() => undefined), 60_000);
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

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
  /** Today's local day key (used as the default for the brief endpoints). */
  async today(): Promise<string> {
    return this.dayKey(await this.tz());
  }

  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /** Once past 11:58 PM local, write today's brief if it isn't done. If that window was missed
   *  (restart), backfill yesterday's the next day so the history has no gaps. */
  async briefTick(): Promise<void> {
    const st = await this.google.status();
    if (!st.connected) return;
    const tz = await this.tz();
    const today = this.dayKey(tz);
    if (this.localHM(tz) >= BRIEF_AT) {
      if (await this.prisma.gmailBrief.findUnique({ where: { day: today } })) return;
      await this.generate(today, false, true).catch((e) => this.log.warn(`brief ${today}: ${e?.message || e}`));
    } else {
      const y = this.dayAdd(today, -1);
      if (await this.prisma.gmailBrief.findUnique({ where: { day: y } })) return;
      await this.generate(y, false, true).catch(() => undefined);
    }
  }

  private shape(row: any): Brief {
    let items: BriefItem[] = [];
    try {
      items = row.items ? JSON.parse(row.items) : [];
    } catch {
      items = [];
    }
    return { day: row.day, unread: row.unread, summary: row.summary || null, items, generated: true, generatedAt: row.generatedAt };
  }

  /** Read a day's brief. Returns the stored one, or (for a day with none yet) a live unread count
   *  with no summary — the caller can then trigger generate() for an on-demand build. */
  async getForDay(day: string): Promise<Brief> {
    const row = await this.prisma.gmailBrief.findUnique({ where: { day } });
    if (row) return this.shape(row);
    const unread = await this.google.gmailDayUnread(day).catch(() => null);
    return { day, unread, summary: null, items: [], generated: false, generatedAt: null };
  }

  /** Build (or rebuild) a day's brief: count unread, summarise the day's important emails, store.
   *  Only the nightly run pushes to Telegram (push=true) — on-demand/refresh builds stay silent. */
  async generate(day: string, force = false, push = false): Promise<Brief> {
    if (!force) {
      const existing = await this.prisma.gmailBrief.findUnique({ where: { day } });
      if (existing) return this.shape(existing);
    }
    const [unread, emails] = await Promise.all([
      this.google.gmailDayUnread(day).catch(() => null),
      this.google.gmailImportantForDay(day, 25).catch(() => [] as { from: string; subject: string; date: string; snippet: string }[]),
    ]);

    const items: BriefItem[] = emails.map((e) => ({ from: cleanFrom(e.from), subject: e.subject, time: e.date }));
    let summary: string;
    if (!emails.length) {
      summary = 'No important emails today — just promotions and newsletters, which were skipped.';
    } else {
      const lines = emails.map((e, i) => `${i + 1}. From: ${cleanFrom(e.from)} — ${e.subject}\n   ${(e.snippet || '').slice(0, 200)}`).join('\n');
      const prompt =
        `You are writing a short end-of-day email brief for the owner of this inbox. The promotions, social and newsletter emails have already been removed — everything below is potentially important.\n\n` +
        `Summarise the day's email clearly and briefly:\n` +
        `- Lead with one short sentence on the overall picture.\n` +
        `- Then concise bullet points grouped by topic or sender.\n` +
        `- Call out anything that needs a reply or an action.\n` +
        `- Skip anything that's clearly automated/unimportant even if it slipped through.\n` +
        `Keep it skimmable, plain text, no preamble.\n\n` +
        `=== IMPORTANT EMAILS ON ${day} (${emails.length}) ===\n${lines}`;
      summary = (await this.llm.completeWith(BRIEF_MODEL, prompt, 900, 'gmail-brief'))?.trim() || `${emails.length} important email(s) today.`;
    }

    const row = await this.prisma.gmailBrief.upsert({
      where: { day },
      create: { day, unread: unread ?? 0, summary, items: JSON.stringify(items), model: BRIEF_MODEL.model },
      update: { unread: unread ?? 0, summary, items: JSON.stringify(items), model: BRIEF_MODEL.model },
    });
    // Only the nightly build hands the brief to the Telegram push loop (same mechanism as the Story of the Day).
    if (push) await this.setSetting('telegram.pushGmailBrief', day).catch(() => undefined);
    return this.shape(row);
  }
}

/** "Sandeep K <s@x.com>" → "Sandeep K"; bare address kept as-is. */
function cleanFrom(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<.*>/);
  return (m ? m[1] : from).trim() || from;
}
