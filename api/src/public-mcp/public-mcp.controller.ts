import { Body, Controller, Get, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { PublicMcpService } from './public-mcp.service';

/**
 * Public RAG MCP endpoint (BEA-631) at /api/mcp — token-gated, read-only, for third-party agents.
 * The owner-only management routes (config/regenerate/enable) stay behind the normal session guard.
 */
@Controller('mcp')
export class PublicMcpController {
  constructor(private readonly mcp: PublicMcpService) {}

  // ---- The public MCP endpoint (its own bearer-token auth, not the session guard) ----
  @Public()
  @Post()
  async rpc(@Req() req: Request, @Res() res: Response) {
    const auth = req.headers['authorization'];
    const presented = typeof auth === 'string' && /^Bearer\s+/i.test(auth)
      ? auth.replace(/^Bearer\s+/i, '').trim()
      : ((req.query?.token as string | undefined) || undefined);
    if (!(await this.mcp.authorize(presented))) {
      // Point OAuth clients (claude.ai connectors) at the resource metadata so they can discover
      // the sign-in flow, per RFC 9728 / the MCP auth spec. (BEA-758)
      const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || 'https';
      const host = (req.headers['x-forwarded-host'] as string) || (req.headers['host'] as string) || 'mybrain.1site.ai';
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized — send Authorization: Bearer <token>, or connect via OAuth, and enable the RAG MCP server in My Brain settings.' } });
      return;
    }
    const body: any = req.body;
    const isBatch = Array.isArray(body);
    const msgs = isBatch ? body : [body];
    const responses: any[] = [];
    for (const m of msgs) {
      const r = await this.mcp.handleRpc(m);
      if (r) responses.push(r);
    }
    if (!responses.length) { res.status(202).end(); return; } // notifications only
    res.status(200).json(isBatch ? responses : responses[0]); // MCP clients expect 200, not Nest's default 201
  }

  @Public()
  @Get()
  info(@Res() res: Response) {
    res.status(200).json({ name: 'mybrain-rag', transport: 'streamable-http', note: 'POST JSON-RPC here with Authorization: Bearer <token>.' });
  }

  // ---- Owner-only management for the settings UI (session-authed) ----
  @Get('config')
  config() { return this.mcp.config(); }

  @Put('config')
  setEnabled(@Body() body: { enabled?: boolean }) { return this.mcp.setEnabled(!!body?.enabled); }

  @Post('regenerate')
  regenerate() { return this.mcp.regenerate(); }
}
