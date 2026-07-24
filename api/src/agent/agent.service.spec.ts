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
  const settings: any[] = [];
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
        const statusOk = (r: any) => {
          if (!where?.status) return true;
          if (typeof where.status === 'object' && Array.isArray(where.status.in)) return where.status.in.includes(r.status);
          return r.status === where.status;
        };
        // sessionId / NOT.sessionId / waitpoints.some filters (durable park + resume, BEA-795)
        const parkOk = (r: any) => {
          if (where?.sessionId !== undefined && (r.sessionId ?? null) !== where.sessionId) return false;
          if (where?.NOT?.sessionId !== undefined && (r.sessionId ?? null) === where.NOT.sessionId) return false;
          if (where?.waitpoints?.some && !wps.some((w) => w.runId === r.id && matchWp(w, where.waitpoints.some))) return false;
          return true;
        };
        let out = runs.filter((r) => (where?.agentId ? r.agentId === where.agentId : true) && statusOk(r) && parkOk(r));
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
      updateMany: async ({ where, data }: any) => {
        const match = (r: any) => {
          if (where?.id !== undefined && r.id !== where.id) return false;
          if (where?.NOT?.sessionId !== undefined && (r.sessionId ?? null) === where.NOT.sessionId) return false;
          if (where?.status !== undefined) {
            if (typeof where.status === 'object' && Array.isArray(where.status.in)) return where.status.in.includes(r.status);
            return r.status === where.status;
          }
          return true;
        };
        const hit = runs.filter(match);
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      delete: async ({ where }: any) => {
        const i = runs.findIndex((x) => x.id === where.id);
        if (i < 0) throw new Error('run not found');
        const [removed] = runs.splice(i, 1);
        for (let j = wps.length - 1; j >= 0; j--) if (wps[j].runId === removed.id) wps.splice(j, 1); // FK cascade
        return removed;
      },
      deleteMany: async ({ where }: any = {}) => {
        const match = (r: any) => {
          if (where?.agentId !== undefined && r.agentId !== where.agentId) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          if (where?.status?.notIn && where.status.notIn.includes(r.status)) return false;
          return true;
        };
        let count = 0;
        for (let i = runs.length - 1; i >= 0; i--) {
          if (!match(runs[i])) continue;
          const [rm] = runs.splice(i, 1);
          for (let j = wps.length - 1; j >= 0; j--) if (wps[j].runId === rm.id) wps.splice(j, 1);
          count++;
        }
        return { count };
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
    setting: {
      findUnique: async ({ where }: any) => settings.find((s) => s.key === where.key) || null,
      upsert: async ({ where, create, update }: any) => {
        const s = settings.find((x) => x.key === where.key);
        if (s) { Object.assign(s, update); return s; }
        const row = { key: where.key, ...create }; settings.push(row); return row;
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

  it('finishRun cannot revive a cancelled run (BEA-793)', async () => {
    const run = await svc.createRun();
    await svc.cancelRun(run.id);
    // a Codex turn that completes after the cancel must NOT flip it back to done
    const after = await svc.finishRun(run.id, { status: 'done', resultText: 'late result', outputDocId: 'doc1' });
    expect(after.status).toBe('cancelled');
    const fresh = await svc.getRun(run.id);
    expect(fresh.status).toBe('cancelled');
    expect(fresh.outputDocId ?? null).toBeNull(); // no result attached
  });

  it('answering a question whose run already finished does not revive it (BEA-794)', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'pick', options: ['a'] });
    // the run finished (e.g. Codex cap) while the question was still open
    await (svc as any).prisma.agentRun.update({ where: { id: run.id }, data: { status: 'failed', endedAt: new Date() } });
    await svc.answerByToken(wp.resumeToken, 'a');
    expect((await svc.getRun(run.id)).status).toBe('failed'); // NOT flipped back to running
  });

  it('an expired question does not flip an already-finished run to failed (BEA-794)', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'pick', options: ['a'] });
    await (svc as any).prisma.waitpoint.update({ where: { id: wp.id }, data: { expiresAt: new Date(Date.now() - 1000), defaultValue: null } });
    await (svc as any).prisma.agentRun.update({ where: { id: run.id }, data: { status: 'done', endedAt: new Date() } });
    await svc.sweepExpired(new Date());
    expect((await svc.getRun(run.id)).status).toBe('done'); // NOT flipped to failed
  });

  it('finishing a run cancels its open question (BEA-794)', async () => {
    const run = await svc.createRun();
    const wp = await svc.ask(run.id, { question: 'pick', options: ['a'] });
    await svc.finishRun(run.id, { status: 'done', resultText: 'ok' });
    const w = (await svc.getRun(run.id)).waitpoints.find((x: any) => x.id === wp.id);
    expect(w.status).toBe('cancelled');
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

  it('deleteRun removes a finished run and cascades its waitpoints (BEA-684)', async () => {
    const run = await svc.createRun({ input: 'topic' });
    await svc.ask(run.id, { question: 'Which angle?', kind: 'choice', options: ['a', 'b'] });
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'done' } });
    await svc.deleteRun(run.id);
    expect(prisma._runs).toHaveLength(0);
    expect(prisma._wps).toHaveLength(0); // cascaded
    await expect(svc.getRun(run.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteRun refuses a run that is still in progress (BEA-684)', async () => {
    const run = await svc.createRun({ input: 'topic' }); // status 'running'
    await expect(svc.deleteRun(run.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma._runs).toHaveLength(1); // kept
  });

  it('clearRuns deletes finished runs but keeps in-flight ones, scoped by agent (BEA-684)', async () => {
    const ag = await svc.createAgent({ name: 'A', prompt: 'x' });
    const other = await svc.createAgent({ name: 'B', prompt: 'y' });
    const done = await svc.createRun({ agentId: ag.id });
    await prisma.agentRun.update({ where: { id: done.id }, data: { status: 'done' } });
    const live = await svc.createRun({ agentId: ag.id }); // running
    const otherDone = await svc.createRun({ agentId: other.id });
    await prisma.agentRun.update({ where: { id: otherDone.id }, data: { status: 'failed' } });

    const res = await svc.clearRuns(ag.id);
    expect(res.deleted).toBe(1);
    const left = (await svc.listRuns({ agentId: ag.id })).map((r) => r.id);
    expect(left).toEqual([live.id]); // in-flight kept
    expect(await svc.listRuns({ agentId: other.id })).toHaveLength(1); // other agent untouched

    const all = await svc.clearRuns(); // no scope → clears all finished, keeps the running one
    expect(all.deleted).toBe(1);
    expect(prisma._runs).toHaveLength(1);
    expect(prisma._runs[0].id).toBe(live.id);
  });

  it('reconcileOrphans fails running AND paused runs left by a restart, leaving terminal runs alone (BEA-629, BEA-632)', async () => {
    const live = await svc.createRun({ input: 'check email related to V-Guard' }); // orphaned 'running'
    const paused = await svc.createRun({ input: 'awaiting something' });
    await svc.ask(paused.id, { question: 'Which one?', kind: 'choice', options: ['a', 'b'] }); // → status 'awaiting_input' + pending waitpoint
    const done = await svc.createRun({ input: 'a' });
    await svc.finishRun(done.id, { status: 'done' });
    const cancelled = await svc.createRun({ input: 'b' });
    await svc.finishRun(cancelled.id, { status: 'cancelled' });

    const n = await svc.reconcileOrphans();
    expect(n).toBe(2); // running + awaiting_input

    const afterLive = await svc.getRun(live.id);
    expect(afterLive.status).toBe('failed');
    expect(afterLive.error).toMatch(/restart/i);
    expect(afterLive.endedAt).toBeTruthy();
    expect((afterLive.stepLog as any[]).some((s) => /interrupted/i.test(s.label))).toBe(true);

    const afterPaused = await svc.getRun(paused.id);
    expect(afterPaused.status).toBe('failed');
    expect(afterPaused.error).toMatch(/waiting for your answer/i);
    // its pending question was cancelled, not left dangling
    expect((prisma._wps as any[]).every((w) => w.status !== 'pending')).toBe(true);

    // terminal runs are untouched
    expect((await svc.getRun(done.id)).status).toBe('done');
    expect((await svc.getRun(cancelled.id)).status).toBe('cancelled');

    // idempotent — nothing left to fix
    expect(await svc.reconcileOrphans()).toBe(0);
  });

  it('BEA-795 reconcileOrphans leaves durably PARKED runs alone — the pause must survive a restart', async () => {
    const parked = await svc.createRun({ input: 'research then ask me' });
    await svc.ask(parked.id, { question: 'Which vendor?', kind: 'choice', options: ['A', 'B'] });
    await svc.parkRun(parked.id, 'sess-1'); // the bridge parked it on its engine session

    const answeredPark = await svc.createRun({ input: 'other parked run' });
    const wp = await svc.ask(answeredPark.id, { question: 'Go on?', kind: 'free_text' });
    await svc.parkRun(answeredPark.id, 'sess-2');
    await svc.answerByToken(wp.resumeToken, 'yes'); // → status 'running' + sessionId still set (awaiting the sweeper)

    expect(await svc.reconcileOrphans()).toBe(0); // neither is an orphan
    expect((await svc.getRun(parked.id)).status).toBe('awaiting_input'); // still waiting, question intact
    expect((prisma._wps as any[]).filter((w) => w.runId === parked.id && w.status === 'pending')).toHaveLength(1);
    expect((await svc.getRun(answeredPark.id)).status).toBe('running'); // left for the resume sweeper
  });

  it('BEA-795 listResumable + claimResume: answered parks surface once, and only one claimer wins', async () => {
    const run = await svc.createRun({ input: 'ask then continue' });
    const wp = await svc.ask(run.id, { question: 'Colour?', kind: 'choice', options: ['red', 'blue'] });
    await svc.parkRun(run.id, 'sess-9');

    expect(await svc.listResumable()).toHaveLength(0); // unanswered → not resumable yet
    await svc.answerByToken(wp.resumeToken, 'blue');
    const list = await svc.listResumable();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(run.id);
    expect(list[0].sessionId).toBe('sess-9');

    expect(await svc.claimResume(run.id)).toBe(true); // first claim wins and clears the marker
    expect(await svc.claimResume(run.id)).toBe(false); // second claim loses (no double drivers)
    expect(await svc.listResumable()).toHaveLength(0); // claimed → gone from the queue
  });

  it('BEA-795 parkRun with no engine session stores the "" marker so the run still resumes', async () => {
    const run = await svc.createRun({ input: 'x' });
    const wp = await svc.ask(run.id, { question: 'q', kind: 'free_text' });
    await svc.parkRun(run.id, undefined); // engine returned no sessionId
    await svc.answerByToken(wp.resumeToken, 'ok');
    const list = await svc.listResumable();
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(''); // parked-without-session sentinel
    expect(await svc.claimResume(run.id)).toBe(true);
  });

  it('BEA-859 boot reconcile retries through transient DB failures instead of swallowing them', async () => {
    let calls = 0;
    (svc as any).reconcileOrphans = jest.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('database is locked');
      return 0;
    });
    await svc.reconcileWithRetry(5, 1);
    expect(calls).toBe(3); // failed twice, then succeeded — no orphan left stuck

    calls = 0;
    (svc as any).reconcileOrphans = jest.fn(async () => { calls++; throw new Error('database is locked'); });
    await svc.reconcileWithRetry(4, 1); // exhausts without throwing (boot must not crash)
    expect(calls).toBe(4);
  });

  it('records and reads engine watchdog health (BEA-632)', async () => {
    expect(await svc.engineHealth()).toEqual({ lastHealthyAt: null, lastAutoRestartAt: null, lastError: null });
    await svc.recordEngineHealth({ healthyAt: 1234, error: null });
    await svc.recordEngineHealth({ restartedAt: 5678, error: 'auto-restarted' });
    const h = await svc.engineHealth();
    expect(h.lastHealthyAt).toBe(1234);
    expect(h.lastAutoRestartAt).toBe(5678);
    expect(h.lastError).toBe('auto-restarted');
  });
});
