import { Injectable } from '@nestjs/common';

const RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';

/** Talks to the host-side codex-runner (the bridge to the host's Codex, which holds the user's
 *  subscription login). Foundation: status only. Task execution is a later, guarded feature. */
@Injectable()
export class CodexService {
  async status() {
    try {
      const r = await fetch(`${RUNNER}/status`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return this.offline(`runner http ${r.status}`);
      const s: any = await r.json();
      return {
        connected: true,
        installed: !!s.installed,
        version: s.version ?? null,
        loggedIn: !!s.loggedIn,
        ready: !!s.ready,
        workdir: s.workdir ?? null,
      };
    } catch (e: any) {
      return this.offline(e?.name === 'TimeoutError' ? 'runner timeout' : 'runner unreachable');
    }
  }
  private offline(reason: string) {
    return { connected: false, installed: false, version: null, loggedIn: false, ready: false, workdir: null, reason };
  }
}
