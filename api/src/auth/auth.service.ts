import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
// Auto-logout window (inactivity). Cookie is re-issued on each authenticated request.
export const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 60 * 60 * 8; // 8h

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  /** Seed the single owner account from env on first boot. */
  async onModuleInit() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) return;
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (!existing) {
      const passwordHash = await bcrypt.hash(password, 12);
      await this.prisma.user.create({ data: { email, passwordHash } });
    }
  }

  async validate(email: string, password: string): Promise<{ id: string; email: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Incorrect email or password.');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Incorrect email or password.');
    return { id: user.id, email: user.email };
  }

  issueToken(payload: { id: string; email: string }): string {
    return jwt.sign(payload, SESSION_SECRET, { expiresIn: SESSION_TTL_SECONDS });
  }

  verifyToken(token: string): { id: string; email: string } | null {
    try {
      const decoded = jwt.verify(token, SESSION_SECRET) as any;
      return { id: decoded.id, email: decoded.email };
    } catch {
      return null;
    }
  }
}
