import { Injectable, Logger } from '@nestjs/common';
import { IdeasService } from '../ideas/ideas.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-950) — the Ideas lane. An "idea" card → ONE organized Idea via the user's
 * "Ideas organizer" prompt (Settings → Prompts). The organizer also drafts a research
 * prompt and stores it ON the idea — but no research runs; that stays the user's call.
 */
@Injectable()
export class EmoIdeaService {
  private readonly log = new Logger('EmoIdea');
  constructor(
    private readonly ideas: IdeasService,
    private readonly cards: EmoCardsService,
  ) {}

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'idea') return;
    const text = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    try {
      const idea: any = await this.ideas.create(text);
      await this.cards.update(cardId, {
        summary: `Idea saved: ${idea.title}`,
        links: [{ kind: 'idea', id: idea.id, label: (idea.title || '').slice(0, 60) }],
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`idea lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn’t save that idea — try saying it again?', error: String(e?.message || e) }).catch(() => undefined);
    }
  }
}
