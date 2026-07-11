import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly cards: EmoCardsService,
    private readonly contacts: ContactsService,
    private readonly reminders: RemindersService,
  ) {}

  private todayKey(): string {
    return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  }

  private async extract(text: string): Promise<{ who: string; what: string; when: string; startDay: string; time: string; inMinutes: number }> {
    try {
      const raw = await this.llm.complete(
        `Today is ${this.todayKey()} (IST). From this spoken reminder, extract JSON {"who":"…","what":"…","when":"…","startDay":"…","time":"…","inMinutes":0}.\n- who = the person to nudge on WhatsApp (their name), or "" if the user means themselves.\n- what = the thing to remind about, as a short topic (strip the verb and the name).\n- when = the timing words as said ("Friday", "tomorrow 10am"), or "".\n- startDay = if a day OTHER than today is meant, resolve it to a concrete FUTURE date YYYY-MM-DD; else "".\n- time = a specific clock time as HH:mm (24h) if one was said, else "".\n- inMinutes = if a RELATIVE delay was said ("in 10 minutes", "after 2 mins", "in an hour", "in half an hour"), the total minutes as a number; else 0.\nRequest: "${text}"\nReply ONLY JSON.`,
        240, 'emo-reminder-extract',
      );
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      return { who: String(j.who || '').trim(), what: String(j.what || '').trim(), when: String(j.when || '').trim(), startDay: String(j.startDay || '').trim(), time: String(j.time || '').trim(), inMinutes: Number.isFinite(j.inMinutes) ? Math.max(0, Math.round(Number(j.inMinutes))) : 0 };
    } catch {
      return { who: '', what: '', when: '', startDay: '', time: '', inMinutes: 0 };
    }
  }

  /** Human day label for a card, e.g. "Fri 10 Jul". */
  private humanDay(day: string): string {
    try { return new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); } catch { return day; }
  }

  /** A "when" that names a day other than today (day-of-week, tomorrow, next…, a date). */
  private isFutureDay(when: string): boolean {
    const w = when.toLowerCase();
    if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening|noon)\b/.test(w)) return false;
    return /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\btomorrow\b|\bnext\b|\bin \d+\s*(day|week|month)|\b\d{1,2}\s*(st|nd|rd|th)\b|\b\d{1,2}[/-]\d{1,2}\b/.test(w);
  }

  /** A short label to tell same-named contacts apart (by WhatsApp-number tail). */
  private contactLabel(c: any): string {
    const tail = c.whatsappNumber ? `…${String(c.whatsappNumber).slice(-4)}` : `#${String(c.id).slice(0, 4)}`;
    return `${c.name} (${tail})`;
  }

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'reminder') return;
    const text = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    try {
      const { who, what, when, startDay, time, inMinutes } = await this.extract(text);
      // If the question we asked was about WHO, the typed answer beats the misheard transcript. (BEA-949)
      const askedWho = /who should i remind|couldn't find/i.test(String(card.needsQuestion || ''));
      const person = ((card.needsAnswer && (askedWho || !who)) ? card.needsAnswer : who).trim();

      // No person named -> the user means THEMSELVES: a personal reminder that
      // rings on the EMO device (BEA-944). Best-guess timing, never a question.
      if (!person) {
        const now = Date.now();
        const day = /^\d{4}-\d{2}-\d{2}$/.test(startDay) ? startDay : this.todayKey();
        let dueMs: number;
        let assumed = '';
        if (inMinutes > 0) {
          dueMs = now + Math.min(inMinutes, 7 * 24 * 60) * 60000;   /* relative delay wins */
        } else if (/^\d{1,2}:\d{2}$/.test(time)) {
          dueMs = Date.parse(`${day}T${time.padStart(5, '0')}:00+05:30`);
          if (!Number.isFinite(dueMs)) dueMs = now + 2 * 3600 * 1000;
          if (dueMs <= now) dueMs += 24 * 3600 * 1000;   // that time already passed -> tomorrow
        } else {
          dueMs = now + 2 * 3600 * 1000;                 // no time said -> 2h from now, say so
          assumed = ' (no time given — set for 2 hours from now)';
        }
        const say = (what || text).trim();
        const rem = await this.prisma.emoDeviceReminder.create({ data: { text: say, dueAt: new Date(dueMs) } });
        const ist = new Date(dueMs + 330 * 60000).toISOString();
        const dayLabel = ist.slice(0, 10) === this.todayKey() ? 'today' : this.humanDay(ist.slice(0, 10));
        const lead = inMinutes > 0 ? `in ${inMinutes} minute${inMinutes === 1 ? '' : 's'} (${ist.slice(11, 16)})` : `${dayLabel} at ${ist.slice(11, 16)}`;
        await this.cards.update(cardId, {
          summary: `I'll remind you ${lead} — ${say}${assumed}`,
          links: [{ kind: 'device-reminder', id: rem.id, label: 'rings on EMO' }],
          status: 'done',
        });
        return;
      }

      // Confidence gate — resolve the contact, but NEVER guess on ambiguity. (BEA-875)
      const matches = await this.contacts.findAllByName(person);
      if (matches.length === 0) {
        await this.cards.update(cardId, {
          needsQuestion: `I couldn't find "${person}" in your contacts. Who should I remind — and are they saved in Contacts?`,
          needsOptions: [],
          status: 'needs_you',
        });
        return;
      }
      if (matches.length > 1) {
        // Two people share this name → ask which one; never message the wrong one silently.
        await this.cards.update(cardId, {
          needsQuestion: `You have ${matches.length} contacts named "${person}". Which one should I remind?`,
          needsOptions: matches.map((c: any) => this.contactLabel(c)),
          status: 'needs_you',
        });
        return;
      }
      const contact = matches[0];
      if (!what) {
        await this.cards.update(cardId, { needsQuestion: `What should I remind ${contact.name} about?`, status: 'needs_you' });
        return;
      }

      // Future-dated reminders are now supported (BEA-876): if a concrete future day resolved, schedule
      // the nudge for that day. If the words point to another day but we couldn't pin a date, clarify
      // rather than silently sending today — reminders are too important to guess.
      const confirmedToday = /\b(today|now|go ahead|yes)\b/i.test(String(card.needsAnswer || ''));
      const futureDay = /^\d{4}-\d{2}-\d{2}$/.test(startDay) && startDay > this.todayKey() ? startDay : undefined;
      if (!futureDay && when && this.isFutureDay(when) && !confirmedToday) {
        await this.cards.update(cardId, {
          needsQuestion: `You said "${when}" but I couldn't pin the exact day. Which date should I remind ${contact.name}? (Or say "today".)`,
          needsOptions: ['Today'],
          status: 'needs_you',
        });
        return;
      }

      const draft = await this.reminders.draftMessage({ contactName: contact.name, userInput: what }).catch(() => ({ message: what }));
      const times = futureDay ? [/^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '09:00'] : undefined;
      const rem: any = await this.reminders.create({ contactId: contact.id, subject: what, message: draft.message || what, count: 1, times, startDay: futureDay });
      await this.cards.update(cardId, {
        summary: futureDay ? `Reminder set: ${contact.name}, ${this.humanDay(futureDay)} — ${what}` : `Reminder set for today: ${contact.name} — ${what}`,
        links: [{ kind: 'reminder', id: rem.id, label: contact.name }],
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`reminder lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn’t set that reminder. Reword it, or set it up in Contacts?', error: String(e?.message || e) }).catch(() => undefined);
    }
  }
}
