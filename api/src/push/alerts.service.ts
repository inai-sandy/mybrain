import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from '../contacts/postbox.service';

const clean = (s: unknown) => String(s || '').trim();

/**
 * Failure alerts (BEA-1071) — "tell me on WhatsApp when an automation breaks". One plain message
 * per failure: name + one-line reason + link. Per-name cooldown so a storm can't spam the owner.
 */
@Injectable()
export class AlertsService {
  private readonly log = new Logger('Alerts');
  /** name → last alert epoch-ms; one alert per automation per 30 min. */
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
   * A job finished (BEA-1102) — one WhatsApp per job with the name, the headline and a private
   * app link. Gated by the master switch + the per-job toggle (checked by the caller).
   */
  async runFinished(name: string, headline: string, path: string): Promise<{ sent: boolean; why?: string }> {
    const [enabled, to] = await Promise.all([this.setting('whatsapp.outputs'), this.setting('alerts.whatsappNumber')]);
    if (enabled === 'false') return { sent: false, why: 'off' };
    if (!to) return { sent: false, why: 'no number' };
    if (!this.postbox.isConfigured()) return { sent: false, why: 'postbox not configured' };
    const body = `🤖 ${(name || 'Your agent').slice(0, 60)}\n${(headline || 'The result is ready.').slice(0, 200)}\n\nOpen: https://mybrain.1site.ai${path}`;
    let r = await this.postbox.sendText(to, body);
    if (r.status === 'failed') {
      // Outside the 24h session window a plain text can't deliver — the approved template can.
      r = await this.postbox.sendReminderTemplate(to, 'Sandy', `${(name || 'your agent').slice(0, 70)} finished — open My Brain`);
    }
    if (r.status === 'failed') this.log.warn(`finished alert not delivered: ${r.error}`);
    return { sent: r.status !== 'failed' };
  }

  /**
   * ONE end-of-day summary of the daily reports that never arrived (BEA-1121). Deliberately a
   * single message listing everything, not one per item: on a bad day that would be three pings.
   * A miss is the signal worth the owner's attention — arrivals need no message at all.
   */
  async dailyMissDigest(day: string, missed: { title: string; contact: string | null }[]): Promise<{ sent: boolean; why?: string }> {
    if (!missed.length) return { sent: false, why: 'nothing missed' };
    const to = await this.setting('alerts.whatsappNumber');
    if (!to) return { sent: false, why: 'no number' };
    if (!this.postbox.isConfigured()) return { sent: false, why: 'postbox not configured' };
    const lines = missed.slice(0, 10).map((m) => `• ${m.title}${m.contact ? ` — ${m.contact}` : ''}`).join('\n');
    const more = missed.length > 10 ? `\n…and ${missed.length - 10} more` : '';
    const body = `📋 ${day}: ${missed.length} daily update${missed.length === 1 ? '' : 's'} did not come in\n${lines}${more}\n\nOpen: https://mybrain.1site.ai/tasks?tab=review&rtab=daily`;
    let r = await this.postbox.sendText(to, body);
    if (r.status === 'failed') {
      // Outside the 24h session window only the approved template can be delivered. (BEA-1112)
      r = await this.postbox.sendReminderTemplate(to, 'Sandy', `${missed.length} daily update${missed.length === 1 ? '' : 's'} missing for ${day}`);
    }
    if (r.status === 'failed') this.log.warn(`miss digest not delivered: ${r.error}`);
    return { sent: r.status !== 'failed' };
  }

  /**
   * The Lab's one line a week (BEA-1144). Sent only when something crossed the bar — the caller
   * decides that; this just delivers. Same template fallback as everything else here, so it still
   * lands when the 24-hour window is shut. (BEA-1112)
   */
  async labWeekly(body: string, subject: string): Promise<{ sent: boolean; why?: string }> {
    if (!clean(body)) return { sent: false, why: 'nothing to say' };
    const [enabled, to] = await Promise.all([this.setting('whatsapp.outputs'), this.setting('alerts.whatsappNumber')]);
    if (enabled === 'false') return { sent: false, why: 'off' };
    if (!to) return { sent: false, why: 'no number' };
    if (!this.postbox.isConfigured()) return { sent: false, why: 'postbox not configured' };
    let r = await this.postbox.sendText(to, body);
    if (r.status === 'failed') {
      r = await this.postbox.sendReminderTemplate(to, 'Sandy', subject.slice(0, 80));
    }
    if (r.status === 'failed') this.log.warn(`weekly Lab line not delivered: ${r.error}`);
    return { sent: r.status !== 'failed' };
  }

  /** An automation failed — WhatsApp the owner (if configured), quietly rate-limited. */
  async runFailed(name: string, reason: string, path: string): Promise<{ sent: boolean; why?: string }> {
    const [enabled, to] = await Promise.all([this.setting('alerts.onFailure'), this.setting('alerts.whatsappNumber')]);
    if (enabled === 'false') return { sent: false, why: 'off' };
    if (!to) return { sent: false, why: 'no number' };
    if (!this.postbox.isConfigured()) return { sent: false, why: 'postbox not configured' };
    const key = name || 'run';
    const last = this.lastByName.get(key) || 0;
    if (Date.now() - last < 30 * 60_000) return { sent: false, why: 'cooldown' };
    this.lastByName.set(key, Date.now());
    const body = `⚠️ ${name || 'An automation'} failed\n${(reason || 'It hit a problem.').slice(0, 200)}\n\nOpen: https://mybrain.1site.ai${path}`;
    let r = await this.postbox.sendText(to, body);
    if (r.status === 'failed') {
      // Outside the 24h WhatsApp session window a plain text can't deliver — the approved template can.
      r = await this.postbox.sendReminderTemplate(to, 'Sandy', `${(name || 'an automation').slice(0, 80)} failed — open My Brain`);
    }
    if (r.status === 'failed') this.log.warn(`failure alert not delivered: ${r.error}`);
    return { sent: r.status !== 'failed' };
  }
}
