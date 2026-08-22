import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { gunzip, gzip } from 'zlib';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import {
  argsHashOf,
  FIRST_SWEEP_AFTER_MS,
  isUsable,
  maskPayload,
  PER_ACTION_GOOD,
  PER_AGENT_FAILING,
  RAW_MAX,
  SAMPLE_MAX_BYTES,
  SWEEP_EVERY_MS,
  shouldSample,
  TOTAL_BUDGET_BYTES,
  truncatedNote,
} from './tool-sample';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** What one attempt to keep an answer is given. Everything the decision and the row need, no more. */
export type KeepInput = {
  /** `svc:<service>.<action>` — our id, never the vendor's. */
  actionId: string;
  service?: string;
  action?: string;
  /** The job this came from. Null/absent for a builder, chat or Social-page call. */
  agentId?: string;
  /** The arguments that really went out. Masked here before anything is written. */
  args?: Record<string, any>;
  /** The provider's whole answer. */
  data: any;
  ok?: boolean;
  gated?: boolean;
  readOnly?: boolean;
  method?: string;
  /** Which provider served the id — only the public-scraping one's answers may be kept. */
  providerKind?: string;
  /** 'good' by default; 'failing' is evidence of a break, kept per job. */
  kind?: string;
  note?: string;
};

/**
 * The sample store (BEA-1386, agent workers 1/10 — `specs/AGENT-WORKERS.md` §A).
 *
 * It keeps ONE thing: whole vendor answers, masked and gzipped, so a worker can be built, tested and
 * repaired against what the vendor really said — **without ever re-calling the vendor**, because a
 * repair that spends the owner's credits is not a repair.
 *
 * Three things about it that are not optional:
 *  - it holds other people's personal data, so it is opt-in per service, never keeps messages, and
 *    masks by key name AND value shape before a byte is written;
 *  - it is bounded — per call shape, per job and in total — and the sweep gives the freed space back
 *    to the disk (`PRAGMA incremental_vacuum`), or the nightly backup copies a growing file for ever;
 *  - `replay()` reads the database and nothing else. There is no provider on this service at all.
 */
@Injectable()
export class ToolSampleService implements OnModuleInit {
  private readonly log = new Logger('ToolSample');
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  // Optional + LAST — spec harnesses build services positionally with fewer arguments.
  constructor(private readonly prisma?: PrismaService) {}

