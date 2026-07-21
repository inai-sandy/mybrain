import { TasksService } from './tasks.service';

/**
 * Owner's rule: a promised date SLOWS the chase, it never pauses it — silence must always still
 * reach him. And re-promising is a slip worth counting. (BEA-1022)
 */
function make(task: any) {
  const settings: Record<string, string> = {};
  const prisma: any = {
    setting: { findUnique: async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null) },
    task: {
      findUnique: async () => task,
      update: async ({ data }: any) => {
        if (data.promiseSlips?.increment) task.promiseSlips = (task.promiseSlips || 0) + data.promiseSlips.increment;
        if (data.promisedFor !== undefined) task.promisedFor = data.promisedFor;
        return task;
      },
    },
  };
  return { svc: new TasksService(prisma, {} as any, {} as any, { indexEntity: async () => undefined } as any) as any, task };
}

const future = () => new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const past = () => new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

describe('recordPromise (BEA-1022)', () => {
  it('records a real future date', async () => {
    const { svc, task } = make({ promisedFor: null, status: 'open', promiseSlips: 0 });
    const d = future();
    expect(await svc.recordPromise('t1', d)).toEqual({ ok: true, slip: false });
    expect(task.promisedFor).toBe(d);
    expect(task.promiseSlips).toBe(0);
  });

  it('counts a RE-promise as a slip', async () => {
    const first = future();
    const { svc, task } = make({ promisedFor: first, status: 'open', promiseSlips: 0 });
    const second = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
    expect(await svc.recordPromise('t1', second)).toEqual({ ok: true, slip: true });
    expect(task.promisedFor).toBe(second);
    expect(task.promiseSlips).toBe(1);
  });

  it('repeating the SAME date is not a slip', async () => {
    const d = future();
    const { svc, task } = make({ promisedFor: d, status: 'open', promiseSlips: 0 });
    expect(await svc.recordPromise('t1', d)).toEqual({ ok: true, slip: false });
    expect(task.promiseSlips).toBe(0);
  });

  it('refuses a date in the past', async () => {
    const { svc, task } = make({ promisedFor: null, status: 'open', promiseSlips: 0 });
    expect(await svc.recordPromise('t1', past())).toEqual({ ok: false });
    expect(task.promisedFor).toBeNull();
  });

  it('refuses anything that is not a date — "soon" is not a promise', async () => {
    const { svc } = make({ promisedFor: null, status: 'open', promiseSlips: 0 });
    for (const bad of ['soon', 'Friday', '', '2026-13-45', 'next week']) {
      expect(await svc.recordPromise('t1', bad)).toEqual({ ok: false });
    }
  });

  it('ignores a promise on work that is already finished', async () => {
    const { svc } = make({ promisedFor: null, status: 'done', promiseSlips: 0 });
    expect(await svc.recordPromise('t1', future())).toEqual({ ok: false });
  });
});
