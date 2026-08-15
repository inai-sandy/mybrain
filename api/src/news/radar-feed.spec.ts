import { RadarFeedService } from './radar-feed.service';

/**
 * BEA-1311 — sync the AI Radar collector fork into RadarItem.
 *
 * The promises tested here are the ones the spec makes: a re-sync never duplicates,
 * a Chinese title is translated before anyone sees it (and hidden until then), the
 * blocklist drops noise, and an unreachable fork changes nothing but the error state.
 */

const LATEST = {
  items: [
    { id: 'en-1', title: 'OpenAI ships a new eval suite', title_original: 'OpenAI ships a new eval suite', title_en: 'OpenAI ships a new eval suite', url: 'https://a.example/1', source: 'OpenAI News', ai_label: 'models', ai_score: 0.9, published_at: '2026-08-14T10:00:00Z' },
    { id: 'en-2', title: 'GitHub agent apps walkthrough', title_original: 'GitHub agent apps walkthrough', url: 'https://a.example/2', source: 'GitHub AI & ML', ai_label: 'devtools', ai_score: 0.8, published_at: '2026-08-14T11:00:00Z' },
    { id: 'zh-1', title: '通义千问开源新模型', title_original: '通义千问开源新模型', url: 'https://a.example/3', source: '公众号：智谱', ai_label: 'models', ai_score: 0.85, published_at: '2026-08-14T09:00:00Z' },
  ],
};

const BRIEF = {
  items: [
    {
      story_id: 'story-1',
      title: 'Open Models 现状 / State of Open Models',
      url: 'https://a.example/story',
      source: 'Hugging Face Blog',
      ai_score: 0.92,
      published_at: '2026-08-14T08:00:00Z',
      sources: [
        { source: 'Hugging Face Blog', url: 'https://a.example/story', title_en: 'State of Open Models' },
        { source: 'The Verge AI', url: 'https://a.example/verge' },
      ],
    },
  ],
};

/** In-memory Prisma covering exactly the query shapes the service uses. */
function makePrisma() {
  const items = new Map<string, any>();
  const state: { row: any } = { row: null };
  const matches = (row: any, where: any = {}): boolean => {
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.id?.notIn && where.id.notIn.includes(row.id)) return false;
    if (where.pendingTranslation !== undefined && row.pendingTranslation !== where.pendingTranslation) return false;
    if (where.isPick !== undefined && row.isPick !== where.isPick) return false;
    if (where.category !== undefined) {
      if (typeof where.category === 'string' && row.category !== where.category) return false;
      if (where.category?.not !== undefined && row.category === where.category.not) return false;
    }
    if (where.source !== undefined) {
      if (typeof where.source === 'string' && row.source !== where.source) return false;
      if (where.source?.not !== undefined && row.source === where.source.not) return false;
    }
    if (where.title?.contains && !String(row.title).toLowerCase().includes(String(where.title.contains).toLowerCase())) return false;
    if (where.heat?.gte !== undefined && !(Number(row.heat) >= where.heat.gte)) return false;
    return true;
  };
  return {
    items,
    state,
    radarItem: {
      findMany: async ({ where, select, distinct, skip, take, orderBy }: any = {}) => {
        let rows = [...items.values()].filter((r) => matches(r, where));
        if (orderBy) {
          const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
          const key = Object.keys(first || {})[0];
          if (key) rows.sort((a, b) => (a[key] < b[key] ? 1 : -1));
        }
        if (distinct) {
          const seen = new Set();
          rows = rows.filter((r) => (seen.has(r[distinct[0]]) ? false : (seen.add(r[distinct[0]]), true)));
        }
        if (skip) rows = rows.slice(skip);
        if (take) rows = rows.slice(0, take);
        if (select) return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
        return rows.map((r) => ({ ...r }));
      },
      count: async ({ where }: any = {}) => [...items.values()].filter((r) => matches(r, where)).length,
      create: async ({ data }: any) => {
        if (items.has(data.id)) throw new Error('unique constraint');
        items.set(data.id, { ...data });
        return { ...data };
      },
      update: async ({ where, data }: any) => {
        const row = items.get(where.id);
        if (!row) throw new Error('not found');
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of items.values()) {
          if (!matches(row, where)) continue;
          for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
          count += 1;
        }
        return { count };
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [id, row] of [...items.entries()]) {
          const lt = where?.lastSeenAt?.lt;
          if (lt && row.lastSeenAt instanceof Date && row.lastSeenAt.getTime() < new Date(lt).getTime()) {
            items.delete(id);
            count += 1;
          }
        }
        return { count };
      },
    },
    radarSync: {
      upsert: async ({ update, create }: any) => {
        state.row = state.row ? { ...state.row, ...update } : { ...create };
        return { ...state.row };
      },
      findUnique: async () => (state.row ? { ...state.row } : null),
    },
  };
}