  onModuleInit() {
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), SWEEP_EVERY_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    // One pass a little after boot, never during the post-deploy stampede.
    const first = setTimeout(() => void this.sweep().catch(() => undefined), FIRST_SWEEP_AFTER_MS);
    if (typeof first.unref === 'function') first.unref();
  }

  /**
   * The hook the worker runner fills in later (§D): a worker's `samples/index.json` names the samples
   * its tests stand on, and the sweep must never delete one of those out from under it. Nothing
   * registers a reader yet — that file does not exist until the workers land — so today it answers
   * "nothing is pinned" and every sample is evictable.
   */
  private pinned?: () => Promise<string[]> | string[];

  /** Registered at boot by whoever owns the worker folders, the way `setFlowSync()` is. */
  setPinned(fn: () => Promise<string[]> | string[]): void {
    this.pinned = fn;
  }

  private async pinnedIds(): Promise<Set<string> | null> {
    try {
      const ids = await this.pinned?.();
      return new Set(Array.isArray(ids) ? ids.map((i) => String(i)) : []);
    } catch {
      // A hook that cannot answer must not lose a pinned sample: null means "delete nothing today".
      return null;
    }
  }

  // ---- writing ------------------------------------------------------------------------------

  /**
   * Keep this answer, if it may be kept. Called from `runDetailed()` on the success path, beside the
   * `ToolCall` row.
   *
   * Never throws: a real vendor call must never be reported as failed because our own store could
   * not be written. Answers the new sample's id, or null when nothing was kept.
   */
  async maybeKeep(input: KeepInput): Promise<string | null> {
    try {
      if (!shouldSample(input)) return null;
      if (input.data === undefined || input.data === null) return null;
      const create = this.prisma?.toolSample?.create;
      if (!create) return null;

      const parsedId = /^svc:([^.]+)\.(.+)$/.exec(String(input.actionId));
      const service = String(input.service || parsedId?.[1] || '').toLowerCase();
      const action = String(input.action || parsedId?.[2] || '');

      // Masked FIRST, always. Nothing unmasked is ever serialised, let alone stored.
      const masked = maskPayload(input.data);
      const json = JSON.stringify(masked);
      if (!json) return null;
      const raw = Buffer.from(json, 'utf8');
      const over = raw.length > RAW_MAX;
      const payload = await gzipAsync(over ? raw.subarray(0, RAW_MAX) : raw);

      if (payload.length > SAMPLE_MAX_BYTES) {
        // Unreachable from a 256 KB input (gzip does not grow text), and cheap insurance if it ever is.
        this.log.warn(`sample for ${input.actionId} was ${payload.length} bytes after gzip — over the cap, not kept`);
        return null;
      }

      const args = input.args && typeof input.args === 'object' ? input.args : {};
      const argsHash = argsHashOf(args);
      const row = await this.prisma.toolSample.create({
        data: {
          service,
          action,
          actionId: String(input.actionId),
          agentId: input.agentId || null,
          argsHash,
          arguments: JSON.stringify(maskPayload(args)),
          payload,
          bytes: payload.length,
          kind: input.kind === 'failing' ? 'failing' : 'good',
          note: over ? truncatedNote(raw.length) : input.note || null,
        },
        select: { id: true },
      });

      // Trim this call shape straight away, so the store stays bounded between sweeps.
      await this.evictShape(String(input.actionId), argsHash).catch(() => undefined);
      return row?.id || null;
    } catch (e: any) {
      this.log.warn(`could not keep a sample for ${input?.actionId}: ${e?.message || e}`);
      return null;
    }
  }

  // ---- reading ------------------------------------------------------------------------------

  /**
   * The newest usable answer for this action (and this exact call shape, when `argsHash` is given),
   * parsed. For a worker's tests and for a repair.
   *
   * **This never reaches a provider** — there is no provider here to reach. That is the whole point:
   * a repair loop runs as many times as it needs to and costs nothing.
   */
  async replay(actionId: string, argsHash?: string): Promise<any | null> {
    const find = this.prisma?.toolSample?.findMany;
    if (!find) return null;
    const rows = await this.prisma.toolSample
      .findMany({
        where: { actionId: String(actionId), kind: 'good', ...(argsHash ? { argsHash: String(argsHash) } : {}) },
        orderBy: { createdAt: 'desc' },
        take: PER_ACTION_GOOD,
      })
      .catch(() => [] as any[]);
    for (const r of rows || []) {
      // A truncated sample is evidence, not a fixture — its JSON does not parse. Skip to the next.
      if (!isUsable(r)) continue;
      const parsed = await this.parse(r.payload).catch(() => undefined);
      if (parsed !== undefined) return parsed;
    }
    return null;
  }

  /** gunzip + JSON.parse, kept in one place because two callers read the same BLOB. */
  private async parse(payload: any): Promise<any> {
    if (!payload) return undefined;
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const text = (await gunzipAsync(buf)).toString('utf8');
    return JSON.parse(text);
  }

  // ---- eviction ------------------------------------------------------------------------------

  /** Oldest good samples for one call shape, beyond `PER_ACTION_GOOD`. */
  private async evictShape(actionId: string, argsHash: string): Promise<number> {
    if (!this.prisma?.toolSample?.findMany) return 0;
    const rows = await this.prisma.toolSample
      .findMany({
        where: { actionId, argsHash, kind: 'good' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
        skip: PER_ACTION_GOOD,
      })
      .catch(() => [] as any[]);
    const ids = (rows || []).map((r: any) => r.id);
    if (!ids.length) return 0;
    const pinned = await this.pinnedIds();
    if (!pinned) return 0;
    const doomed = ids.filter((id: string) => !pinned.has(id));
    if (!doomed.length) return 0;
    await this.prisma?.toolSample?.deleteMany?.({ where: { id: { in: doomed } } });
    return doomed.length;
  }

  /**
   * The sweep: the three caps, then the disk.
   *
   * 1. per call shape — good samples beyond `PER_ACTION_GOOD`, oldest first;
   * 2. per job — failing samples beyond `PER_AGENT_FAILING`, oldest first;
   * 3. the whole store — oldest first until it is under `TOTAL_BUDGET_MB`.
   *
   * Then `PRAGMA incremental_vacuum`, because SQLite keeps the freed pages inside the file until it
   * is told to hand them back, and the nightly backup copies the file whole.
   */
  async sweep(): Promise<{ deleted: number; freed: number }> {
    const find = this.prisma?.toolSample?.findMany;
    if (!find) return { deleted: 0, freed: 0 };
    const rows: any[] = await this.prisma.toolSample
      .findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, actionId: true, argsHash: true, agentId: true, kind: true, bytes: true } })
      .catch(() => [] as any[]);
    if (!rows?.length) return { deleted: 0, freed: 0 };

    const pinned = await this.pinnedIds();
    // The hook could not answer: a sample a worker's tests stand on might be in this list, so this
    // pass deletes nothing rather than risk taking one away.
    if (!pinned) return { deleted: 0, freed: 0 };

    const doomed = new Map<string, number>();
    const keepLast = (list: any[], limit: number) => {
      // `rows` is oldest-first, so everything before the last `limit` is the old end.
      for (const r of list.slice(0, Math.max(0, list.length - limit))) {
        if (!pinned.has(r.id)) doomed.set(r.id, Number(r.bytes) || 0);
      }
    };

    const shapes = new Map<string, any[]>();
    const agents = new Map<string, any[]>();
    for (const r of rows) {
      if (r.kind === 'failing') {
        const key = String(r.agentId || '');
        if (!agents.has(key)) agents.set(key, []);
        agents.get(key).push(r);
      } else {
        const key = `${r.actionId} ${r.argsHash}`;
        if (!shapes.has(key)) shapes.set(key, []);
        shapes.get(key).push(r);
      }
    }
    for (const list of shapes.values()) keepLast(list, PER_ACTION_GOOD);
    for (const list of agents.values()) keepLast(list, PER_AGENT_FAILING);

    // 3) the total, oldest first over whatever is still standing.
    let total = rows.reduce((n, r) => n + (doomed.has(r.id) ? 0 : Number(r.bytes) || 0), 0);
    for (const r of rows) {
      if (total <= TOTAL_BUDGET_BYTES) break;
      if (doomed.has(r.id) || pinned.has(r.id)) continue;
      doomed.set(r.id, Number(r.bytes) || 0);
      total -= Number(r.bytes) || 0;
    }

    if (!doomed.size) return { deleted: 0, freed: 0 };
    const ids = [...doomed.keys()];
    let freed = 0;
    for (const id of ids) freed += doomed.get(id) || 0;
    // In chunks: SQLite has a limit on how many values one IN (…) may carry.
    for (let i = 0; i < ids.length; i += 200) {
      await this.prisma?.toolSample?.deleteMany?.({ where: { id: { in: ids.slice(i, i + 200) } } }).catch(() => undefined);
    }
    await this.vacuum();
    this.log.log(`swept ${ids.length} samples, ${(freed / 1024 / 1024).toFixed(1)} MB`);
    return { deleted: ids.length, freed };
  }

  /**
   * Hand the freed pages back to the file system. The database is `auto_vacuum = INCREMENTAL` (set in
   * the same migration that made the table), so this is the step that actually shrinks the file.
   */
  async vacuum(): Promise<void> {
    const p: any = this.prisma;
    if (!p) return;
    try {
      await p.$executeRawUnsafe?.('PRAGMA incremental_vacuum');
    } catch {
      // Some drivers answer a PRAGMA with rows rather than a count — then it is a query, not an exec.
      await p.$queryRawUnsafe?.('PRAGMA incremental_vacuum').catch(() => undefined);
    }
  }
}
