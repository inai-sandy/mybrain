import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { AuthService, SESSION_TTL_SECONDS } from './auth.service';
import { IS_PUBLIC } from './public.decorator';
import { SESSION_ONLY } from './session-only.decorator';

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
    if (user) {
      (req as any).user = user;
      // Sliding expiry → auto-logout after inactivity.
      res.cookie(SESSION_COOKIE, this.auth.issueToken(user), cookieOpts());
      return true;
    }
    // A device key manages nothing — least of all itself. Without this, whoever holds the LEAKED key
    // could read the brand-new one out of GET /auth/device-token during the grace period and the
    // rotation would buy nothing. (DEVICE-TOKEN-ROTATION)
    const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_ONLY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (sessionOnly) throw new UnauthorizedException('Sign in on the website to manage the device key.');

    // EMO hardware: a long-lived device token in the X-Device-Token header (no cookie / no sliding expiry).
    // The route (path only — never the query string, which can carry secrets) rides along so a device
    // still on the OLD token can be named in the log. (DEVICE-TOKEN-ROTATION)
    const deviceToken = (req.headers['x-device-token'] as string) || '';
    const route = `${req.method} ${(req as any).path || (req.url || '').split('?')[0]}`;
    const owner = deviceToken && this.auth.verifyDeviceToken(deviceToken, route) ? this.auth.deviceUser() : null;
    if (owner) {
      (req as any).user = owner;
      return true;
    }
    throw new UnauthorizedException('Not signed in.');
  }
}
