import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { GoogleService } from './google.service';
import { MemoryService } from '../memory/memory.service';
import { EmailMemoryService } from './email-memory.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const BRIEF_AT = '23:58'; // 11:58 PM local — write today's email brief
const BRIEF_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

type BriefItem = { from: string; subject: string; time: string; threadId?: string };
type BriefSection = { heading: string; points: string[]; link: string | null; threadId?: string };
export type Brief = { day: string; unread: number | null; overview: string; summary: string | null; sections: BriefSection[]; items: BriefItem[]; generated: boolean; generatedAt: string | null };

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
    private readonly memory: MemoryService,
    private readonly emailMemory: EmailMemoryService,
  ) {}

  /** Index the day's brief into Explore (mandatory section). (BEA-336) */
  private indexBrief(row: any): void {
    if (!row?.day) return;
    const content = `Daily Email Brief — ${row.day}\n\n${row.summary || ''}`;
    if (!row.summary) return;
    this.memory
      .indexEntity({
        refType: 'gmailbrief',
        refId: row.day,
        title: `Daily Email Brief ${row.day}`,
        content,
        tags: ['email', 'brief', 'activity'],
        prevSupermemoryId: row.supermemoryId,
        prevRagId: row.ragId,
      })
      .catch(() => undefined);
  }

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

  // ---- engine picker (own model; defaults to Sonnet, can run free on Codex/Gemini) ----
  async briefModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'gmailbrief.llm' } });
    if (row) {
      try {
        const v = JSON.parse(row.value);
        if (v?.provider && v?.model) return v;
      } catch {
        /* ignore */
      }
    }
    return BRIEF_MODEL;
  }
  async setBriefModel(provider: string, model: string): Promise<LlmConfig> {
    const cfg = this.llm.agentConfig(provider, model);
    await this.setSetting('gmailbrief.llm', JSON.stringify(cfg));
    return cfg;
  }
  async listModels() {
    return this.llm.listOpenRouterModels(['openai/', 'anthropic/']);
  }

  /** Once past 11:58 PM local, write today's brief if it isn't done. If that window was missed
   *  (restart), backfill yesterday's the next day so the history has no gaps. */
  async briefTick(): Promise<void> {
    const st = await this.google.status();
    if (!st.connected) return;
    const tz = await this.tz();
    const today = this.dayKey(tz);
    // Catch-up: index any complete PAST-day brief that isn't linked yet (covers mid-day-only builds,
    // missed nights, downtime). Runs before the nightly-generate branch so its early returns don't skip it. (BEA-343)
    await this.finalizeRecentBriefs(today).catch(() => undefined);
    if (this.localHM(tz) >= BRIEF_AT) {
      // Nightly: build the FULL brief once and push. A midday on-demand build may already have
      // created a partial row for today; that used to make this return early, so the night's full
      // brief never ran and the Telegram push never fired. Regenerate (force) and push, guarded by a
      // self-contained marker so we don't rebuild/re-push every minute after 23:58. (BEA-803)
      const doneDay = (await this.prisma.setting.findUnique({ where: { key: 'gmailbrief.nightlyDone' } }).catch(() => null))?.value;
      if (doneDay === today) return;
      await this.generate(today, true, true).catch((e) => this.log.warn(`brief ${today}: ${e?.message || e}`));
      await this.setSetting('gmailbrief.nightlyDone', today).catch(() => undefined);
    } else {
      const y = this.dayAdd(today, -1);
      if (await this.prisma.gmailBrief.findUnique({ where: { day: y } })) return;
      await this.generate(y, false, true).catch(() => undefined);
    }
  }

  /** Index complete PAST-day briefs (last 3 days) that aren't linked yet. Idempotent — only fires while
   *  a day's brief is unlinked, so it stops once indexed. The safety-net for the night-only rule. (BEA-343) */
  private async finalizeRecentBriefs(today: string): Promise<void> {
    for (let i = 1; i <= 3; i++) {
      const d = this.dayAdd(today, -i);
      const row = await this.prisma.gmailBrief.findUnique({ where: { day: d } });
      if (row && row.summary && (!row.ragId || !row.supermemoryId)) this.indexBrief(row);
    }
  }

  private shape(row: any): Brief {
    let items: BriefItem[] = [];
    let sections: BriefSection[] = [];
    try {
      items = row.items ? JSON.parse(row.items) : [];
    } catch {
      items = [];
    }
    try {
      sections = row.sections ? JSON.parse(row.sections) : [];
    } catch {
      sections = [];
    }
    // Overview = the lead sentence before the first section in the stored summary.
    const sum = String(row.summary || '');
    const cut = sum.indexOf('\n\n**');
    const overview = sections.length ? (cut > 0 ? sum.slice(0, cut).trim() : '') : sum.trim();
    return { day: row.day, unread: row.unread, overview, summary: row.summary || null, sections, items, generated: true, generatedAt: row.generatedAt };
  }

  /** Read a day's brief. Returns the stored one, or (for a day with none yet) a live unread count
   *  with no summary — the caller can then trigger generate() for an on-demand build. */
  async getForDay(day: string): Promise<Brief> {
    const row = await this.prisma.gmailBrief.findUnique({ where: { day } });
    if (row) return this.shape(row);
    const unread = await this.google.gmailDayUnread(day).catch(() => null);
    return { day, unread, overview: '', summary: null, sections: [], items: [], generated: false, generatedAt: null };
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
      this.google.gmailImportantForDay(day, 25).catch(() => [] as { id: string; threadId: string; from: string; subject: string; date: string; snippet: string }[]),
    ]);

    const items: BriefItem[] = emails.map((e) => ({ from: cleanFrom(e.from), subject: e.subject, time: e.date, threadId: e.threadId }));
    let summary: string;
    let sections: BriefSection[] = [];
    let briefModelUsed = BRIEF_MODEL.model;
    if (!emails.length) {
      summary = 'No important emails today — just promotions and newsletters, which were skipped.';
    } else {
      const lines = emails.map((e, i) => `${i + 1}. From: ${cleanFrom(e.from)} — ${e.subject}\n   ${(e.snippet || '').slice(0, 200)}`).join('\n');
      const prompt =
        `You are writing a short end-of-day email brief for the owner of this inbox. Promotions/social/newsletter emails are already removed.\n\n` +
        `Return ONLY JSON (no prose, no code fences), shaped exactly:\n` +
        `{"overview":"one short sentence on the overall picture","sections":[{"heading":"short topic or sender","points":["concise point","another"],"emails":[1,3]}]}\n\n` +
        `Rules:\n` +
        `- Group the emails into a few clear topics. Each section: a short heading, 1–4 concise points, and "emails" = the NUMBERS (from the list) the section is based on.\n` +
        `- In points you may use **bold** for names, companies, amounts, dates. Prefix anything needing a reply with "Action:".\n` +
        `- Keep it brief and skimmable. Write in simple, plain, everyday English — short words and short sentences, no fancy words.\n\n` +
        `=== IMPORTANT EMAILS ON ${day} (${emails.length}) ===\n${lines}`;
      const res = await this.llm.completeWithModel(await this.briefModel(), prompt, 1200, 'gmail-brief');
      const raw = (res.text || '').trim();
      briefModelUsed = res.model || briefModelUsed;
      let overview = '';
      try {
        const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        overview = String(json?.overview || '').trim();
        if (Array.isArray(json?.sections)) {
          sections = json.sections
            .map((s: any) => {
              const heading = String(s?.heading || '').trim().slice(0, 120);
              const points = Array.isArray(s?.points) ? s.points.map((p: any) => String(p || '').trim()).filter(Boolean).slice(0, 8) : [];
              const idxs = Array.isArray(s?.emails) ? s.emails.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= emails.length) : [];
              const tid = idxs.length ? emails[idxs[0] - 1]?.threadId : null;
              const link = tid ? `https://mail.google.com/mail/u/0/#all/${tid}` : null;
              return heading && points.length ? { heading, points, link, threadId: tid || undefined } : null;
            })
            .filter(Boolean) as BriefSection[];
        }
      } catch {
        sections = [];
      }
      // Plain-markdown summary kept for the Telegram push + memory + the legacy/fallback render.
      summary =
        (overview ? overview + '\n\n' : '') +
        (sections.length ? sections.map((s) => `**${s.heading}**\n${s.points.map((p) => `- ${p}`).join('\n')}`).join('\n\n') : `${emails.length} important email(s) today.`);
    }

    const row = await this.prisma.gmailBrief.upsert({
      where: { day },
      create: { day, unread: unread ?? 0, summary, sections: JSON.stringify(sections), items: JSON.stringify(items), model: briefModelUsed },
      update: { unread: unread ?? 0, summary, sections: JSON.stringify(sections), items: JSON.stringify(items), model: briefModelUsed },
    });
    // Index only a FINALIZED brief — the nightly build (push), or a PAST day (already complete).
    // A partial mid-day on-open build of TODAY's brief is NOT indexed; tonight's finalize handles it. (BEA-343)
    const todayKey = this.dayKey(await this.tz());
    if (push || day < todayKey) {
      this.indexBrief(row);
      // Also store each important email itself (full body) in memory — same finalize gate. (BEA-439)
      void this.emailMemory.syncDay(day, emails).catch(() => undefined);
    }
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
