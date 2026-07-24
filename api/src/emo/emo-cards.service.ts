import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type EmoLane = 'search' | 'story' | 'reminder' | 'task' | 'meeting' | 'research' | 'note' | 'talk' | 'close' | 'brief' | 'idea' | 'agent';
export type EmoStatus = 'done' | 'cooking' | 'needs_you';
export type EmoLink = { kind: string; id: string; label?: string };

export interface CreateEmoCard {
  lane: EmoLane;
  status?: EmoStatus;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  links?: EmoLink[];
  needsQuestion?: string | null;
  needsOptions?: string[];
  source?: string;
  day?: string;
  rawTranscript?: string | null;
  audioPath?: string | null;
  sources?: any[];
}

/**
 * EMO (BEA-861) — storage for the "receipt" cards every voice capture files into. Thin: the card
 * carries the recording + transcript + a one-line summary and LINKS to the real object; it is not a
 * second copy of your data. The "answer-later" clarify (Needs-you) lives on the card.
 */
@Injectable()
export class EmoCardsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The user's configured timezone (matches DailyService — the one source of truth for "today"). */
  private async tz(): Promise<string> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } });
      return ((row as any)?.value || '').trim() || 'Asia/Kolkata';
    } catch { return 'Asia/Kolkata'; }
  }

  /** The current day key in the user's timezone. Powers "Today's Captures". Reused, not a hardcoded offset. (BEA-878) */
  async todayKey(): Promise<string> {
    const tz = await this.tz();
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  /** Which day a STORY belongs to (BEA-981): before noon, a still-open yesterday — the "told the
   *  next morning" case. After noon, or once yesterday is closed, it's today's. Capped at exactly
   *  one day back so an older stale open day never attracts a fresh story. Story lane only. */
  async storyDay(): Promise<string> {
    const today = await this.todayKey();
    const tz = await this.tz();
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (!(hour >= 0 && hour < 12)) return today;
    const [y, m, d] = today.split('-').map(Number);
    const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
    const closed = await this.prisma.dayClose.findUnique({ where: { day: yesterday } }).catch(() => null);
    return closed ? today : yesterday;
  }

  private parse<T>(s: string | null | undefined, fallback: T): T {
    try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
  }

  /** Shape a row for the API: JSON fields parsed. */
  shape(r: any) {
    return {
      id: r.id,
      lane: r.lane,
      status: r.status,
      title: r.title,
      summary: r.summary,
      detail: r.detail,
      links: this.parse<EmoLink[]>(r.links, []),
      sources: this.parse<any[]>(r.sources, []),
      needsQuestion: r.needsQuestion,
      needsOptions: this.parse<string[]>(r.needsOptions, []),
      needsAnswer: r.needsAnswer,
      source: r.source,
      contactId: r.contactId || null,
      day: r.day,
      rawTranscript: r.rawTranscript,
      audioPath: r.audioPath,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async create(input: CreateEmoCard) {
    const row = await this.prisma.emoCard.create({
      data: {
        lane: input.lane,
        status: input.status ?? 'cooking',
        title: input.title ?? null,
        summary: input.summary ?? null,
        detail: input.detail ?? null,
        links: JSON.stringify(input.links ?? []),
        sources: JSON.stringify(input.sources ?? []),
        needsQuestion: input.needsQuestion ?? null,
        needsOptions: JSON.stringify(input.needsOptions ?? []),
        source: input.source ?? 'emo',
        day: input.day ?? (await this.todayKey()),
        rawTranscript: input.rawTranscript ?? null,
        audioPath: input.audioPath ?? null,
      },
    });
    return this.shape(row);
  }

  /** Feed query — newest first, optional filters. The UI does the day/Today's-Captures grouping. */
  async list(opts: { status?: EmoStatus; lane?: EmoLane; day?: string; contactId?: string; take?: number; skip?: number } = {}) {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.lane) where.lane = opts.lane;
    if (opts.day) where.day = opts.day;
    if (opts.contactId) where.contactId = opts.contactId; // everything EMO did about one person (BEA-1034)
    const take = Math.min(200, Math.max(1, opts.take ?? 50));
    const [rows, total] = await Promise.all([
      this.prisma.emoCard.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(0, opts.skip ?? 0) }),
      this.prisma.emoCard.count({ where }),
    ]);
    return { cards: rows.map((r) => this.shape(r)), total };
  }

  /** Counts for the attention strip (Needs you / Cooking). */
  async counts() {
    const [needsYou, cooking] = await Promise.all([
      this.prisma.emoCard.count({ where: { status: 'needs_you' } }),
      this.prisma.emoCard.count({ where: { status: 'cooking' } }),
    ]);
    return { needsYou, cooking };
  }

  async get(id: string) {
    const r = await this.prisma.emoCard.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Card not found');
    return this.shape(r);
  }

  async update(id: string, patch: Partial<{ status: EmoStatus; title: string | null; summary: string | null; detail: string | null; links: EmoLink[]; sources: any[]; needsQuestion: string | null; needsOptions: string[]; needsAnswer: string | null; error: string | null; rawTranscript: string | null; contactId: string | null }>) {
    const exists = await this.prisma.emoCard.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Card not found');
    const data: any = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.contactId !== undefined) data.contactId = patch.contactId; // (BEA-1034)
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.summary !== undefined) data.summary = patch.summary;
    if (patch.detail !== undefined) data.detail = patch.detail;
    if (patch.rawTranscript !== undefined) data.rawTranscript = patch.rawTranscript;
    if (patch.links !== undefined) data.links = JSON.stringify(patch.links);
    if (patch.sources !== undefined) data.sources = JSON.stringify(patch.sources);
    if (patch.needsQuestion !== undefined) data.needsQuestion = patch.needsQuestion;
    if (patch.needsOptions !== undefined) data.needsOptions = JSON.stringify(patch.needsOptions);
    if (patch.needsAnswer !== undefined) data.needsAnswer = patch.needsAnswer;
    if (patch.error !== undefined) data.error = patch.error;
    const row = await this.prisma.emoCard.update({ where: { id }, data });
    return this.shape(row);
  }

  /** Record the owner's answer to a Needs-you card and hand it back to its lane (status → cooking). */
  async answer(id: string, answer: string) {
    const r = await this.prisma.emoCard.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Card not found');
    if (r.status !== 'needs_you') return { ok: false, message: 'This card is not waiting for an answer.' };
    const row = await this.prisma.emoCard.update({ where: { id }, data: { needsAnswer: String(answer ?? ''), status: 'cooking' } });
    return { ok: true, card: this.shape(row) };
  }

  async remove(id: string) {
    const exists = await this.prisma.emoCard.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Card not found');
    await this.prisma.emoCard.delete({ where: { id } });
    return { ok: true };
  }
}
