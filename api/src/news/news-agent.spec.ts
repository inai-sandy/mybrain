import { FlowsService } from '../flows/flows.service';
import { NEWS_FLOW_NAME, NEWS_SCHEDULE, NewsAgentService, newsGraph } from './news-agent.service';
import { NewsPipelineService } from './news-pipeline.service';

/**
 * BEA-1259 — AI News Daily as an agent, with a flow Auto-plan cannot touch.
 *
 * The lock is the point. The planner is good at turning a question into branches and terrible at
 * leaving a working pipeline alone: one press would replace the three real steps with generic
 * web-search branches and throw the RSS work away, exactly as BEA-1246 downgraded a research flow.
 */

describe('the flow is drawn by hand, and it is a real pipeline (BEA-1259)', () => {
  const g = newsGraph();

  it('runs collect → write → flag, in that order, into the output', () => {
    const ids = g.nodes.map((n: any) => n.id);
    expect(ids).toEqual(['question', 'news_collect', 'news_write', 'news_flag', 'output']);
    expect(g.edges.map((e: any) => `${e.source}>${e.target}`)).toEqual([
      'question>news_collect',
      'news_collect>news_write',
      'news_write>news_flag',
      'news_flag>output',
    ]);
  });

  it('every step is a real TOOL, not an ask-the-model box', () => {
    // A node whose refId is not a registered tool falls through to a plain model call, which would
    // cheerfully describe collecting the news instead of collecting it.
    const steps = g.nodes.filter((n: any) => n.data.kind === 'tool');
    expect(steps).toHaveLength(3);
    expect(steps.map((n: any) => n.data.refId)).toEqual(['news_collect', 'news_write', 'news_flag']);
  });

  it('is scheduled for noon in the owner\'s timezone', () => {
    expect(NEWS_SCHEDULE).toEqual({ every: 'day', at: '12:00' });
  });
});

