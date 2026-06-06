import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SuperMemoryStore } from './supermemory.store';
import { RagStore } from './rag.store';

const MAX_ATTEMPTS = 3;
const DRAIN_INTERVAL_MS = Number(process.env.MEMORY_DRAIN_MS) || 5000;

@Injectable()
export class MemoryService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: SuperMemoryStore,
    private readonly rag: RagStore,
  ) {}

  onModuleInit() {
    // Background worker drains the outbox to both stores.
    this.timer = setInterval(() => this.drain().catch(() => undefined), DRAIN_INTERVAL_MS);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Queue a doc for dual-write to BOTH stores (one outbox row each). */
  async enqueue(content: string, opts: { itemId?: string; title?: string; tags?: string[] } = {}): Promise<void> {
    const payload = JSON.stringify({ content, title: opts.title, tags: opts.tags ?? [] });
    await this.prisma.memoryOutbox.createMany({
      data: [
        { itemId: opts.itemId, target: 'supermemory', payload },
        { itemId: opts.itemId, target: 'rag', payload },
      ],
    });
  }

  /** Process pending outbox rows. Each goes to its target with retries; never leaves the two inconsistent silently. */
  async drain(): Promise<{ processed: number }> {
    // In-process lock: only one drain runs at a time (timer + manual calls never overlap → no double-writes).
    if (this.draining) return { processed: 0 };
    this.draining = true;
    try {
      return await this.drainInner();
    } finally {
      this.draining = false;
    }
  }

  private async drainInner(): Promise<{ processed: number }> {
    const pending = await this.prisma.memoryOutbox.findMany({
      where: { status: 'pending', attempts: { lt: MAX_ATTEMPTS } },
      take: 20,
      orderBy: { createdAt: 'asc' },
    });
    let processed = 0;
    for (const row of pending) {
      const p = JSON.parse(row.payload);
      try {
        let resultId: string | undefined;
        if (row.target === 'supermemory') resultId = await this.sm.save(p.content, p.tags ?? []);
        else resultId = await this.rag.save(p.content, p.title, p.tags ?? []);
        await this.prisma.memoryOutbox.update({ where: { id: row.id }, data: { status: 'done' } });
        // Record where it landed so the UI can show per-store status.
        if (row.itemId && resultId) {
          await this.prisma.item
            .update({
              where: { id: row.itemId },
              data: row.target === 'supermemory' ? { supermemoryId: resultId } : { ragId: resultId },
            })
            .catch(() => undefined);
        }
        processed++;
      } catch (e: any) {
        const attempts = row.attempts + 1;
        await this.prisma.memoryOutbox.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: String(e?.message ?? e).slice(0, 500),
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          },
        });
      }
    }
    return { processed };
  }

  /** Full content of one SuperMemory doc (graceful). */
  async getSuperMemoryContent(id: string) {
    try {
      return await this.sm.getContent(id);
    } catch {
      return null;
    }
  }

  /** Browse the user's existing SuperMemory documents (graceful on failure). */
  async browseSuperMemory(limit = 50, page = 1): Promise<{ total: number; docs: any[] }> {
    try {
      return await this.sm.list(limit, page);
    } catch {
      return { total: 0, docs: [] };
    }
  }

  /** Delete a doc from both stores (best-effort; never throws). */
  async deleteDoc(supermemoryId?: string | null, ragId?: string | null): Promise<void> {
    if (supermemoryId) await this.sm.delete(supermemoryId).catch(() => undefined);
    if (ragId) await this.rag.delete(ragId).catch(() => undefined);
  }

  async status() {
    const grouped = await this.prisma.memoryOutbox.groupBy({ by: ['status'], _count: { _all: true } });
    return grouped.map((g) => ({ status: g.status, count: g._count._all }));
  }

  /** Search both stores (for verification / the search feature). */
  async searchBoth(q: string) {
    const [sm, rag] = await Promise.allSettled([this.sm.search(q, 3), this.rag.search(q, 3)]);
    return {
      supermemory: sm.status === 'fulfilled' ? sm.value : { error: String((sm as any).reason?.message ?? sm) },
      rag: rag.status === 'fulfilled' ? rag.value : { error: String((rag as any).reason?.message ?? rag) },
    };
  }
}
