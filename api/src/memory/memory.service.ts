import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SuperMemoryStore } from './supermemory.store';
import { RagStore } from './rag.store';

const MAX_ATTEMPTS = 3;
const DRAIN_INTERVAL_MS = Number(process.env.MEMORY_DRAIN_MS) || 5000;
const RECONCILE_INTERVAL_MS = Number(process.env.MEMORY_RECONCILE_MS) || 15 * 60 * 1000;

/** Row types that carry supermemoryId/ragId columns and should be kept in the index. */
const INDEXABLE: Array<'item' | 'idea' | 'meeting' | 'task' | 'story'> = ['item', 'idea', 'meeting', 'task', 'story'];

@Injectable()
export class MemoryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MemoryService');
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private reconciling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: SuperMemoryStore,
    private readonly rag: RagStore,
  ) {}

  onModuleInit() {
    // Background worker drains the outbox to both stores.
    this.timer = setInterval(() => this.drain().catch(() => undefined), DRAIN_INTERVAL_MS);
    // Slower safety-net: revive failed writes + re-enqueue any row that never got linked. (BEA-333)
    this.reconcileTimer = setInterval(() => this.reconcile().catch(() => undefined), RECONCILE_INTERVAL_MS);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

  /** Queue a doc for dual-write to BOTH stores (one outbox row each).
   *  `refType` + `refId` link the result back to any table (item/task/story/idea/meeting);
   *  `itemId` is kept for back-compat and implies refType 'item'. */
  async enqueue(
    content: string,
    opts: {
      itemId?: string;
      refType?: string;
      refId?: string;
      title?: string;
      tags?: string[];
      targets?: Array<'supermemory' | 'rag'>;
    } = {},
  ): Promise<void> {
    const payload = JSON.stringify({ content, title: opts.title, tags: opts.tags ?? [] });
    const refId = opts.refId ?? opts.itemId;
    const refType = opts.refType ?? (opts.itemId ? 'item' : undefined);
    const targets = opts.targets ?? ['supermemory', 'rag'];
    try {
      await this.prisma.memoryOutbox.createMany({
        data: targets.map((target) => ({ itemId: refId, refType, target, payload })),
      });
    } catch (e) {
      // Don't silently swallow: if the outbox insert itself fails the write would be lost.
      // The reconcile sweep is the backstop (it re-enqueues any null-id row), but log it loudly.
      this.log.error(`outbox enqueue failed (refType=${refType} refId=${refId}): ${(e as Error)?.message ?? e}`);
      throw e;
    }
  }

  /** Index (or re-index) a row's content into both stores. Deletes any prior docs first so an
   *  edit REPLACES rather than duplicates, then queues a fresh dual-write linked back to the row. */
  async indexEntity(opts: {
    refType: string;
    refId: string;
    content: string;
    title?: string;
    tags?: string[];
    prevSupermemoryId?: string | null;
    prevRagId?: string | null;
  }): Promise<void> {
    const text = (opts.content || '').trim();
    if (!text) return;
    if (opts.prevSupermemoryId || opts.prevRagId) {
      await this.deleteDoc(opts.prevSupermemoryId, opts.prevRagId);
    }
    await this.enqueue(text, { refType: opts.refType, refId: opts.refId, title: opts.title, tags: opts.tags });
  }

  /** Write a returned store doc id back onto the right table (item/task/story/idea/meeting). */
  private async writeBackId(refType: string | null | undefined, id: string, target: string, resultId: string) {
    const data = target === 'supermemory' ? { supermemoryId: resultId } : { ragId: resultId };
    const models: Record<string, any> = {
      item: this.prisma.item,
      task: this.prisma.task,
      story: this.prisma.story,
      idea: this.prisma.idea,
      meeting: this.prisma.meeting,
    };
    const model = models[refType || 'item'] ?? this.prisma.item;
    await model.update({ where: { id }, data }).catch(() => undefined);
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
        // Record where it landed so the UI can show per-store status — on the right table.
        if (row.itemId && resultId) {
          await this.writeBackId((row as any).refType, row.itemId, row.target, resultId);
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

  /** Per-table count of indexable rows not yet fully linked into BOTH stores. */
  async unindexedCounts(): Promise<Array<{ type: string; unindexed: number }>> {
    const out: Array<{ type: string; unindexed: number }> = [];
    for (const t of INDEXABLE) {
      const unindexed = await (this.prisma as any)[t].count({
        where: { OR: [{ ragId: null }, { supermemoryId: null }] },
      });
      if (unindexed) out.push({ type: t, unindexed });
    }
    return out;
  }

  /** Build searchable text for a row that needs re-indexing (reconcile backstop). */
  private buildContent(table: string, row: any): { content: string; title: string; tags: string[] } | null {
    const parseTags = (s: any) => {
      try {
        const a = JSON.parse(s || '[]');
        return Array.isArray(a) ? a.map((x) => String(x)) : [];
      } catch {
        return [];
      }
    };
    switch (table) {
      case 'task': {
        const parts = [row.title, row.note || '', row.category ? `Category: ${row.category}` : '', `Status: ${row.status === 'done' ? 'done' : 'open'}`, row.day ? `Day: ${row.day}` : ''].filter(Boolean);
        return { content: `Task — ${parts.join('\n')}`, title: `Task: ${row.title}`.slice(0, 120), tags: ['task', row.sphere || 'work', ...(row.category ? [String(row.category).toLowerCase()] : [])] };
      }
      case 'story':
        return { content: `His own story — ${row.day}${row.mood ? ` (mood: ${row.mood})` : ''}\n\n${row.rawText}`, title: `Your story ${row.day}`, tags: ['activity', 'story'] };
      case 'idea':
        return { content: [row.title, row.content, row.rawDump].filter(Boolean).join('\n\n'), title: row.title || 'Idea', tags: ['idea'] };
      case 'meeting': {
        const text = [row.title, row.summary, (row.transcript || '').slice(0, 6000), row.takeaways, row.decisions].filter(Boolean).join('\n\n');
        return text ? { content: text, title: row.title || 'Meeting', tags: ['meeting', ...parseTags(row.tags)] } : null;
      }
      case 'item': {
        const text = [row.title, row.summary].filter(Boolean).join('\n\n');
        return text ? { content: text, title: row.title || 'Document', tags: parseTags(row.tags) } : null;
      }
      default:
        return null;
    }
  }

  /**
   * Safety net so nothing is ever silently lost from the index. (BEA-333)
   *  (a) revives failed outbox rows, and
   *  (b) re-enqueues any indexable row missing a store id — copying existing content from the
   *      store that DOES have it when possible (so we fill the missing side without duplicating).
   */
  async reconcile(): Promise<{ retried: number; reEnqueued: number; perType: Record<string, number> }> {
    if (this.reconciling) return { retried: 0, reEnqueued: 0, perType: {} };
    this.reconciling = true;
    try {
      const { retried } = await this.retryFailed();
      let reEnqueued = 0;
      const perType: Record<string, number> = {};
      for (const table of INDEXABLE) {
        const rows = await (this.prisma as any)[table].findMany({
          where: { OR: [{ ragId: null }, { supermemoryId: null }] },
          take: 200,
        });
        for (const row of rows) {
          const missingSm = !row.supermemoryId;
          const missingRag = !row.ragId;
          if (!missingSm && !missingRag) continue;

          let content: string | undefined;
          let title: string | undefined;
          let tags: string[] | undefined;

          // Prefer copying the real content from the store that already has it.
          if (missingRag && !missingSm) {
            const sm = await this.getSuperMemoryContent(row.supermemoryId);
            if (sm?.content) {
              content = sm.content;
              title = sm.title;
              tags = sm.tags;
            }
          }
          if (!content) {
            const built = this.buildContent(table, row);
            if (!built) continue;
            content = built.content;
            title = built.title;
            tags = built.tags;
          }

          const targets: Array<'supermemory' | 'rag'> = [];
          if (missingSm) targets.push('supermemory');
          if (missingRag) targets.push('rag');
          await this.enqueue(content, { refType: table, refId: row.id, title, tags, targets }).catch(() => undefined);
          reEnqueued++;
          perType[table] = (perType[table] || 0) + 1;
        }
      }
      if (reEnqueued || retried) this.log.log(`reconcile: retried ${retried} failed, re-enqueued ${reEnqueued} unlinked rows`);
      return { retried, reEnqueued, perType };
    } finally {
      this.reconciling = false;
    }
  }

  /** Search both stores (for verification / the raw search feature). */
  async searchBoth(q: string) {
    const [sm, rag] = await Promise.allSettled([this.sm.search(q, 8), this.rag.search(q, 8)]);
    return {
      supermemory: sm.status === 'fulfilled' ? sm.value : { error: String((sm as any).reason?.message ?? sm) },
      rag: rag.status === 'fulfilled' ? rag.value : { error: String((rag as any).reason?.message ?? rag) },
    };
  }

  /** Tags on a SuperMemory result (from saved metadata, or its containerTags). */
  private smTags(r: any): string[] {
    const meta = r?.metadata?.tags;
    if (typeof meta === 'string' && meta.trim()) return meta.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (Array.isArray(r?.containerTags)) return r.containerTags;
    if (Array.isArray(r?.tags)) return r.tags;
    return [];
  }

  /**
   * Scoped semantic search for the chat. `include` = tags that MUST be present; `exclude` = tags that must be ABSENT.
   * Queries BOTH stores IN PARALLEL, merges, de-dups and re-ranks by relevance × recency × importance — so the
   * best hit is never dropped just because SuperMemory answered first. The scope stays strict (chat correctness);
   * the ONLY widening is a safe whole-brain retry when the scoped search finds literally nothing. (BEA-332)
   */
  async searchScoped(q: string, include: string[] = [], limit = 5, exclude: string[] = []): Promise<MemHit[]> {
    const scoped = include.length > 0 || exclude.length > 0;
    const inc = include.map((s) => s.toLowerCase());
    const exc = exclude.map((s) => s.toLowerCase());
    const ok = (tags: string[]): boolean => {
      const t = (tags || []).map((x) => String(x).toLowerCase());
      if (inc.length && !inc.some((x) => t.includes(x))) return false;
      if (exc.length && exc.some((x) => t.includes(x))) return false;
      return true;
    };
    // Over-fetch when scoped so post-filtering still leaves enough results.
    const fetchN = scoped ? Math.max(limit * 4, 20) : Math.max(limit, 12);
    const [smR, ragR] = await Promise.allSettled([this.sm.search(q, fetchN, include), this.rag.search(q, fetchN)]);
    const smHits = smR.status === 'fulfilled' ? (smR.value || []).filter((r) => !scoped || ok(this.smTags(r))).map((r) => this.normSm(r)) : [];
    const ragHits = ragR.status === 'fulfilled' ? (ragR.value || []).filter((r) => !scoped || ok(Array.isArray(r?.tags) ? r.tags : [])).map((r) => this.normRag(r)) : [];
    const merged = this.rerank([...smHits, ...ragHits], limit);
    // Safe fallback: a scoped query that found NOTHING widens to the whole brain (it had nothing to lose).
    if (scoped && merged.length === 0) return this.searchBrain(q, limit);
    return merged;
  }

  /** Whole-brain semantic search — both stores in parallel, merged + re-ranked, no scope. For Explore. (BEA-332) */
  async searchBrain(q: string, limit = 14): Promise<MemHit[]> {
    const fetchN = Math.max(limit, 16);
    const [smR, ragR] = await Promise.allSettled([this.sm.search(q, fetchN), this.rag.search(q, fetchN)]);
    const smHits = smR.status === 'fulfilled' ? (smR.value || []).map((r) => this.normSm(r)) : [];
    const ragHits = ragR.status === 'fulfilled' ? (ragR.value || []).map((r) => this.normRag(r)) : [];
    return this.rerank([...smHits, ...ragHits], limit);
  }

  /** Merge + de-dup + re-rank hits by relevance × recency × importance. */
  private rerank(hits: MemHit[], limit: number): MemHit[] {
    const now = Date.now();
    const importanceFor = (h: MemHit) => {
      const t = (h.tags || []).map((x) => String(x).toLowerCase());
      if (t.includes('story') || t.includes('activity')) return 0.12; // the day's context — the spine
      if (t.includes('task')) return 0.08;
      return 0;
    };
    const recencyFor = (h: MemHit) => {
      if (!h.when) return 0;
      const ageDays = (now - new Date(h.when).getTime()) / 86_400_000;
      if (!isFinite(ageDays) || ageDays < 0) return 0;
      if (ageDays <= 7) return 0.15;
      if (ageDays <= 30) return 0.08;
      if (ageDays <= 90) return 0.03;
      return 0;
    };
    const seen = new Map<string, MemHit & { _rank?: number }>();
    for (const h of hits) {
      if (!h.content) continue;
      // Content fingerprint (not store id): the dual-write means the SAME doc lives in BOTH stores
      // under different ids, so de-dup by what the text IS — this collapses those cross-store twins.
      const key = `${h.title}|${h.content.slice(0, 120)}`.toLowerCase().replace(/\s+/g, ' ').trim();
      const rank = (h.score ?? 0) * (1 + recencyFor(h) + importanceFor(h));
      const prev = seen.get(key);
      if (!prev || rank > (prev._rank ?? 0)) seen.set(key, { ...h, _rank: rank });
    }
    return [...seen.values()]
      .sort((a, b) => (b._rank ?? 0) - (a._rank ?? 0))
      .slice(0, limit)
      .map(({ _rank, ...h }) => h);
  }

  private normSm(r: any): MemHit {
    const content =
      r.content || r.chunk || (Array.isArray(r.chunks) ? r.chunks.map((c: any) => c.content || c.text || '').join(' ') : '') || r.summary || (typeof r.memory === 'string' ? r.memory : '') || '';
    return {
      memId: r.documentId || r.id || r.memoryId || r.memory?.id || undefined,
      title: r.title || r.metadata?.title || r.document?.title || '',
      content: String(content).slice(0, 4000),
      url: r.url || r.metadata?.url || undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      when: r.createdAt || r.updatedAt || r.metadata?.createdAt || undefined,
      tags: this.smTags(r),
      source: 'supermemory',
    };
  }

  private normRag(r: any): MemHit {
    const content = r.content || r.text || r.chunk || r.document || (typeof r === 'string' ? r : '') || '';
    return {
      memId: r.id || r.doc_id || undefined,
      title: r.title || r.metadata?.title || '',
      content: String(content).slice(0, 4000),
      url: r.url || r.metadata?.url || undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      when: r.createdAt || r.created_at || undefined,
      tags: Array.isArray(r?.tags) ? r.tags : [],
      source: 'rag',
    };
  }
}

export type MemHit = {
  memId?: string;
  title: string;
  content: string;
  url?: string;
  score?: number;
  when?: string;
  tags?: string[];
  source: 'supermemory' | 'rag';
};