describe('Auto-plan refuses a locked flow (BEA-1259)', () => {
  function svc(flow: any) {
    const prisma: any = { flow: { findUnique: async () => flow, update: async ({ data }: any) => ({ ...flow, ...data }) } };
    const llm: any = { completeHelper: async () => JSON.stringify({ branches: [{ subquestion: 'x', steps: [{ kind: 'ask_ai' }] }] }) };
    const skills: any = { list: async () => [] };
    const prompts: any = { get: async () => 'PLAN IT' };
    const catalog: any = { catalog: async () => ({ groups: [], tools: [] }) };
    return new FlowsService(prisma, skills, llm, prompts, catalog);
  }

  it('says why, in plain words, and leaves the flow alone', async () => {
    const flow = { id: 'f1', name: NEWS_FLOW_NAME, question: 'what happened', graph: JSON.stringify(newsGraph()), locked: true };
    await expect(svc(flow).planAndSave('f1')).rejects.toThrow(/locked flow/);
    await expect(svc(flow).planAndSave('f1')).rejects.toThrow(/Unlock it first/);
  });

  it('an ordinary flow still re-plans exactly as before', async () => {
    const flow = { id: 'f2', name: 'Some flow', question: 'what happened', graph: '{"nodes":[],"edges":[]}', locked: false };
    const out: any = await svc(flow).planAndSave('f2');
    expect(out.graph.nodes.length).toBeGreaterThan(0);
  });

  it('the ordinary SAVE path cannot overwrite a locked flow either', async () => {
    // Guarding only Auto-plan left the lock worthless: the canvas PATCHes this same endpoint on
    // every edit, so opening AI News Daily and nudging one node would have wiped the hand-drawn
    // steps. Same failure, different button.
    const flow = { id: 'f1', name: NEWS_FLOW_NAME, graph: JSON.stringify(newsGraph()), locked: true };
    await expect(svc(flow).update('f1', { graph: { nodes: [], edges: [] } })).rejects.toThrow(/locked flow/);
    await expect(svc(flow).update('f1', { schedule: { every: 'day', at: '03:00' } })).rejects.toThrow(/locked flow/);
  });

  it('renaming a locked flow is still allowed — it changes nothing about what runs', async () => {
    const flow = { id: 'f1', name: NEWS_FLOW_NAME, graph: JSON.stringify(newsGraph()), locked: true };
    await expect(svc(flow).update('f1', { name: 'My morning paper' })).resolves.toBeTruthy();
  });

  it('unlocking and changing it in one go is allowed — the lock is a guard, not a prison', async () => {
    const flow = { id: 'f1', name: NEWS_FLOW_NAME, graph: JSON.stringify(newsGraph()), locked: true };
    await expect(svc(flow).update('f1', { locked: false, graph: { nodes: [], edges: [] } })).resolves.toBeTruthy();
  });

  it('an ordinary flow saves exactly as before', async () => {
    const flow = { id: 'f2', name: 'Some flow', graph: '{"nodes":[],"edges":[]}', locked: false };
    await expect(svc(flow).update('f2', { graph: { nodes: [{ id: 'a' }], edges: [] } })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('setting the agent up is safe to repeat (BEA-1259)', () => {
  function harness(seed: { areas?: any[]; jobs?: any[]; flows?: any[]; settings?: Record<string, string> } = {}) {
    const areas = seed.areas || [];
    const jobs = seed.jobs || [];
    const flows = seed.flows || [];
    const settings = new Map<string, string>(Object.entries(seed.settings || {}));
    const prisma: any = {
      setting: {
        findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
        upsert: async ({ where, create, update }: any) => {
          settings.set(where.key, (settings.has(where.key) ? update : create).value);
          return { key: where.key, value: settings.get(where.key) };
        },
      },
      agentArea: { findMany: async () => areas },
      agent: { findMany: async () => jobs },
      flow: {
        findMany: async ({ where }: any) => flows.filter((f) => f.agentId === where.agentId),
        create: async ({ data }: any) => {
          const f = { id: `f${flows.length + 1}`, ...data };
          flows.push(f);
          return f;
        },
        update: async ({ where, data }: any) => {
          const f = flows.find((x) => x.id === where.id);
          Object.assign(f, data);
          return f;
        },
      },
    };
    const areasSvc: any = {
      create: async (a: any) => {
        const row = { id: `a${areas.length + 1}`, ...a };
        areas.push(row);
        return row;
      },
    };
    const agentSvc: any = {
      createAgent: async (a: any) => {
        const row = { id: `j${jobs.length + 1}`, ...a };
        jobs.push(row);
        return row;
      },
    };
    return { service: new NewsAgentService(prisma, areasSvc, agentSvc), areas, jobs, flows, settings };
  }

  it('creates the agent, its job and a LOCKED, scheduled flow', async () => {
    const { service, areas, jobs, flows } = harness();
    const out = await service.ensure();
    expect(out.created).toBe(true);
    expect(areas).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(flows).toHaveLength(1);
    expect(flows[0].locked).toBe(true);
    expect(JSON.parse(flows[0].schedule)).toEqual(NEWS_SCHEDULE);
    expect(areas[0].tools.map((t: any) => t.id)).toEqual(['news_collect', 'news_write', 'news_flag']);
  });

  it('running it again makes nothing new', async () => {
    const { service, areas, jobs, flows } = harness();
    await service.ensure();
    const second = await service.ensure();
    expect(second.created).toBe(false);
    expect(areas).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(flows).toHaveLength(1);
  });

  it('re-locks a flow someone unlocked, rather than leaving it one press from ruin', async () => {
    const { service, flows } = harness({
      areas: [{ id: 'a1', name: 'AI News Daily' }],
      jobs: [{ id: 'j1', name: 'AI News Daily', areaId: 'a1' }],
      flows: [{ id: 'f1', name: NEWS_FLOW_NAME, agentId: 'j1', locked: false, schedule: null }],
    });
    await service.ensure();
    expect(flows[0].locked).toBe(true);
    expect(JSON.parse(flows[0].schedule)).toEqual(NEWS_SCHEDULE);
  });

  it('survives you RENAMING the agent — it does not build a second one', async () => {
    // Matching on name alone meant a rename made the next setup miss the job, create a second one
    // with its own locked, scheduled flow, and then TWO editions would publish at noon.
    const h = harness();
    await h.service.ensure();
    h.areas[0].name = 'My morning paper';
    h.jobs[0].name = 'Morning paper';
    const second = await h.service.ensure();
    expect(second.created).toBe(false);
    expect(h.areas).toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
    expect(h.flows).toHaveLength(1);
  });

  it('sets itself up on first boot, and only once', async () => {
    // Otherwise "it runs itself at noon" is only true if somebody remembers to call setup by hand.
    const h = harness();
    await h.service.ensureOnce();
    expect(h.flows).toHaveLength(1);
    expect(h.settings.get('news.agent.setupAt')).toBeTruthy();
  });

  it('once you delete the agent it STAYS deleted — it does not reappear every restart', async () => {
    const h = harness({ settings: { 'news.agent.setupAt': '2026-08-01T00:00:00Z' } });
    await h.service.ensureOnce();
    expect(h.areas).toHaveLength(0);
    expect(h.flows).toHaveLength(0);
  });

  it('a setup failure never takes the app down', async () => {
    const prisma: any = {
      setting: { findUnique: async () => null, upsert: async () => ({}) },
      agentArea: { findMany: async () => { throw new Error('database is locked'); } },
    };
    await expect(new NewsAgentService(prisma, {} as any, {} as any).ensureOnce()).resolves.toBeUndefined();
  });

  it('says so plainly when the agent module is missing, instead of half-creating things', async () => {
    const prisma: any = { agentArea: { findMany: async () => [] } };
    await expect(new NewsAgentService(prisma).ensure()).rejects.toThrow(/agent module is not available/);
  });
});

describe('the pipeline steps report what actually happened (BEA-1259)', () => {
  function pipe(over: any = {}) {
    // `in` rather than `??` — a test that passes `issue: null` means "there is no issue", and
    // `null ?? default` would quietly hand back the default instead.
    const issue = 'issue' in over ? over.issue : { id: 'i1', title: 'not much happened today', pubDate: new Date('2026-07-31T05:44:39Z') };
    const prisma: any = { newsIssue: { findFirst: async () => issue }, newsEdition: { findUnique: async () => null } };
    return new NewsPipelineService(
      prisma,
      { poll: async () => over.poll ?? { ok: true, fetched: 10, stored: 1, known: 9, filled: 0, unusable: 0 } } as any,
      { splitPending: async () => over.splits ?? [{ ok: true }] } as any,
      { categoriseIssue: async () => over.cat ?? { ok: true, total: 40, placed: 40, uncategorised: 0, batches: 2 } } as any,
      { publishEdition: async () => over.edition ?? { id: 'e1', number: 3, day: '2026-07-31', engineOk: true, storyCount: 40, notes: [] } } as any,
      { flagIssue: async () => over.flag ?? { ok: true, considered: 40, flagged: 3 } } as any,
    );
  }

  it('collect says how many stories it found and filed', async () => {
    const out = await pipe().collect();
    expect(out).toContain('Stories found: 40');
    expect(out).toContain('None left uncategorised');
  });

  it('a feed that will not come back FAILS the step rather than writing an empty edition', async () => {
    await expect(pipe({ poll: { ok: false, message: 'the feed returned 503' } }).collect()).rejects.toThrow(/503/);
  });

  it('write says plainly when not every section was written', async () => {
    const out = await pipe({ edition: { number: 3, day: '2026-07-31', engineOk: false, storyCount: 40, notes: ['Models & releases could not be produced.'] } }).writeToday();
    expect(out).toContain('NOT every section was written');
    expect(out).toContain('every story and every link');
  });

  it('a failed shortlist does not fail the run — the edition is still fine', async () => {
    const out = await pipe({ flag: { ok: false, message: 'the model returned nothing — every story still has its own research button' } }).flagToday();
    expect(out).toContain('Could not work out what is worth researching');
  });

  it('a clean day says so instead of looking broken', async () => {
    const out = await pipe({ flag: { ok: true, considered: 40, flagged: 0 } }).flagToday();
    expect(out).toContain('Nothing today needs chasing');
  });

  it('the run says WHERE the edition is — there is no file to go looking for', async () => {
    // The owner ran it, found two markdown documents from the flow runner, no HTML anywhere, and
    // had no idea the output was a page. A run that produces something unopenable is a run that
    // did not finish.
    const out = await pipe().writeToday();
    expect(out).toContain('/news/2026-07-31');
    expect(out).toContain('/paper/2026-07-31');
  });

  it('says plainly when the source has not published anything newer', async () => {
    // Re-writing an older day and reporting it like a fresh one is how a run looks successful and
    // still feels wrong.
    const out = await pipe().collect();
    expect(out).toContain('has not published since 2026-07-31');
  });

  it('the whole run ends with the headline and the two links', async () => {
    // The last step's output becomes the run's saved "result" document, so it has to be the thing
    // worth opening — not whatever the final step happened to say.
    const p = pipe();
    (p as any).prisma.newsEdition = { findUnique: async () => ({ number: 3, day: '2026-07-31', headline: 'DeepSeek resets the price war', storyCount: 40 }) };
    const out = await p.runDaily();
    expect(out).toContain('AI News Daily No. 3');
    expect(out).toContain('DeepSeek resets the price war');
    expect(out).toContain('no file to find');
    expect(out).toContain('/paper/2026-07-31');
  });

  it('writing before collecting fails with a plain reason', async () => {
    await expect(pipe({ issue: null }).writeToday()).rejects.toThrow(/run the collect step first/);
  });
});
