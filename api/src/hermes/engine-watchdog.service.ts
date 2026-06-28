import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HermesClient } from './hermes.client';
import { AgentService } from '../agent/agent.service';

const CHECK_EVERY_MS = 60_000; // ping cadence
const FAILS_BEFORE_RESTART = 3; // ~3 consecutive misses before we act (avoids one-off blips)
const MIN_RESTART_GAP_MS = 10 * 60_000; // never auto-restart more than once per 10 min (no crash-loop thrash)

/**
 * EngineWatchdog (BEA-632) — systemd restarts the engine on crash/reboot, but NOT when the
 * process is up-but-unresponsive (hung). This pings it on a cadence and, after a few consecutive
 * failures, auto-restarts it once via the locked-down host helper (rate-limited). Health is
 * persisted so the settings page can show last-healthy / last-auto-restart. Fully guarded — a bad
 * tick can never crash the app.
 */
@Injectable()
export class EngineWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EngineWatchdog');
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFails = 0;
  private lastRestartAt = 0;
  private busy = false;

  constructor(
    private readonly hermes: HermesClient,
    private readonly agent: AgentService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), CHECK_EVERY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Decide whether a restart is warranted from the failure count + last-restart time. Pure — unit-tested. */
  static shouldRestart(consecutiveFails: number, now: number, lastRestartAt: number): boolean {
    return consecutiveFails >= FAILS_BEFORE_RESTART && now - lastRestartAt >= MIN_RESTART_GAP_MS;
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await this.hermes.ping().catch((e) => ({ ok: false, reason: e?.message }));
      const now = Date.now();
      if (res.ok) {
        this.consecutiveFails = 0;
        await this.agent.recordEngineHealth({ healthyAt: now, error: null }).catch(() => undefined);
        return;
      }
      this.consecutiveFails++;
      await this.agent.recordEngineHealth({ error: `unreachable (${res.reason || 'no response'}) ×${this.consecutiveFails}` }).catch(() => undefined);
      if (EngineWatchdog.shouldRestart(this.consecutiveFails, now, this.lastRestartAt)) {
        this.lastRestartAt = now;
        this.consecutiveFails = 0;
        this.log.warn('engine unresponsive — auto-restarting via helper');
        const ok = await this.restartViaHelper();
        await this.agent.recordEngineHealth({ restartedAt: now, error: ok ? 'auto-restarted (was unresponsive)' : 'auto-restart attempt failed' }).catch(() => undefined);
      }
    } finally {
      this.busy = false;
    }
  }

  private async restartViaHelper(): Promise<boolean> {
    const url = process.env.AGENT_HELPER_URL || 'http://172.18.0.1:8770';
    const token = process.env.AGENT_HELPER_TOKEN || '';
    try {
      const r = await fetch(`${url}/restart`, { method: 'POST', headers: { 'x-token': token }, signal: AbortSignal.timeout(20000) });
      return r.ok;
    } catch (e: any) {
      this.log.error(`helper restart failed: ${e?.message || e}`);
      return false;
    }
  }
}
