import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleWorkspaceService } from './google-workspace.service';
import { MemoryService } from '../memory/memory.service';
import { isBlockedSender, senderAddress } from './email-senders';

// Stores each important email (full body) in memory — RAG + SuperMemory — for whole-brain recall. (BEA-439)
type Meta = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string };

// IST day key — the backfill must tag/query emails by the SAME day the Gmail brief uses (IST), or
// EmailMemory.day ends up with two vocabularies and the Lab's per-day email lookup misses them. (BEA-812)
function ymd(d: Date): string {
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
function parseDate(s?: string): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

@Injectable()
export class EmailMemoryService implements OnModuleInit {
  private readonly log = new Logger('EmailMemoryService');
  private backfilling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleWorkspaceService,
    private readonly memory: MemoryService,
  ) {}

  onModuleInit() {
    // One-time backfill of recent important emails when the store is empty. Delayed + guarded + bounded
    // so it can never loop or hammer the runner on boot.
    setTimeout(() => this.maybeBackfill().catch((e) => this.log.warn(`email backfill skipped: ${e?.message ?? e}`)), 20_000);
  }

  /** Store + index ONE important email (full body). Upsert by Gmail message id so re-syncs don't dupe. */
  async syncOne(day: string, m: Meta): Promise<boolean> {
    if (!this.memory.sourceEnabled('email')) return false;
    // Gmail's "important" flag is Google's guess, not the owner's. If a human cannot receive a
    // reply, or the owner has blocked that sender, it never enters the brain. (BEA-1125/1126)
    if (isBlockedSender(m.from, await this.blockedSenders())) return false;
    try {
      const existing = await this.prisma.emailMemory.findUnique({ where: { id: m.id } });
      const body = await this.google.gmailMessageFull(m.id).catch(() => existing?.body || m.snippet || '');
      const row = await this.prisma.emailMemory.upsert({
        where: { id: m.id },
        create: { id: m.id, threadId: m.threadId || m.id, fromAddr: m.from || '', subject: m.subject || '(no subject)', day, sentAt: parseDate(m.date), snippet: m.snippet || '', body },
        update: { fromAddr: m.from || '', subject: m.subject || '(no subject)', day, sentAt: parseDate(m.date), snippet: m.snippet || '', body },
      });
      await this.memory.indexEmail(row); // → RAG + SuperMemory
      return true;
    } catch (e) {
      this.log.warn(`email sync failed (${m.id}): ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /** Sync every important email for a day (uses the provided metas, or fetches them). */
  async syncDay(day: string, metas?: Meta[]): Promise<number> {
    if (!this.memory.sourceEnabled('email')) return 0;
    const list = metas ?? (await this.google.gmailImportantForDay(day, 40).catch(() => [] as Meta[]));
    let n = 0;
    const CONC = 4; // limited concurrency — don't hammer Google
    for (let i = 0; i < list.length; i += CONC) {
      const oks = await Promise.all(list.slice(i, i + CONC).map((m) => this.syncOne(day, m)));
      n += oks.filter(Boolean).length;
    }
    return n;
  }

  /** One-time, bounded backfill of the last `days` days of important emails. */
  async backfill(days = 30): Promise<number> {
    if (this.backfilling) return 0;
    this.backfilling = true;
    let total = 0;
    try {
      for (let i = 0; i < days; i++) {
        total += await this.syncDay(ymd(new Date(Date.now() - i * 86_400_000)));
        if (total > 1500) {
          this.log.warn('email backfill cap (1500) reached — stopping');
          break;
        }
      }
      this.log.log(`email backfill done: ${total} important emails indexed over ${days}d`);
    } finally {
      this.backfilling = false;
    }
    return total;
  }

  private async maybeBackfill(): Promise<void> {
    if ((await this.prisma.emailMemory.count()) > 0) return; // already populated — nightly keeps it current
    if (!this.memory.sourceEnabled('email')) return;
    const st = await this.google.status().catch(() => ({ connected: false }) as any);
    if (!st?.connected) {
      this.log.log('email backfill skipped: Google not connected');
      return;
    }
    void this.backfill(30);
  }

  /** Addresses the owner has blocked by hand, on top of the automatic no-reply rule. (BEA-1126) */
  async blockedSenders(): Promise<string[]> {
    // Defensive on purpose: a lookup failure must never stop mail being captured, and must never
    // throw synchronously into the sync path.
    try {
      const row = await this.prisma.setting?.findUnique({ where: { key: 'email.blockedSenders' } }).catch(() => null);
      if (!row?.value) return [];
      const a = JSON.parse(row.value);
      return Array.isArray(a) ? a.filter((x: unknown) => typeof x === 'string').map((x: string) => senderAddress(x)).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Sweep out email already in the brain that the rules would now refuse. Reports first when
   * `dryRun`, so nothing of the owner's is deleted before he has seen exactly what goes.
   * Deletion-only — no AI cost. (BEA-1125)
   */
  async purgeBlocked(dryRun = false): Promise<{ removed: number; senders: { from: string; count: number }[] }> {
    const blocked = await this.blockedSenders();
    const rows = await this.prisma.emailMemory.findMany({ select: { id: true, fromAddr: true, supermemoryId: true, ragId: true } });
    const doomed = rows.filter((r) => isBlockedSender(r.fromAddr, blocked));
    const bySender = new Map<string, number>();
    for (const r of doomed) {
      const a = senderAddress(r.fromAddr) || '(unknown)';
      bySender.set(a, (bySender.get(a) || 0) + 1);
    }
    const senders = [...bySender.entries()].map(([from, count]) => ({ from, count })).sort((a, b) => b.count - a.count);
    if (dryRun) return { removed: doomed.length, senders };
    for (const r of doomed) {
      await this.memory.deleteDoc(r.supermemoryId, r.ragId).catch(() => undefined);
      await this.prisma.emailMemory.delete({ where: { id: r.id } }).catch(() => undefined);
    }
    if (doomed.length) this.log.log(`purged ${doomed.length} blocked email(s) from ${senders.length} sender(s)`);
    return { removed: doomed.length, senders };
  }

  /** Every sender in the brain with how many of theirs are stored — the owner's decision surface. */
  async senderBreakdown(): Promise<{ total: number; blocked: string[]; senders: { from: string; count: number; blocked: boolean }[] }> {
    const [rows, blocked] = await Promise.all([
      this.prisma.emailMemory.findMany({ select: { fromAddr: true } }),
      this.blockedSenders(),
    ]);
    const counts = new Map<string, number>();
    for (const r of rows) {
      const a = senderAddress(r.fromAddr) || '(unknown)';
      counts.set(a, (counts.get(a) || 0) + 1);
    }
    const senders = [...counts.entries()]
      .map(([from, count]) => ({ from, count, blocked: blocked.includes(from) }))
      .sort((a, b) => b.count - a.count);
    return { total: rows.length, blocked, senders };
  }

  /** Block or unblock one sender. Blocking also sweeps their mail out of the brain. (BEA-1126) */
  async setSenderBlocked(from: string, on: boolean): Promise<{ blocked: string[]; removed: number }> {
    const addr = senderAddress(from);
    if (!addr) return { blocked: await this.blockedSenders(), removed: 0 };
    const current = new Set(await this.blockedSenders());
    if (on) current.add(addr);
    else current.delete(addr);
    const next = [...current];
    await this.prisma.setting.upsert({
      where: { key: 'email.blockedSenders' },
      create: { key: 'email.blockedSenders', value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    });
    // Blocking removes what is already stored; unblocking never resurrects it (we don't keep it).
    const removed = on ? (await this.purgeBlocked()).removed : 0;
    return { blocked: next, removed };
  }
}
