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

  /** Reset failed outbox rows back to pending so the drain reprocesses them. */
  async retryFailed(): Promise<{ retried: number }> {
    const res = await this.prisma.memoryOutbox.updateMany({
      where: { status: 'failed' },
      data: { status: 'pending', attempts: 0, lastError: null },
    });
    return { retried: res.count };
  }

  /** Search both stores (for verification / the search feature). */
  async searchBoth(q: string) {
    const [sm, rag] = await Promise.allSettled([this.sm.search(q, 3), this.rag.search(q, 3)]);
    return {
      supermemory: sm.status === 'fulfilled' ? sm.value : { error: String((sm as any).reason?.message ?? sm) },
      rag: rag.status === 'fulfilled' ? rag.value : { error: String((rag as any).reason?.message ?? rag) },
    };
  }

  /** Scoped semantic search for the chat: SuperMemory (tag-filtered) first, RAG as fallback. Returns normalized snippets. */
  async searchScoped(q: string, tags: string[] = [], limit = 5): Promise<MemHit[]> {
    try {
      const sm = await this.sm.search(q, limit, tags);
      const norm = (sm || []).map((r) => this.normSm(r)).filter((x) => x.content);
      if (norm.length) return norm;
    } catch {
      /* fall through to RAG */
    }
    try {
      const rag = await this.rag.search(q, limit);
      return (rag || []).map((r) => this.normRag(r)).filter((x) => x.content);
    } catch {
      return [];
    }
  }

  private normSm(r: any): MemHit {
    const content =
      r.content || r.chunk || (Array.isArray(r.chunks) ? r.chunks.map((c: any) => c.content || c.text || '').join(' ') : '') || r.summary || (typeof r.memory === 'string' ? r.memory : '') || '';
    return {
      memId: r.documentId || r.id || r.memoryId || r.memory?.id || undefined,
      title: r.title || r.metadata?.title || r.document?.title || '',
      content: String(content).slice(0, 1500),
      url: r.url || r.metadata?.url || undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      source: 'supermemory',
    };
  }

  private normRag(r: any): MemHit {
    const content = r.content || r.text || r.chunk || r.document || (typeof r === 'string' ? r : '') || '';
    return {
      memId: r.id || r.doc_id || undefined,
      title: r.title || r.metadata?.title || '',
      content: String(content).slice(0, 1500),
      url: r.url || r.metadata?.url || undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      source: 'rag',
    };
  }
}

export type MemHit = { memId?: string; title: string; content: string; url?: string; score?: number; source: 'supermemory' | 'rag' };
