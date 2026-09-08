import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
// Auto-logout window (inactivity). Cookie is re-issued on each authenticated request.
export const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 60 * 60 * 8; // 8h

// EMO device token rotation (DEVICE-TOKEN-ROTATION). The token is shared by every prototype and was
// exposed in a public firmware repo, so rotating it must NOT lock out the boards that are still on
// the old firmware. Two tokens are live at once: the current one, and the previous one until its
// deadline. Keys, all in `Setting`:
export const DEVICE_TOKEN_KEY = 'emo.device.token';
export const DEVICE_TOKEN_PREV_KEY = 'emo.device.token.prev';
export const DEVICE_TOKEN_PREV_UNTIL_KEY = 'emo.device.token.prev.until';
export const DEVICE_TOKEN_PREV_LASTSEEN_KEY = 'emo.device.token.prev.lastseen';
export const DEVICE_TOKEN_PREV_COUNT_KEY = 'emo.device.token.prev.count';
/** How long the old token keeps working after a rotation. */
export const DEVICE_TOKEN_GRACE_DAYS = 30;

/** What the owner is shown about the previous token. NEVER carries the token value itself. */
export type PreviousDeviceToken = {
  /** true while the old token still authenticates (deadline in the future). */
  active: boolean;
  /** ISO deadline — after this the old token is refused. */
  until: string | null;
  /** ISO time of the last request that authenticated with the old token, or null if never. */
  lastSeenAt: string | null;
  /** How many requests have authenticated with the old token since the rotation. */
  count: number;
};

export type DeviceTokenView = { token: string; previous: PreviousDeviceToken | null };

const mintDeviceToken = () => 'emod_' + randomBytes(24).toString('hex');

