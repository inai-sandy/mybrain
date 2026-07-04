import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { SESSION_COOKIE, cookieOpts } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 8, ttl: 60_000 } }) // brute-force guard: 8 login attempts / minute / IP (BEA-829)
  @Post('login')
  async login(
    @Body() body: { email?: string; password?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = (body?.email || '').trim().toLowerCase();
    const password = body?.password || '';
    const user = await this.auth.validate(email, password);
    res.cookie(SESSION_COOKIE, this.auth.issueToken(user), cookieOpts());
    return { ok: true, email: user.email };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: Request) {
    return { user: (req as any).user };
  }

  @Post('change-password')
  async changePassword(@Req() req: Request, @Body() body: { currentPassword?: string; newPassword?: string }) {
    const email = (req as any).user?.email;
    await this.auth.changePassword(email, body?.currentPassword || '', body?.newPassword || '');
    return { ok: true };
  }
}
