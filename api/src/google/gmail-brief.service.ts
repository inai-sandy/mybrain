import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { GoogleWorkspaceService } from './google-workspace.service';
import { MemoryService } from '../memory/memory.service';
import { EmailMemoryService } from './email-memory.service';
import { PromptsService } from '../prompts/prompts.service';
import { EARLY_AT, FINAL_AT } from './gmail-schedule';

const DEFAULT_TZ = 'Asia/Kolkata';
const BRIEF_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };
/** How many of the day's important mails one read takes. */
const DAY_MAX = 25;
/** Settings the two passes leave behind — all per local day. (BEA-1399) */
const EARLY_DONE = 'gmailbrief.earlyDone';
const EARLY_AT_KEY = 'gmailbrief.earlyAt'; // epoch seconds the early read started
const EARLY_METAS = 'gmailbrief.earlyMetas'; // the mails it read, so the final pass re-summarises without re-reading
const FINAL_DONE = 'gmailbrief.nightlyDone';
const CATCHUP_TRIED = 'gmailbrief.catchupTried';

type BriefItem = { from: string; subject: string; time: string; threadId?: string };
type BriefSection = { heading: string; points: string[]; link: string | null; threadId?: string };
export type Brief = { day: string; unread: number | null; overview: string; summary: string | null; sections: BriefSection[]; items: BriefItem[]; generated: boolean; generatedAt: string | null };

/** Builds the Gmail "Daily Brief": per-day unread count + an AI summary of that day's important emails.
 *  Reads Gmail at 21:00 (early brief) and 23:30 (final pass) local and at no other time in the
 *  background; pushes the finished brief to Telegram. A page open never reads Gmail. (BEA-1399) */
