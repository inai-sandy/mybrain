import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from '../contacts/postbox.service';

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
