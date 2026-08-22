import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The per-job run lock (BEA-1388 — `specs/AGENT-WORKERS.md` §G, `specs/briefs/AGENT-WORKERS-QUEUE.md` §3).
 *
 * Until now nothing stopped one agent running twice at once: `AgentScheduler.tick()` dedups only on
 * `lastFiredKey` (one fire per minute-slot) and runs are fire-and-forget promises with no queue — so a
 * manual tap during a scheduled run, or an event trigger during a manual run, started a second run
 * over the top of the first. Two runs of one job share a Watch baseline, a "keep adding" sheet and a
 * credit ceiling, so the overlap is not harmless.
 *
 * **The claim is a compare-and-set, never a read-then-write.** Reading "is it free?" and then writing
 * "it's mine" is exactly the race this exists to close. Two atomic statements do the whole job:
 *  1. `INSERT` on a UNIQUE `jobId` — either it lands or the database rejects it (P2002). No read.
 *  2. `UPDATE … WHERE jobId = ? AND expiresAt <= now` — one conditional update for taking over an
 *     expired lock. SQLite has a single writer, so of two racers the second one's WHERE no longer
 *     matches by the time it runs, and it gets 0 rows back. No read.
 *
 * Only the holder releases (`DELETE … WHERE jobId = ? AND holder = ?`), so a holder that comes back
 * from the dead after its lock was taken over cannot free somebody else's run.
 */
@Injectable()
export class RunLockService {
  private readonly log = new Logger('RunLock');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * How long a claim survives without being released. **The only safety net for a crashed holder**
   * until the stall watchdog lands (piece 7, BEA-1392), so it is chosen deliberately:
   *
   *  - **Longer than any real run.** An engine turn is capped at 250s inside `runViaCodexInner`, and
   *    the longest plan run there is — 11 pages × up to 50 creator calls with vendor backoff — is
   *    minutes, not tens of minutes. 30 minutes is well clear of both, so a lock never expires under
   *    a run that is still working.
   *  - **Longer than the stall watchdog's 20 minutes** (piece 7's `STALL_MINUTES`). When that lands,
   *    a stalled run is failed and its lock released properly — with a line the owner reads — before
   *    the silent expiry could reach it. Expiry stays the last resort, not the usual road.
   *  - **Short enough that a crash costs one fire.** A deploy mid-run, an OOM kill, a reboot: the job
   *    is free again within half an hour instead of being wedged for ever, so a daily agent misses at
   *    most one day and an hourly one at most one hour.
   *  - **A parked run does not hold a job hostage.** A run waiting on the owner's answer (up to 12h in
   *    piece 7) is not terminal and does not release — the lock expires instead and the schedule
   *    carries on. A job that could not fire for half a day would be a worse bug than the small
   *    chance of overlapping with a run that is only sitting there waiting.
   */
  static readonly TTL_MS = 30 * 60 * 1000;

  /**
   * Take the lock for `jobId`, or say who has it. Never throws for a busy job — the caller decides
   * whether that is a skip (the scheduler) or a plain refusal (a manual tap).
   */
  async claim(
    jobId: string,
    opts: { runId?: string | null; reason?: string; ttlMs?: number } = {},
  ): Promise<ClaimResult> {
    const holder = `h_${randomUUID()}`;
    const ttl = Math.max(1, opts.ttlMs ?? RunLockService.TTL_MS);
    // Two tries: the only way round the loop is the narrow window where the row existed when the
    // INSERT was rejected and was released before the take-over UPDATE ran. One retry closes it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = new Date();
      const data = { holder, runId: opts.runId ?? null, reason: opts.reason ?? null, takenAt: now, expiresAt: new Date(now.getTime() + ttl) };
      try {
        await this.prisma.jobRunLock.create({ data: { jobId, ...data } });
        return { ok: true, holder };
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e; // a real database problem is not "busy"
      }
      // Held. Take it over ONLY if it has expired — one conditional UPDATE, so of two racers exactly
      // one can match, and neither of them read first.
      const took = await this.prisma.jobRunLock.updateMany({ where: { jobId, expiresAt: { lte: now } }, data });
      if (took.count > 0) {
        this.log.warn(`job ${jobId}: took over a lock that expired (its holder never released it)`);
        return { ok: true, holder, tookOver: true };
      }
      const row = await this.prisma.jobRunLock.findUnique({ where: { jobId } }).catch(() => null);
      if (row) return { ok: false, held: shape(row) };
      // gone between the two statements — go round once and try to claim it properly
    }
    return { ok: false, held: null };
  }

  /**
   * The worker road's door: claim for a run that ALREADY exists. A worker is spawned once when the
   * run starts and again after every pause, and a pause can outlive the timeout — so a fresh spawn
   * of a run that still owns the lock simply pushes `expiresAt` out, while a spawn for a job that
   * somebody else is now running is refused. Never a read-then-write to ACQUIRE: `claim()` does the
   * atomic part, and the read only happens once it has already said "busy".
   */
  async claimForRun(jobId: string, runId: string, opts: { reason?: string; ttlMs?: number } = {}): Promise<ClaimResult> {
    const got = await this.claim(jobId, { runId, reason: opts.reason, ttlMs: opts.ttlMs });
    if (got.ok) return got;
    if (got.held?.runId !== runId) return got; // somebody else's run — refuse
    const ttl = Math.max(1, opts.ttlMs ?? RunLockService.TTL_MS);
    const kept = await this.prisma.jobRunLock.updateMany({
      where: { jobId, runId, holder: got.held.holder },
      data: { expiresAt: new Date(Date.now() + ttl) },
    });
    return kept.count > 0 ? { ok: true, holder: got.held.holder } : { ok: false, held: got.held };
  }

  /** Attach the run to the lock the moment it exists, so a skipped fire can point at it. */
  async attachRun(holder: string, runId: string): Promise<void> {
    await this.prisma.jobRunLock.updateMany({ where: { holder }, data: { runId } }).catch(() => undefined);
  }

  /** Give the lock back. Only the holder's own row goes — a taken-over lock is somebody else's now. */
  async release(holder: string): Promise<boolean> {
    if (!holder) return false;
    const r = await this.prisma.jobRunLock.deleteMany({ where: { holder } }).catch(() => ({ count: 0 }));
    return (r?.count ?? 0) > 0;
  }

  /**
   * Release whatever this run was holding — the terminal-state road (`finishRun`, `cancelRun`, the
   * boot reconciler). Keyed on `runId`, so a lock already taken over by someone else is untouched.
   */
  async releaseForRun(runId: string): Promise<boolean> {
    if (!runId) return false;
    const r = await this.prisma.jobRunLock.deleteMany({ where: { runId } }).catch(() => ({ count: 0 }));
    return (r?.count ?? 0) > 0;
  }

  /** The job is gone (deleted) — drop its lock row. No FK, so by hand, exactly like SocialWatch. */
  async releaseJob(jobId: string): Promise<void> {
    await this.prisma.jobRunLock.deleteMany({ where: { jobId } }).catch(() => undefined);
  }

  /** Who holds this job right now — null when it is free or the lock has expired. */
  async heldBy(jobId: string): Promise<HeldBy | null> {
    const row = await this.prisma.jobRunLock.findUnique({ where: { jobId } }).catch(() => null);
    if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return null;
    return shape(row);
  }
}

