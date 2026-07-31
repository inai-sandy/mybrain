import { clip, GROUP_ORDER, ToolCatalogService } from './tool-catalog.service';

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
const google = (connected: boolean) => ({ status: async () => ({ connected, email: null, gws: connected, bridge: connected }) }) as any;

describe('ToolCatalogService', () => {
  const origFetch = global.fetch;
  beforeEach(() => { global.fetch = (async () => ({ ok: false })) as any; });
  afterEach(() => { global.fetch = origFetch; });

  it('returns every group, in a stable order, with no empty groups', async () => {
    const svc = new ToolCatalogService(connectors(['tavily', 'telegram']), skills([]), google(true));
    const { groups } = await svc.catalog();
    const names = groups.map((g) => g.group);
    // Skills is absent when there are none; every other group must be present.
    expect(names).toEqual(GROUP_ORDER.filter((g) => g !== 'Skills'));
    expect(groups.every((g) => g.tools.length > 0)).toBe(true);
  });

  it('keeps the tool ids the flow executor dispatches on', async () => {
    const svc = new ToolCatalogService(connectors(['tavily']), skills([]), google(true));
    const { tools } = await svc.catalog();
    const ids = tools.map((t) => t.id);
    // Renaming any of these silently breaks every saved flow.
    for (const id of ['search_brain', 'web_search', 'web_read', 'gmail', 'calendar', 'drive', 'ask_ai', 'http', 'save_document', 'telegram']) {
      expect(ids).toContain(id);
    }
  });

  it('marks a tool as needing connection when its credentials are missing, with somewhere to go', async () => {
    const svc = new ToolCatalogService(connectors([]), skills([]), google(false));
    const { tools } = await svc.catalog();
    const web = tools.find((t) => t.id === 'web_search')!;
    expect(web.connected).toBe(false);
    expect(web.connectHint).toBeTruthy();
    expect(web.connectPath).toBeTruthy();

    const gmail = tools.find((t) => t.id === 'gmail')!;
    expect(gmail.connected).toBe(false);
    expect(gmail.connectPath).toBe('/google');
  });

  it('marks a tool connected once its credentials are there', async () => {
    const svc = new ToolCatalogService(connectors(['tavily', 'telegram']), skills([]), google(true));
    const { tools } = await svc.catalog();
    expect(tools.find((t) => t.id === 'web_search')!.connected).toBe(true);
    expect(tools.find((t) => t.id === 'gmail')!.connected).toBe(true);
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
      google(false),
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
      google(false),
    );
    const t = (await svc.catalog()).tools.find((x) => x.id === 'sk9')!;
    expect(t.connected).toBe(false);
    expect(t.connectHint).toMatch(/Install this skill/);
  });

  it('marks every skill unavailable when the chosen engine cannot run skills at all', async () => {
    const svc = new ToolCatalogService(
      connectors([]),
      skills([{ id: 'sk1', title: 'Installed everywhere', description: '', installedOn: ['sandy'] }]),
      google(false),
      { engineChoice: async () => ({ provider: 'gemini', model: 'g' }) } as any,
    );
    const t = (await svc.catalog()).tools.find((x) => x.id === 'sk1')!;
    expect(t.connected).toBe(false);
    expect(t.connectHint).toMatch(/gemini.*cannot run skills/);
    expect(t.connectPath).toBe('/settings#models');   // the fix is to change engine, not to install
  });

  it('lists the My Brain MCP server', async () => {
    const svc = new ToolCatalogService(connectors([]), skills([]), google(false));
    const { tools } = await svc.catalog();
    const mcp = tools.find((t) => t.kind === 'mcp')!;
    expect(mcp.id).toBe('mcp:mybrain');
    expect(mcp.group).toBe('MCP servers');
  });

  it('validate() separates real ids, unknown ids and unconnected ones', async () => {
    const svc = new ToolCatalogService(connectors([]), skills([]), google(false));
    const r = await svc.validate(['search_brain', 'web_search', 'not_a_tool']);
    expect(r.ok.map((t) => t.id)).toEqual(['search_brain', 'web_search']);
    expect(r.unknown).toEqual(['not_a_tool']);
    expect(r.notConnected.map((t) => t.id)).toEqual(['web_search']);
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