/** Compare in constant time against one candidate. A null candidate never matches. */
function constantTimeEquals(presented: Buffer, candidate: string | null): boolean {
  if (!candidate) return false;
  const b = Buffer.from(candidate);
  return presented.length === b.length && timingSafeEqual(presented, b);
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger('DeviceAuth');
  private _deviceToken: string | null = null;
  private _prevToken: string | null = null;
  private _prevUntil: number | null = null; // epoch ms
  private _prevLastSeen: string | null = null;
  private _prevCount = 0;
  /** Test hook: the in-flight write of the previous-token sighting (verify itself stays sync). */
  prevUseWrite: Promise<void> = Promise.resolve();
  private _owner: { id: string; email: string } | null = null;
  constructor(private readonly prisma: PrismaService) {}

  /** Seed the single owner account from env on first boot; ensure the EMO device token. */
  async onModuleInit() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (email && password) {
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (!existing) {
        const passwordHash = await bcrypt.hash(password, 12);
        await this.prisma.user.create({ data: { email, passwordHash } });
      }
    }
    // EMO hardware device token — long-lived; the device sends it as the X-Device-Token header (BEA-895).
    let dt = (await this.readSetting(DEVICE_TOKEN_KEY)) || null;
    if (!dt) {
      dt = mintDeviceToken();
      await this.prisma.setting.upsert({ where: { key: DEVICE_TOKEN_KEY }, create: { key: DEVICE_TOKEN_KEY, value: dt }, update: {} }).catch(() => undefined);
    }
    this._deviceToken = dt;
    await this.loadPrevious();
    this._owner = await this.prisma.user.findFirst({ select: { id: true, email: true } }).catch(() => null);
  }

  private async readSetting(key: string): Promise<string> {
    return (await this.prisma.setting.findUnique({ where: { key } }).catch(() => null))?.value || '';
  }
  private async writeSetting(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined);
  }
  /** Pull the previous token + its deadline and usage into memory (verify must stay synchronous). */
  private async loadPrevious(): Promise<void> {
    this._prevToken = (await this.readSetting(DEVICE_TOKEN_PREV_KEY)) || null;
    const until = await this.readSetting(DEVICE_TOKEN_PREV_UNTIL_KEY);
    const at = until ? Date.parse(until) : NaN;
    this._prevUntil = Number.isFinite(at) ? at : null;
    this._prevLastSeen = (await this.readSetting(DEVICE_TOKEN_PREV_LASTSEEN_KEY)) || null;
    this._prevCount = Number(await this.readSetting(DEVICE_TOKEN_PREV_COUNT_KEY)) || 0;
  }

  /** The EMO device token (owner-only; flashed into the firmware). */
  async getDeviceToken(): Promise<string> {
    if (!this._deviceToken) await this.onModuleInit();
    return this._deviceToken || '';
  }

  /** What the owner sees: the current token, plus the previous one's deadline and usage (never its value). */
  async deviceTokenView(): Promise<DeviceTokenView> {
    const token = await this.getDeviceToken();
    return { token, previous: this.previousView() };
  }

  private previousView(): PreviousDeviceToken | null {
    if (!this._prevToken) return null;
    return {
      active: this.previousIsLive(),
      until: this._prevUntil ? new Date(this._prevUntil).toISOString() : null,
      lastSeenAt: this._prevLastSeen,
      count: this._prevCount,
    };
  }

  private previousIsLive(): boolean {
    return !!this._prevToken && this._prevUntil !== null && Date.now() < this._prevUntil;
  }

  /**
   * Rotate: the current token becomes the PREVIOUS one for a grace period, and a fresh current token
   * is minted. Devices still on the old firmware keep working until the deadline — flash them, then
   * call `revokePreviousDeviceToken()` to kill the old key for good.
   */
  async regenerateDeviceToken(opts?: { force?: boolean }): Promise<string> {
    // A second rotation would push the FIRST old key out of the grace period on the spot — the exact
    // lockout this feature exists to prevent. Say so instead of doing it quietly; `force` is the
    // owner deliberately accepting that (a fresh leak).
    if (this.previousIsLive() && !opts?.force) {
      const until = this._prevUntil ? new Date(this._prevUntil).toISOString() : '';
      throw new BadRequestException(
        `The key from your last rotation still works until ${until}. Rotating again now would stop it immediately and lock out any device still on it — revoke it first, or rotate again with force.`,
      );
    }
    const current = await this.getDeviceToken();
    const dt = mintDeviceToken();
    const until = new Date(Date.now() + DEVICE_TOKEN_GRACE_DAYS * 24 * 60 * 60 * 1000);
    if (current) {
      await this.writeSetting(DEVICE_TOKEN_PREV_KEY, current);
      await this.writeSetting(DEVICE_TOKEN_PREV_UNTIL_KEY, until.toISOString());
      await this.writeSetting(DEVICE_TOKEN_PREV_LASTSEEN_KEY, '');
      await this.writeSetting(DEVICE_TOKEN_PREV_COUNT_KEY, '0');
      this._prevToken = current;
      this._prevUntil = until.getTime();
      this._prevLastSeen = null;
      this._prevCount = 0;
    }
    await this.prisma.setting.upsert({ where: { key: DEVICE_TOKEN_KEY }, create: { key: DEVICE_TOKEN_KEY, value: dt }, update: { value: dt } });
    this._deviceToken = dt;
    this.log.log(`EMO device token rotated. The old key keeps working until ${until.toISOString()} — flash every device, then revoke it.`);
    return dt;
  }

  /** The last step of a rotation: the old key stops working right now. */
  async revokePreviousDeviceToken(): Promise<void> {
    await this.writeSetting(DEVICE_TOKEN_PREV_KEY, '');
    await this.writeSetting(DEVICE_TOKEN_PREV_UNTIL_KEY, '');
    await this.writeSetting(DEVICE_TOKEN_PREV_LASTSEEN_KEY, '');
    await this.writeSetting(DEVICE_TOKEN_PREV_COUNT_KEY, '0');
    this._prevToken = null;
    this._prevUntil = null;
    this._prevLastSeen = null;
    this._prevCount = 0;
    this.log.log('Previous EMO device token revoked — only the current key works now.');
  }

  /**
   * Constant-time verify of the X-Device-Token header. Either the current token or (until its
   * deadline) the previous one is accepted. Both candidates are always compared — there is no early
   * return that would leak which one matched.
   */
  verifyDeviceToken(presented: string | undefined, route?: string): boolean {
    if (!presented) return false;
    const a = Buffer.from(presented);
    const prevLive = this.previousIsLive();
    const currentOk = constantTimeEquals(a, this._deviceToken);
    const previousOk = constantTimeEquals(a, prevLive ? this._prevToken : null);
    if (currentOk) return true;
    if (previousOk) {
      // The owner needs to know WHICH device is still on the old firmware before he revokes the key.
      this.log.log(`EMO device signed in with the PREVIOUS device token — ${route || 'unknown route'}. This device still runs the old firmware; update it before you revoke the old key.`);
      this.notePreviousUse();
      return true;
    }
    return false;
  }

  /**
   * Remember that the old key was used, so Settings can say when it is safe to revoke. The counters
   * move in memory at once (the guard is synchronous) and the rows are written behind a QUEUE — two
   * devices calling in the same tick would otherwise race, and the owner decides when to revoke off
   * this timestamp, so it must never go backwards.
   */
  private notePreviousUse(): void {
    const at = new Date().toISOString();
    this._prevLastSeen = at;
    this._prevCount += 1;
    const count = this._prevCount;
    this.prevUseWrite = this.prevUseWrite
      .then(() => this.writeSetting(DEVICE_TOKEN_PREV_LASTSEEN_KEY, at))
      .then(() => this.writeSetting(DEVICE_TOKEN_PREV_COUNT_KEY, String(count)))
      .catch(() => undefined);
  }
  /** The owner identity the device acts as. */
  deviceUser(): { id: string; email: string } | null {
    return this._owner;
  }

  async validate(email: string, password: string): Promise<{ id: string; email: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Incorrect email or password.');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Incorrect email or password.');
    return { id: user.id, email: user.email };
  }

  async changePassword(email: string, current: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) throw new BadRequestException('New password must be at least 8 characters.');
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Not signed in.');
    const ok = await bcrypt.compare(current, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect.');
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  }

  issueToken(payload: { id: string; email: string }): string {
    // typ:'session' marks this as a login token (vs the OAuth access/refresh tokens signed with the
    // same secret). New tokens carry it; verifyToken doesn't require it, so existing cookies keep working.
    return jwt.sign({ ...payload, typ: 'session' }, SESSION_SECRET, { expiresIn: SESSION_TTL_SECONDS });
  }

  verifyToken(token: string): { id: string; email: string } | null {
    try {
      const decoded = jwt.verify(token, SESSION_SECRET) as any;
      // The OAuth server signs read-only MCP access/refresh tokens with this SAME secret. Without this
      // check a connector token could be replayed as a full login cookie. Reject anything that looks
      // like an OAuth token (typ:'access'/'refresh' or aud:'mcp'), and require real session claims. (BEA-777)
      if (decoded.typ === 'access' || decoded.typ === 'refresh' || decoded.aud === 'mcp') return null;
      if (!decoded.id || !decoded.email) return null;
      return { id: decoded.id, email: decoded.email };
    } catch {
      return null;
    }
  }
}