/** The service with the network replaced: canned JSON and a controllable translator. */
class TestRadar extends RadarFeedService {
  files: Record<string, any> = {};
  translations: Record<string, string | null> = {};
  translateCalls: string[] = [];
  protected async fetchJson(file: string): Promise<any> {
    const body = this.files[file];
    if (body === undefined) throw new Error(`${file}: HTTP 404`);
    return JSON.parse(JSON.stringify(body));
  }
  protected async translateText(text: string): Promise<string | null> {
    this.translateCalls.push(text);
    return this.translations[text] ?? null;
  }
}

function makeService(prisma: any) {
  // Positional on purpose (house rule): LlmService is optional and comes last.
  const svc = new TestRadar(prisma as any);
  svc.files = { 'latest-24h.json': LATEST, 'daily-brief.json': BRIEF };
  return svc;
}

describe('radar sync stores and counts honestly (BEA-1311)', () => {
  it('stores every offered item on first sync, translating the Chinese one', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'Tongyi Qianwen open-sources a new model';
    const r = await svc.sync();
    expect(r.ok).toBe(true);
    expect(r.fetched).toBe(4);
    expect(r.stored).toBe(4);
    expect(r.known).toBe(0);
    expect(r.translated).toBe(1);
    expect(r.pending).toBe(0);
    expect(r.failed).toBe(0);
    const zh = prisma.items.get('zh-1');
    expect(zh.title).toBe('Tongyi Qianwen open-sources a new model');
    expect(zh.titleOriginal).toBe('通义千问开源新模型');
    expect(zh.translated).toBe(true);
  });

  it('a bilingual pick title needs no translation — the English half wins', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'x';
    await svc.sync();
    const pick = prisma.items.get('story-1');
    expect(pick.isPick).toBe(true);
    expect(pick.title).toBe('State of Open Models');
    expect(JSON.parse(pick.sources)).toHaveLength(2);
    // Only the genuinely Chinese title went to the translator.
    expect(svc.translateCalls).toEqual(['通义千问开源新模型']);
  });

  it('re-syncing the same data updates instead of duplicating', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'Tongyi Qianwen open-sources a new model';
    await svc.sync();
    const firstSeen = prisma.items.get('en-1').lastSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await svc.sync();
    expect(r2.stored).toBe(0);
    expect(r2.known).toBe(4);
    expect(prisma.items.size).toBe(4);
    expect(prisma.items.get('en-1').lastSeenAt.getTime()).toBeGreaterThanOrEqual(firstSeen.getTime());
  });
});

describe('an item is never shown untranslated (BEA-1311, spec B4)', () => {
  it('hides a failed translation as pending, then finishes it on a later sync', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    // Translator down: the Chinese item goes pending and stays out of the list.
    const r1 = await svc.sync();
    expect(r1.pending).toBe(1);
    expect(prisma.items.get('zh-1').pendingTranslation).toBe(true);
    const hidden = await svc.list({});
    expect(hidden.items.map((i: any) => i.id)).not.toContain('zh-1');

    // Next sync only offers the English items — the pending row is retried anyway.
    svc.files['latest-24h.json'] = { items: LATEST.items.filter((i) => i.id !== 'zh-1') };
    svc.translations['通义千问开源新模型'] = 'Tongyi Qianwen open-sources a new model';
    const r2 = await svc.sync();
    expect(r2.translated).toBe(1);
    const row = prisma.items.get('zh-1');
    expect(row.pendingTranslation).toBe(false);
    expect(row.title).toBe('Tongyi Qianwen open-sources a new model');
    const shown = await svc.list({});
    expect(shown.items.map((i: any) => i.id)).toContain('zh-1');
  });
});

describe('titles are stored as text, not HTML entities (real-data fix, BEA-1313)', () => {
  it('decodes entities before storing — seen live: "Gemini&#8217;s"', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.files['latest-24h.json'] = {
      items: [{ id: 'e1', title: 'You can turn off Gemini&#8217;s watermarks &amp; more', url: 'https://a.example/e1', source: 'X', ai_score: 0.5, published_at: '2026-08-14T10:00:00Z' }],
    };
    svc.files['daily-brief.json'] = { items: [] };
    await svc.sync();
    expect(prisma.items.get('e1').title).toBe('You can turn off Gemini’s watermarks & more');
  });
});