export type HeldBy = { jobId: string; holder: string; runId: string | null; reason: string | null; takenAt: Date; expiresAt: Date };
/**
 * One flat shape, not a union: this project runs `strict:false`, where a discriminated union does not
 * narrow reliably. `ok` decides — `holder` is set when you won it, `held` says who has it when you did not.
 */
export type ClaimResult = { ok: boolean; holder?: string; tookOver?: boolean; held?: HeldBy | null };

const shape = (row: any): HeldBy => ({
  jobId: row.jobId,
  holder: row.holder,
  runId: row.runId ?? null,
  reason: row.reason ?? null,
  takenAt: new Date(row.takenAt),
  expiresAt: new Date(row.expiresAt),
});

/**
 * "This job is already running." A `ConflictException`, so a manual tap gets an honest HTTP 409 with
 * a sentence the owner reads in the toast — **never a silently swallowed second run**. The scheduler
 * catches this one by name and turns it into a skipped-fire step on the run that is still going.
 */
export class JobBusyError extends ConflictException {
  readonly held: HeldBy | null;
  constructor(held: HeldBy | null, what = 'This job') {
    super(`${what} is already running${held?.reason ? ` (${held.reason})` : ''} — open the run that is going, or wait for it to finish.`);
    this.name = 'JobBusyError'; // the scheduler recognises it by name across module boundaries
    this.held = held;
  }
}

export const isJobBusy = (e: any): e is JobBusyError => e instanceof JobBusyError || e?.name === 'JobBusyError';
