import { Injectable, Logger } from '@nestjs/common';

/**
 * My Brain's thin client to the shared Postbox WhatsApp gateway (postbox.1site.ai).
 * Postbox holds the Pinnacle key; we just ask it to send. (BEA-729)
 */
@Injectable()
export class PostboxService {
  private readonly log = new Logger('Postbox');
  private readonly base = (process.env.POSTBOX_URL || 'https://postbox.1site.ai/api').replace(/\/$/, '');
  private readonly key = process.env.POSTBOX_API_KEY || '';
  private readonly template = process.env.POSTBOX_REMINDER_TEMPLATE || 'reminder_nudge';
  private readonly lang = process.env.POSTBOX_REMINDER_LANG || 'en';

  isConfigured(): boolean {
    return !!this.key;
  }

  /** The API key we expect Postbox to echo back on its callbacks (so we can verify them). */
  get callbackKey(): string {
    return this.key;
  }

  private async post(path: string, body: any): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-postbox-key': this.key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (!res.ok) throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The exact text of the approved `reminder_nudge` WhatsApp template, rendered
   * with its two variables. This is the ONE place the reminder-nudge wording
   * lives — the chat window stores what this returns, so the message shown can
   * never drift from what {@link sendReminderTemplate} actually sends.
   *
   * IMPORTANT: this string MUST stay word-for-word identical to the Meta-approved
   * `reminder_nudge` template body. If that template is edited, update this too.
   */
  renderReminderTemplate(firstName: string, subject: string): string {
    return `Hi ${firstName}, just a gentle reminder about ${subject}. Do let me know where it stands whenever you get a chance. Thanks!`;
  }

  /** Send the approved reminder template. Returns { wamid, status, error }. */
  async sendReminderTemplate(to: string, firstName: string, subject: string) {
    if (!this.isConfigured()) return { wamid: null, status: 'failed', error: 'Postbox not configured (missing POSTBOX_API_KEY).' };
    try {
      const r = await this.post('/v1/messages/template', {
        to,
        template: this.template,
        language: this.lang,
        variables: [firstName, subject],
      });
      // Postbox returns { id, status, wamid, error }
      return { wamid: r?.wamid || null, status: r?.status || 'sent', error: r?.error || null };
    } catch (e: any) {
      this.log.warn(`sendReminderTemplate -> ${e?.message}`);
      return { wamid: null, status: 'failed', error: e?.message || 'send failed' };
    }
  }

  /** Free-text reply inside the 24h window (used by the two-way agent, C2). */
  async sendText(to: string, body: string) {
    if (!this.isConfigured()) return { wamid: null, status: 'failed', error: 'Postbox not configured.' };
    try {
      const r = await this.post('/v1/messages/text', { to, body });
      return { wamid: r?.wamid || null, status: r?.status || 'sent', error: r?.error || null };
    } catch (e: any) {
      return { wamid: null, status: 'failed', error: e?.message || 'send failed' };
    }
  }
}
