import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from '../contacts/postbox.service';
import { OwnerAlertResult, ownerFirstName, sendOwnerAlert } from '../contacts/owner-alert';
import { askDetail } from '../contacts/owner-reply';

const clean = (s: unknown) => String(s || '').trim();

/**
 * What every alert here answers. `sent` + `why` are what the callers always read; `via`, `wamid`,
 * `error` and `note` carry the honest detail for the run step (see `whatsappStepLabel`).
 *  - why: 'off' | 'no number' | 'postbox not configured' | 'cooldown' | 'nothing missed' | <Meta's reason>
 */
export type AlertResult = { sent: boolean; why?: string } & Partial<OwnerAlertResult>;

/**
 * Every WhatsApp message My Brain sends its OWNER (BEA-1071 · BEA-1102 · BEA-1121 · BEA-1144).
 *
 * All of them go through {@link ownerAlert}: the approved `mybrain_update_v1` template FIRST, free
 * text only as an optional second message (BEA-1362). Before that, each sent free text and fell
 * back to a template "if it failed" — which never fired, because Postbox says `sent` before Meta
 * fails a text outside the 24-hour window. 93 owner messages in a row failed that way.
 */
@Injectable()
export class AlertsService {
  private readonly log = new Logger('Alerts');
  /** name → last alert epoch-ms; one failure alert per automation per 30 min. */
  private readonly lastByName = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
  ) {}

  private async setting(key: string): Promise<string | null> {
    const r = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    return (r as any)?.value ?? null;
  }

  /**
   * THE one road to the owner's phone. Checks the switch (when one applies) and the number, then
   * hands the message to `sendOwnerAlert()` — template first. `why` on a refusal is Meta's reason.
   */
  private async ownerAlert(
    msg: { headline: string; detail?: string; path: string; longBody?: string },
    opts: { gate?: 'whatsapp.outputs' | 'alerts.onFailure'; log: string; telegramCarried?: boolean } ,
  ): Promise<AlertResult> {
    const [enabled, to] = await Promise.all([opts.gate ? this.setting(opts.gate) : Promise.resolve(null), this.setting('alerts.whatsappNumber')]);
    if (opts.gate && enabled === 'false') return { sent: false, why: 'off' };
    if (!to) return { sent: false, why: 'no number' };
    if (!this.postbox.isConfigured()) return { sent: false, why: 'postbox not configured' };
    // telegramCarried: a Watch/Alert push already sent this on Telegram — a Meta refusal must not
    // send it there a second time (BEA-1379).
    const r = await sendOwnerAlert(this.postbox, to, { ...msg, firstName: await ownerFirstName(this.prisma) }, { telegramCarried: opts.telegramCarried });
    if (!r.sent) this.log.warn(`${opts.log} not delivered: ${r.error || 'unknown reason'}`);
    else if (r.note) this.log.warn(`${opts.log}: ${r.note}`);
    return r.sent ? { ...r, sent: true } : { ...r, sent: false, why: r.error || 'the message could not be delivered' };
  }

  /**
   * A job finished (BEA-1102) — one WhatsApp per job with the name, the headline and a private
   * app link behind the button. Gated by the master switch + the per-job toggle (checked by the
   * caller). `kind: 'alert'` is a Watch/Alert that fired (BEA-1358), worded as one.
   */
  async runFinished(name: string, headline: string, path: string, opts: { kind?: 'finished' | 'alert'; detail?: string } = {}): Promise<AlertResult> {
    const who = clean(name).slice(0, 120) || 'Your agent';
    const line = opts.kind === 'alert' ? `${who} — alert` : `${who} finished`;
    const what = clean(headline).slice(0, 600) || 'The result is ready.';
    return this.ownerAlert(
      { headline: line, detail: opts.detail ? `${what} · ${clean(opts.detail)}` : what, path },
      { gate: 'whatsapp.outputs', log: 'finished alert', telegramCarried: opts.kind === 'alert' },
    );
  }

  /**
   * ONE end-of-day summary of the daily reports that never arrived (BEA-1121). Deliberately a
   * single message listing everything, not one per item: on a bad day that would be three pings.
   * A miss is the signal worth the owner's attention — arrivals need no message at all.
   */
  async dailyMissDigest(day: string, missed: { title: string; contact: string | null }[]): Promise<AlertResult> {
    if (!missed.length) return { sent: false, why: 'nothing missed' };
    const lines = missed.slice(0, 10).map((m) => `• ${m.title}${m.contact ? ` — ${m.contact}` : ''}`);
    const more = missed.length > 10 ? `…and ${missed.length - 10} more` : '';
    const headline = `📋 ${day}: ${missed.length} daily update${missed.length === 1 ? '' : 's'} did not come in`;
    const detail = [...lines, more].filter(Boolean).join('\n');
    return this.ownerAlert(
      { headline, detail, path: '/tasks?tab=review&rtab=daily', longBody: `${headline}\n${detail}` },
      { log: 'miss digest' },
    );
  }

  /**
   * The Lab's one line a week (BEA-1144). Sent only when something crossed the bar — the caller
   * decides that; this just delivers. The body rides in the template's detail; when it is longer
   * than a template line can hold, the full text follows as a second message.
   */
  async labWeekly(body: string, subject: string): Promise<AlertResult> {
    if (!clean(body)) return { sent: false, why: 'nothing to say' };
    return this.ownerAlert(
      { headline: clean(subject) || 'What the Lab noticed this week', detail: body, path: '/lab', longBody: body },
      { gate: 'whatsapp.outputs', log: 'weekly Lab line' },
    );
  }

  /**
   * The owner's number, as Settings holds it (BEA-1392). One reader, so "who is the owner" can
   * never differ between the message going out and the reply coming back. `OWNER_WHATSAPP_NUMBER`
   * overrides it for a server whose Settings row is not filled in yet.
   */
  async ownerNumber(): Promise<string | null> {
    const env = String(process.env.OWNER_WHATSAPP_NUMBER || '').trim();
    if (env) return env;
    return (await this.setting('alerts.whatsappNumber')) || null;
  }

  /**
   * A run has STOPPED and needs an answer (BEA-1392 §H) — the worker's `kit.ask` / `kit.trouble`.
   *
   * The same one road as every other owner message (template first, Meta's real verdict, Telegram
   * when Meta refuses), so BEA-1379 comes free. Two differences from the alerts above, both on
   * purpose: it is NOT behind the `whatsapp.outputs` switch — that switch is about results, and a
   * question is a run that cannot carry on until he answers — and it is not rate-limited, because a
   * silently-dropped question would strand the run until its 12-hour deadline.
   */
  async askOwner(msg: { jobName: string; question: string; choices?: string[]; tag?: string; path: string }): Promise<AlertResult> {
    const who = clean(msg.jobName).slice(0, 100) || 'Your agent';
    const tag = clean(msg.tag);
    const headline = `${who} needs your answer${tag ? ` ${tag}` : ''}`;
    const detail = askDetail(clean(msg.question), msg.choices);
    return this.ownerAlert({ headline, detail, path: msg.path, longBody: `${headline}\n\n${detail}` }, { log: 'a question from a run' });
  }

  /** An automation failed — WhatsApp the owner (if configured), quietly rate-limited. */
  async runFailed(name: string, reason: string, path: string): Promise<AlertResult> {
    const key = name || 'run';
    const last = this.lastByName.get(key) || 0;
    // The switch and number are checked first, so an alert that could not go out anyway does not
    // start a cooldown; the cooldown is set only when a message is really about to leave.
    const [enabled, to] = await Promise.all([this.setting('alerts.onFailure'), this.setting('alerts.whatsappNumber')]);
    if (enabled === 'false') return { sent: false, why: 'off' };
    if (!to) return { sent: false, why: 'no number' };
    if (!this.postbox.isConfigured()) return { sent: false, why: 'postbox not configured' };
    if (Date.now() - last < 30 * 60_000) return { sent: false, why: 'cooldown' };
    this.lastByName.set(key, Date.now());
    return this.ownerAlert(
      { headline: `⚠️ ${clean(name).slice(0, 120) || 'An automation'} failed`, detail: clean(reason).slice(0, 400) || 'It hit a problem.', path },
      { gate: 'alerts.onFailure', log: 'failure alert' },
    );
  }
}
