import { BadRequestException, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SuperMemoryStore } from './supermemory.store';
import { RagStore } from './rag.store';

const MAX_ATTEMPTS = 3;
const DRAIN_INTERVAL_MS = Number(process.env.MEMORY_DRAIN_MS) || 5000;
const RECONCILE_INTERVAL_MS = Number(process.env.MEMORY_RECONCILE_MS) || 15 * 60 * 1000;

/**
 * The manageable index sections. `model` = the Prisma delegate name, `pk` = its primary-key field
 * (GmailBrief is keyed by `day`, not `id`). `mandatory` sections are always on and can't be disabled.
 */
// cadence = WHEN it indexes: live (on save) · on-update (re-indexes when it regenerates) · nightly (finalized at night)
type Cadence = 'live' | 'on-update' | 'nightly';
type SourceMeta = { label: string; model: string; pk: string; defaultDisabled?: boolean; mandatory?: boolean; manageable?: boolean; cadence?: Cadence };
const SOURCE_META: Record<string, SourceMeta> = {
  task: { label: 'Tasks', model: 'task', pk: 'id', cadence: 'live' },
  story: { label: 'Stories & Daily', model: 'story', pk: 'id', cadence: 'live' },
  item: { label: 'Documents & Bookmarks', model: 'item', pk: 'id', cadence: 'live' },
  idea: { label: 'Ideas', model: 'idea', pk: 'id', cadence: 'live' },
  meeting: { label: 'Meetings', model: 'meeting', pk: 'id', cadence: 'live' },
  note: { label: 'Notes', model: 'note', pk: 'id', defaultDisabled: true, cadence: 'live' },
  // Vault — LABELS ONLY (BEA-368). Index the searchable metadata so items are findable from the brain;
  // the encrypted secret is NEVER indexed (see buildVaultIndexText). User-toggleable; default on.
  vault: { label: 'Vault (labels only)', model: 'vaultItem', pk: 'id', cadence: 'live' },
  gmailbrief: { label: 'Daily Email Brief', model: 'gmailBrief', pk: 'day', mandatory: true, cadence: 'nightly' },
  gmailrequest: { label: 'Email Requests', model: 'gmailRequest', pk: 'id', mandatory: true, cadence: 'live' },
  // Each important email stored in memory, full body (BEA-439). User-toggleable; default on.
  email: { label: 'Important Emails', model: 'emailMemory', pk: 'id', cadence: 'nightly' },
  // Derived day-context (regenerate from the user's story) — indexed + reconciled, but not shown as
  // separate toggles in the manager (they follow the 'story' section). manageable:false. (BEA-342)
  daysummary: { label: 'Day summaries', model: 'daySummary', pk: 'id', manageable: false, cadence: 'on-update' },
  daystory: { label: 'Story of the Day', model: 'dayStory', pk: 'id', manageable: false, cadence: 'on-update' },
  monthstory: { label: 'Month stories', model: 'monthStory', pk: 'id', manageable: false, cadence: 'on-update' },
  yearstory: { label: 'Year stories', model: 'yearStory', pk: 'id', manageable: false, cadence: 'on-update' },
};
const ALL_SOURCES = Object.keys(SOURCE_META);

// Human label per vault type, for readable index text (kept in sync with the web `types.ts`).
const VAULT_TYPE_LABEL: Record<string, string> = {
  login: 'Login', note: 'Secure note', card: 'Payment card', bank: 'Bank account', crypto: 'Crypto wallet',
  identity: 'Identity', apisecret: 'API secret', document: 'Document', license: 'Software license', wifi: 'Wi-Fi', membership: 'Membership',
};

/**
 * Build the LABEL-ONLY index text for a vault row (BEA-368). SECURITY: this reads ONLY the plaintext
 * metadata columns — title, type, website, username, cardType, bankName, collection, tags. It must
 * NEVER touch `blob` (the encrypted secret) or any decrypted value. Anything added here is sent to
 * RAG + SuperMemory + the embedding API, so it must stay metadata-only.
 */
