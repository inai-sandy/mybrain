import { Injectable, Logger } from '@nestjs/common';

const BASE = process.env.GWS_RUNNER_URL || 'http://172.18.0.1:8766';

/** Talks to the host `gws-runner` bridge, which drives the Google Workspace CLI (`gws`).
 *  The CLI holds the user's Google login; the app never sees OAuth tokens directly. */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);

  /** Connection state — offline-safe (bridge down / not authed → connected:false, never throws). */
  async status(): Promise<{ connected: boolean; email: string | null; gws: boolean; bridge: boolean }> {
    try {
      const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { connected: false, email: null, gws: false, bridge: false };
      const d: any = await r.json();
      return { connected: !!d.connected, email: d.email || null, gws: !!d.installed, bridge: true };
    } catch {
      return { connected: false, email: null, gws: false, bridge: false };
    }
  }

  /** Run a gws command via the bridge and return its parsed JSON.
   *  Throws Error('not-connected') when gws has no Google login (exit code 2),
   *  Error('bridge-down') when the host bridge is unreachable. */
  async run(argv: string[]): Promise<any> {
    let d: any;
    try {
      const r = await fetch(`${BASE}/gws`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ argv }),
        signal: AbortSignal.timeout(60000),
      });
      d = await r.json();
    } catch (e) {
      this.logger.warn(`gws bridge unreachable: ${String((e as Error)?.message || e)}`);
      throw new Error('bridge-down');
    }
    if (!d.ok) {
      if (d.code === 2) throw new Error('not-connected');
      const msg = (d.stderr || '').split('\n')[0] || 'gws command failed';
      throw new Error(msg);
    }
    return d.json ?? d.text;
  }
}
