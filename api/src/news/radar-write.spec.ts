import { RadarWriteService } from './radar-write.service';

/**
 * BEA-1312 — the daily "why it matters" lines under the Radar picks.
 *
 * What must never regress: ONE batched engine call (never per-article), a failed
 * engine leaves picks pending and SAYS so, already-annotated picks are not sent
 * again, and a half-usable reply writes what it can and reports the rest honestly.
 */

const PICKS = [
  { id: 'p1', title: 'State of Open Models', source: 'Hugging Face Blog', isPick: true, whyItMatters: null, pendingTranslation: false, aiScore: 0.92, publishedAt: new Date('2026-08-14T08:00:00Z') },
  { id: 'p2', title: 'GitHub agent apps walkthrough', source: 'GitHub AI & ML', isPick: true, whyItMatters: null, pendingTranslation: false, aiScore: 0.87, publishedAt: new Date('2026-08-14T10:00:00Z') },
  { id: 'p3', title: 'Qwen open-sources a new model', source: 'Qwen', isPick: true, whyItMatters: null, pendingTranslation: false, aiScore: 0.85, publishedAt: new Date('2026-08-14T09:00:00Z') },
];

function makePrisma(rows: any[]) {
  const items = new Map(rows.map((r) => [r.id, { ...r }]));
  const matches = (row: any, where: any = {}) => {
    if (where.isPick !== undefined && row.isPick !== where.isPick) return false;
    if ('whyItMatters' in where && row.whyItMatters !== where.whyItMatters) return false;
    if (where.pendingTranslation !== undefined && row.pendingTranslation !== where.pendingTranslation) return false;
    return true;
  };
  return {
    items,
    radarItem: {
      findMany: async ({ where, take }: any = {}) => {
        let rows2 = [...items.values()].filter((r) => matches(r, where));
        rows2.sort((a, b) => b.aiScore - a.aiScore);
        if (take) rows2 = rows2.slice(0, take);
        return rows2.map((r) => ({ ...r }));
      },
      count: async ({ where }: any = {}) => [...items.values()].filter((r) => matches(r, where)).length,
      update: async ({ where, data }: any) => {
        const row = items.get(where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
}

function makeLlm(reply: string | null) {
  return {
    calls: [] as Array<{ key: string; prompt: string }>,
    async completeHelper(key: string, prompt: string) {
      this.calls.push({ key, prompt });
      return reply;
    },
  };
}

describe('one batched engine call writes every pick line (BEA-1312)', () => {
  it('writes lines by number and reports honest counts', async () => {
    const prisma = makePrisma(PICKS);
    const llm = makeLlm('1. Shows where open models really get used.\n2. A working pattern for agents inside GitHub.\n3. A strong free option to benchmark against.');
    const svc = new RadarWriteService(prisma as any, llm as any);
    const r = await svc.annotate();
    expect(r).toMatchObject({ ok: true, picks: 3, written: 3, pending: 0 });
    // ONE call, on the named helper — never per-article, never the loose general model.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].key).toBe('radar-why');
    expect(llm.calls[0].prompt).toContain('1. State of Open Models (Hugging Face Blog)');
    // Highest score is number 1, so the right line landed on the right pick.
    expect(prisma.items.get('p1').whyItMatters).toBe('Shows where open models really get used.');
    expect(prisma.items.get('p2').whyItMatters).toBe('A working pattern for agents inside GitHub.');
  });

  it('does not send picks that already have a line, and skips the engine when none wait', async () => {
    const done = PICKS.map((p) => ({ ...p, whyItMatters: 'already written' }));
    const prisma = makePrisma(done);
    const llm = makeLlm('1. x');
    const svc = new RadarWriteService(prisma as any, llm as any);
    const r = await svc.annotateIfNeeded();
    expect(r).toMatchObject({ ok: true, picks: 0, written: 0, pending: 0 });
    expect(llm.calls).toHaveLength(0);
  });

  it('leaves hidden (untranslated) picks out of the batch', async () => {
    const rows = [...PICKS, { id: 'p4', title: '原始中文标题', source: 'AIbase', isPick: true, whyItMatters: null, pendingTranslation: true, aiScore: 0.99, publishedAt: new Date() }];
    const prisma = makePrisma(rows);
    const llm = makeLlm('1. a\n2. b\n3. c');
    const svc = new RadarWriteService(prisma as any, llm as any);
    const r = await svc.annotate();
    expect(r.picks).toBe(3);
    expect(llm.calls[0].prompt).not.toContain('原始中文标题');
    expect(prisma.items.get('p4').whyItMatters).toBeNull();
  });
});

describe('a failed engine never fakes done (BEA-1312, honest-runs)', () => {
  it('reports the failure and leaves every pick pending', async () => {
    const prisma = makePrisma(PICKS);
    const llm = makeLlm(null);
    const svc = new RadarWriteService(prisma as any, llm as any);
    const r = await svc.annotate();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ picks: 3, written: 0, pending: 3 });
    expect(r.message).toContain('engine unavailable');
    for (const id of ['p1', 'p2', 'p3']) expect(prisma.items.get(id).whyItMatters).toBeNull();
  });

  it('a half-usable reply writes what it can and says what is missing', async () => {
    const prisma = makePrisma(PICKS);
    const llm = makeLlm('Some chatter first\n2. Only this line is usable.\n99. wrong number\n');
    const svc = new RadarWriteService(prisma as any, llm as any);
    const r = await svc.annotate();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ picks: 3, written: 1, pending: 2 });
    expect(r.message).toContain('2 pick(s) still without a line');
    expect(prisma.items.get('p2').whyItMatters).toBe('Only this line is usable.');
    expect(prisma.items.get('p1').whyItMatters).toBeNull();
  });
});

