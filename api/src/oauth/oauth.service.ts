import { Injectable, BadRequestException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';

const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const ACCESS_TTL = 60 * 60; // 1h
const REFRESH_TTL = 60 * 60 * 24 * 90; // 90d
const CODE_TTL_MS = 5 * 60 * 1000; // 5 min
export const OAUTH_SCOPE = 'mcp';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Minimal OAuth 2.1 authorization server for the public MCP (BEA-758). Single owner:
 * the consent step reuses the My Brain login. PKCE (S256) is mandatory; codes are
 * short-lived and single-use; access/refresh tokens are signed JWTs (aud "mcp").
 */
@Injectable()
export class OAuthService {
  constructor(private readonly prisma: PrismaService) {}

  origin(req: { headers: Record<string, any> }): string {
    if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || (req.headers['host'] as string) || 'mybrain.1site.ai';
    return `${proto}://${host}`;
  }

  authServerMetadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [OAUTH_SCOPE],
    };
  }

  protectedResourceMetadata(origin: string) {
    return {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [OAUTH_SCOPE],
    };
  }

  // ---- Dynamic Client Registration (RFC 7591) ----
  async register(body: any) {
    const uris: string[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u: any) => typeof u === 'string') : [];
    if (!uris.length) throw new BadRequestException({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
    for (const u of uris) {
      try {
        const p = new URL(u);
        if (p.protocol !== 'https:' && p.hostname !== 'localhost' && p.hostname !== '127.0.0.1') {
          throw new BadRequestException({ error: 'invalid_redirect_uri', error_description: `redirect_uri must be https (or localhost): ${u}` });
        }
      } catch {
        throw new BadRequestException({ error: 'invalid_redirect_uri', error_description: `not a valid URL: ${u}` });
      }
    }
    const id = 'mbc_' + randomBytes(16).toString('hex');
    const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 120) : null;
    // Registration is public (@Public) so bound the table — otherwise anyone can create unlimited
    // rows to bloat the DB. Keep the newest MAX_CLIENTS by pruning the oldest. (BEA-830)
    const MAX_CLIENTS = 50;
    const count = await this.prisma.oAuthClient.count();
    if (count >= MAX_CLIENTS) {
      const old = await this.prisma.oAuthClient.findMany({ orderBy: { createdAt: 'asc' }, take: count - MAX_CLIENTS + 1, select: { id: true } });
      await this.prisma.oAuthClient.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    }
    await this.prisma.oAuthClient.create({ data: { id, name, redirectUris: JSON.stringify(uris) } });
    return {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      client_name: name || undefined,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  async getClient(clientId?: string) {
    if (!clientId) return null;
    return this.prisma.oAuthClient.findUnique({ where: { id: clientId } }).catch(() => null);
  }

  /** Validate the authorize params up-front so we never render consent for a bad request. */
  async validateAuthorize(q: Record<string, any>): Promise<{ clientId: string; redirectUri: string; challenge: string; state?: string; scope?: string; clientName: string }> {
    if (q.response_type !== 'code') throw new BadRequestException('response_type must be "code"');
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) throw new BadRequestException('PKCE S256 (code_challenge) is required');
    const client = await this.getClient(q.client_id);
    if (!client) throw new BadRequestException('Unknown client_id');
    const allowed: string[] = JSON.parse(client.redirectUris || '[]');
    if (!q.redirect_uri || !allowed.includes(q.redirect_uri)) throw new BadRequestException('redirect_uri does not match the registered client');
    return { clientId: client.id, redirectUri: q.redirect_uri, challenge: q.code_challenge, state: q.state, scope: q.scope, clientName: client.name || 'An application' };
  }

  /** Mint a single-use PKCE-bound code and return the full redirect URL. */
  async issueCode(p: { clientId: string; redirectUri: string; challenge: string; state?: string; scope?: string; userId: string }): Promise<string> {
    const code = randomBytes(32).toString('hex');
    await this.prisma.oAuthCode.create({
      data: { code, clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.challenge, scope: p.scope || OAUTH_SCOPE, userId: p.userId, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
    const u = new URL(p.redirectUri);
    u.searchParams.set('code', code);
    if (p.state) u.searchParams.set('state', p.state);
    return u.toString();
  }

  /** authorization_code grant → verify PKCE, single-use, and issue tokens. */
  async exchangeCode(body: Record<string, any>) {
    const code = await this.prisma.oAuthCode.findUnique({ where: { code: body.code || '' } }).catch(() => null);
    if (!code || code.used || code.expiresAt < new Date()) throw new BadRequestException({ error: 'invalid_grant', error_description: 'code invalid or expired' });
    if (code.clientId !== body.client_id) throw new BadRequestException({ error: 'invalid_grant', error_description: 'client mismatch' });
    if (code.redirectUri !== body.redirect_uri) throw new BadRequestException({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    const verifier = String(body.code_verifier || '');
    const computed = b64url(createHash('sha256').update(verifier).digest());
    if (!verifier || computed !== code.codeChallenge) throw new BadRequestException({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    await this.prisma.oAuthCode.update({ where: { code: code.code }, data: { used: true } });
    return this.tokens(code.userId, code.scope || OAUTH_SCOPE);
  }

  /** refresh_token grant. */
  async refresh(body: Record<string, any>) {
    try {
      const d: any = jwt.verify(String(body.refresh_token || ''), SECRET);
      if (d.aud !== 'mcp' || d.typ !== 'refresh') throw new Error('bad');
      return this.tokens(d.sub, d.scope || OAUTH_SCOPE);
    } catch {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'refresh_token invalid' });
    }
  }

  private tokens(userId: string, scope: string) {
    const access_token = jwt.sign({ sub: userId, scope, typ: 'access' }, SECRET, { audience: 'mcp', expiresIn: ACCESS_TTL });
    const refresh_token = jwt.sign({ sub: userId, scope, typ: 'refresh' }, SECRET, { audience: 'mcp', expiresIn: REFRESH_TTL });
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token, scope };
  }

  /** Verify an MCP access token (used by the public MCP endpoint). */
  static verifyAccess(token: string): { sub: string } | null {
    try {
      const d: any = jwt.verify(token, SECRET, { audience: 'mcp' });
      if (d.typ !== 'access' || (d.scope || '') !== OAUTH_SCOPE) return null;
      return { sub: d.sub };
    } catch {
      return null;
    }
  }

  /** The consent (and, if needed, login) page. Self-contained HTML. */
  consentPage(p: { params: Record<string, string>; clientName: string; needLogin: boolean; error?: string }): string {
    const hidden = Object.entries(p.params)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    const loginFields = p.needLogin
      ? `<label>Email<input name="__email" type="email" autocomplete="username" required></label>
         <label>Password<input name="__password" type="password" autocomplete="current-password" required></label>`
      : '';
    const err = p.error ? `<p class="err">${esc(p.error)}</p>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize · My Brain</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#07090f;color:#e4e4e7;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;padding:20px}
.card{width:100%;max-width:400px;background:#18181b99;border:1px solid #27272a;border-radius:18px;padding:26px}
h1{font-size:20px;margin:0 0 4px}p{color:#a1a1aa;margin:.4em 0}.who{color:#34d399;font-weight:600}
label{display:block;font-size:12px;color:#a1a1aa;margin-top:12px}input{width:100%;box-sizing:border-box;margin-top:4px;padding:10px;border-radius:10px;border:1px solid #3f3f46;background:transparent;color:#fff;font-size:15px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:11px;border-radius:10px;border:0;font-size:15px;font-weight:600;cursor:pointer}
.allow{background:#059669;color:#fff}.deny{background:transparent;border:1px solid #3f3f46;color:#a1a1aa}
.scope{background:#34d39914;border:1px solid #34d39933;border-radius:10px;padding:10px 12px;margin-top:14px;font-size:13px;color:#d4d4d8}
.err{background:#f43f5e1a;border:1px solid #f43f5e55;color:#fda4af;border-radius:10px;padding:8px 10px;font-size:13px}
</style></head><body><div class="card">
<h1>Authorize access</h1>
<p><span class="who">${esc(p.clientName)}</span> wants to connect to your My Brain.</p>
${err}
<div class="scope">It will be able to:<br>• Search your brain (notes, documents, memories)<br>• Read a document's full text</div>
<form method="post" action="/api/oauth/authorize">${hidden}
${loginFields}
${p.needLogin ? '<p style="font-size:12px;margin-top:12px">Sign in to your My Brain to approve.</p>' : ''}
<div class="row"><button class="deny" name="__decision" value="deny">Deny</button><button class="allow" name="__decision" value="allow">Allow</button></div>
</form></div></body></html>`;
  }
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
