import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentService } from './agent.service';

// ---- minimal in-memory fake of the Prisma models AgentService uses ----
function matchWp(row: any, where: any = {}): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.resumeToken !== undefined && row.resumeToken !== where.resumeToken) return false;
  if (where.runId !== undefined && row.runId !== where.runId) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.expiresAt !== undefined) {
    const c = where.expiresAt;
    if ('not' in c && c.not === null && row.expiresAt === null) return false;
    if ('lte' in c) {
      if (row.expiresAt === null || row.expiresAt === undefined) return false;
      if (new Date(row.expiresAt).getTime() > new Date(c.lte).getTime()) return false;
    }
  }
  return true;
}

function fakePrisma() {
  const runs: any[] = [];
  const wps: any[] = [];
  const ags: any[] = [];
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  return {
    _runs: runs,
    _wps: wps,
    agentRun: {
      create: async ({ data }: any) => {
        const row = { id: id('run'), agentId: null, title: null, input: null, status: 'running', sessionId: null, stepLog: '[]', outputDocId: null, error: null, startedAt: new Date(), endedAt: null, ...data };
        runs.push(row);
        return row;
      },
      findUnique: async ({ where, include }: any) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) return null;
        return include?.waitpoints ? { ...r, waitpoints: wps.filter((w) => w.runId === r.id) } : r;
      },
      findMany: async ({ where, include, take }: any = {}) => {
        let out = runs.filter((r) => (where?.agentId ? r.agentId === where.agentId : true));
        out = [...out].reverse();
        if (take) out = out.slice(0, take);
        return include?.waitpoints ? out.map((r) => ({ ...r, waitpoints: wps.filter((w) => w.runId === r.id) })) : out;
      },
      update: async ({ where, data }: any) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) throw new Error('run not found');
        Object.assign(r, data);
        return r;
      },
    },
    waitpoint: {
      create: async ({ data }: any) => {
        const row = { id: id('wp'), kind: 'choice', options: '[]', defaultValue: null, status: 'pending', answer: null, answeredVia: null, expiresAt: null, answeredAt: null, createdAt: new Date(), ...data };
        wps.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => wps.find((w) => (where.id ? w.id === where.id : w.resumeToken === where.resumeToken)) || null,
      findMany: async ({ where }: any = {}) => wps.filter((w) => matchWp(w, where)),
      update: async ({ where, data }: any) => {
        const w = wps.find((x) => x.id === where.id);
        if (!w) throw new Error('wp not found');
        Object.assign(w, data);
        return w;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = wps.filter((w) => matchWp(w, where));
        hit.forEach((w) => Object.assign(w, data));
        return { count: hit.length };
      },
    },
    agent: {
      create: async ({ data }: any) => { const row = { id: id('ag'), prompt: null, icon: null, description: null, autonomy: 'cautious', skills: '[]', schedule: null, scheduleText: null, lastFiredKey: null, collectionId: null, enabled: true, createdAt: new Date(), updatedAt: new Date(), ...data }; ags.push(row); return row; },
      findMany: async () => [...ags].reverse(),
      findUnique: async ({ where }: any) => ags.find((a) => a.id === where.id) || null,
      update: async ({ where, data }: any) => { const a = ags.find((x) => x.id === where.id); if (!a) throw new Error('not found'); Object.assign(a, data); return a; },
      delete: async ({ where }: any) => { const i = ags.findIndex((x) => x.id === where.id); if (i < 0) throw new Error('not found'); return ags.splice(i, 1)[0]; },
    },
  };
}