describe('sync counters tell the truth about the stored rows (review fix, BEA-1311)', () => {
  it('does not count an already-translated row as pending when a re-sync finds no English', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'Tongyi Qianwen open-sources a new model';
    await svc.sync(); // translated and visible

    // Translator goes down; the same Chinese item arrives again.
    svc.translations = {};
    const r = await svc.sync();
    expect(r.pending).toBe(0); // the stored row still shows its good English title
    expect(prisma.items.get('zh-1').pendingTranslation).toBe(false);
    expect(prisma.items.get('zh-1').title).toBe('Tongyi Qianwen open-sources a new model');
  });
});

describe('picks mirror the current daily brief (review fix, BEA-1311)', () => {
  it('clears isPick when a story drops out of the brief, but not when the brief is unreachable', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'x';
    await svc.sync();
    expect(prisma.items.get('story-1').isPick).toBe(true);

    // Brief unreachable → yesterday's picks survive the hour.
    delete svc.files['daily-brief.json'];
    await svc.sync();
    expect(prisma.items.get('story-1').isPick).toBe(true);

    // Brief back with different picks → the old story stops being a pick.
    svc.files['daily-brief.json'] = { items: [] };
    await svc.sync();
    expect(prisma.items.get('story-1').isPick).toBe(false);
  });
});

describe('heat and timelines come from the merged stories (BEA-1323)', () => {
  const MERGED = {
    stories: [
      {
        story_id: 'st-en1',
        source_count: 3,
        sources: [
          // The real feed's items carry NO story_id — the merged story names its member
          // item ids instead, so the map must match by this id.
          { id: 'en-1', source: 'OpenAI News', url: 'https://a.example/1', title_en: 'OpenAI ships a new eval suite', published_at: '2026-08-14T10:00:00Z' },
          { source: 'hackernews', url: 'https://a.example/hn', title_en: 'OpenAI eval suite', published_at: '2026-08-14T11:30:00Z' },
          { source: 'Techmeme', url: 'https://a.example/tm', title_en: 'OpenAI ships evals', published_at: '2026-08-14T10:45:00Z' },
        ],
      },
    ],
  };

  it('stores heat and a time-ordered English timeline on matching items', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'x';
    svc.files['latest-24h.json'] = { items: [{ ...LATEST.items[0] }] }; // deliberately NO story_id — like the real feed
    svc.files['stories-merged.json'] = MERGED;
    await svc.sync();
    const row = prisma.items.get('en-1');
    expect(row.heat).toBe(3);
    const timeline = JSON.parse(row.sources);
    expect(timeline.map((t: any) => t.name)).toEqual(['OpenAI News', 'Techmeme', 'hackernews']); // time order
    expect(timeline[0].title).toBe('OpenAI ships a new eval suite');
  });

  it('heat decays when a story leaves the merged file, but NEVER during an outage', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'x';
    svc.files['latest-24h.json'] = { items: [{ ...LATEST.items[0] }] };
    svc.files['stories-merged.json'] = MERGED;
    await svc.sync();
    expect(prisma.items.get('en-1').heat).toBe(3);

    // Merged file unreachable → the story keeps its heat (outage, not a cool-down).
    delete svc.files['stories-merged.json'];
    await svc.sync();
    expect(prisma.items.get('en-1').heat).toBe(3);

    // Merged file back but the story is gone → it really cooled: heat resets.
    svc.files['stories-merged.json'] = { stories: [] };
    await svc.sync();
    expect(prisma.items.get('en-1').heat).toBe(1);
    expect(JSON.parse(prisma.items.get('en-1').sources)).toEqual([]);
  });

  it('an unreachable merged file costs nothing — items stay heat 1', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'x';
    const r = await svc.sync(); // no stories-merged.json in files at all
    expect(r.ok).toBe(true);
    expect(prisma.items.get('en-1').heat).toBe(1);
  });
});

describe('the radar is a rolling window (review fix, BEA-1313)', () => {
  it('prunes rows unseen for 48h, but never during an outage', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'x';
    await svc.sync();
    // Age one row far past retention.
    prisma.items.get('en-1').lastSeenAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Outage: nothing is pruned — stale stories must survive an unreachable radar.
    const files = svc.files;
    svc.files = {};
    await svc.sync();
    expect(prisma.items.has('en-1')).toBe(true);

    // Healthy sync that no longer offers en-1: the old row goes, and says so.
    svc.files = files;
    svc.files['latest-24h.json'] = { items: LATEST.items.filter((i) => i.id !== 'en-1') };
    const r = await svc.sync();
    expect(r.pruned).toBe(1);
    expect(prisma.items.has('en-1')).toBe(false);
  });
});

