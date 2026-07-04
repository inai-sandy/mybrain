import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { TasksService } from '../tasks/tasks.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-868) — the Meetings lane. A "meeting" card → a structured meeting card: a summary (key
 * points + decisions) on top, action items pulled out and auto-created as Tasks, and the full
 * transcript below. NOTE: browser recordings aren't stored (BEA-874), so speaker diarization
 * (Speaker 1/2…) arrives with the dedicated meeting-record mode / the Emo device; here we work from
 * the plain transcript, which still yields the summary + action items (the high-value parts).
 */
@Injectable()
export class EmoMeetingService {
  private readonly log = new Logger('EmoMeeting');
  constructor(
    private readonly llm: LlmService,
    private readonly tasks: TasksService,
    private readonly cards: EmoCardsService,
  ) {}

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'meeting') return;
    const transcript = (card.rawTranscript || '').trim();
    if (!transcript) {
      await this.cards.update(cardId, { status: 'done', summary: 'Empty meeting' });
      return;
    }
    try {
      const raw = await this.llm.complete(
        `Summarise this meeting transcript. Reply ONLY JSON:\n{"summary":"markdown with a **Key points** list and a **Decisions** list","actionItems":["short imperative action items"],"attendees":<approx number of distinct speakers>}\n\nTranscript:\n${transcript.slice(0, 12000)}`,
        1000, 'emo-meeting',
      );
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      const summary = String(j.summary || 'No summary.').trim();
      const actionItems: string[] = Array.isArray(j.actionItems) ? j.actionItems.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
      const attendees = Number.isFinite(j.attendees) ? Number(j.attendees) : null;

      const links: any[] = [];
      for (const item of actionItems) {
        const t = await this.tasks.create({ title: item, category: 'Meeting' }).catch(() => null);
        if (t) links.push({ kind: 'task', id: t.id, label: item.slice(0, 60) });
      }

      const detail = [
        summary,
        links.length ? `\n**Action items → Tasks (${links.length}):**\n${actionItems.map((a) => `- ${a}`).join('\n')}` : '',
        attendees ? `\n_Attendees (approx): ${attendees}_` : '',
        `\n_Speaker labels (Speaker 1/2…) come with the Emo device / meeting-record mode._`,
        `\n\n---\n### Transcript\n${transcript}`,
      ].filter(Boolean).join('\n');

      await this.cards.update(cardId, {
        summary: links.length ? `Meeting — ${links.length} action item${links.length === 1 ? '' : 's'}` : 'Meeting summary',
        detail,
        links,
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`meeting lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'done', error: String(e?.message || e), detail: `Couldn’t summarise the meeting.\n\n---\n### Transcript\n${transcript}` }).catch(() => undefined);
    }
  }
}
