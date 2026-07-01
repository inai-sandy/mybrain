import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';

const CHECK_EVERY_MS = 60_000; // ping cadence
const RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';

/**
 * EngineWatchdog (BEA-632, repointed to direct Codex in F5/BEA-663) — pings the host codex-runner
 * on a cadence and records health so the settings page can show last-healthy / last-error. The
 * runner is a tiny stable HTTP service that systemd restarts on crash, so we no longer auto-restart
 * (the old Hermes helper-restart is gone). Fully guarded — a bad tick can never crash the app.
 */
@Injectable()
export class EngineWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EngineWatchdog');
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFails = 0;
  private busy = false;

  constructor(private readonly agent: AgentService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), CHECK_EVERY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async ping(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await fetch(`${RUNNER}/status`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { ok: false, reason: `runner http ${r.status}` };
      const s: any = await r.json();
      return s?.ready ? { ok: true } : { ok: false, reason: 'codex not ready' };
    } catch (e: any) {
      return { ok: false, reason: e?.name === 'TimeoutError' ? 'runner timeout' : 'runner unreachable' };
    }
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await this.ping();
      const now = Date.now();
      if (res.ok) {
        this.consecutiveFails = 0;
        await this.agent.recordEngineHealth({ healthyAt: now, error: null }).catch(() => undefined);
        return;
      }
      this.consecutiveFails++;
      await this.agent.recordEngineHealth({ error: `unreachable (${res.reason || 'no response'}) ×${this.consecutiveFails}` }).catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }
}
