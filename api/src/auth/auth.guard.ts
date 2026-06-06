import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { AuthService, SESSION_TTL_SECONDS } from './auth.service';
import { IS_PUBLIC } from './public.decorator';

export const SESSION_COOKIE = 'mb_session';

export function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const token = (req as any).cookies?.[SESSION_COOKIE];
    const user = token ? this.auth.verifyToken(token) : null;
    if (!user) throw new UnauthorizedException('Not signed in.');
    (req as any).user = user;
    // Sliding expiry → auto-logout after inactivity.
    res.cookie(SESSION_COOKIE, this.auth.issueToken(user), cookieOpts());
    return true;
  }
}
