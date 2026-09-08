import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { SessionOnly } from './session-only.decorator';
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

  /**
   * Owner-only: the EMO hardware device token (flashed into the firmware; sent as X-Device-Token).
   * `previous` says whether the key from before the last rotation still works, and when it was last
   * used — it NEVER carries the old token's value. (DEVICE-TOKEN-ROTATION)
   *
   * All three device-key routes are @SessionOnly(): a device key may not read or change device keys,
   * or the leaked one would just fetch its own replacement during the grace period.
   */
  @SessionOnly()
  @Get('device-token')
  async deviceToken() {
    return this.auth.deviceTokenView();
  }

  /** Rotate: mint a new token and keep the old one working for the grace period. */
  @SessionOnly()
  @Post('device-token/regenerate')
  async regenerateDeviceToken(@Body() body: { force?: boolean }) {
    const token = await this.auth.regenerateDeviceToken({ force: !!body?.force });
    return { token, previous: (await this.auth.deviceTokenView()).previous };
  }

  /** The last step of a rotation: stop the old key right now. */
  @SessionOnly()
  @Post('device-token/revoke-previous')
  async revokePreviousDeviceToken() {
    await this.auth.revokePreviousDeviceToken();
    return { ok: true, previous: null };
  }

  @Post('change-password')
  async changePassword(@Req() req: Request, @Body() body: { currentPassword?: string; newPassword?: string }) {
    const email = (req as any).user?.email;
    await this.auth.changePassword(email, body?.currentPassword || '', body?.newPassword || '');
    return { ok: true };
  }
}