describe('AgentService — durable human-in-the-loop engine (BEA-619)', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let svc: AgentService;

  beforeEach(() => {
    prisma = fakePrisma();
    svc = new AgentService(prisma as any);
  });

  it('creates a run in the running state', async () => {
    const run = await svc.createRun({ title: 'Research X', input: 'topic' });
    expect(run.status).toBe('running');
    expect(run.stepLog).toEqual([]); // shaped from "[]" to an array
  });

  it('ask() pauses the run durably and mints a one-time token', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'Which angle?', kind: 'choice', options: ['cost', 'speed'], defaultValue: 'cost' });
    expect(wp.status).toBe('pending');
    expect(wp.kind).toBe('choice');
    expect(wp.options).toEqual(['cost', 'speed']); // round-trips through JSON
    expect(typeof wp.resumeToken).toBe('string');
    expect(wp.resumeToken.length).toBeGreaterThan(20);
    const after = await svc.getRun(run.id);
    expect(after.status).toBe('awaiting_input');
  });

  it('round-trips structured (object) options', async () => {
    const run = await svc.createRun();
    const draft = { draft: 'Hi Ravi, paying Friday.', fields: [{ key: 'tone', type: 'choice' }] };
    const wp = await svc.ask(run.id, { question: 'Send this?', kind: 'approve_edit_reject', options: draft });
    expect(wp.options).toEqual(draft);
  });

  it('answers by token: applies once and resumes the run', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'Which angle?', options: ['cost', 'speed'] });
    const res = await svc.answerByToken(wp.resumeToken, 'speed', 'telegram');
    expect(res.applied).toBe(true);
    expect(res.waitpoint.status).toBe('answered');
    expect(res.waitpoint.answer).toBe('speed');
    expect(res.waitpoint.answeredVia).toBe('telegram');
    expect(res.run.status).toBe('running'); // handed back to the engine
  });

  it('is idempotent: a second answer (e.g. double-tap) is a no-op and keeps the first answer', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'Which angle?', options: ['cost', 'speed'] });
    const first = await svc.answerByToken(wp.resumeToken, 'speed');
    const second = await svc.answerByToken(wp.resumeToken, 'cost');
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.alreadyResolved).toBe(true);
    const fresh = await svc.getRun(run.id);
    expect(fresh.waitpoints[0].answer).toBe('speed'); // first answer preserved
    expect(fresh.status).toBe('running');
  });

  it('survives a restart: a brand-new service instance over the same store can resolve the pause', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'Which angle?', options: ['cost', 'speed'] });
    // simulate the API process restarting — no in-memory state carries over
    const svc2 = new AgentService(prisma as any);
    const res = await svc2.answerByToken(wp.resumeToken, 'cost');
    expect(res.applied).toBe(true);
    expect((await svc2.getRun(run.id)).status).toBe('running');
  });

  it('rejects a bad/old token', async () => {
    await expect(svc.answerByToken('nope', 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to ask on a finished run', async () => {
    const run = await svc.createRun();
    await svc.finishRun(run.id, { status: 'done' });
    await expect(svc.ask(run.id, { question: 'too late?' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers by waitpoint id (in-app path) too', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'pick', options: ['a', 'b'] });
    const res = await svc.answerById(wp.id, 'b', 'web');
    expect(res.applied).toBe(true);
    expect(res.waitpoint.answer).toBe('b');
  });

  it('sweepExpired applies the smart default to overdue questions', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'pick', options: ['a', 'b'], defaultValue: 'a', expiresInMs: 1000 });
    const future = new Date(Date.now() + 10_000);
    const handled = await svc.sweepExpired(future);
    expect(handled).toBe(1);
    const fresh = await svc.getRun(run.id);
    expect(fresh.waitpoints[0].status).toBe('answered');
    expect(fresh.waitpoints[0].answer).toBe('a');
    expect(fresh.waitpoints[0].answeredVia).toBe('timeout');
    expect(fresh.status).toBe('running');
    void wp;
  });

  it('sweepExpired parks the run when there is no default', async () => {
    const run = await svc.createRun();
    await svc.ask(run.id, { question: 'pick', options: ['a', 'b'], expiresInMs: 1000 });
    const handled = await svc.sweepExpired(new Date(Date.now() + 10_000));
    expect(handled).toBe(1);
    const fresh = await svc.getRun(run.id);
    expect(fresh.waitpoints[0].status).toBe('expired');
    expect(fresh.status).toBe('failed');
  });

  it('sweepExpired ignores questions that are not due yet or already answered', async () => {
    const run = await svc.createRun();
    await svc.ask(run.id, { question: 'pending-future', options: ['a'], defaultValue: 'a', expiresInMs: 60_000 });
    const run2 = await svc.createRun();
    const wp2 = await svc.ask(run2.id, { question: 'answered', options: ['a'], expiresInMs: 1000 });
    await svc.answerByToken(wp2.resumeToken, 'a');
    const handled = await svc.sweepExpired(new Date(Date.now() + 5000));
    expect(handled).toBe(0); // first not due (60s), second already answered
  });

  it('cancelRun cancels the run and any open question', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'pick', options: ['a'] });
    const res = await svc.cancelRun(run.id);
    expect(res.status).toBe('cancelled');
    const fresh = await svc.getRun(run.id);
    expect(fresh.waitpoints[0].status).toBe('cancelled');
    // answering a cancelled question is a no-op
    const ans = await svc.answerByToken(wp.resumeToken, 'a');
    expect(ans.applied).toBe(false);
  });

  it('appendStep records plain-English progress', async () => {
    const run = await svc.createRun();
    await svc.appendStep(run.id, { label: 'Read sources', status: 'done' });
    const fresh = await svc.getRun(run.id);
    expect(fresh.stepLog).toHaveLength(1);
    expect(fresh.stepLog[0].label).toBe('Read sources');
  });

  it('attachOutput links a saved document to the run', async () => {
    const run = await svc.createRun();
    const updated = await svc.attachOutput(run.id, 'doc-42');
    expect(updated.outputDocId).toBe('doc-42');
  });

  it('getWaitpoint reads a question back by its token (for polling agents)', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'pick', options: ['a', 'b'] });
    const read = await svc.getWaitpoint(wp.resumeToken);
    expect(read?.id).toBe(wp.id);
    expect(read?.status).toBe('pending');
    expect(await svc.getWaitpoint('missing')).toBeNull();
  });

  // ---- saved agents (BEA-623) ----
  it('creates a saved agent with a parsed schedule', async () => {
    const a = await svc.createAgent({ name: 'Morning Brief', prompt: 'summarise my day', schedule: { every: 'weekday', at: '07:00' }, scheduleText: 'every weekday 7am' });
    expect(a.name).toBe('Morning Brief');
    expect(a.schedule).toEqual({ every: 'weekday', at: '07:00' }); // round-trips through JSON
    expect((await svc.listAgents())).toHaveLength(1);
  });

  it('updates an agent and resets the fired-marker when the schedule changes', async () => {
    const a = await svc.createAgent({ name: 'A', prompt: 'x', schedule: { every: 'day', at: '08:00' } });
    await svc.markFired(a.id, '2026-06-28:08:00');
    const up = await svc.updateAgent(a.id, { schedule: { every: 'day', at: '09:00' } });
    expect(up.schedule).toEqual({ every: 'day', at: '09:00' });
    expect((await svc.getAgent(a.id)).lastFiredKey).toBeNull(); // reset so the new slot can fire
  });

  it('deletes an agent', async () => {
    const a = await svc.createAgent({ name: 'Temp', prompt: 'x' });
    await svc.deleteAgent(a.id);
    expect(await svc.listAgents()).toHaveLength(0);
  });
});
