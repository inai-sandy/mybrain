import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE, cookieOpts } from '../auth/auth.guard';
import { OAuthService } from './oauth.service';

/**
 * OAuth 2.1 endpoints for the public MCP (BEA-758). All public (they ARE the auth flow).
 * Consent reuses the My Brain login — the owner signs in on the Allow screen if needed.
 */
@Public()
@Controller('oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly auth: AuthService,
  ) {}

  @Post('register')
  register(@Body() body: any) {
    return this.oauth.register(body || {});
  }

  // The keys we carry through the consent form (everything except our own __ fields).
  private carried(src: Record<string, any>): Record<string, string> {
    const keys = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
    const out: Record<string, string> = {};
    for (const k of keys) if (src[k] != null) out[k] = String(src[k]);
    return out;
  }

  @Get('authorize')
  async authorizeGet(@Query() q: Record<string, any>, @Req() req: Request, @Res() res: Response) {
    let info;
    try {
      info = await this.oauth.validateAuthorize(q);
    } catch (e: any) {
      res.status(400).send(this.errPage(e?.message || 'Invalid authorization request'));
      return;
    }
    const session = req.cookies?.[SESSION_COOKIE];
    const user = session ? this.auth.verifyToken(session) : null;
    res.status(200).send(this.oauth.consentPage({ params: this.carried(q), clientName: info.clientName, needLogin: !user }));
  }

  @Post('authorize')
  async authorizeDecision(@Body() body: Record<string, any>, @Req() req: Request, @Res() res: Response) {
    let info;
    try {
      info = await this.oauth.validateAuthorize(body);
    } catch (e: any) {
      res.status(400).send(this.errPage(e?.message || 'Invalid authorization request'));
      return;
    }

    // Who is approving? Existing session, or the email/password typed on the consent page.
    const session = req.cookies?.[SESSION_COOKIE];
    let user = session ? this.auth.verifyToken(session) : null;
    if (!user && body.__email && body.__password) {
      try {
        const u = await this.auth.validate(String(body.__email).trim().toLowerCase(), String(body.__password));
        res.cookie(SESSION_COOKIE, this.auth.issueToken(u), cookieOpts());
        user = u;
      } catch {
        res.status(401).send(this.oauth.consentPage({ params: this.carried(body), clientName: info.clientName, needLogin: true, error: 'Incorrect email or password.' }));
        return;
      }
    }
    if (!user) {
      res.status(200).send(this.oauth.consentPage({ params: this.carried(body), clientName: info.clientName, needLogin: true, error: 'Please sign in to approve.' }));
      return;
    }

    if (body.__decision !== 'allow') {
      const u = new URL(info.redirectUri);
      u.searchParams.set('error', 'access_denied');
      if (info.state) u.searchParams.set('state', info.state);
      res.redirect(u.toString());
      return;
    }

    const url = await this.oauth.issueCode({ ...info, userId: user.id });
    res.redirect(url);
  }

  @Post('token')
  async token(@Body() body: Record<string, any>, @Res() res: Response) {
    try {
      const grant = body?.grant_type;
      const out = grant === 'refresh_token' ? await this.oauth.refresh(body) : await this.oauth.exchangeCode(body);
      res.status(200).set('Cache-Control', 'no-store').json(out);
    } catch (e: any) {
      const r = e?.response;
      res.status(400).json(typeof r === 'object' && r?.error ? r : { error: 'invalid_request', error_description: e?.message || 'token request failed' });
    }
  }

  private errPage(msg: string): string {
    return `<!doctype html><meta charset="utf-8"><body style="background:#07090f;color:#e4e4e7;font:15px ui-sans-serif,system-ui;display:grid;min-height:100vh;place-items:center;margin:0"><div style="max-width:380px;text-align:center;padding:24px"><h1 style="font-size:18px">Couldn't authorize</h1><p style="color:#a1a1aa">${msg.replace(/[<>&]/g, '')}</p></div></body>`;
  }
}
