import { Injectable, Logger } from '@nestjs/common';

/** What every send here answers: Postbox's synchronous verdict. */
export type SendResult = { wamid: string | null; status: string; error: string | null };

/**
 * My Brain's thin client to the shared Postbox WhatsApp gateway (postbox.1site.ai).
 * Postbox holds the Pinnacle key; we just ask it to send. (BEA-729)
 */
@Injectable()
export class PostboxService {
  private readonly log = new Logger('Postbox');
  private readonly base = (process.env.POSTBOX_URL || 'https://postbox.1site.ai/api').replace(/\/$/, '');
  private readonly key = process.env.POSTBOX_API_KEY || '';
  private readonly template = process.env.POSTBOX_REMINDER_TEMPLATE || 'reminder_nudge_v3';
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
   * The exact text of the approved `reminder_nudge_v3` WhatsApp template, rendered
   * with its two variables. This is the ONE place the reminder-nudge wording
   * lives — the chat window stores what this returns, so the message shown can
   * never drift from what {@link sendReminderTemplate} actually sends.
   *
   * IMPORTANT: this string MUST stay word-for-word identical to the Meta-approved
   * `reminder_nudge_v3` template body. If that template is edited, update this too.
   * (v3 also carries three quick-reply buttons — Done / Still working on it /
   * I'll reply here — which are static and not part of the rendered body text.)
   */
  renderReminderTemplate(firstName: string, subject: string): string {
    return `Hi ${firstName}, I'm following up on behalf of Sandeep about ${subject}. Could you let him know where it stands? A quick tap below is enough.`;
  }

  /** Send the approved reminder template. Returns { wamid, status, error }. */
  /**
   * The multi-task chase (BEA-1041): numbered items, no reply buttons, and the contact's own page
   * behind an "Open my list" button. Falls back to the single-task template upstream if this one
   * is not approved yet — the caller handles that.
   */
  async sendTaskListTemplate(to: string, firstName: string, count: number, list: string, slug: string) {
    return this.sendTemplate(to, process.env.POSTBOX_TASKLIST_TEMPLATE || 'task_list_v1', [firstName, String(count), list], { buttonUrl: slug });
  }

  /**
   * Send ANY approved template by name (BEA-1362). Postbox's `POST /v1/messages/template` takes
   * `{to, template, language, variables, buttonUrl}` — `buttonUrl` is the per-send suffix of a
   * dynamic URL button (the template holds the base). Answers `{wamid, status, error}` from
   * Postbox's own synchronous result: a template send is refused or accepted right here — unlike
   * free text, which Postbox accepts and Meta then fails a few seconds later, out of our sight.
   */
  async sendTemplate(to: string, name: string, variables: string[], opts: { language?: string; buttonUrl?: string } = {}): Promise<SendResult> {
    if (!this.isConfigured()) return { wamid: null, status: 'failed', error: 'Postbox not configured (missing POSTBOX_API_KEY).' };
    try {
      const r = await this.post('/v1/messages/template', {
        to,
        template: name,
        language: opts.language || this.lang,
        variables: variables.map((v) => String(v ?? '')),
        ...(opts.buttonUrl ? { buttonUrl: opts.buttonUrl } : {}),
      });
      // Postbox returns { id, status, wamid, error }
      return { wamid: r?.wamid || null, status: r?.status || 'sent', error: r?.error || null };
    } catch (e: any) {
      this.log.warn(`sendTemplate(${name}) -> ${e?.message}`);
      return { wamid: null, status: 'failed', error: e?.message || 'send failed' };
    }
  }

  /**
   * What the multi-task template reads like — stored in the chat thread as the outbound body.
   * The real WhatsApp message carries the page as a BUTTON; buttons don't exist in our thread
   * mirror, so the link is written out as a line — otherwise the app makes it look like the link
   * never went. (BEA-1042)
   */
  renderTaskListTemplate(firstName: string, count: number, list: string, slug?: string): string {
    const btn = slug && slug !== 'unavailable' ? `\n🔗 Open my list: https://mybrain.1site.ai/t/${slug}` : '';
    return `Hi ${firstName}, following up on behalf of Sandeep — ${count} things are pending with him: ${list}. Just reply here with where things stand.${btn}`;
  }

  /**
   * The chase as a PLAIN chat message, for when the contact has replied within WhatsApp's 24h
   * session window. The owner's call (BEA-1045): someone who answered in the morning must still be
   * chased in the evening — but re-firing the formal template at a person who is already talking
   * to us reads robotic. Inside an open session free text is allowed, so ask like a human would.
   * Sent via {@link sendText}; this is the one place the wording lives.
   */
  renderProgressNudge(firstName: string, count: number, listOrSubject: string, slug?: string | null, updatesTab?: boolean): string {
    if (count <= 1) {
      // A recurring chase carries the Updates tab (BEA-1217): the structured section on their page
      // is where the day's update belongs, so the nudge hands them the door, not just the question.
      const link = updatesTab && slug && slug !== 'unavailable' ? `\n📝 Fill today's update here: https://mybrain.1site.ai/t/${slug}?tab=updates` : '';
      return `Hi ${firstName}, checking in again about ${listOrSubject} — how is it going? Even a quick line on where it stands helps.${link}`;
    }
    const link = slug && slug !== 'unavailable'
      ? `\n🔗 Your list: https://mybrain.1site.ai/t/${slug}${updatesTab ? '?tab=updates' : ''}`
      : '';
    return `Hi ${firstName}, checking in again — ${count} things are still pending with Sandeep: ${listOrSubject}. How are they coming along? A quick line on each is enough.${link}`;
  }

  async sendReminderTemplate(to: string, firstName: string, subject: string) {
    return this.sendTemplate(to, this.template, [firstName, subject]);
  }

  /**
   * Free-text reply inside the 24h window (used by the two-way agent, C2).
   *
   * Careful: Postbox answers `sent` as soon as it has handed the text to Meta; outside the 24-hour
   * window Meta fails it a few seconds LATER ("Re-engagement message"), and that never comes back
   * here. Anything bound for the OWNER must go through `sendOwnerAlert()` (owner-alert.ts), which
   * sends the approved template first. (BEA-1362)
   */
  async sendText(to: string, body: string): Promise<SendResult> {
    if (!this.isConfigured()) return { wamid: null, status: 'failed', error: 'Postbox not configured.' };
    try {
      const r = await this.post('/v1/messages/text', { to, body });
      return { wamid: r?.wamid || null, status: r?.status || 'sent', error: r?.error || null };
    } catch (e: any) {
      return { wamid: null, status: 'failed', error: e?.message || 'send failed' };
    }
  }

  /**
   * A pickable list — one tappable row per choice, each carrying an id. (BEA-1302)
   *
   * The row id comes back on the tap, so the answer needs no interpreting. Only deliverable inside
   * the 24-hour window; Postbox refuses outside it rather than pretending to send, and that refusal
   * arrives here as `status: 'failed'` with a reason the caller can act on.
   */
  async sendList(
    to: string,
    msg: { header?: string; body: string; footer?: string; buttonText?: string; rows: { id: string; title: string; description?: string }[] },
  ) {
    if (!this.isConfigured()) return { wamid: null, status: 'failed', error: 'Postbox not configured.' };
    try {
      const r = await this.post('/v1/messages/list', { to, ...msg });
      return { wamid: r?.wamid || null, status: r?.status || 'sent', error: r?.error || null };
    } catch (e: any) {
      return { wamid: null, status: 'failed', error: e?.message || 'send failed' };
    }
  }
}
