import { BadRequestException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
// Auto-logout window (inactivity). Cookie is re-issued on each authenticated request.
export const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 60 * 60 * 8; // 8h

@Injectable()
export class AuthService implements OnModuleInit {
  private _deviceToken: string | null = null;
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
    let dt = (await this.prisma.setting.findUnique({ where: { key: 'emo.device.token' } }).catch(() => null))?.value || null;
    if (!dt) {
      dt = 'emod_' + randomBytes(24).toString('hex');
      await this.prisma.setting.upsert({ where: { key: 'emo.device.token' }, create: { key: 'emo.device.token', value: dt }, update: {} }).catch(() => undefined);
    }
    this._deviceToken = dt;
    this._owner = await this.prisma.user.findFirst({ select: { id: true, email: true } }).catch(() => null);
  }

  /** The EMO device token (owner-only; flashed into the firmware). */
  async getDeviceToken(): Promise<string> {
    if (!this._deviceToken) await this.onModuleInit();
    return this._deviceToken || '';
  }
  /** Constant-time verify of the X-Device-Token header. */
  verifyDeviceToken(presented: string | undefined): boolean {
    if (!presented || !this._deviceToken) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this._deviceToken);
    return a.length === b.length && timingSafeEqual(a, b);
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