export function buildVaultIndexText(row: {
  type: string; title?: string | null; website?: string | null; username?: string | null;
  cardType?: string | null; bankName?: string | null; collection?: string | null; tags?: string | null;
}): { content: string; title: string; tags: string[] } {
  const typeLabel = VAULT_TYPE_LABEL[row.type] || 'Vault item';
  const name = (row.title || '').trim() || typeLabel;
  const lines = [
    `Vault — ${typeLabel}: ${name}`,
    row.website ? `Website: ${row.website}` : '',
    row.username ? `Username: ${row.username}` : '',
    row.cardType ? `Card: ${row.cardType}` : '',
    row.bankName ? `Bank: ${row.bankName}` : '',
    row.collection ? `Collection: ${row.collection}` : '',
    row.tags ? `Tags: ${row.tags}` : '',
  ].filter(Boolean);
  const userTags = (row.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  return { content: lines.join('\n'), title: `Vault: ${name}`.slice(0, 120), tags: ['vault', row.type, ...userTags] };
}

/** A real in-app deep-link + display type for a resolved source row. Shared by Explore + Chat. (BEA-373) */
export function deepLinkFor(ent: { type: string; id: string; day?: string }): { link: string; sourceType: string } {
  switch (ent.type) {
    case 'item':
      return { link: `/doc/${ent.id}`, sourceType: 'document' };
    case 'idea':
      return { link: `/ideas/${ent.id}`, sourceType: 'idea' };
    case 'meeting':
      return { link: `/meeting/${ent.id}`, sourceType: 'meeting' };
    case 'story':
      return { link: ent.day ? `/activity?day=${ent.day}` : '/activity', sourceType: 'story' };
    case 'task':
      return { link: '/tasks', sourceType: 'task' };
    case 'note':
      return { link: '/notes', sourceType: 'note' };
    case 'vault':
      return { link: `/vault?item=${ent.id}`, sourceType: 'vault' };
    case 'gmailbrief':
    case 'gmailrequest':
    case 'email':
      return { link: '/google/gmail', sourceType: 'email' };
    default:
      return { link: '/explore', sourceType: 'document' };
  }
}

@Injectable()
export class MemoryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MemoryService');
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private reconciling = false;
  /** type -> enabled, cached so the index gate doesn't hit the DB on every write. */
  private enabled = new Map<string, boolean>();
  /** type -> last time we bumped lastIndexedAt, to throttle those writes. */
  private lastBump = new Map<string, number>();
  /** Progress of the one-time re-chunk optimize job. (BEA-337) */
  private rechunk = { running: false, total: 0, done: 0, rechunked: 0, skipped: 0, startedAt: 0, finishedAt: 0 };

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
    // Load (and seed) the per-section enable flags. (BEA-335)
    this.loadSources().catch((e) => this.log.warn(`source load failed: ${e?.message ?? e}`));
  }

  /** Prisma delegate + primary-key field for a source type (handles camelCase + non-`id` PKs). */
  private modelOf(type: string): any {
    return (this.prisma as any)[SOURCE_META[type]?.model ?? type];
  }
  private pkOf(type: string): string {
    return SOURCE_META[type]?.pk ?? 'id';
  }

  /** Seed IndexSource rows (first run) and populate the enabled cache. */
  private async loadSources(): Promise<void> {
    for (const type of ALL_SOURCES) {
      const meta = SOURCE_META[type];
      const def = meta.mandatory ? true : !meta.defaultDisabled;
      const row = await this.prisma.indexSource
        .upsert({ where: { type }, create: { type, enabled: def }, update: meta.mandatory ? { enabled: true } : {} })
        .catch(() => ({ type, enabled: def }) as any);
      this.enabled.set(type, meta.mandatory ? true : row.enabled);
    }
  }

  /** Is this section currently indexed? (mandatory = always; defaults: everything on except Notes). */
  sourceEnabled(type?: string): boolean {
    if (!type) return true;
    const meta = SOURCE_META[type];
    if (meta?.mandatory || meta?.manageable === false) return true; // always-on / not user-toggleable
    if (this.enabled.has(type)) return this.enabled.get(type)!;
    return !meta?.defaultDisabled;
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
    // Respect the per-section toggle — a disabled section is not indexed. (BEA-335)
    if (!this.sourceEnabled(opts.refType)) return;
    if (opts.prevSupermemoryId || opts.prevRagId) {
      await this.deleteDoc(opts.prevSupermemoryId, opts.prevRagId);
    }
    await this.enqueue(text, { refType: opts.refType, refId: opts.refId, title: opts.title, tags: opts.tags });
  }

  /**
   * Index (or re-index) a vault item's LABELS ONLY (BEA-368). The encrypted secret is never passed.
   * Best-effort: indexing must never block or fail the vault write. Respects the section toggle.
   */
  async indexVaultItem(row: any): Promise<void> {
    try {
      const built = buildVaultIndexText(row);
      await this.indexEntity({ refType: 'vault', refId: row.id, content: built.content, title: built.title, tags: built.tags, prevSupermemoryId: row.supermemoryId, prevRagId: row.ragId });
    } catch (e) {
      this.log.warn(`vault index failed (${row?.id}): ${(e as Error)?.message ?? e}`);
    }
  }

  /** Index (or re-index) one important email's full content into both stores (BEA-439). Best-effort. */
  async indexEmail(row: any): Promise<void> {
    try {
      const built = this.buildContent('email', row);
      if (!built) return;
      await this.indexEntity({ refType: 'email', refId: row.id, content: built.content, title: built.title, tags: built.tags, prevSupermemoryId: row.supermemoryId, prevRagId: row.ragId });
    } catch (e) {
      this.log.warn(`email index failed (${row?.id}): ${(e as Error)?.message ?? e}`);
    }
  }

  /** Write a returned store doc id back onto the right table (by its delegate + primary key). */
  private async writeBackId(refType: string | null | undefined, id: string, target: string, resultId: string) {
    const data = target === 'supermemory' ? { supermemoryId: resultId } : { ragId: resultId };
    const type = refType || 'item';
    await this.modelOf(type)
      .update({ where: { [this.pkOf(type)]: id }, data })
      .catch(() => undefined);
    this.bumpLastIndexed(refType);
  }

  /** Record that a section was just indexed (throttled to ~once/30s per type). (BEA-335) */
  private bumpLastIndexed(refType: string | null | undefined) {
    const type = refType || 'item';
    if (!ALL_SOURCES.includes(type)) return;
    const now = Date.now();
    if (now - (this.lastBump.get(type) || 0) < 30_000) return;
    this.lastBump.set(type, now);
    this.prisma.indexSource
      .upsert({ where: { type }, create: { type, enabled: !SOURCE_META[type]?.defaultDisabled, lastIndexedAt: new Date() }, update: { lastIndexedAt: new Date() } })
      .catch(() => undefined);
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

  /** Delete EVERY task-type doc from both stores (so the caller can re-index a clean set). Deletion only. (BEA-549) */
  async deleteAllTaskDocs(): Promise<{ sm: number; rag: number }> {
    const isTaskDoc = (d: { title?: string; tags?: string[] }) =>
      (d.tags || []).map((t) => String(t).toLowerCase()).includes('task') || String(d.title || '').startsWith('Task:');
    // SuperMemory: collect all task ids across pages first (deletion shifts pages), then delete.
    const smIds: string[] = [];
    for (let page = 1; page <= 500; page++) {
      const { docs, total } = await this.sm.list(200, page).catch(() => ({ docs: [] as any[], total: 0 }));
      if (!docs.length) break;
      for (const d of docs) if (isTaskDoc(d)) smIds.push(d.id);
      if (page * 200 >= (total || 0)) break;
    }
    for (const id of smIds) await this.sm.delete(id).catch(() => undefined);
    // RAG: list_docs is capped at 100 with no offset — but since we delete every task doc each pass,
    // repeated list+delete drains them all.
    let rag = 0;
    for (let pass = 0; pass < 500; pass++) {
      const docs = await this.rag.list(100, 'task').catch(() => [] as { id: string; title: string; tags: string[] }[]);
      if (!docs.length) break;
      for (const d of docs) {
        await this.rag.delete(d.id).catch(() => undefined);
        rag++;
      }
    }
    return { sm: smIds.length, rag };
  }

  /**
   * Delete ORPHAN task docs from the stores — task-type docs not linked to any live task. These pile up
   * from past re-index churn. Deletion only (no embeddings). (BEA-548)
   */
  async purgeOrphanTaskDocs(): Promise<{ smDeleted: number; ragDeleted: number; smScanned: number; ragScanned: number }> {
    const tasks = await this.prisma.task.findMany({ select: { supermemoryId: true, ragId: true } });
    const liveSm = new Set(tasks.map((t) => t.supermemoryId).filter(Boolean) as string[]);
    const liveRag = new Set(tasks.map((t) => t.ragId).filter(Boolean) as string[]);
    const isTaskDoc = (d: { title?: string; tags?: string[] }) =>
      (d.tags || []).map((t) => String(t).toLowerCase()).includes('task') || String(d.title || '').startsWith('Task:');

    let smDeleted = 0;
    let smScanned = 0;
    for (let page = 1; page <= 500; page++) {
      const { docs, total } = await this.sm.list(200, page).catch(() => ({ docs: [] as any[], total: 0 }));
      if (!docs.length) break;
      smScanned += docs.length;
      for (const d of docs) {
        if (isTaskDoc(d) && !liveSm.has(d.id)) {
          await this.sm.delete(d.id).catch(() => undefined);
          smDeleted++;
        }
      }
      if (page * 200 >= (total || 0)) break;
    }

    let ragDeleted = 0;
    const ragDocs = await this.rag.list(8000).catch(() => [] as { id: string; title: string; tags: string[] }[]);
    for (const d of ragDocs) {
      if (isTaskDoc(d) && !liveRag.has(d.id)) {
        await this.rag.delete(d.id).catch(() => undefined);
        ragDeleted++;
      }
    }
    return { smDeleted, ragDeleted, smScanned, ragScanned: ragDocs.length };
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

  /**
   * Map store-doc ids (supermemoryId/ragId) back to the real app rows that own them, so an Explore
   * source can deep-link to the actual item. Returns { storeId -> { type, id, day? } }. (BEA-340)
   */
  async resolveRefs(ids: string[]): Promise<Record<string, { type: string; id: string; day?: string }>> {
    const uniq = [...new Set((ids || []).filter(Boolean))];
    const out: Record<string, { type: string; id: string; day?: string }> = {};
    if (!uniq.length) return out;
    for (const type of ALL_SOURCES) {
      const pk = this.pkOf(type);
      const select: any = { [pk]: true, supermemoryId: true, ragId: true };
      if (type === 'story') select.day = true; // story has a separate `day` column
      let rows: any[] = [];
      try {
        rows = await this.modelOf(type).findMany({ where: { OR: [{ supermemoryId: { in: uniq } }, { ragId: { in: uniq } }] }, select });
      } catch {
        continue;
      }
      for (const r of rows) {
        const entity = { type, id: String(r[pk]), day: type === 'gmailbrief' ? String(r[pk]) : r.day };
        if (r.supermemoryId) out[r.supermemoryId] = entity;
        if (r.ragId) out[r.ragId] = entity;
      }
    }
    return out;
  }

  /** Per-table count of ENABLED-section rows not yet fully linked into BOTH stores. */
  async unindexedCounts(): Promise<Array<{ type: string; unindexed: number }>> {
    const out: Array<{ type: string; unindexed: number }> = [];
    for (const t of ALL_SOURCES) {
      if (!this.sourceEnabled(t)) continue;
      if (!this.modelOf(t)) continue;
      const unindexed = await this.modelOf(t).count({
        where: { OR: [{ ragId: null }, { supermemoryId: null }] },
      });
      if (unindexed) out.push({ type: t, unindexed });
    }
    return out;
  }

  /** Status of every manageable section for the Settings index manager. (BEA-335) */
  async sourceStatus(): Promise<Array<{ type: string; label: string; total: number; indexed: number; ragIndexed: number; smIndexed: number; lastIndexedAt: Date | null; enabled: boolean; mandatory: boolean; cadence: string }>> {
    const out = [];
    for (const type of ALL_SOURCES) {
      if (SOURCE_META[type].manageable === false) continue; // derived/internal sources aren't shown as toggles
      if (!this.modelOf(type)) continue;
      const model = this.modelOf(type);
      // Per-store counts so the UI can show whether RAG and SuperMemory are actually in sync. (BEA-370)
      const [total, indexed, ragIndexed, smIndexed] = await Promise.all([
        model.count(),
        model.count({ where: { AND: [{ ragId: { not: null } }, { supermemoryId: { not: null } }] } }),
        model.count({ where: { ragId: { not: null } } }),
        model.count({ where: { supermemoryId: { not: null } } }),
      ]);
      const src = await this.prisma.indexSource.findUnique({ where: { type } }).catch(() => null);
      out.push({ type, label: SOURCE_META[type].label, total, indexed, ragIndexed, smIndexed, lastIndexedAt: src?.lastIndexedAt ?? null, enabled: this.sourceEnabled(type), mandatory: !!SOURCE_META[type].mandatory, cadence: SOURCE_META[type].cadence || 'live' });
    }
    return out;
  }

  /** Toggle a section. Disable = stop + PURGE from the index. Enable = resume + re-index. (BEA-335)
   *  Mandatory sections (Daily Email Brief, Email Requests) can't be disabled. (BEA-336) */
  async setSourceEnabled(type: string, enabled: boolean): Promise<{ type: string; enabled: boolean; reindexed?: number; purged?: number }> {
    if (!ALL_SOURCES.includes(type)) throw new BadRequestException(`unknown section: ${type}`);
    if (SOURCE_META[type].mandatory && !enabled) throw new BadRequestException(`${SOURCE_META[type].label} is always indexed and can't be turned off.`);
    await this.prisma.indexSource.upsert({ where: { type }, create: { type, enabled }, update: { enabled } });
    this.enabled.set(type, enabled);
    if (enabled) return { type, enabled, reindexed: await this.reindexType(type) };
    return { type, enabled, purged: await this.purgeType(type) };
  }

  /** Remove a section's docs from BOTH stores and clear its link ids. Source rows are untouched. */
  async purgeType(type: string): Promise<number> {
    if (!this.modelOf(type)) return 0;
    const pk = this.pkOf(type);
    const rows = await this.modelOf(type).findMany({ where: { OR: [{ ragId: { not: null } }, { supermemoryId: { not: null } }] } });
    for (const r of rows) {
      await this.deleteDoc(r.supermemoryId, r.ragId);
      await this.modelOf(type).update({ where: { [pk]: r[pk] }, data: { supermemoryId: null, ragId: null } }).catch(() => undefined);
    }
    return rows.length;
  }

  rechunkStatus() {
    return { ...this.rechunk };
  }

  /**
   * One-time optimize: re-save content-heavy RAG docs as proper chunks using the FULL content from
   * SuperMemory — fixes old whole-doc entries that were truncated at 8000 chars before the chunking
   * fix (BEA-330). SuperMemory is untouched (it chunks server-side). Runs in the background. (BEA-337)
   */
  async startRechunk(): Promise<{ started: boolean; total: number; running: boolean }> {
    if (this.rechunk.running) return { started: false, total: this.rechunk.total, running: true };
    const types = ['item', 'idea', 'meeting'];
    let total = 0;
    for (const t of types) total += await this.modelOf(t).count({ where: { supermemoryId: { not: null } } });
    this.rechunk = { running: true, total, done: 0, rechunked: 0, skipped: 0, startedAt: Date.now(), finishedAt: 0 };

    void (async () => {
      try {
        for (const type of types) {
          const pk = this.pkOf(type);
          const rows = await this.modelOf(type).findMany({ where: { supermemoryId: { not: null } } });
          for (const r of rows) {
            try {
              const sm = await this.getSuperMemoryContent(r.supermemoryId);
              const full = sm?.content?.trim();
              if (!full || full.length < 100) {
                this.rechunk.skipped++;
              } else {
                if (r.ragId) await this.rag.delete(r.ragId).catch(() => undefined);
                const newRagId = await this.rag.save(full, sm.title || undefined, sm.tags || []);
                if (newRagId && newRagId !== 'saved') {
                  await this.modelOf(type).update({ where: { [pk]: r[pk] }, data: { ragId: newRagId } }).catch(() => undefined);
                  this.rechunk.rechunked++;
                } else {
                  this.rechunk.skipped++;
                }
              }
            } catch {
              this.rechunk.skipped++;
            }
            this.rechunk.done++;
          }
        }
      } finally {
        this.rechunk.running = false;
        this.rechunk.finishedAt = Date.now();
        this.log.log(`rechunk done: ${this.rechunk.rechunked} re-chunked, ${this.rechunk.skipped} skipped`);
      }
    })();

    return { started: true, total, running: true };
  }

  /** (Re)index every row of a section (used by manual reindex + enabling). Idempotent. */
  async reindexType(type: string): Promise<number> {
    if (!this.sourceEnabled(type)) return 0;
    if (!this.modelOf(type)) return 0;
    const pk = this.pkOf(type);
    const rows = await this.modelOf(type).findMany({});
    let n = 0;
    for (const r of rows) {
      const built = this.buildContent(type, r);
      if (!built) continue;
      await this.indexEntity({ refType: type, refId: r[pk], content: built.content, title: built.title, tags: built.tags, prevSupermemoryId: r.supermemoryId, prevRagId: r.ragId });
      n++;
    }
    return n;
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
      case 'vault':
        // Metadata-only — never the encrypted blob. (BEA-368)
        return row.title || row.website || row.username ? buildVaultIndexText(row) : null;
      case 'email':
        // Full important email (BEA-439): sender + subject + date + body.
        return row.subject || row.body || row.snippet
          ? { content: `From: ${row.fromAddr || ''}\nSubject: ${row.subject || ''}\nDate: ${row.day || ''}\n\n${row.body || row.snippet || ''}`.trim(), title: (row.subject || 'Email').slice(0, 120), tags: ['email', 'important'] }
          : null;
      case 'note': {
        let checklist = '';
        try {
          checklist = (JSON.parse(row.checklist || '[]') as any[]).map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n');
        } catch {
          /* ignore */
        }
        const text = [row.title, row.content, checklist].filter(Boolean).join('\n');
        return text ? { content: text, title: row.title || 'Note', tags: ['note', ...parseTags(row.tags)] } : null;
      }
      case 'gmailbrief': {
        let sections = '';
        try {
          sections = (JSON.parse(row.sections || '[]') as any[]).map((s) => `## ${s.heading}\n${(s.points || []).map((p: string) => `- ${p}`).join('\n')}`).join('\n\n');
        } catch {
          /* ignore */
        }
        const text = [`Daily Email Brief — ${row.day}`, row.summary, sections].filter(Boolean).join('\n\n');
        return text.trim() ? { content: text, title: `Daily Email Brief ${row.day}`, tags: ['email', 'brief', 'activity'] } : null;
      }
      case 'gmailrequest': {
        const text = [row.title, row.query, row.threadSubject, row.summary].filter(Boolean).join('\n\n');
        return text.trim() ? { content: text, title: row.title || 'Email request', tags: ['email', 'request'] } : null;
      }
      case 'daysummary':
        return row.text?.trim() ? { content: `Day summary — ${row.day}\n\n${row.text}`, title: `Day summary ${row.day}`, tags: ['activity'] } : null;
      case 'daystory':
        return row.text?.trim() ? { content: `Story of the Day — ${row.day}\n\n${row.text}${row.personalText ? `\n\nPERSONAL LIFE:\n${row.personalText}` : ''}`, title: `Story of the Day ${row.day}`, tags: ['activity', 'story'] } : null;
      case 'monthstory':
        return row.text?.trim() ? { content: `Story of the Month — ${row.month}${row.title ? ` — ${row.title}` : ''}\n\n${row.text}`, title: `Story of the Month ${row.month}`, tags: ['activity'] } : null;
      case 'yearstory':
        return row.text?.trim() && !row.partial ? { content: `Story of the Year — ${row.year}${row.title ? ` — ${row.title}` : ''}\n\n${row.text}`, title: `Story of the Year ${row.year}`, tags: ['activity'] } : null;
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
      for (const table of ALL_SOURCES) {
        if (!this.sourceEnabled(table)) continue; // disabled sections aren't auto-indexed
        // The Daily Email Brief is clock-bound — its own service indexes only the finalized nightly
        // build, so the generic safety-net must NOT pull in today's partial brief. (BEA-343)
        if (table === 'gmailbrief') continue;
        if (!this.modelOf(table)) continue; // unknown/missing delegate — never let one source halt the sweep
        const rows = await this.modelOf(table).findMany({
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
          await this.enqueue(content, { refType: table, refId: row[this.pkOf(table)], title, tags, targets }).catch(() => undefined);
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
