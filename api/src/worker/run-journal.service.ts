import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { gunzip, gzip } from 'zlib';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { stableStringify } from '../tools/tool-sample';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** The seed's own slot. It is not one of the worker's calls, so it sits outside the call order. */
export const SEED_SEQ = -1;

/**
 * What a replay says when the call order changed. A worker that asks for something different the
 * second time round is broken, and doing the step again would spend money twice — so it fails
 * loudly with this, and never repeats anything.
 */
export const NOT_REPEATABLE = 'the worker is not repeatable';

export type JournalHit<T> = { replayed: boolean; value: T };

/**
 * The run journal (BEA-1387, agent workers 2/10 — `specs/AGENT-WORKERS.md` §H).
 *
 * A worker is a script, not a graph: when it stops to ask the owner something it EXITS, and the
 * resume runs it again from the top. Every call that costs money or has an effect goes through
 * `once()`, which records what it returned against `(runId, seq)`. On the re-run the same call
 * finds its row and returns the recorded value — no vendor, no sheet, no message. That is the whole
 * reason a two-day wait is free, and why `writeSheet(append)` and `notify()` cannot fire twice.
 *
 * The order is the contract: `stepKey = sha256(seq + fn + argsHash)`. A replay whose key does not
 * match what was recorded at that position means the worker is not repeatable — it fails, loudly.
 */
@Injectable()
export class RunJournalService {
  private readonly log = new Logger('RunJournal');

  /**
   * The calls running right now, keyed by `runId:seq`. A worker's HTTP client can retry a call it
   * thinks timed out while the first one is still working: the journal row does not exist yet, so
   * BOTH would fetch, both would send, and the second write would tidy the evidence away. The
   * second caller joins the first instead.
   */
  private readonly inFlight = new Map<string, { key: string; work: Promise<any> }>();

  // Optional + LAST — spec harnesses build services positionally with fewer arguments.
  constructor(private readonly prisma?: PrismaService) {}

  /**
   * sha256(seq + fn + the arguments) — the same call at the same position always hashes the same.
   *
   * The arguments are hashed AS THEY ARE. `argsHashOf()` next door masks first (by value shape:
   * every 10–14 digit run, every e-mail), which is right for grouping saved answers and wrong here:
   * two questions that differ only in a phone number would share a step key, and the second would
   * be handed the first one's answer instead of failing as "not repeatable".
   */
  stepKey(seq: number, fn: string, args: any): string {
    return createHash('sha256').update(`${seq} | ${fn} | ${stableStringify(args ?? {})}`).digest('hex');
  }

  /**
   * Do this call exactly once per run, whatever happens afterwards.
   *
   * A row at this position: its value comes back and `work` is never called (`replayed: true`).
   * No row: `work` runs for real and its answer is recorded. A row whose `stepKey` differs → the
   * call order changed between replays, which throws `NOT_REPEATABLE`. The same call arriving twice
   * at once joins the one already running, so a retry cannot double-spend.
   */
  async once<T>(runId: string, seq: number, fn: string, args: any, work: () => Promise<T>): Promise<JournalHit<T>> {
    const key = this.stepKey(seq, fn, args);
    const found = await this.read(runId, seq);
    if (found) {
      if (found.stepKey !== key) throw new Error(this.mismatch(seq, fn, found.fn));
      return { replayed: true, value: found.value as T };
    }
    const slot = `${runId}:${seq}`;
    const live = this.inFlight.get(slot);
    if (live) {
      if (live.key !== key) throw new Error(this.mismatch(seq, fn, 'something else at the same moment'));
      return { replayed: true, value: (await live.work) as T };
    }
    const running = (async () => {
      const value = await work();
      await this.write(runId, seq, key, fn, value);
      return value;
    })();
    this.inFlight.set(slot, { key, work: running });
    try {
      return { replayed: false, value: (await running) as T };
    } finally {
      this.inFlight.delete(slot);
    }
  }

