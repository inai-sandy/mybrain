import { MindReviewService } from './review.service';

function makePrisma(findings: any[]) {
  const updates: any[] = [];
  const evidence: any[] = [];
  const prisma: any = {
    mindEvidence: { create: async ({ data }: any) => { evidence.push(data); return data; } },
    mindFinding: {
      findUnique: async ({ where }: any) => findings.find((f) => f.id === where.id) || null,
      findMany: async ({ where }: any) => {
        let r = findings.filter((f) => f.id !== where?.id?.not);
        if (where?.NOT?.status) r = r.filter((f) => f.status !== where.NOT.status);
        if (where?.OR) r = r.filter((f) => where.OR.some((c: any) => (c.subject && f.subject === c.subject) || (c.object && f.object === c.object)));
        return r.map((f) => ({ ...f }));
      },
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        const f = findings.find((x) => x.id === where.id);
        if (f) Object.assign(f, data);
        return f;
      },
      delete: async ({ where }: any) => ({ id: where.id }),
    },
  };
  return { prisma, updates, evidence };
}

const base = { evidenceCount: 1, pinned: false, trend: 'steady', status: 'emerging', valence: 'neutral', confidence: 0.4, validated: null as string | null, firstSeenDay: '2026-06-01', lastSeenDay: '2026-06-20' };

describe('MindReviewService (BEA-449)', () => {
  it('confirm boosts the finding and ripples a small boost to neighbours sharing a node', async () => {
    const target = { ...base, id: 't', subject: 'money tasks', relation: 'drains', object: 'you', confidence: 0.4 };
    const neighbour = { ...base, id: 'n', subject: 'admin', relation: 'tires', object: 'you', confidence: 0.5 };
    const unrelated = { ...base, id: 'u', subject: 'gym', relation: 'energizes', object: 'mood', confidence: 0.5 };
    const { prisma } = makePrisma([target, neighbour, unrelated]);
    const r = await new MindReviewService(prisma).confirm('t');
    expect(r.ok).toBe(true);
    expect(target.validated).toBe('confirmed');
    expect(target.confidence).toBeGreaterThan(0.4);
    expect(neighbour.confidence).toBeCloseTo(0.53, 2); // rippled (+0.03)
    expect(unrelated.confidence).toBe(0.5); // untouched
  });

  it('refute retires it and records the boundary (validated=refuted) so the engine excludes it', async () => {
    const f = { ...base, id: 'x', subject: 's', relation: 'r', object: 'o', confidence: 0.6 };
    const { prisma } = makePrisma([f]);
    await new MindReviewService(prisma).refute('x');
    expect(f.validated).toBe('refuted');
    expect(f.status).toBe('retired');
    expect(f.confidence).toBe(0);
  });

  it('amend updates the wording and counts as a confirmation', async () => {
    const f = { ...base, id: 'a', subject: 'money', relation: 'drains', object: 'you', confidence: 0.4 };
    const { prisma } = makePrisma([f]);
    await new MindReviewService(prisma).amend('a', { subject: 'money & admin tasks' });
    expect(f.subject).toBe('money & admin tasks');
    expect(f.validated).toBe('confirmed');
    expect(f.confidence).toBeGreaterThan(0.4);
  });

  it('note stores the user\'s words as feedback evidence and softly confirms (BEA-464)', async () => {
    const f = { ...base, id: 'n', subject: 's', relation: 'r', object: 'o', confidence: 0.4, evidenceCount: 2, status: 'proposed' };
    const { prisma, evidence } = makePrisma([f]);
    const r = await new MindReviewService(prisma).note('n', "It's only Beakn tasks I avoid, not all work.");
    expect(r.ok).toBe(true);
    expect(evidence[0]).toMatchObject({ findingId: 'n', signal: 'feedback', snippet: "It's only Beakn tasks I avoid, not all work." });
    expect(f.validated).toBe('confirmed');
    expect(f.evidenceCount).toBe(3);
    expect(f.confidence).toBeGreaterThan(0.4);
    expect(f.status).toBe('emerging'); // proposed → emerging
  });

  it('note ignores an empty body', async () => {
    const f = { ...base, id: 'e', subject: 's', relation: 'r', object: 'o' };
    const { prisma, evidence } = makePrisma([f]);
    const r = await new MindReviewService(prisma).note('e', '   ');
    expect(r.ok).toBe(false);
    expect(evidence.length).toBe(0);
  });
});