describe('an unreachable fork changes nothing but the error state (BEA-1311)', () => {
  it('keeps old rows and records the error', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'x';
    await svc.sync();
    svc.files = {}; // radar gone
    const r = await svc.sync();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unreachable');
    expect(prisma.items.size).toBe(4);
    expect(prisma.state.row.lastError).toContain('unreachable');
    const status = await svc.status();
    expect(status.lastError).toContain('unreachable');
    expect(status.total).toBe(4);
  });
});

describe('the source blocklist drops noise and says so (BEA-1311)', () => {
  const OLD = process.env.RADAR_SOURCE_BLOCKLIST;
  afterEach(() => {
    if (OLD === undefined) delete process.env.RADAR_SOURCE_BLOCKLIST;
    else process.env.RADAR_SOURCE_BLOCKLIST = OLD;
  });

  it('counts blocked items instead of storing them', async () => {
    process.env.RADAR_SOURCE_BLOCKLIST = '公众号：智谱, Something Else';
    const prisma = makePrisma();
    const svc = makeService(prisma);
    const r = await svc.sync();
    expect(r.blocked).toBe(1);
    expect(prisma.items.has('zh-1')).toBe(false);
    expect(r.stored).toBe(3);
  });
});

describe('the radar list behaves like every list here (BEA-1311)', () => {
  it('searches, filters, and paginates with a real total', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'Tongyi Qianwen open-sources a new model';
    await svc.sync();

    const all = await svc.list({ pageSize: 2 });
    expect(all.total).toBe(4);
    expect(all.items).toHaveLength(2);
    expect(all.pages).toBe(2);

    const search = await svc.list({ search: 'github' });
    expect(search.items.map((i: any) => i.id)).toEqual(['en-2']);

    const picks = await svc.list({ picksOnly: true });
    expect(picks.items.map((i: any) => i.id)).toEqual(['story-1']);

    const byCategory = await svc.list({ category: 'models' });
    expect(byCategory.total).toBe(2);
  });
});

describe('the public radar is a separate, narrower shape (BEA-1325)', () => {
  it('publicList maps items field by field — sync bookkeeping never leaves the house', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    svc.translations['通义千问开源新模型'] = 'Tongyi Qianwen open-sources a new model';
    await svc.sync();

    const r: any = await svc.publicList({ page: 1, pageSize: 100 });
    expect(r.total).toBe(4);
    const item = r.items.find((i: any) => i.id === 'en-1');
    expect(item.title).toBe('OpenAI ships a new eval suite');
    expect(item.heat).toBe(1);
    expect(item).not.toHaveProperty('firstSeenAt');
    expect(item).not.toHaveProperty('lastSeenAt');
    expect(item).not.toHaveProperty('pendingTranslation');
  });

  it('publicStatus keeps freshness and filters but never our internal error text', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.sync();
    delete svc.files['latest-24h.json'];
    await svc.sync(); // the fork goes down → lastError is set privately

    const priv: any = await svc.status();
    expect(priv.lastError).toBeTruthy();
    const s: any = await svc.publicStatus();
    expect(s.lastOkAt).toBeTruthy();
    expect(s.total).toBeGreaterThan(0);
    expect(s.categories.length).toBeGreaterThan(0);
    expect(s).not.toHaveProperty('lastError');
    expect(s).not.toHaveProperty('lastSyncAt');
    expect(s).not.toHaveProperty('counts');
    expect(s).not.toHaveProperty('pendingTranslation');
  });

  it('the /radar share card carries the hottest stories, or a plain line when nothing is hot', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.sync();

    let m: any = await svc.ogMeta('https://mybrain.example');
    expect(m.url).toBe('https://mybrain.example/radar');
    expect(m.title).toBe('AI News Daily — My Brain');
    expect(m.description).toContain('AI news');

    prisma.items.get('en-1').heat = 3;
    m = await svc.ogMeta('https://mybrain.example');
    expect(m.description).toContain('OpenAI ships a new eval suite');
  });

  it('the card never repeats a headline — member items share a merged story\'s heat (live fix)', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.sync();
    prisma.items.get('en-1').heat = 3;
    prisma.items.get('en-2').heat = 3;
    prisma.items.get('en-2').title = 'OpenAI ships a new eval suite'; // same story, second outlet
    const m: any = await svc.ogMeta('https://mybrain.example');
    expect(m.description.match(/OpenAI ships a new eval suite/g)).toHaveLength(1);
  });
});
