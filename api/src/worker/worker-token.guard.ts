import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { WorkerTokenService } from './worker-token.service';

/** The header a worker sends. `Authorization: Bearer …` is read too, for whoever reaches for it first. */
export const WORKER_TOKEN_HEADER = 'x-worker-token';

/**
 * The only way into `/api/worker/*` (BEA-1387 §C).
 *
 * The app's `AuthGuard` is a global guard with two branches — a session cookie and the EMO device
 * token — and both grant full owner identity. The worker routes are marked `@Public()` so that guard
 * steps aside, and this one takes over: it accepts a run-scoped token and NOTHING else. An owner's
 * browser session must not reach these routes, or "identity comes from the token, never the body"
 * silently stops being true and any signed-in tab could drive somebody's run.
 */
@Injectable()
export class WorkerTokenGuard implements CanActivate {
  constructor(private readonly tokens: WorkerTokenService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req: any = ctx.switchToHttp().getRequest();
    const auth = String(req?.headers?.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    const raw = bearer || req?.headers?.[WORKER_TOKEN_HEADER] || '';
    const who = raw ? this.tokens.verify(String(raw).trim()) : null;
    if (!who) throw new UnauthorizedException('This route is for a worker run, and needs its own run token.');
    // Identity comes from the token. Whatever the body says about runId/agentId is ignored.
    req.worker = who;
    return true;
  }
}