describe('review fixes stay fixed (BEA-1312)', () => {
  it('reads "1.No space" as line 1 but never reads "2.78T parameters" as line 2', async () => {
    const prisma = makePrisma(PICKS);
    const llm = makeLlm('1.Open models are winning on real usage.\n2.78T parameters is the headline, not a line\n3. A fine third line.');
    const svc = new RadarWriteService(prisma as any, llm as any);
    const r = await svc.annotate();
    expect(prisma.items.get('p1').whyItMatters).toBe('Open models are winning on real usage.');
    expect(prisma.items.get('p2').whyItMatters).toBeNull(); // "2.78T…" must not land on pick 2
    expect(prisma.items.get('p3').whyItMatters).toBe('A fine third line.');
    expect(r).toMatchObject({ ok: false, written: 2, pending: 1 });
  });

  it('pending reports the whole backlog, not just this batch', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`, title: `Pick ${i}`, source: 's', isPick: true, whyItMatters: null,
      pendingTranslation: false, aiScore: 1 - i / 100, publishedAt: new Date(),
    }));
    const prisma = makePrisma(many);
    // A reply that answers the full 25-line batch perfectly.
    const llm = makeLlm(Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join('\n'));
    const svc = new RadarWriteService(prisma as any, llm as any);
    const r = await svc.annotate();
    expect(r.picks).toBe(25);
    expect(r.written).toBe(25);
    expect(r.pending).toBe(5); // the 5 beyond the cap still wait — ok must not claim done
    expect(r.ok).toBe(false);
  });
});

describe('the scheduling constants (BEA-1314)', () => {
  it('boots after the first sync window and then checks hourly', () => {
    // 5 minutes: the first radar sync (with its translation budget) takes ~4 — checking
    // at 2 was the ship-day bug that left every pick blank until the next fixed run.
    expect(RadarWriteService.BOOT_DELAY_MS).toBe(5 * 60 * 1000);
    expect(RadarWriteService.CHECK_MS).toBe(60 * 60 * 1000);
  });
});
