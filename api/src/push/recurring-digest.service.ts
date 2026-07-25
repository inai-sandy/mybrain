import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RecurringService } from '../tasks/recurring.service';
import { AlertsService } from './alerts.service';

/**
 * Closes the day for standing daily reports and sends ONE summary of what never arrived (BEA-1121).
 *
 * A recurring report is never confirmed, so it can't sit in a review queue waiting to be noticed —
 * the miss is the only thing worth telling the owner about, and it has to reach him the same
 * evening. Lives here rather than in the sender because the owner's WhatsApp channel is on this
 * side (contacts must never import push — that would be a cycle).
 *
 * Checks every 10 minutes; `closeDay()` itself refuses to run twice for the same day and refuses
 * to run before the day is over, so the cadence only decides how soon after the hour it fires.
 */
@Injectable()
export class RecurringDigestService implements OnModuleInit {
  private readonly log = new Logger('RecurringDigest');
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly recurring: RecurringService,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn(`tick: ${e?.message}`));
    }, 10 * 60_000);
  }

  async tick(): Promise<{ sent: boolean } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const closed = await this.recurring.closeDay();
      if (!closed) return null; // day not over, already closed, a rest day, or nothing missed
      const r = await this.alerts.dailyMissDigest(closed.day, closed.missed);
      this.log.log(`${closed.day}: told the owner about ${closed.missed.length} missed report(s) — sent=${r.sent}`);
      return { sent: r.sent };
    } finally {
      this.running = false;
    }
  }
}
