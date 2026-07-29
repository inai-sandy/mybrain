import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TaskHealthService } from '../tasks/task-health.service';
import { TelegramService } from './telegram.service';
import { localDayKey } from '../common/localday';

/**
 * Tells the owner when the nightly tasks health check finds something (BEA-1190).
 *
 * It lives HERE rather than beside the check itself because this module already depends on tasks —
 * wiring it the other way round is a circular dependency, and Nest refuses to start on one. The
 * first attempt did exactly that and the deploy rolled itself back.
 *
 * Silence means healthy. Nothing is sent when every check passes.
 */
@Injectable()
export class TaskHealthNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TaskHealth');
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunDay = '';

  constructor(
    private readonly health: TaskHealthService,
    private readonly telegram: TelegramService,
  ) {}

  onModuleInit() {
    // Woken every 30 minutes but it only runs once a day, after 22:00 local. A fixed nightly timer
    // drifts with every restart; this survives them.
    this.timer = setInterval(() => void this.maybeRunNightly().catch(() => undefined), 30 * 60_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async maybeRunNightly() {
    const now = new Date();
    const day = localDayKey(now);
    if (this.lastRunDay === day) return;
    const localHour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
    if (localHour < 22) return;
    this.lastRunDay = day;
    await this.runAndReport();
  }

  /** Run every check and tell the owner if — and only if — something is wrong. */
  async runAndReport(): Promise<{ found: number; told: boolean }> {
    const findings = await this.health.check().catch(() => []);
    if (!findings.length) {
      this.log.log('nightly health check: all clear');
      return { found: 0, told: false };
    }
    const body = this.health.message(findings);
    let told = false;
    const owner = await this.telegram.ownerChatId().catch(() => null);
    if (owner && body) {
      await this.telegram.send(owner, body).catch(() => undefined);
      told = true;
    }
    this.log.warn(`nightly health check: ${findings.length} problem(s)${told ? ' — owner told' : ' (nobody to tell)'}`);
    return { found: findings.length, told };
  }
}
