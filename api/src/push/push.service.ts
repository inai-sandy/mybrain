import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

export type PushPayload = {
  title: string;
  body: string;
  /** Where a tap lands, e.g. `/agent?focus=<waitpointId>` */
  url?: string;
  /** Same tag replaces the previous notification instead of stacking. */
  tag?: string;
  /** Direct asks always deliver; everything else respects quiet hours. */
  isAsk?: boolean;
};

const IST_OFFSET_MIN = 330;

/**
 * Web Push (BEA-1088) — real phone notifications from the PWA. VAPID keys are minted once at boot
 * and kept in the Setting table (no env plumbing); dead endpoints are pruned on send. Telegram
 * stays as the second channel — callers ping both.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly log = new Logger('Push');
  private keys: { publicKey: string; privateKey: string } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureKeys().catch((e) => this.log.warn(`vapid init failed: ${e?.message}`));
  }

  private async ensureKeys(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.keys) return this.keys;
    const [pub, priv] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: 'push.vapidPublic' } }).catch(() => null),
      this.prisma.setting.findUnique({ where: { key: 'push.vapidPrivate' } }).catch(() => null),
    ]);
    if (pub?.value && priv?.value) {
      this.keys = { publicKey: pub.value, privateKey: priv.value };
    } else {
      const fresh = webpush.generateVAPIDKeys();
      await this.prisma.setting.upsert({ where: { key: 'push.vapidPublic' }, create: { key: 'push.vapidPublic', value: fresh.publicKey }, update: { value: fresh.publicKey } });
      await this.prisma.setting.upsert({ where: { key: 'push.vapidPrivate' }, create: { key: 'push.vapidPrivate', value: fresh.privateKey }, update: { value: fresh.privateKey } });
      this.keys = fresh;
      this.log.log('minted fresh VAPID keys');
    }
    webpush.setVapidDetails('mailto:sandypublic@gmail.com', this.keys.publicKey, this.keys.privateKey);
    return this.keys;
  }

  async publicKey(): Promise<{ key: string }> {
    const k = await this.ensureKeys();
    return { key: k.publicKey };
  }

  async subscribe(sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }, userAgent?: string) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return { ok: false, message: 'Not a valid subscription' };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 200) || null },
      update: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 200) || null },
    });
    return { ok: true };
  }

  async unsubscribe(endpoint?: string) {
    if (endpoint) await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
    return { ok: true };
  }

  async count(): Promise<{ devices: number }> {
    return { devices: await this.prisma.pushSubscription.count() };
  }

  /** The current quiet-hours window, for the settings card. null/null = off. (BEA-1232) */
  async quietHours(): Promise<{ start: number | null; end: number | null }> {
    const [s, e] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: 'push.quietStart' } }).catch(() => null),
      this.prisma.setting.findUnique({ where: { key: 'push.quietEnd' } }).catch(() => null),
    ]);
    const start = s?.value === '' ? null : Number(s?.value ?? 22);
    const end = e?.value === '' ? null : Number(e?.value ?? 7);
    return { start: Number.isNaN(start as number) ? null : start, end: Number.isNaN(end as number) ? null : end };
  }

  /** Set (or clear with nulls) the quiet-hours window. Hours 0–23; asks always pass regardless. */
  async setQuietHours(start: number | null, end: number | null): Promise<{ start: number | null; end: number | null }> {
    const clean = (v: number | null) => (v === null || !Number.isFinite(v) || v < 0 || v > 23 ? '' : String(Math.floor(v)));
    const put = async (key: string, value: string) => {
      await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined);
    };
    await put('push.quietStart', clean(start));
    await put('push.quietEnd', clean(end));
    return this.quietHours();
  }

  /** Quiet hours (IST): non-ask pushes are held between quietStart and quietEnd. Asks always pass. */
  async inQuietHours(now: Date = new Date()): Promise<boolean> {
    const [s, e] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: 'push.quietStart' } }).catch(() => null),
      this.prisma.setting.findUnique({ where: { key: 'push.quietEnd' } }).catch(() => null),
    ]);
    const start = s?.value === '' ? null : Number(s?.value ?? 22);
    const end = e?.value === '' ? null : Number(e?.value ?? 7);
    if (start == null || end == null || Number.isNaN(start) || Number.isNaN(end)) return false; // quiet hours off
    const istHour = new Date(now.getTime() + IST_OFFSET_MIN * 60000).getUTCHours();
    return start > end ? istHour >= start || istHour < end : istHour >= start && istHour < end;
  }

  /** Send to every subscribed device; prunes endpoints that are gone. Returns delivery counts. */
  async send(payload: PushPayload): Promise<{ sent: number; pruned: number; held?: boolean }> {
    await this.ensureKeys();
    if (!payload.isAsk && (await this.inQuietHours())) return { sent: 0, pruned: 0, held: true };
    const subs = await this.prisma.pushSubscription.findMany();
    if (!subs.length) return { sent: 0, pruned: 0 };
    const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/agent', tag: payload.tag });
    let sent = 0;
    let pruned = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600 });
        sent++;
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await this.prisma.pushSubscription.deleteMany({ where: { endpoint: s.endpoint } }).catch(() => undefined);
          pruned++;
        } else {
          this.log.warn(`push failed (${code || e?.message})`);
        }
      }
    }
    return { sent, pruned };
  }
}
