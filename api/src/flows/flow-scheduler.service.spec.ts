import { FlowScheduler } from './flow-scheduler.service';
import { resetScheduleClock } from '../hermes/schedule-clock';

/**
 * FlowScheduler — the flow twin of AgentScheduler. PROTECT THE CLOCK (BEA-1605): a zone name Intl
 * rejects must not stop every scheduled flow, and a tick that throws must be logged and never stop
 * the next one. `matches()`, the look-back and `markFired` are untouched.
 */

function logStub() {
  const said = { error: [] as string[], warn: [] as string[], log: [] as string[] };
  return { said, log: { error: (m: string) => said.error.push(m), warn: (m: string) => said.warn.push(m), log: (m: string) => said.log.push(m), debug: () => undefined, verbose: () => undefined } };
}

function build(flowRows: any[], opts: { tz?: string } = {}) {
  const started: string[] = [];
  const marked: any[] = [];
  const prisma: any = { setting: { findUnique: async () => ({ value: opts.tz ?? 'Asia/Kolkata' }) } };
  const flows: any = {
    listSchedulable: async () => flowRows,
    markFired: async (id: string, key: string) => marked.push({ id, key }),
  };
  const runner: any = { start: async (id: string) => { started.push(id); return { id: 'run' }; } };
  const sch = new FlowScheduler(prisma, flows, runner);
  const { said, log } = logStub();
  (sch as any).log = log;
  return { sch, started, marked, said, flows };
}
const mk = (over: any = {}) => ({ id: 'f1', lastFiredKey: null, schedule: { every: 'day', at: '07:00' }, ...over });

describe('FlowScheduler', () => {
  beforeEach(() => resetScheduleClock());
  afterEach(() => jest.useRealTimers());

  it('fires a due flow once at its local minute and records the fired key', async () => {
    const { sch, started, marked } = build([mk()]);
    expect(await sch.tick(new Date('2026-06-28T01:30:00Z'))).toBe(1); // 07:00 Asia/Kolkata
    expect(started).toEqual(['f1']);
    expect(marked[0]).toEqual({ id: 'f1', key: '2026-06-28:07:00' });
    expect(await sch.tick(new Date('2026-06-28T01:30:30Z'))).toBe(0); // the same slot again — once
  });

  it('BEA-1605: WHEN tasks.tz is "Asia/Kolkatta" (a typo), the tick still fires at the right IST minute and warns ONCE', async () => {
    const { sch, started, marked, said } = build([mk()], { tz: 'Asia/Kolkatta' });
    expect(await sch.tick(new Date('2026-06-28T01:30:00Z'))).toBe(1); // 07:00 on the fallback zone
    expect(started).toEqual(['f1']);
    expect(marked[0].key).toBe('2026-06-28:07:00');
    expect(said.warn).toHaveLength(1);
    expect(said.warn[0]).toContain('Asia/Kolkatta');
    expect(said.error).toHaveLength(0);
    expect(await sch.tick(new Date('2026-06-28T01:31:00Z'))).toBe(0);
    expect(said.warn).toHaveLength(1); // once, not every minute
  });

  it('BEA-1605: WHEN a tick throws for another reason, the error is in the log and the NEXT tick still runs (the 60 s timer path)', async () => {
    const { sch, started, said, flows } = build([mk()]);
    const real = flows.listSchedulable;
    let calls = 0;
    flows.listSchedulable = async () => { calls++; if (calls === 1) throw new Error('database is locked'); return real(); };
    jest.useFakeTimers({ now: new Date('2026-06-28T01:30:00Z') }); // 07:00 IST
    try {
      sch.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000); // 07:01 — throws
      expect(said.error).toHaveLength(1);
      expect(said.error[0]).toContain('database is locked');
      expect(started).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(60_000); // 07:02 — runs; the look-back still sees 07:00
      expect(calls).toBe(2);
      expect(started).toEqual(['f1']);
    } finally {
      sch.onModuleDestroy();
    }
  });
});
