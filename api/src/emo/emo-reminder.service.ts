import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { ContactsService } from '../contacts/contacts.service';
import { RemindersService } from '../contacts/reminders.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-867) — the Reminders lane. A "reminder" card → a real WhatsApp reminder to a contact
 * (reusing the hardened Contacts/Reminders services). Confidence gate: if the contact or the intent
 * is unclear, the card returns Needs-you rather than guessing — reminders are too important to get
 * wrong silently.
 */
@Injectable()
export class EmoReminderService {
  private readonly log = new Logger('EmoReminder');
  constructor(
    private readonly llm: LlmService,
    private readonly cards: EmoCardsService,
    private readonly contacts: ContactsService,
    private readonly reminders: RemindersService,
  ) {}

  private async extract(text: string): Promise<{ who: string; what: string; when: string }> {
    try {
      const raw = await this.llm.complete(
        `From this spoken reminder, extract JSON {"who":"…","what":"…","when":"…"}.\n- who = the person to nudge on WhatsApp (their name), or "" if it's the user reminding themselves.\n- what = the thing to remind about, as a short topic (strip the verb and the name).\n- when = any timing words ("Friday", "tomorrow 10am"), or "".\nRequest: "${text}"\nReply ONLY JSON.`,
        200, 'emo-reminder-extract',
      );
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      return { who: String(j.who || '').trim(), what: String(j.what || '').trim(), when: String(j.when || '').trim() };
    } catch {
      return { who: '', what: '', when: '' };
    }
  }

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'reminder') return;
    const text = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    try {
      const { who, what, when } = await this.extract(text);
      const person = (card.needsAnswer && !who ? card.needsAnswer : who).trim();

      // Confidence gate — no clear person → ask on the card (reminders nudge a real contact).
      const contact = person ? await this.contacts.findByName(person) : null;
      if (!contact) {
        await this.cards.update(cardId, {
          needsQuestion: person
            ? `I couldn't find "${person}" in your contacts. Who should I remind — and are they saved in Contacts?`
            : 'Who should I remind? (Reminders nudge a person on WhatsApp.)',
          needsOptions: [],
          status: 'needs_you',
        });
        return;
      }
      if (!what) {
        await this.cards.update(cardId, { needsQuestion: `What should I remind ${contact.name} about?`, status: 'needs_you' });
        return;
      }

      const draft = await this.reminders.draftMessage({ contactName: contact.name, userInput: what }).catch(() => ({ message: what }));
      const rem: any = await this.reminders.create({ contactId: contact.id, subject: what, message: draft.message || what, count: 1 });
      const whenBit = when ? ` (${when})` : '';
      await this.cards.update(cardId, {
        summary: `Reminder set: ${contact.name} — ${what}${whenBit}`,
        links: [{ kind: 'reminder', id: rem.id, label: contact.name }],
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`reminder lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn’t set that reminder. Reword it, or set it up in Contacts?', error: String(e?.message || e) }).catch(() => undefined);
    }
  }
}
