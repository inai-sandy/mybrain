import { Injectable, Logger } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-866) — the Tasks lane. A "task" card → real Task(s) in My Brain Tasks, reusing the
 * hardened brain-dump splitter (auto-split: one recording → several tasks, with title/category/
 * due/estimate). If the dump is too vague the built-in clarity check surfaces on the card (Needs-you).
 */
@Injectable()
export class EmoTaskService {
  private readonly log = new Logger('EmoTask');
  constructor(
    private readonly tasks: TasksService,
    private readonly cards: EmoCardsService,
  ) {}

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'task') return;
    const text = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    try {
      const res: any = await this.tasks.dump(text, 'emo');
      const created: any[] = Array.isArray(res?.tasks) ? res.tasks : [];
      // Vague → ask on the card (reuses the dump clarity check), unless the owner already answered.
      if (res?.question && !created.length && !card.needsAnswer) {
        await this.cards.update(cardId, { needsQuestion: res.question, status: 'needs_you' });
        return;
      }
      if (!created.length) {
        await this.cards.update(cardId, { status: 'done', summary: card.summary || 'Nothing to add' });
        return;
      }
      const links = created.map((t) => ({ kind: 'task', id: t.id, label: (t.title || '').slice(0, 60) }));
      const summary = created.length === 1 ? `Task added: ${created[0].title}` : `${created.length} tasks added`;
      await this.cards.update(cardId, { summary, links, status: 'done' });
    } catch (e: any) {
      this.log.warn(`task lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'done', error: String(e?.message || e), summary: card.summary || 'Couldn’t add the task' }).catch(() => undefined);
    }
  }
}
