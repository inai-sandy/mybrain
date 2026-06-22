import { MentalModelService } from './mentalmodel.service';
import { DaySignals } from './mind.types';

const SIGNALS: DaySignals = {
  day: '2026-06-20',
  tasks: {
    done: [{ id: 'a', title: 'Gym', category: 'Health', sphere: 'personal', priority: 'medium', pinned: false, rolloverCount: 0, status: 'done' }],
    skipped: [],
    postponed: [{ id: 'c', title: 'Read vendor contract', category: 'Admin', sphere: 'work', priority: 'high', pinned: false, rolloverCount: 5, status: 'open' }],
    created: [],
    counts: { done: 1, open: 0, skipped: 0, postponed: 1, created: 0 },
  },
  story: { rawText: 'Gym felt great. Dreading that contract, put it off again.', mood: 'mixed', workedMinutes: 300, workedBreakdown: null },
  daySummary: null,
  ideas: [],
  emails: [],
  meetings: [],
  hasSignal: true,
};

function harness(opts: { llmJson: string; existing?: any[]; closed?: string[] }) {
  const created: any[] = [];
  const updated: any[] = [];
  const evidence: any[] = [];
  const existing = opts.existing || [];
  const settings: Record<string, string> = {};
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (where?.key in settings ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create }: any) => {
        settings[where.key] = create.value;
        return { key: where.key, value: create.value };
      },
    },
    dayClose: { findMany: async () => (opts.closed || []).map((day) => ({ day })) },
    mindFinding: {
      findMany: async ({ where }: any) => {
        if (where?.validated === 'refuted') return [];
        return existing;
      },
      create: async ({ data }: any) => {
        const row = { id: `new-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        updated.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
    mindEvidence: { createMany: async ({ data }: any) => { evidence.push(...data); return { count: data.length }; } },
  };
  const llm: any = { completeWith: jest.fn(async () => opts.llmJson) };
  const ingestion: any = { gatherDaySignals: jest.fn(async () => SIGNALS) };
  const lifecycle: any = { runDaily: jest.fn(async () => ({ merged: 0, decayed: 0, promoted: 0, retired: 0 })) };
  const svc = new MentalModelService(prisma, llm, ingestion, lifecycle);
  return { svc, created, updated, evidence, llm, ingestion, settings };
}

const ONE_FINDING = JSON.stringify({
  findings: [{ reinforcesId: null, statement: 'Gym lifts you', kind: 'causal', subject: 'gym', relation: 'energizes', object: 'you', valence: 'energizing', confidence: 0.4, cadence: 'situational', evidence: [{ signal: 'done', snippet: 'Gym felt great' }] }],
});

describe('MentalModelService close-day learning (BEA-458)', () => {
  it('runNow learns only CLOSED days that were not learned yet, and marks them learned', async () => {
    const { svc, ingestion, settings } = harness({ llmJson: ONE_FINDING, closed: ['2026-06-18', '2026-06-19'] });
    const r = await svc.runNow();
    expect(r.days).toBe(2); // both closed days, none learned yet
    expect(ingestion.gatherDaySignals).toHaveBeenCalledWith('2026-06-18');
    expect(ingestion.gatherDaySignals).toHaveBeenCalledWith('2026-06-19');
    expect(JSON.parse(settings['mind.learnedDays'])).toEqual(['2026-06-18', '2026-06-19']);
  });

  it('runNow re-reflects on the latest closed day once everything is already learned', async () => {
    const { svc, ingestion } = harness({ llmJson: ONE_FINDING, closed: ['2026-06-18', '2026-06-19'] });
    await svc.runNow(); // learns both
    ingestion.gatherDaySignals.mockClear();
    const r = await svc.runNow(); // nothing new → re-reflect on the latest
    expect(r.days).toBe(1);
    expect(ingestion.gatherDaySignals).toHaveBeenCalledTimes(1);
    expect(ingestion.gatherDaySignals).toHaveBeenCalledWith('2026-06-19');
  });

  it('learnDay reflects on the given day and records it as learned', async () => {
    const { svc, settings } = harness({ llmJson: ONE_FINDING, closed: [] });
    await svc.learnDay('2026-06-20');
    expect(JSON.parse(settings['mind.learnedDays'])).toContain('2026-06-20');
  });
});

describe('MentalModelService.run (BEA-447)', () => {
  it('creates new findings and reinforces existing ones from the LLM output', async () => {
    const llmJson = JSON.stringify({
      findings: [
        { reinforcesId: null, statement: 'Exercise reliably lifts your mood', kind: 'causal', subject: 'gym', relation: 'energizes', object: 'you', valence: 'energizing', confidence: 0.4, cadence: 'situational', evidence: [{ signal: 'done', snippet: 'Gym felt great' }] },
        { reinforcesId: 'exist-1', statement: 'Admin/contract work drains you and you defer it', kind: 'behavioural', subject: 'admin tasks', relation: 'drains', object: 'you', valence: 'draining', confidence: 0.5, cadence: 'situational', evidence: [{ signal: 'postponed', snippet: 'put it off again' }] },
      ],
    });
    const { svc, created, updated, evidence } = harness({ llmJson, existing: [{ id: 'exist-1', statement: 'Admin work drains you', confidence: 0.5, evidenceCount: 2, status: 'emerging' }] });
    const r = await svc.run('2026-06-20');
    expect(r).toEqual({ proposed: 1, reinforced: 1 });
    expect(created[0]).toMatchObject({ subject: 'gym', valence: 'energizing', status: 'emerging' }); // conf 0.4 → emerging
    expect(updated[0].id).toBe('exist-1');
    expect(updated[0].data.evidenceCount).toBe(3); // 2 + 1
    expect(updated[0].data.confidence).toBeGreaterThan(0.5); // reinforced upward
    expect(evidence.length).toBe(2);
  });

  it('salvages complete findings from a TRUNCATED (token-capped) LLM response', async () => {
    const truncated =
      '{"findings":[' +
      '{"reinforcesId":null,"statement":"Gym lifts you","kind":"causal","subject":"gym","relation":"energizes","object":"you","valence":"energizing","confidence":0.4,"cadence":"situational","evidence":[{"signal":"done","snippet":"Gym felt great"}]},' +
      '{"reinforcesId":null,"statement":"Admin drains you","kind":"behavioural","subject":"admin","relation":"drains","object":"you","valence":"draining","confidence":0.5,"cadence":"situational","evidence":[{"signal":"postponed","snippet":"put it o'; // cut off mid-second finding
    const { svc, created } = harness({ llmJson: truncated });
    const r = await svc.run('2026-06-20');
    expect(r.proposed).toBe(1); // the first complete finding is recovered
    expect(created[0].subject).toBe('gym');
  });

  it('a malformed LLM response never corrupts the store', async () => {
    const { svc, created, updated } = harness({ llmJson: 'sorry, I cannot do that' });
    const r = await svc.run('2026-06-20');
    expect(r).toEqual({ proposed: 0, reinforced: 0 });
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('does nothing on a day with no signal', async () => {
    const { svc, llm } = harness({ llmJson: '{}' });
    (svc as any).ingestion.gatherDaySignals = async () => ({ ...SIGNALS, hasSignal: false });
    const r = await svc.run('2026-06-20');
    expect(r).toEqual({ proposed: 0, reinforced: 0 });
    expect(llm.completeWith).not.toHaveBeenCalled();
  });
});
