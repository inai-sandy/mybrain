import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DailyService } from '../daily/daily.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-865) — the Story lane. Story moments already land in "Today's Captures" (the router files
 * them as terminal story cards). This adds the user-initiated "Merge into Day Story": it APPENDS the
 * day's captures to the existing Story (never overwrites what you wrote) and marks them merged. Emo
 * NEVER closes the day — you review in /today and close yourself.
 */
@Injectable()
export class EmoStoryService {
  private readonly log = new Logger('EmoStory');
  constructor(
    private readonly prisma: PrismaService,
    private readonly daily: DailyService,
    private readonly cards: EmoCardsService,
  ) {}

  private mergedAlready(card: any): boolean {
    return (card.links || []).some((l: any) => l.kind === 'story');
  }

  /** Add ONE story capture to its day's story — the per-card button (BEA-985). Idempotent. */
  async addCard(id: string): Promise<{ ok: boolean; storyDay?: string; message?: string }> {
    const c = await this.cards.get(id);
    if (c.lane !== 'story') return { ok: false, message: 'Only story captures can be added to a story.' };
    if (this.mergedAlready(c)) return { ok: true, storyDay: c.day, message: 'Already in the story.' };
    const today = await this.cards.todayKey();
    const day = c.day || today;
    // Emo never touches a day that is already closed.
    if (day !== today && (await this.daily.isClosed(day).catch(() => false))) return { ok: false, message: 'That day is already closed.' };
    const line = (c.rawTranscript || c.summary || '').trim();
    if (!line) return { ok: false, message: 'This capture has no text to add.' };
    const existing = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    const combined = [existing?.rawText?.trim(), `- ${line}`].filter(Boolean).join('\n');
    // noWrap: Emo NEVER closes the day — the 10:00 check wraps it once the story is in.
    await this.daily.submitStory(combined, 'emo-captures', undefined, day, true);
    await this.cards.update(id, { links: [...(c.links || []), { kind: 'story', id: day, label: 'In Day Story' }] }).catch(() => undefined);
    return { ok: true, storyDay: day };
  }

  async mergeToday(): Promise<{ merged: number; storyDay: string; days: string[] }> {
    const today = await this.cards.todayKey();
    // Each card already carries the day it belongs to — a morning story carries the still-open
    // yesterday (BEA-981). Merge every unmerged capture into ITS day's story, newest day last.
    const { cards: list } = await this.cards.list({ lane: 'story', take: 200 });
    const unmerged = list.filter((c) => c.day && !this.mergedAlready(c));
    const byDay = new Map<string, any[]>();
    for (const c of unmerged) byDay.set(c.day, [...(byDay.get(c.day) || []), c]);

    let merged = 0;
    const days: string[] = [];
    for (const day of [...byDay.keys()].sort()) {
      // Emo never touches a day that is already closed — those captures stay as cards.
      if (day !== today && (await this.daily.isClosed(day).catch(() => false))) continue;
      const group = byDay.get(day)!;

      // Append to the existing raw story (read it first) so nothing the user wrote is lost.
      const existing = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }).catch(() => null);
      const captureLines = group
        .map((c) => (c.rawTranscript || c.summary || '').trim())
        .filter(Boolean)
        .map((t) => `- ${t}`)
        .join('\n');
      const combined = [existing?.rawText?.trim(), captureLines].filter(Boolean).join('\n');

      // noWrap: Emo NEVER closes the day — even a past one. The 10:00 check wraps it once the story is in.
      await this.daily.submitStory(combined, 'emo-captures', undefined, day, true);

      for (const c of group) {
        await this.cards.update(c.id, { links: [...(c.links || []), { kind: 'story', id: day, label: 'In Day Story' }] }).catch(() => undefined);
      }
      merged += group.length;
      days.push(day);
    }
    return { merged, storyDay: days[days.length - 1] || today, days };
  }
}
