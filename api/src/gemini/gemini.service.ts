import { Injectable } from '@nestjs/common';

const RUNNER = process.env.GEMINI_RUNNER_URL || 'http://172.18.0.1:8767';

/** Talks to the host-side gemini-runner (the bridge to the host's Antigravity CLI "agy", which holds
 *  the user's Google AI Pro/Ultra login). Foundation: status only. Task execution is a later, guarded
 *  feature (parity with the Codex runner). */
@Injectable()
export class GeminiService {
  async status() {
    try {
      // The host probe runs `agy models`, which can take a few seconds — allow headroom.
      const r = await fetch(`${RUNNER}/status`, { signal: AbortSignal.timeout(15000) });
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