@Injectable()
export class GmailBriefService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(GmailBriefService.name);
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly google: GoogleWorkspaceService,
    private readonly memory: MemoryService,
    private readonly emailMemory: EmailMemoryService,
    private readonly prompts: PromptsService,
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

  private async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    return row?.value ? String(row.value) : null;
  }
  /** Seconds since the epoch — a method so a spec can pin the clock. */
  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Gmail is read at two local times a day and at no other time in the background (BEA-1399).
   * The clock is checked FIRST — outside the windows this touches nothing, not even a status
   * probe. 21:00 = the early brief (full read, Telegram, email memory). 23:30 = the final pass:
   * only mail that arrived after the early read, a re-summary and a second push only when
   * something new came; with no early pass behind it (restart) it does the full read. Each
   * window is tried ONCE (the marker is set even when the read fails — a bad night costs one
   * attempt, never one a minute), and a night missed altogether is caught up once the next day.
   */
  async briefTick(): Promise<void> {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const hm = this.localHM(tz);
    // Catch-up: index any complete PAST-day brief that isn't linked yet — database only. (BEA-343)
    await this.finalizeRecentBriefs(today).catch(() => undefined);
    if (hm >= FINAL_AT) {
      if ((await this.getSetting(FINAL_DONE)) === today) return;
      const earlyAt = (await this.getSetting(EARLY_DONE)) === today ? Number(await this.getSetting(EARLY_AT_KEY)) : NaN;
      await this.finalPass(today, Number.isFinite(earlyAt) ? earlyAt : null).catch((e) => this.log.warn(`final brief ${today}: ${e?.message || e}`));
      await this.setSetting(FINAL_DONE, today).catch(() => undefined);
    } else if (hm >= EARLY_AT) {
      if ((await this.getSetting(EARLY_DONE)) === today) return;
      const startedAt = this.nowSeconds();
      await this.earlyPass(today).catch((e) => this.log.warn(`early brief ${today}: ${e?.message || e}`));
      await this.setSetting(EARLY_DONE, today).catch(() => undefined);
      await this.setSetting(EARLY_AT_KEY, String(startedAt)).catch(() => undefined);
    } else {
      if ((await this.getSetting(CATCHUP_TRIED)) === today) return;
      await this.setSetting(CATCHUP_TRIED, today).catch(() => undefined);
      const y = this.dayAdd(today, -1);
      if (await this.prisma.gmailBrief.findUnique({ where: { day: y } })) return;
      await this.generate(y, false, true).catch((e) => this.log.warn(`catch-up brief ${y}: ${e?.message || e}`));
    }
  }

  /** 21:00 — the full read of the day, pushed; the mails are kept for the final pass. */
  private async earlyPass(day: string): Promise<void> {
    await this.google.rememberEmail?.().catch?.(() => null);
    const { unread, emails } = await this.readDay(day);
    await this.setSetting(EARLY_METAS, JSON.stringify(emails)).catch(() => undefined);
    await this.writeBrief(day, unread, emails, { push: true, finalize: true, syncEmails: emails });
  }

  /**
   * 23:30 — with an early pass behind it, read ONLY what arrived after it; nothing new → refresh
   * the unread count and stop (no push, no memory sync); new mail → re-summarise early + new
   * together, push again, sync only the new. No early pass → the full read.
   */
  private async finalPass(day: string, earlyAt: number | null): Promise<void> {
    const row = earlyAt == null ? null : await this.prisma.gmailBrief.findUnique({ where: { day } });
    if (earlyAt == null || !row) {
      await this.generate(day, true, true);
      return;
    }
    let early: GmailMetaLike[] = [];
    try {
      early = JSON.parse((await this.getSetting(EARLY_METAS)) || '[]');
      if (!Array.isArray(early)) early = [];
    } catch {
      early = [];
    }
    const [unread, fresh] = await Promise.all([this.google.gmailDayUnread(day).catch(() => null), this.google.gmailImportantSince(day, earlyAt, DAY_MAX)]);
    if (!fresh.length) {
      if (unread != null) await this.prisma.gmailBrief.update({ where: { day }, data: { unread } }).catch(() => undefined);
      return;
    }
    const seen = new Set(fresh.map((m) => m.id));
    const all = [...fresh, ...early.filter((m) => m?.id && !seen.has(m.id))].slice(0, DAY_MAX * 2);
    await this.writeBrief(day, unread ?? row.unread, all, { push: true, finalize: true, syncEmails: fresh });
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

  /** Read a day's brief — the stored one, or an empty shell for a day with none. Never reads Gmail:
   *  the page shows what the scheduled passes stored, and a Refresh is an explicit, counted call. (BEA-1399) */
  async getForDay(day: string): Promise<Brief> {
    const row = await this.prisma.gmailBrief.findUnique({ where: { day } });
    if (row) return this.shape(row);
    return { day, unread: null, overview: '', summary: null, sections: [], items: [], generated: false, generatedAt: null };
  }

  /** Build (or rebuild) a day's brief: count unread, summarise the day's important emails, store.
   *  Only a scheduled pass pushes to Telegram (push=true) — on-demand/refresh builds stay silent. */
  async generate(day: string, force = false, push = false): Promise<Brief> {
    if (!force) {
      const existing = await this.prisma.gmailBrief.findUnique({ where: { day } });
      if (existing) return this.shape(existing);
    }
    const { unread, emails } = await this.readDay(day);
    const todayKey = this.dayKey(await this.tz());
    const finalize = push || day < todayKey;
    return this.writeBrief(day, unread, emails, { push, finalize, syncEmails: finalize ? emails : [] });
  }

  /** The day's two reads: the unread count (best effort) and the important list — which must succeed,
   *  or the brief would honestly say "no important emails" about a day it never read. */
  private async readDay(day: string): Promise<{ unread: number | null; emails: GmailMetaLike[] }> {
    const [unread, emails] = await Promise.all([this.google.gmailDayUnread(day).catch(() => null), this.google.gmailImportantForDay(day, DAY_MAX)]);
    return { unread, emails };
  }

  /** Summarise + store a day's brief from the mails already read; index/sync/push as asked. */
  private async writeBrief(day: string, unread: number | null, emails: GmailMetaLike[], opts: { push: boolean; finalize: boolean; syncEmails: GmailMetaLike[] }): Promise<Brief> {
    const push = opts.push;
    const items: BriefItem[] = emails.map((e) => ({ from: cleanFrom(e.from), subject: e.subject, time: e.date, threadId: e.threadId }));
    let summary: string;
    let sections: BriefSection[] = [];
    let briefModelUsed = BRIEF_MODEL.model;
    if (!emails.length) {
      summary = 'No important emails today — just promotions and newsletters, which were skipped.';
    } else {
      const lines = emails.map((e, i) => `${i + 1}. From: ${cleanFrom(e.from)} — ${e.subject}\n   ${(e.snippet || '').slice(0, 200)}`).join('\n');
      const tmpl = await this.prompts.get('google.gmailBrief');
      const prompt = `${tmpl}\n\n=== IMPORTANT EMAILS ON ${day} (${emails.length}) ===\n${lines}`;
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
    // Index only a FINALIZED brief — a scheduled pass, or a PAST day (already complete).
    // A partial on-demand build of TODAY's brief is NOT indexed; tonight's pass handles it. (BEA-343)
    if (opts.finalize) {
      this.indexBrief(row);
      // Also store each important email itself (full body) in memory — only the mails this pass read. (BEA-439 / BEA-1399)
      if (opts.syncEmails.length) void this.emailMemory.syncDay(day, opts.syncEmails).catch(() => undefined);
    }
    // Only a scheduled pass hands the brief to the Telegram push loop (same mechanism as the Story of the Day).
    if (push) await this.setSetting('telegram.pushGmailBrief', day).catch(() => undefined);
    return this.shape(row);
  }
}

type GmailMetaLike = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string };

/** "Sandeep K <s@x.com>" → "Sandeep K"; bare address kept as-is. */
function cleanFrom(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<.*>/);
  return (m ? m[1] : from).trim() || from;
}
