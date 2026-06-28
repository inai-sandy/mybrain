import { Injectable, Logger } from '@nestjs/common';

/**
 * Low-level client for the Hermes dashboard (BEA-618). Drives the WebSocket JSON-RPC
 * run protocol that was validated end-to-end against live Hermes:
 *   password-login -> cookie -> ws-ticket -> ws -> session.create -> prompt.submit -> events.
 * Node 22 built-in WebSocket + fetch (no extra deps).
 */

const WS: any = (globalThis as any).WebSocket;

export type HermesStep = { label: string; status?: string; detail?: string; kind?: string };

export interface HermesRunHandlers {
  /** A friendly progress step (tool start/finish, status). */
  onStep?: (step: HermesStep) => void;
  /** The agent asks a question mid-run. Return the answer string. Default: a safe "proceed". */
  onClarify?: (q: { requestId?: string; question: string; choices?: string[] }) => Promise<string>;
  /** The agent wants to run a risky command. Return 'once'|'session'|'always'|'deny'. Default: 'deny'. */
  onApproval?: (a: { command?: string; description?: string }) => Promise<string>;
}

export interface HermesRunResult {
  sessionId: string;
  finalText: string;
  status: string; // 'complete' | 'error' | ...
  error?: string;
}

export interface HermesRunOpts {
  title?: string;
  model?: string;
  provider?: string;
  timeoutMs?: number;
}

@Injectable()
export class HermesClient {
  private readonly log = new Logger('HermesClient');
  private readonly base = process.env.HERMES_URL || 'http://172.18.0.1:9119';
  private readonly user = process.env.HERMES_USER || 'mybrain';
  private readonly pass = process.env.HERMES_PASSWORD || '';
  private cookie: string | null = null;

  /** True once we can reach + authenticate Hermes (used for a friendly "engine offline" message). */
  async ping(): Promise<{ ok: boolean; version?: string; reason?: string }> {
    try {
      const res = await fetch(`${this.base}/api/status`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, reason: `status ${res.status}` };
      const j: any = await res.json();
      return { ok: true, version: j?.version };
    } catch (e: any) {
      return { ok: false, reason: e?.message || 'unreachable' };
    }
  }

  /** Rich engine status for the settings panel: reachability, version, gateway, and the Codex/model wiring. */
  async engineStatus(): Promise<{ ok: boolean; version?: string; gatewayRunning?: boolean; authRequired?: boolean; connectedToCodex?: boolean; model?: string; provider?: string; reason?: string }> {
    let base: any = { ok: false };
    try {
      const s = await fetch(`${this.base}/api/status`, { signal: AbortSignal.timeout(5000) });
      if (!s.ok) return { ok: false, reason: `status ${s.status}` };
      const st: any = await s.json();
      base = { ok: true, version: st.version, gatewayRunning: !!st.gateway_running, authRequired: !!st.auth_required };
    } catch (e: any) {
      return { ok: false, reason: e?.message || 'unreachable' };
    }
    try {
      const c = await this.authed('/api/config');
      if (c.ok) {
        const cfg: any = await c.json();
        const m = cfg.model;
        base.model = typeof m === 'string' ? m : m?.default || m?.model;
        base.provider = (typeof m === 'object' ? m?.provider : undefined) || (typeof cfg.provider === 'string' ? cfg.provider : undefined);
        base.connectedToCodex = /openai-codex|codex_app_server|codex/i.test(JSON.stringify(m || '') + JSON.stringify(cfg.provider || ''));
      }
    } catch { /* config read is best-effort */ }
    return base;
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.base}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'basic', username: this.user, password: this.pass, next: '/' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Hermes login failed (${res.status})`);
    const setCookies: string[] = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error('Hermes login returned no cookie');
    this.cookie = cookie;
  }

  /** Run an authed request, logging in (or re-logging-in on 401) as needed. */
  private async authed(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.cookie) await this.login();
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), cookie: this.cookie || '' },
      signal: init.signal || AbortSignal.timeout(8000),
    });
    if (res.status === 401 && retry) {
      this.cookie = null;
      await this.login();
      return this.authed(path, init, false);
    }
    return res;
  }

  private async wsTicket(): Promise<string> {
    const res = await this.authed('/api/auth/ws-ticket', { method: 'POST' });
    if (!res.ok) throw new Error(`Hermes ws-ticket failed (${res.status})`);
    return (await res.json()).ticket;
  }

  /**
   * Run one agent turn over the WebSocket and resolve when it completes.
   * Creates a fresh session (returns its id) unless opts carries one later.
   */
  async runTurn(text: string, handlers: HermesRunHandlers = {}, opts: HermesRunOpts = {}): Promise<HermesRunResult> {
    const ticket = await this.wsTicket();
    const wsUrl = `${this.base.replace(/^http/, 'ws')}/api/ws?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WS(wsUrl);

