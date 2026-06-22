import { MindLifecycleService } from './lifecycle.service';

function makePrisma(findings: any[]) {
  const updates: any[] = [];
  const deletes: string[] = [];
  const evidenceMoves: any[] = [];
  const prisma: any = {
    mindFinding: {
      findMany: async ({ where }: any) => {
        let r = findings;
        if (where?.NOT?.status) r = r.filter((f) => f.status !== where.NOT.status);
        return r.map((f) => ({ ...f }));
      },
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        const f = findings.find((x) => x.id === where.id);
        if (f) Object.assign(f, data);
        return f;
      },
      delete: async ({ where }: any) => {
        deletes.push(where.id);
        return {};
      },
    },
    mindEvidence: { updateMany: async ({ where, data }: any) => { evidenceMoves.push({ from: where.findingId, to: data.findingId }); return { count: 1 }; } },
  };
  return { prisma, updates, deletes, evidenceMoves };
}

const base = { evidenceCount: 1, pinned: false, trend: 'steady', subject: 's', relation: 'r', object: 'o', valence: 'neutral', kind: 'behavioural' };

describe('MindLifecycleService (BEA-448)', () => {
  it('does NOT decay a weekly finding within its rhythm, but DOES once overdue', async () => {
    const fresh = { ...base, id: 'w1', confidence: 0.6, status: 'emerging', cadence: 'weekly', firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-18' }; // 4 days ago < grace(10)
    const stale = { ...base, id: 'w2', confidence: 0.6, status: 'emerging', cadence: 'weekly', firstSeenDay: '2026-05-01', lastSeenDay: '2026-06-01' }; // 21 days ago > grace
    const { prisma } = makePrisma([fresh, stale]);
    const svc = new MindLifecycleService(prisma);
    await svc.decayAndPromote('2026-06-22');
    expect(fresh.confidence).toBe(0.6); // untouched within rhythm
    expect(stale.confidence).toBeLessThan(0.6); // decayed (overdue)
    expect(stale.trend).toBe('fading');
  });

  it('pinned findings never decay', async () => {
    const pinned = { ...base, id: 'p1', pinned: true, confidence: 0.5, status: 'established', cadence: 'daily', firstSeenDay: '2026-05-01', lastSeenDay: '2026-05-01' };
    const { prisma } = makePrisma([pinned]);
    await new MindLifecycleService(prisma).decayAndPromote('2026-06-22');
    expect(pinned.confidence).toBe(0.5);
  });

  it('promotes a durable, well-evidenced finding to established', async () => {
    const f = { ...base, id: 'e1', confidence: 0.6, evidenceCount: 4, status: 'emerging', cadence: 'situational', firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-20' };
    const { prisma } = makePrisma([f]);
    const r = await new MindLifecycleService(prisma).decayAndPromote('2026-06-22');
    expect(f.status).toBe('established');
    expect(r.promoted).toBe(1);
  });

  it('retires a finding whose confidence has collapsed', async () => {
    const f = { ...base, id: 'r1', confidence: 0.03, status: 'fading', cadence: 'daily', firstSeenDay: '2026-05-01', lastSeenDay: '2026-05-01' };
    const { prisma } = makePrisma([f]);
    const r = await new MindLifecycleService(prisma).decayAndPromote('2026-06-22');
    expect(f.status).toBe('retired');
    expect(r.retired).toBe(1);
  });

  it('consolidates duplicate subject-relation-object findings into the strongest', async () => {
    const a = { ...base, id: 'a', subject: 'Money tasks', relation: 'drains', object: 'you', confidence: 0.7, evidenceCount: 3, status: 'established', firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-20', pinned: false };
    const b = { ...base, id: 'b', subject: 'money tasks ', relation: 'Drains', object: 'You', confidence: 0.4, evidenceCount: 2, status: 'emerging', firstSeenDay: '2026-05-20', lastSeenDay: '2026-06-10', pinned: false };
    const { prisma, deletes } = makePrisma([a, b]);
    const merged = await new MindLifecycleService(prisma).consolidate();
    expect(merged).toBe(1);
    expect(deletes).toContain('b');
    expect(a.evidenceCount).toBe(5); // 3 + 2
    expect(a.firstSeenDay).toBe('2026-05-20'); // earliest kept
  });

  it('merges REWORDED duplicates about the same topic + valence (BEA-459)', async () => {
    const a = { ...base, id: 'a', statement: 'You keep deferring Beakn product tasks', subject: 'Beakn product tasks', relation: 'are deferred by', object: 'you', valence: 'draining', confidence: 0.7, evidenceCount: 3, status: 'established', firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-20' };
    const b = { ...base, id: 'b', statement: 'You avoid Beakn product tasks again and again', subject: 'you', relation: 'avoids', object: 'Beakn product tasks', valence: 'draining', confidence: 0.4, evidenceCount: 2, status: 'emerging', firstSeenDay: '2026-06-05', lastSeenDay: '2026-06-18' };
    const { prisma, deletes } = makePrisma([a, b]);
    const merged = await new MindLifecycleService(prisma).consolidate();
    expect(merged).toBe(1); // same topic (Beakn product tasks) + same valence + swapped you/topic → one node-pair
    expect(deletes).toContain('b');
    expect(a.evidenceCount).toBe(5);
  });

  it('does NOT merge different insights about the same topic (BEA-459)', async () => {
    const a = { ...base, id: 'a', statement: 'Gym lifts your mood', subject: 'gym', relation: 'energizes', object: 'you', valence: 'energizing', confidence: 0.7, evidenceCount: 3, status: 'established', firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-20' };
    const b = { ...base, id: 'b', statement: 'Gym sharpens your focus for deep work', subject: 'gym', relation: 'improves', object: 'focus', valence: 'energizing', confidence: 0.5, evidenceCount: 2, status: 'emerging', firstSeenDay: '2026-06-05', lastSeenDay: '2026-06-18' };
    const { prisma, deletes } = makePrisma([a, b]);
    const merged = await new MindLifecycleService(prisma).consolidate();
    expect(merged).toBe(0); // different node-pair AND low word overlap → kept apart
    expect(deletes).not.toContain('b');
  });

  it('semanticConsolidate merges same-meaning findings the LLM groups, keeping the strongest (BEA-459)', async () => {
    // Three re-wordings of one insight that lexical matching misses (different words + nodes), one unrelated finding.
    const a = { ...base, id: 'a', statement: 'Family milestones lift you more than work wins', subject: 'Sandeep', object: 'family moments', valence: 'energizing', confidence: 0.92, evidenceCount: 3, status: 'established', firstSeenDay: '2026-06-10', lastSeenDay: '2026-06-20' };
    const b = { ...base, id: 'b', statement: "A child's milestones beat work completions for joy", subject: 'Sandeep', object: 'child milestones', valence: 'energizing', confidence: 0.9, evidenceCount: 2, status: 'emerging', firstSeenDay: '2026-06-08', lastSeenDay: '2026-06-18' };
    const c = { ...base, id: 'c', statement: 'Arya learning to cycle gave the biggest lift of the day', subject: 'Arya cycling', object: 'you', valence: 'energizing', confidence: 0.67, evidenceCount: 1, status: 'emerging', firstSeenDay: '2026-06-15', lastSeenDay: '2026-06-15' };
    const d = { ...base, id: 'd', statement: 'Admin paperwork is deferred for weeks', subject: 'admin', object: 'you', valence: 'draining', confidence: 0.55, evidenceCount: 4, status: 'established', firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-19' };
    const { prisma, deletes } = makePrisma([a, b, c, d]);
    const llm: any = { completeWith: jest.fn(async () => '{"groups":[[0,1,2]]}') }; // a,b,c are the same insight
    const merged = await new MindLifecycleService(prisma, llm).semanticConsolidate();
    expect(merged).toBe(2); // b and c folded into a
    expect(deletes).toEqual(expect.arrayContaining(['b', 'c']));
    expect(deletes).not.toContain('d');
    expect(a.evidenceCount).toBe(6); // 3 + 2 + 1
  });

  it('semanticConsolidate is a no-op without an LLM', async () => {
    const a = { ...base, id: 'a', confidence: 0.7, status: 'established', firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-20' };
    const b = { ...base, id: 'b', confidence: 0.5, status: 'emerging', firstSeenDay: '2026-06-05', lastSeenDay: '2026-06-18' };
    const c = { ...base, id: 'c', confidence: 0.4, status: 'emerging', firstSeenDay: '2026-06-05', lastSeenDay: '2026-06-18' };
    const { prisma } = makePrisma([a, b, c]);
    expect(await new MindLifecycleService(prisma).semanticConsolidate()).toBe(0);
  });
});
