import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { TasksService } from '../tasks/tasks.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-866 / BEA-947) — the Tasks lane. One utterance = exactly ONE task (the user's rule).
 * The LLM only cleans the phrasing into a short imperative title; it never splits.
 */
@Injectable()
export class EmoTaskService {
  private readonly log = new Logger('EmoTask');
  constructor(
    private readonly llm: LlmService,
    private readonly tasks: TasksService,
    private readonly cards: EmoCardsService,
  ) {}

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'task') return;
    const text = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    try {
      let title = '';
      try {
        const raw = await this.llm.complete(
          `Turn this spoken request into ONE short imperative task title (max 12 words). Keep names and specifics. Reply ONLY the title.\n"${text}"`,
          60, 'emo-task-title',
        );
        title = (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').slice(0, 140);
      } catch { /* fall back to the raw words */ }
      if (!title) title = text.slice(0, 140);
      if (!title) {
        await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn\u2019t hear a task in that \u2014 say it as a clear to-do?' });
        return;
      }
      const t: any = await this.tasks.create({ title, category: 'Emo' });
      await this.cards.update(cardId, {
        summary: `Task added: ${title}`,
        links: [{ kind: 'task', id: t.id, label: title.slice(0, 60) }],
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`task lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn\u2019t add that task \u2014 reword it and try again?', error: String(e?.message || e) }).catch(() => undefined);
    }
  }
}
