import { AgentScheduler } from './agent-scheduler.service';

const prisma: any = { setting: { findUnique: async () => ({ value: 'Asia/Kolkata' }) } };

function build(agents: any[]) {
  const started: any[] = [];
  const marked: any[] = [];
  const agent: any = { listSchedulable: async () => agents, markFired: async (id: string, key: string) => marked.push({ id, key }) };
  const bridge: any = { startRun: async (i: any) => { started.push(i); return { id: 'run' }; } };
  return { sch: new AgentScheduler(agent, bridge, prisma), started, marked };
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

  it('does not re-fire a slot already fired, even within the look-back (BEA-798)', async () => {
    const { sch, started } = build([mk({ lastFiredKey: '2026-06-28:07:00', schedule: { every: 'day', at: '07:00' } })]);
    expect(await sch.tick(new Date('2026-06-28T01:31:00.100Z'))).toBe(0); // 07:01 IST; 07:00 already done
    expect(started.length).toBe(0);
  });
});