  private mismatch(seq: number, fn: string, was: string): string {
    return `${NOT_REPEATABLE}: at call ${seq} it did "${fn}", but this run did "${was}" there. Nothing was repeated.`;
  }

  /** The recorded value at this position, or null. `stepKey`/`fn` come back so a mismatch can be named. */
  async read(runId: string, seq: number): Promise<{ stepKey: string; fn: string; value: any } | null> {
    const find = this.prisma?.runJournal?.findUnique;
    if (!find) return null;
    const row: any = await this.prisma.runJournal.findUnique({ where: { runId_seq: { runId, seq } } }).catch(() => null);
    if (!row) return null;
    const value = await this.parse(row.result).catch(() => undefined);
    return { stepKey: row.stepKey, fn: row.fn, value: value === undefined ? null : value };
  }

  /**
   * Record a value at this position. Used by `once()`, and by `/ask` when the answer finally lands.
   *
   * A write that fails **stops the run**. The call it was recording has already happened, and an
   * unrecorded call is one a resume would do again — quietly, with the owner's money. Failing here
   * is loud and costs one honest re-run; swallowing it is a double charge nobody sees.
   */
  async write(runId: string, seq: number, stepKey: string, fn: string, value: any): Promise<void> {
    const create = this.prisma?.runJournal?.upsert;
    if (!create) return;
    const payload = await gzipAsync(Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8'));
    try {
      await this.prisma.runJournal.upsert({
        where: { runId_seq: { runId, seq } },
        create: { runId, seq, stepKey, fn, result: payload, bytes: payload.length },
        update: { stepKey, fn, result: payload, bytes: payload.length },
        select: { id: true },
      });
    } catch (e: any) {
      this.log.error(`could not journal ${fn} at ${seq} of run ${runId}: ${e?.message || e}`);
      throw new Error(`"${fn}" was done, but it could not be recorded in the run journal (${String(e?.message || e).slice(0, 160)}) — the run stops here, because a resume would do it again.`);
    }
  }

  /**
   * The worker's frozen clock and its random seed, recorded once per RUN (not per spawn): a resume
   * mints a fresh token but must see the same "now", or "the last 30 days" would move under it and
   * two replays would disagree. `Date.now`, `Math.random` and `crypto.randomUUID` in the worker are
   * pointed at these (§H, "determinism is enforced, not hoped for").
   */
  async seed(runId: string): Promise<{ now: number; random: number }> {
    const found = await this.read(runId, SEED_SEQ);
    if (found?.value && typeof found.value.now === 'number') return found.value;
    const seed = { now: Date.now(), random: Math.floor(Math.random() * 0xffffffff) };
    await this.write(runId, SEED_SEQ, this.stepKey(SEED_SEQ, 'seed', {}), 'seed', seed);
    return seed;
  }

  /** Everything this run recorded, in call order — for a resume, and for the tests that count repeats. */
  async list(runId: string): Promise<{ seq: number; fn: string }[]> {
    const find = this.prisma?.runJournal?.findMany;
    if (!find) return [];
    const rows: any[] = await this.prisma.runJournal.findMany({ where: { runId }, orderBy: { seq: 'asc' } }).catch(() => []);
    return (rows || []).map((r) => ({ seq: r.seq, fn: r.fn }));
  }

  /**
   * Forget a finished run's journal. It exists for exactly one purpose — making a RESUME free — and
   * a run that has reached a terminal state is never resumed. Dropping it at `finish` keeps the
   * store self-cleaning: without this every run's whole fetched table would sit in the database for
   * ever, and the nightly backup would copy it every night (the lesson `ToolSample` was built on).
   */
  async forget(runId: string): Promise<number> {
    const del = this.prisma?.runJournal?.deleteMany;
    if (!del) return 0;
    const r: any = await this.prisma.runJournal.deleteMany({ where: { runId } }).catch(() => ({ count: 0 }));
    return r?.count || 0;
  }

  private async parse(payload: any): Promise<any> {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const json = (await gunzipAsync(buf)).toString('utf8');
    return JSON.parse(json);
  }
}
