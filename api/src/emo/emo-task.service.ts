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
      // Vague FIRST time → ask once on the card (reuses the dump clarity check).
      if (res?.question && !created.length && !card.needsAnswer) {
        await this.cards.update(cardId, { needsQuestion: res.question, status: 'needs_you' });
        return;
      }
      if (!created.length) {
        // Already asked (or nothing parsed) and STILL no task — never discard the user's words. (BEA-877)
        // Capture one best-effort task from the raw text so it's saved and editable.
        const raw = (card.rawTranscript || card.needsAnswer || card.summary || '').trim();
        const t: any = raw ? await this.tasks.create({ title: raw.slice(0, 140), category: 'Emo' }).catch(() => null) : null;
        if (t?.id) {
          await this.cards.update(cardId, { summary: `Task added: ${t.title}`, links: [{ kind: 'task', id: t.id, label: (t.title || '').slice(0, 60) }], status: 'done' });
        } else {
          await this.cards.update(cardId, { status: 'needs_you', needsQuestion: res?.question || 'I couldn’t turn that into a task — can you say it as a clear to-do?' });
        }
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
