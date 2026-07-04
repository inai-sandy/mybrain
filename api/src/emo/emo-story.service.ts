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

  async mergeToday(): Promise<{ merged: number; storyDay: string }> {
    const day = this.cards.todayKey();
    const { cards: list } = await this.cards.list({ lane: 'story', day, take: 200 });
    const unmerged = list.filter((c) => !this.mergedAlready(c));
    if (!unmerged.length) return { merged: 0, storyDay: day };

    // Append to the existing raw story (read it first) so nothing the user wrote is lost.
    const existing = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    const captureLines = unmerged
      .map((c) => (c.rawTranscript || c.summary || '').trim())
      .filter(Boolean)
      .map((t) => `- ${t}`)
      .join('\n');
    const combined = [existing?.rawText?.trim(), captureLines].filter(Boolean).join('\n');

    // submitStory on TODAY only updates the raw story — it does NOT close the day.
    await this.daily.submitStory(combined, 'emo-captures', undefined, day);

    for (const c of unmerged) {
      await this.cards.update(c.id, { links: [...(c.links || []), { kind: 'story', id: day, label: 'In Day Story' }] }).catch(() => undefined);
    }
    return { merged: unmerged.length, storyDay: day };
  }
}
