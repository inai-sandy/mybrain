import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleService } from './google.service';
import { MemoryService } from '../memory/memory.service';

// Stores each important email (full body) in memory — RAG + SuperMemory — for whole-brain recall. (BEA-439)
type Meta = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string };

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
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
    private readonly google: GoogleService,
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
    const CONC = 4; // limited concurrency — don't hammer the gws-runner
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
}