    let sessionId = '';
    let finalText = '';
    let idc = 0;
    const send = (method: string, params: any) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'c' + ++idc, method, params }));

    return new Promise<HermesRunResult>((resolve, reject) => {
      // Re-armable inactivity timer — paused while we're waiting on a human (clarify/approval),
      // since the bridge's handler bounds that wait itself.
      const TURN_MS = opts.timeoutMs ?? 240_000;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } reject(new Error('Hermes run timed out')); }, TURN_MS); };
      const disarm = () => { if (timer) clearTimeout(timer); timer = null; };
      arm();

      const finish = (status: string, error?: string) => {
        disarm();
        try { ws.close(); } catch { /* noop */ }
        resolve({ sessionId, finalText, status, error });
      };

      ws.addEventListener('error', (e: any) => { disarm(); reject(new Error('Hermes ws error: ' + (e?.message || 'unknown'))); });

      ws.addEventListener('message', async (ev: any) => {
        for (const line of String(ev.data).split('\n')) {
          if (!line.trim()) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }

          if (msg.method === 'event') {
            const t = msg.params?.type;
            const p = msg.params?.payload || {};
            switch (t) {
              case 'gateway.ready':
                send('session.create', { source: 'mybrain', title: opts.title || 'Agent run', model: opts.model, provider: opts.provider });
                break;
              case 'message.delta':
                finalText += p.text || '';
                break;
              case 'tool.start':
                handlers.onStep?.({ label: friendlyTool(p.name), status: 'running', kind: 'tool' });
                break;
              case 'tool.complete':
                handlers.onStep?.({ label: friendlyTool(p.name), status: 'done', kind: 'tool', detail: p.summary });
                break;
              case 'status.update': {
                const txt = String(p.text || '').trim();
                // Skip internal engine plumbing (context/compaction/token-budget chatter) — it's noise, not progress.
                if (txt && !/caps context|auto-compaction|compaction|context window|token budget|summariz|rollout|reasoning effort/i.test(txt)) {
                  handlers.onStep?.({ label: txt.slice(0, 140), status: 'info', kind: p.kind });
                }
                break;
              }
              case 'clarify.request': {
                disarm(); // a human may take a while — don't time out the turn
                const answer = handlers.onClarify ? await handlers.onClarify({ requestId: p.request_id, question: p.question, choices: p.choices }) : 'Use your best judgment.';
                send('clarify.respond', { session_id: sessionId, request_id: p.request_id, answer });
                arm();
                break;
              }
              case 'approval.request': {
                disarm();
                const choice = handlers.onApproval ? await handlers.onApproval({ command: p.command, description: p.description }) : 'deny';
                send('approval.respond', { session_id: sessionId, choice });
                arm();
                break;
              }
              case 'message.complete':
                if (p.text) finalText = p.text;
                finish(p.status || 'complete');
                break;
              case 'error':
                finish('error', p.message || 'agent error');
                break;
              default:
                break;
            }
          } else if (msg.id && msg.result) {
            if (msg.result.session_id && !sessionId) {
              sessionId = msg.result.session_id;
              send('prompt.submit', { session_id: sessionId, text });
            }
          } else if (msg.id && msg.error) {
            finish('error', msg.error?.message || 'rpc error');
          }
        }
      });
    });
  }
}

/** Turn a raw tool name into a plain-English step label. */
function friendlyTool(name?: string): string {
  const map: Record<string, string> = {
    shell: 'Running a command',
    apply_patch: 'Editing files',
    update_plan: 'Planning the steps',
    web_search: 'Searching the web',
    web_extract: 'Reading a page',
    view_image: 'Looking at an image',
  };
  return map[name || ''] || (name ? `Using ${name}` : 'Working');
}
