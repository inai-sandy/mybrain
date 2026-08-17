import { clip, GROUP_ORDER, ToolCatalogService } from './tool-catalog.service';
import { SERVICE_TOOL_ID_RE } from './service-provider';

describe('clip', () => {
  it('leaves a short description alone', () => {
    expect(clip('short one', 140)).toBe('short one');
  });
  it('cuts on a word boundary, never mid-word', () => {
    const out = clip('Captures how your project is tested and deployed so that nothing is lost', 46);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\bs…$/); // the "deployed so t…" case
    expect(out.length).toBeLessThanOrEqual(47);
  });
  it('handles empty input', () => {
    expect(clip(undefined, 20)).toBe('');
  });
});

/**
 * The catalog is the single source both the agent toolbox and the flow canvas read (BEA-1167).
 * The ids it returns are load-bearing: the flow executor dispatches on them.
 */
const connectors = (configured: string[]) => ({
  listStatus: async () => ['tavily', 'telegram', 'notion'].map((name) => ({ name, configured: configured.includes(name) })),
}) as any;

const skills = (rows: any[] = []) => ({ list: async () => rows }) as any;

describe('ToolCatalogService', () => {
  const origFetch = global.fetch;
  beforeEach(() => { global.fetch = (async () => ({ ok: false })) as any; });
  afterEach(() => { global.fetch = origFetch; });

  it('returns every group, in a stable order, with no empty groups', async () => {
    const svc = new ToolCatalogService(connectors(['tavily', 'telegram']), skills([]));
    const { groups } = await svc.catalog();
    const names = groups.map((g) => g.group);
    // Skills is absent when there are none, Services when no Composio key is set (BEA-1345) and
    // Social when no Scrape Creators key is set (BEA-1355); every other group must be present.
    expect(names).toEqual(GROUP_ORDER.filter((g) => g !== 'Skills' && g !== 'Services' && g !== 'Social'));
    expect(groups.every((g) => g.tools.length > 0)).toBe(true);
  });

  it('keeps the tool ids the flow executor dispatches on', async () => {
    const svc = new ToolCatalogService(connectors(['tavily']), skills([]));
    const { tools } = await svc.catalog();
    const ids = tools.map((t) => t.id);
    // Renaming any of these silently breaks every saved flow.
    // gmail / calendar / drive are gone on purpose (BEA-1351): Google now comes through the seam as
    // svc:gmail.* / svc:googlecalendar.* / svc:googledrive.*, so it appears exactly once.
    for (const id of ['search_brain', 'web_search', 'web_read', 'ask_ai', 'http', 'save_document', 'telegram']) {
      expect(ids).toContain(id);
    }
  });

  it('marks a tool as needing connection when its credentials are missing, with somewhere to go', async () => {
    const svc = new ToolCatalogService(connectors([]), skills([]));
    const { tools } = await svc.catalog();
    const web = tools.find((t) => t.id === 'web_search')!;
    expect(web.connected).toBe(false);
    expect(web.connectHint).toBeTruthy();
    expect(web.connectPath).toBeTruthy();
  });

  it('carries no Google group of its own — Gmail, Calendar and Drive come through the seam only (BEA-1351)', async () => {
    const svc = new ToolCatalogService(connectors([]), skills([]));
    const { tools, groups } = await svc.catalog();
    expect(tools.some((t) => ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'].includes(t.id))).toBe(false);
    expect(groups.some((g) => (g.group as string) === 'Google')).toBe(false);
  });

  it('marks a tool connected once its credentials are there', async () => {
    const svc = new ToolCatalogService(connectors(['tavily', 'telegram']), skills([]));
    const { tools } = await svc.catalog();
    expect(tools.find((t) => t.id === 'web_search')!.connected).toBe(true);
    expect(tools.find((t) => t.id === 'telegram')!.connected).toBe(true);
  });

  /**
   * A skill counts as available only when it is in the folder THE ENGINES READ (BEA-1224).
   *
   * This used to accept any target. But `beakn` is a separate machine account that neither runner
   * reads, so a skill sitting only there was offered on the canvas and then failed at run time.
   */
  it('offers a skill installed where the engines actually look', async () => {
    const svc = new ToolCatalogService(
      connectors([]),
      skills([
        { id: 'sk1', title: 'Deep research', description: 'digs properly', installedOn: ['sandy'] },
        { id: 'sk2', title: 'Not installed', description: '', installedOn: [] },
      ]),
    );
    const { tools } = await svc.catalog();
    expect(tools.find((t) => t.id === 'sk1')!.connected).toBe(true);
    const b = tools.find((t) => t.id === 'sk2')!;
    expect(b.connected).toBe(false);
    expect(b.connectPath).toBe('/skills');
  });

  it('does NOT offer a skill installed only on a machine no engine reads', async () => {
    const svc = new ToolCatalogService(
      connectors([]),
      skills([{ id: 'sk9', title: 'Only on beakn', description: '', installedOn: ['beakn'] }]),
    );
    const t = (await svc.catalog()).tools.find((x) => x.id === 'sk9')!;
    expect(t.connected).toBe(false);
    expect(t.connectHint).toMatch(/Install this skill/);
  });

  it('marks every skill unavailable when the chosen engine cannot run skills at all', async () => {
    const svc = new ToolCatalogService(
      connectors([]),
      skills([{ id: 'sk1', title: 'Installed everywhere', description: '', installedOn: ['sandy'] }]),
      { engineChoice: async () => ({ provider: 'gemini', model: 'g' }) } as any,
    );
    const t = (await svc.catalog()).tools.find((x) => x.id === 'sk1')!;
    expect(t.connected).toBe(false);
    expect(t.connectHint).toMatch(/gemini.*cannot run skills/);
    expect(t.connectPath).toBe('/settings#models');   // the fix is to change engine, not to install
  });

  it('lists the My Brain MCP server', async () => {
    const svc = new ToolCatalogService(connectors([]), skills([]));
    const { tools } = await svc.catalog();
    const mcp = tools.find((t) => t.kind === 'mcp')!;
    expect(mcp.id).toBe('mcp:mybrain');
    expect(mcp.group).toBe('MCP servers');
  });

  it('validate() separates real ids, unknown ids and unconnected ones', async () => {
    const svc = new ToolCatalogService(connectors([]), skills([]));
    const r = await svc.validate(['search_brain', 'web_search', 'not_a_tool']);
    expect(r.ok.map((t) => t.id)).toEqual(['search_brain', 'web_search']);
    expect(r.unknown).toEqual(['not_a_tool']);
    expect(r.notConnected.map((t) => t.id)).toEqual(['web_search']);
  });

  /**
   * Outside services reaching the one catalog (BEA-1345).
   *
   * The catalog must be exactly what it is today when there is no Composio key, must never learn
   * the vendor's name, and must survive the vendor being down with every built-in tool intact.
   */
  describe('outside services', () => {
    const baseline = async () => {
      const svc = new ToolCatalogService(connectors(['tavily']), skills([]));
      return svc.catalog();
    };
    const provider = (over: any = {}) => ({
      status: async () => ({ configured: true, reachable: true }),
      listServices: async () => [
        { slug: 'github', name: 'GitHub', category: 'Developer Tools', connected: true, accounts: [{ id: 'ca_1', label: 'sandy', status: 'ACTIVE' }], actionCount: 871 },
      ],
      listActions: async () => [
        { id: 'svc:github.create_issue', name: 'Create issue', description: 'Open an issue', schema: {}, risky: false, service: 'github' },
        { id: 'svc:github.delete_a_repository', name: 'Delete repository', description: 'Gone for good', schema: {}, risky: true, service: 'github' },
        { id: 'svc:github.old_thing', name: 'Old', description: '', schema: {}, risky: false, service: 'github', deprecated: true },
      ],
      ...over,
    }) as any;

    it('with no key, returns exactly what it returns today — no Services group, no error', async () => {
      const before = await baseline();
      const svc = new ToolCatalogService(connectors(['tavily']), skills([]), undefined, {
        status: async () => ({ configured: false, reachable: false }),
        listServices: async () => { throw new Error('must not be asked'); },
        listActions: async () => { throw new Error('must not be asked'); },
      } as any);
      const after = await svc.catalog();
      expect(after.groups.map((g) => g.group)).not.toContain('Services');
      expect(after.tools.map((t) => t.id)).toEqual(before.tools.map((t) => t.id));
    });

    it('with a working key, adds a Services group whose ids all have the one shape', async () => {
      const svc = new ToolCatalogService(connectors(['tavily']), skills([]), undefined, provider());
      const { groups, tools } = await svc.catalog();
      const services = groups.find((g) => g.group === 'Services')!;
      expect(services).toBeTruthy();
      expect(services.tools.length).toBeGreaterThan(0);
      for (const t of services.tools) {
        expect(t.id).toMatch(SERVICE_TOOL_ID_RE);
        expect(t.id).not.toMatch(/composio/i); // the vendor name may never reach an id
      }
      expect(services.tools.map((t) => t.id)).toEqual(['svc:github.create_issue', 'svc:github.delete_a_repository']); // deprecated dropped
      expect(services.tools[0].name).toBe('GitHub: Create issue');
      expect(services.tools[1].risky).toBe(true);
      expect(tools.find((t) => t.id === 'search_brain')).toBeTruthy(); // built-ins untouched
    });

    it('keeps the group when the key works but nothing is connected yet', async () => {
      const svc = new ToolCatalogService(connectors([]), skills([]), undefined, provider({ listServices: async () => [] }));
      const { groups } = await svc.catalog();
      const services = groups.find((g) => g.group === 'Services')!;
      expect(services).toBeTruthy();
      expect(services.tools).toEqual([]);
    });

    it('never lists a blocked service, even if the provider hands one back', async () => {
      const svc = new ToolCatalogService(connectors([]), skills([]), undefined, provider({
        listServices: async () => [{ slug: 'tavily', name: 'Tavily', category: 'Search', connected: true, accounts: [{ id: 'x', label: 'x', status: 'ACTIVE' }] }],
        listActions: async () => [{ id: 'svc:tavily.search', name: 'Search', description: '', schema: {}, risky: false, service: 'tavily' }],
      }));
      const { tools } = await svc.catalog();
      expect(tools.filter((t) => t.id.startsWith('svc:tavily.'))).toEqual([]);
    });

    /**
     * EVERY action, no cap (BEA-1354). The catalog used to ask for the vendor's shortlist and stop
     * at 60 — GitHub showed 36 of 871. Now whatever `listActions()` hands back is in, minus only
     * the deprecated ones, and the provider is asked for the plain full list.
     */
    it('puts every action of a connected service in the catalog — no important filter, no cap', async () => {
      const asked: any[] = [];
      const many = Array.from({ length: 871 }, (_, i) => ({
        id: `svc:github.action_${i}`, name: `Action ${i}`, description: `Does thing ${i}`, schema: {}, risky: i % 50 === 0, service: 'github',
        ...(i % 100 === 0 ? { important: true } : {}),
      }));
      const svc = new ToolCatalogService(connectors([]), skills([]), undefined, provider({
        listActions: async (_slug: string, opts: any) => { asked.push(opts); return many; },
      }));
      const { tools } = await svc.catalog();
      const github = tools.filter((t) => t.id.startsWith('svc:github.'));
      expect(github.length).toBe(871);
      expect(asked[0]?.important).toBeUndefined(); // the vendor's shortlist is not what was asked for
      expect(asked[0]?.limit).toBeUndefined(); // and nothing capped the walk
      expect(github.filter((t) => t.risky).length).toBe(18); // gates are computed over the full set
      expect(github.filter((t) => t.important).length).toBe(9); // the mark rides along as a hint
      expect(github.find((t) => t.id === 'svc:github.action_1')!.important).toBeUndefined();
    });

    /**
     * The 8s budget and the fall-back-to-last-good-list guard (BEA-1345) must still hold with the
     * full list: a slow provider never stalls or throws `GET /api/tools/catalog`.
     */
    it('a slow provider never holds the catalog past its budget, and the last good list is what is served', async () => {
      let hang = false;
      let gen = 1;
      const p = provider({
        generation: () => gen,
        listActions: async () => {
          if (hang) await new Promise((r) => setTimeout(r, 400));
          return [{ id: 'svc:github.create_issue', name: 'Create issue', description: '', schema: {}, risky: false, service: 'github' }];
        },
      });
      const svc = new ToolCatalogService(connectors([]), skills([]), undefined, p);
      svc.serviceBudgetMs = 50;

      // First read: fast, and remembered.
      expect((await svc.catalog()).tools.some((t) => t.id === 'svc:github.create_issue')).toBe(true);

      // The connections change (generation bumps) and the provider turns slow: the catalog answers
      // inside its budget, does not throw, and still carries the last good list.
      hang = true;
      gen += 1;
      const started = Date.now();
      const { tools, groups } = await svc.catalog();
      expect(Date.now() - started).toBeLessThan(300);
      expect(tools.some((t) => t.id === 'svc:github.create_issue')).toBe(true);
      expect(groups.some((g) => g.group === 'Services')).toBe(true);
      expect(tools.some((t) => t.id === 'search_brain')).toBe(true); // built-ins untouched
    });

    it('a slow provider on a fresh server answers with no Services rather than a stall or an error', async () => {
      const p = provider({ listActions: () => new Promise(() => undefined) }); // never answers
      const svc = new ToolCatalogService(connectors(['tavily']), skills([]), undefined, p);
      svc.serviceBudgetMs = 50;
      const started = Date.now();
      const { tools } = await svc.catalog();
      expect(Date.now() - started).toBeLessThan(300);
      expect(tools.some((t) => t.id === 'search_brain')).toBe(true);
      expect(tools.some((t) => t.id.startsWith('svc:'))).toBe(false);
    });

    it('serves the last list at once while a re-read runs behind, and never starts two walks', async () => {
      let walks = 0;
      let release: () => void = () => undefined;
      const p = provider({
        listActions: async () => {
          walks += 1;
          if (walks > 1) await new Promise<void>((r) => { release = r; });
          return [{ id: `svc:github.v${walks}`, name: `V${walks}`, description: '', schema: {}, risky: false, service: 'github' }];
        },
      });
      const svc = new ToolCatalogService(connectors([]), skills([]), undefined, p);
      await svc.catalog();
      expect(walks).toBe(1);
      // Make the copy old, then ask three times at once: all three answer from the copy, one walk starts.
      (svc as any).lastServices.at = Date.now() - 10 * 60 * 1000;
      const three = await Promise.all([svc.catalog(), svc.catalog(), svc.catalog()]);
      for (const c of three) expect(c.tools.some((t) => t.id === 'svc:github.v1')).toBe(true);
      expect(walks).toBe(2);
      release();
      await new Promise((r) => setTimeout(r, 10));
      // The next read has the fresh copy.
      expect((await svc.catalog()).tools.some((t) => t.id === 'svc:github.v2')).toBe(true);
      expect(walks).toBe(2);
    });

    it('a connect during a re-read starts a fresh walk — the newcomer never gets the pre-connect list', async () => {
      let gen = 1;
      let walks = 0;
      const gates: (() => void)[] = [];
      const p = provider({
        generation: () => gen,
        listActions: async () => {
          const n = ++walks;
          await new Promise<void>((r) => gates.push(r));
          return [{ id: `svc:github.walk${n}`, name: `W${n}`, description: '', schema: {}, risky: false, service: 'github' }];
        },
      });
      const svc = new ToolCatalogService(connectors([]), skills([]), undefined, p);
      svc.serviceBudgetMs = 5000;
      const first = svc.catalog(); // walk 1 (gen 1) starts and hangs
      await new Promise((r) => setTimeout(r, 5));
      gen = 2; // a connect happens while walk 1 is in flight
      const second = svc.catalog(); // must start walk 2, not join walk 1
      await new Promise((r) => setTimeout(r, 5));
      expect(walks).toBe(2);
      gates[0]!(); // walk 1 finishes first
      const a = await first;
      expect(a.tools.some((t) => t.id === 'svc:github.walk1')).toBe(true);
      gates[1]!();
      const b = await second;
      expect(b.tools.some((t) => t.id === 'svc:github.walk2')).toBe(true);
      expect(b.tools.some((t) => t.id === 'svc:github.walk1')).toBe(false);
      // And the remembered copy is the newer generation's — served fresh from now on.
      expect((svc as any).lastServices.gen).toBe(2);
      expect((await svc.catalog()).tools.some((t) => t.id === 'svc:github.walk2')).toBe(true);
      expect(walks).toBe(2);
    });

    it('survives the service layer being down — every built-in tool is still there', async () => {
      const before = await baseline();
      for (const broken of [
        { status: async () => { throw new Error('network'); } },
        { status: async () => ({ configured: true, reachable: false, message: 'no' }) },
        { listServices: async () => { throw new Error('boom'); } },
        { listActions: async () => { throw new Error('boom'); } },
      ]) {
        const svc = new ToolCatalogService(connectors(['tavily']), skills([]), undefined, provider(broken));
        const { tools } = await svc.catalog();
        for (const id of before.tools.map((t) => t.id)) expect(tools.map((t) => t.id)).toContain(id);
      }
    });
  });

  it('survives every probe failing — the catalog still comes back', async () => {
    const broken = { listStatus: async () => { throw new Error('db down'); } } as any;
    const brokenSkills = { list: async () => { throw new Error('nope'); } } as any;
    const svc = new ToolCatalogService(broken, brokenSkills, undefined);
    const { tools } = await svc.catalog();
    expect(tools.find((t) => t.id === 'search_brain')).toBeTruthy();
    expect(tools.find((t) => t.id === 'web_search')!.connected).toBe(false);
  });
});
