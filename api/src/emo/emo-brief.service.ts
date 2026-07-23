import { Injectable, Logger } from '@nestjs/common';
import { EmoCardsService } from './emo-cards.service';
import { BriefingsService } from '../briefings/briefings.service';
import { ContactsService } from '../contacts/contacts.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { looseJsonParse } from '../common/llm-json';

/**
 * Brief a person by voice. (BEA-1032)
 *
 * The task lane is blind to people — "Ramesh needs to finish the GST filing" became a task owned
 * by the owner himself, with the name surviving only as words in the title. And one utterance made
 * exactly one task, so a real briefing could never become several.
 *
 * This lane resolves the person the same careful way the reminder lane already does — and with the
 * same rule: two people with that name means ASK, never guess. Work filed against the wrong person
 * is worse than work not filed at all.
 *
 * Unlike the app's briefing flow there is no review step here: you are speaking, often walking. So
 * the card shows exactly what was created, every task links back, and everything is editable.
 */
@Injectable()
export class EmoBriefService {
  private readonly log = new Logger('EmoBrief');

  constructor(
    private readonly cards: EmoCardsService,
    private readonly briefings: BriefingsService,
    private readonly contacts: ContactsService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  private label(c: any): string {
    const last4 = String(c.whatsappNumber || '').slice(-4);
    return last4 ? `${c.name} (…${last4})` : `${c.name} (#${String(c.id).slice(0, 4)})`;
  }

  /** Pull the person's name out of the spoken briefing — nothing else. */
  private async whoIsIt(text: string): Promise<string> {
    const tmpl = await this.prompts.get('emo.briefWho');
    const prompt = `${tmpl}\n\n${text.slice(0, 2000)}`;
    try {
      const raw = await this.llm.complete(prompt, 60, 'emo-brief-who');
      const out = looseJsonParse(raw);
      return String(out?.who || '').trim();
    } catch {
      return '';
    }
  }

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'brief') return;
    const text = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    if (!text) {
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: "I couldn't hear that — who is it about, and what do they owe you?" });
      return;
    }

    try {
      // If we asked WHO, the typed answer beats the misheard transcript. (same rule as BEA-949)
      const askedWho = /which one|couldn't find|who is this about/i.test(String(card.needsQuestion || ''));
      const spoken = await this.whoIsIt(text);
      const person = ((card.needsAnswer && (askedWho || !spoken)) ? card.needsAnswer : spoken).trim();

      if (!person) {
        await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'Who is this about?', needsOptions: [] });
        return;
      }

      // A tapped option comes back as "Name (…1234)" — match on the leading name.
      const bare = person.replace(/\s*\(.*\)\s*$/, '').trim();
      const matches = await this.contacts.findAllByName(bare);
      if (matches.length === 0) {
        await this.cards.update(cardId, {
          status: 'needs_you',
          needsQuestion: `I couldn't find "${bare}" in your contacts. Who is this for — and are they saved in Contacts?`,
          needsOptions: [],
        });
        return;
      }
      if (matches.length > 1) {
        // Never file someone else's work against the wrong person. (BEA-875 rule)
        await this.cards.update(cardId, {
          status: 'needs_you',
          needsQuestion: `You have ${matches.length} contacts named "${bare}". Which one is this about?`,
          needsOptions: matches.map((c: any) => this.label(c)),
        });
        return;
      }

      const contact: any = matches[0];
      const draft = await this.briefings.draft(contact.id, text);
      if (!draft.tasks.length) {
        await this.cards.update(cardId, { status: 'needs_you', needsQuestion: `I couldn't find anything ${contact.name} needs to do in that. Say it again with the specifics?` });
        return;
      }

      // Spoken briefings are saved straight away — you're talking, often walking, so there is no
      // review sheet. Everything is on the card and editable.
      const saved: any = await this.briefings.create(contact.id, { text, summary: draft.summary, tasks: draft.tasks });
      const tasks = saved?.tasks || [];
      this.log.log(`briefed ${contact.name} by voice: ${tasks.length} task(s)`);

      await this.cards.update(cardId, {
        status: 'done',
        contactId: contact.id, // so this card shows on their page (BEA-1034)
        summary: `Briefed ${contact.name} — ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
        detail: [`**${contact.name}** now owes you:`, ...tasks.map((t: any) => `- ${t.title}`), '', '_Set their chase times on their contact page._'].join('\n'),
        links: [{ kind: 'contact', id: contact.id, label: contact.name }, ...tasks.slice(0, 8).map((t: any) => ({ kind: 'task', id: t.id, label: String(t.title).slice(0, 60) }))],
      });
    } catch (e: any) {
      this.log.warn(`brief lane failed: ${e?.message ?? e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: "I couldn't file that briefing — say it again?", error: String(e?.message ?? e).slice(0, 200) });
    }
  }
}
