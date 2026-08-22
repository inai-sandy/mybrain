import { AgentScheduler } from './agent-scheduler.service';
import { JobBusyError } from '../agent/run-lock.service';

const prisma: any = { setting: { findUnique: async () => ({ value: 'Asia/Kolkata' }) } };

function build(agents: any[], opts: { busyWith?: string | null } = {}) {
  const started: any[] = [];
  const marked: any[] = [];
  const steps: any[] = [];
  const agent: any = {
    listSchedulable: async () => agents,
    markFired: async (id: string, key: string) => marked.push({ id, key }),
    appendStep: async (runId: string, step: any) => { steps.push({ runId, ...step }); },
  };
  const bridge: any = {
    startRun: async (i: any) => {
      // The job lock (BEA-1388) lives inside startRun; a busy job throws JobBusyError from there.
      if (opts.busyWith !== undefined && opts.busyWith !== null) {
        throw new JobBusyError({ jobId: i.agentId, holder: 'h_1', runId: opts.busyWith, reason: 'the scheduled run', takenAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
      }
      started.push(i);
      return { id: 'run' };
    },
    applyAgentSkills: async (_a: any, i: any) => i,
  };
  return { sch: new AgentScheduler(agent, bridge, prisma), started, marked, steps };
}
const mk = (over: any = {}) => ({ id: 'a1', name: 'Brief', prompt: 'do it', collectionId: null, lastFiredKey: null, schedule: { every: 'day', at: '07:00' }, ...over });

describe('AgentScheduler (BEA-623)', () => {
  it('matches day / weekday / week / hour schedules', () => {
    const { sch } = build([]);
    expect(sch.matches({ every: 'day', at: '07:00' }, '07:00', 3)).toBe(true);
    expect(sch.matches({ every: 'day', at: '07:00' }, '07:01', 3)).toBe(false);
    expect(sch.matches({ every: 'weekday', at: '07:00' }, '07:00', 6)).toBe(false); // Saturday
    expect(sch.matches({ every: 'weekday', at: '07:00' }, '07:00', 2)).toBe(true);
    expect(sch.matches({ every: 'week', at: '09:00', dow: 1 }, '09:00', 1)).toBe(true);
    expect(sch.matches({ every: 'week', at: '09:00', dow: 1 }, '09:00', 2)).toBe(false);
    expect(sch.matches({ every: 'hour', minute: 30 }, '13:30', 4)).toBe(true);
    expect(sch.matches({ every: 'hour', minute: 30 }, '13:31', 4)).toBe(false);
    expect(sch.matches(null, '07:00', 1)).toBe(false);
  });

  it('fires a due agent once and records the fired key', async () => {
    const { sch, started, marked } = build([mk()]);
    const now = new Date('2026-06-28T01:30:00Z'); // = 07:00 Asia/Kolkata
    expect(await sch.tick(now)).toBe(1);
    expect(started[0]).toMatchObject({ prompt: 'do it', agentId: 'a1', title: 'Brief' });
    expect(marked[0].key).toContain(':07:00');
  });

  it('does not fire when the time does not match', async () => {
    const { sch, started } = build([mk({ schedule: { every: 'day', at: '09:00' } })]);
    expect(await sch.tick(new Date('2026-06-28T01:30:00Z'))).toBe(0); // 07:00 IST
    expect(started.length).toBe(0);
  });

  it('skips an agent already fired this slot (dedup)', async () => {
    const { sch, started } = build([mk({ lastFiredKey: '2026-06-28:07:00' })]);
    expect(await sch.tick(new Date('2026-06-28T01:30:00Z'))).toBe(0);
    expect(started.length).toBe(0);
  });

  it('catches a slot the 60s timer drifted past, one minute late (BEA-798)', async () => {
    const { sch, started, marked } = build([mk({ schedule: { every: 'day', at: '07:00' } })]);
    const now = new Date('2026-06-28T01:31:00.100Z'); // 07:01 IST — the 07:00 tick was skipped
    expect(await sch.tick(now)).toBe(1);
    expect(started.length).toBe(1);
    expect(marked[0].key).toContain(':07:00'); // fired the missed 07:00 slot, not 07:01
  });

  it('BEA-1359: the owner\'s Monday 08:00 IST digest fires from the schedule alone — startRun with the job id, once, and not on Tuesday', async () => {
    // `{every:'week', dow:1, at:'08:00'}` is what the SchedulePicker stores for "every Monday 08:00";
    // 08:00 Asia/Kolkata = 02:30Z. The bridge's startRun → execute() forks to the direct Social runner
    // on `agentId` (hermes-bridge.service.ts), so this IS the whole scheduled road minus the fetch.
    const digest = mk({ id: 'social1', name: 'Smart Home India — Instagram digest', prompt: 'Keep India-relevant posts…', schedule: { every: 'week', dow: 1, at: '08:00' }, tools: ['svc:instagram.search_hashtag'], toolArgs: { 'svc:instagram.search_hashtag': { hashtag: 'smarthomeindia' } } });
    const { sch, started, marked } = build([digest]);
    expect(await sch.tick(new Date('2026-08-24T02:30:00Z'))).toBe(1); // Monday 24 Aug 2026, 08:00 IST
    expect(started[0]).toMatchObject({ agentId: 'social1', title: 'Smart Home India — Instagram digest' });
    expect(marked[0]).toEqual({ id: 'social1', key: '2026-08-24:08:00' });
    expect(await sch.tick(new Date('2026-08-24T02:30:30Z'))).toBe(0); // the same slot again — once
    const again = build([{ ...digest, lastFiredKey: '2026-08-24:08:00' }]);
    expect(await again.sch.tick(new Date('2026-08-25T02:30:00Z'))).toBe(0); // Tuesday 08:00 — not a Monday
    expect(await again.sch.tick(new Date('2026-08-31T02:30:00Z'))).toBe(1); // next Monday — fires again
  });

  it('a slot that comes round while the last run is still going is SKIPPED out loud, never doubled (BEA-1388)', async () => {
    const { sch, started, marked, steps } = build([mk({ schedule: { every: 'hour', minute: 0 } })], { busyWith: 'run-in-flight' });
    expect(await sch.tick(new Date('2026-06-28T01:30:00Z'))).toBe(0); // 07:00 IST — due, but busy
    expect(started.length).toBe(0); // not queued, not duplicated
    expect(marked.length).toBe(1); // the slot is spent, so the same minute is not retried
    // …and the owner can SEE why: the note lands on the run that is still going.
    expect(steps.length).toBe(1);
    expect(steps[0]).toMatchObject({ runId: 'run-in-flight', status: 'info', kind: 'info' });
    expect(steps[0].label).toContain('still going');
  });

  it('a busy job with no run on the lock is still skipped quietly, never started twice (BEA-1388)', async () => {
    // A lock with no run on it (a repair turn, a spawn that has not attached its run yet) — there is
    // nowhere to put the step, and the fire must still be skipped rather than run twice.
    const { sch, started, steps } = build([mk()]);
    (sch as any).bridge.startRun = async (i: any) => { throw new JobBusyError({ jobId: i.agentId, holder: 'h_1', runId: null, reason: 'a worker run', takenAt: new Date(), expiresAt: new Date() }); };
    expect(await sch.tick(new Date('2026-06-28T01:30:00Z'))).toBe(0);
    expect(started.length).toBe(0);
    expect(steps.length).toBe(0);
  });

  it('does not re-fire a slot already fired, even within the look-back (BEA-798)', async () => {
    const { sch, started } = build([mk({ lastFiredKey: '2026-06-28:07:00', schedule: { every: 'day', at: '07:00' } })]);
    expect(await sch.tick(new Date('2026-06-28T01:31:00.100Z'))).toBe(0); // 07:01 IST; 07:00 already done
    expect(started.length).toBe(0);
  });
});
