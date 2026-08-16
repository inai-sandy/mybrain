import { ComposioProvider } from './composio.provider';

/**
 * The Composio provider (BEA-1345), against a stand-in for their REST API.
 *
 * The shapes here are copied from real responses recorded in `specs/COMPOSIO-API.md` — including
 * the two that catch people out: a FAILED action still returns HTTP 200 with `successful: false`,
 * and `composio_managed_auth_schemes` can be empty (Vercel), which means no one-click connect.
 */

const TOOLKITS: Record<string, any> = {
  github: {
    slug: 'github',
    name: 'GitHub',
    auth_schemes: ['OAUTH2'],
    composio_managed_auth_schemes: ['OAUTH2'],
    no_auth: false,
    meta: { tools_count: 871, triggers_count: 46, description: 'Code hosting', logo: 'l', categories: [{ name: 'Developer Tools' }] },
    auth_config_details: [{ mode: 'OAUTH2', fields: { auth_config_creation: { required: [{ name: 'client_id', displayName: 'Client id' }, { name: 'client_secret', displayName: 'Client secret' }] } } }],
  },
  vercel: {
    slug: 'vercel',
    name: 'Vercel',
    auth_schemes: ['API_KEY'],
    composio_managed_auth_schemes: [], // the real answer — Vercel has no managed login of any kind
    no_auth: false,
    meta: { tools_count: 131, triggers_count: 0, description: 'Deployments', categories: [{ name: 'Developer Tools' }] },
    // Vercel's real shape: API-key auth, and the field the owner must supply sits under
    // connected_account_initiation, not auth_config_creation.
    auth_config_details: [{ mode: 'API_KEY', fields: { auth_config_creation: { required: [] }, connected_account_initiation: { required: [{ name: 'bearer_token', displayName: 'Bearer token' }] } } }],
  },
  tavily: { slug: 'tavily', name: 'Tavily', composio_managed_auth_schemes: ['API_KEY'], meta: { tools_count: 3, triggers_count: 0, categories: [] } },
  // Twitter's real shape: an OAuth service with no managed login, so the owner supplies their own
  // APP's details — and those go to the login config, not to the account.
  twitter: {
    slug: 'twitter',
    name: 'Twitter',
    composio_managed_auth_schemes: [],
    no_auth: false,
    meta: { tools_count: 40, triggers_count: 0, categories: [{ id: 'social', name: 'social' }] },
    auth_config_details: [{ mode: 'OAUTH2', fields: { auth_config_creation: { required: [{ name: 'client_id', displayName: 'Client id' }, { name: 'client_secret', displayName: 'Client secret' }] }, connected_account_initiation: { required: [] } } }],
  },
  // Verified live: Composio REFUSES to make a login config for one of these, so we must not try.
  hackernews: { slug: 'hackernews', name: 'Hacker News', composio_managed_auth_schemes: [], no_auth: true, meta: { tools_count: 5, triggers_count: 0, categories: [] } },
};

const TOOLS: Record<string, any[]> = {
  github: [
    { slug: 'GITHUB_CREATE_ISSUE', name: 'Create issue', description: 'Open an issue', input_parameters: { type: 'object', properties: { title: { type: 'string' } } } },
    { slug: 'GITHUB_DELETE_A_REPOSITORY', name: 'Delete repository', description: 'Gone for good', input_parameters: { type: 'object' } },
    { slug: 'GITHUB_OLD_THING', name: 'Old', description: '', is_deprecated: true, input_parameters: {} },
  ],
};

/** A stand-in for Composio's REST API — every route answers with a recorded shape. */
function fakeApi(opts: { accounts?: any[]; fail?: boolean; execFails?: boolean; noAuthConfigs?: boolean } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchMock = async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    if (opts.fail) return { ok: false, status: 401, text: async () => 'bad key' } as any;
    const u = new URL(String(url));
    const json = (v: any) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) } as any);

    if (u.pathname.endsWith('/toolkits')) {
      const items = Object.values(TOOLKITS);
      return json({ items, total_items: 1209, next_cursor: null });
    }
    const one = /\/toolkits\/([^/]+)$/.exec(u.pathname);
    if (one) {
      const t = TOOLKITS[decodeURIComponent(one[1])];
      return t ? json(t) : ({ ok: false, status: 404, text: async () => 'no' } as any);
    }
    if (u.pathname.endsWith('/tools')) {
      return json({ items: TOOLS[u.searchParams.get('toolkit_slug') || ''] || [], next_cursor: null });
    }
    if (u.pathname.endsWith('/connected_accounts')) {
      if (method === 'POST') return json({ id: 'ca_direct', status: 'ACTIVE', connectionData: { authScheme: body?.connection?.state?.authScheme, val: body?.connection?.state?.val } });
      const mine = (opts.accounts || []).filter((a) => a.user_id === u.searchParams.get('user_ids'));
      return json({ items: mine, total_items: mine.length, next_cursor: null });
    }
    if (u.pathname.endsWith('/auth_configs')) {
      if (method === 'POST') return json({ toolkit: { slug: 'github' }, auth_config: { id: 'ac_new', auth_scheme: 'OAUTH2', is_composio_managed: true } });
      return json({ items: opts.noAuthConfigs ? [] : [{ id: 'ac_existing' }], next_cursor: null });
    }
    if (u.pathname.endsWith('/connected_accounts/link')) {
      return json({ link_token: 'lk_1', redirect_url: 'https://connect.composio.dev/link/lk_1', connected_account_id: 'ca_new' });
    }
    if (u.pathname.includes('/tools/execute/')) {
      // A failure still answers 200 — the verdict is in the body.
      return opts.execFails
        ? json({ successful: false, error: 'Not Found', data: {} })
        : json({ successful: true, error: null, data: { repos: 3 } });
    }
    return json({});
  };
  return { fetchMock, calls };
}

const connectors = (key: string | null) => ({ get: async () => (key ? { apiKey: key } : null) }) as any;
const prisma = () => {
  const rows: any[] = [];
  return {
    serviceConnection: {
      findMany: async () => rows,
      upsert: async ({ create }: any) => { rows.push(create); return create; },
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    rows,
  } as any;
};

const ACTIVE_GITHUB = { id: 'ca_1', user_id: 'mybrain-owner', status: 'ACTIVE', toolkit: { slug: 'github' }, created_at: '2026-08-16T00:00:00Z', word_id: 'github_one' };
const PLAYGROUND_GMAIL = { id: 'ca_pg', user_id: 'pg-test-41c13fd3', status: 'ACTIVE', toolkit: { slug: 'gmail' } };

describe('ComposioProvider', () => {
  const origFetch = global.fetch;
  const origKey = process.env.COMPOSIO_API_KEY;
  beforeEach(() => { delete process.env.COMPOSIO_API_KEY; });
  afterEach(() => { global.fetch = origFetch; if (origKey === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = origKey; });

  it('does nothing at all with no key — and never throws', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors(null), prisma());
    expect(await p.status()).toEqual({ configured: false, reachable: false, message: expect.any(String) });
    expect(await p.listServices()).toEqual([]);
    expect(await p.listActions('github')).toEqual([]);
    expect((await p.execute('svc:github.create_issue', {})).ok).toBe(false);
    expect(calls).toHaveLength(0); // not one wasted request
  });

  it('reports a wrong key without throwing, and still answers empty', async () => {
    const { fetchMock } = fakeApi({ fail: true });
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('bad'), prisma());
    const s = await p.status();
    expect(s.configured).toBe(true);
    expect(s.reachable).toBe(false);
    expect(s.message).toMatch(/rejected/i);
    expect(await p.listServices()).toEqual([]);
    expect(await p.listActions('github')).toEqual([]);
  });

  it('reads the service counts live and never invents them', async () => {
    const { fetchMock } = fakeApi({ accounts: [ACTIVE_GITHUB] });
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const [gh] = await p.listServices({ connectedOnly: true });
    expect(gh.slug).toBe('github');
    expect(gh.actionCount).toBe(871); // straight from meta.tools_count
    expect(gh.triggerCount).toBe(46);
    expect(gh.connected).toBe(true);
    expect(gh.accounts[0]).toMatchObject({ id: 'ca_1', status: 'ACTIVE' });
  });

  it('ignores connections that belong to someone else', async () => {
    const { fetchMock } = fakeApi({ accounts: [ACTIVE_GITHUB, PLAYGROUND_GMAIL] });
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const slugs = (await p.listServices({ connectedOnly: true })).map((s) => s.slug);
    expect(slugs).toEqual(['github']); // the playground's Gmail accounts are not ours
  });

  it('never hands out a blocked service', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const slugs = (await p.listServices()).map((s) => s.slug);
    expect(slugs).toContain('github');
    expect(slugs).not.toContain('tavily'); // ours, and better
    expect(await p.listActions('tavily')).toEqual([]);
    const blocked = await p.connect('tavily');
    expect(blocked.ok).toBe(false);
    expect((await p.execute('svc:tavily.search', {})).ok).toBe(false);
  });

  it('turns vendor slugs into our ids and flags what cannot be undone', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const actions = await p.listActions('github');
    expect(actions.map((a) => a.id)).toEqual(['svc:github.create_issue', 'svc:github.delete_a_repository', 'svc:github.old_thing']);
    expect(actions.every((a) => !/composio/i.test(a.id))).toBe(true);
    expect(actions.find((a) => a.id === 'svc:github.delete_a_repository')!.risky).toBe(true);
    expect(actions.find((a) => a.id === 'svc:github.create_issue')!.risky).toBe(false);
    expect(actions[0].schema.properties.title.type).toBe('string');
  });

  it('says what is missing when a service has no ready-made login', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const [vercel] = (await p.listServices()).filter((s) => s.slug === 'vercel');
    expect(vercel.managedAuth).toBe(false);
    expect(vercel.needs!.map((n) => n.name)).toEqual(['bearer_token']);

    const r = await p.connect('vercel');
    expect(r.ok).toBe(false);
    expect(r.needsCredentials).toBe(true);
    expect(r.redirectUrl).toBeUndefined();
    expect(r.fields!.map((f) => f.name)).toEqual(['bearer_token']);
  });

  it('connects through the link endpoint, reusing the login config that already exists', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const db = prisma();
    const p = new ComposioProvider(connectors('k'), db);
    const r = await p.connect('github', { label: 'my github' });
    expect(r.ok).toBe(true);
    expect(r.redirectUrl).toBe('https://connect.composio.dev/link/lk_1');
    expect(r.connectionId).toBe('ca_new');
    // The deprecated POST /connected_accounts answers 400 for managed OAuth — we must not use it.
    expect(calls.some((c) => c.method === 'POST' && /\/connected_accounts$/.test(new URL(c.url).pathname))).toBe(false);
    const link = calls.find((c) => c.url.includes('/connected_accounts/link'))!;
    expect(link.body).toEqual({ auth_config_id: 'ac_existing', user_id: 'mybrain-owner' });
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/auth_configs'))).toBe(false); // reused, not duplicated
    expect(db.rows[0]).toMatchObject({ service: 'github', connectedAccountId: 'ca_new', label: 'my github' });
  });

  it('runs an action and reads the verdict from the body, not the status code', async () => {
    const ok = fakeApi();
    global.fetch = ok.fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const good = await p.execute('svc:github.create_issue', { title: 'hi' }, { connectionId: 'ca_1' });
    expect(good.ok).toBe(true);
    expect(good.data).toEqual({ repos: 3 });
    const exec = ok.calls.find((c) => c.url.includes('/tools/execute/'))!;
    expect(exec.url).toContain('/tools/execute/GITHUB_CREATE_ISSUE'); // our id, their slug
    expect(exec.body).toEqual({ arguments: { title: 'hi' }, user_id: 'mybrain-owner', connected_account_id: 'ca_1' });

    const bad = fakeApi({ execFails: true });
    global.fetch = bad.fetchMock as any;
    const p2 = new ComposioProvider(connectors('k'), prisma());
    const failed = await p2.execute('svc:github.create_issue', {});
    expect(failed.ok).toBe(false); // HTTP 200, successful:false — still a failure
    expect(failed.error).toBe('Not Found');
  });

  it('refuses an id that is not ours', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    expect((await p.execute('GITHUB_CREATE_ISSUE', {})).ok).toBe(false);
    expect((await p.execute('search_brain', {})).ok).toBe(false);
  });

  /**
   * The three roads out of `connect()` (BEA-1346). Which one is taken is decided by the toolkit,
   * and each was checked against the live API on 2026-08-16 before it was written here.
   */
  it('sends a key-based service its key on the ACCOUNT, never on the login config', async () => {
    const { fetchMock, calls } = fakeApi({ noAuthConfigs: true });
    global.fetch = fetchMock as any;
    const db = prisma();
    const p = new ComposioProvider(connectors('k'), db);
    const r = await p.connect('vercel', { credentials: { bearer_token: 'tok_live' }, label: 'my vercel' });

    expect(r.ok).toBe(true);
    expect(r.done).toBe(true); // an API key needs no trip to a browser
    expect(r.redirectUrl).toBeUndefined();
    expect(r.connectionId).toBe('ca_direct');

    // The login config is ours (custom), and carries NOTHING — Vercel's field belongs to the account.
    const cfg = calls.find((c) => c.method === 'POST' && c.url.includes('/auth_configs'))!;
    expect(cfg.body.auth_config).toMatchObject({ type: 'use_custom_auth', authScheme: 'API_KEY', credentials: {} });
    // And the key itself went where the vendor actually reads it.
    const acct = calls.find((c) => c.method === 'POST' && /\/connected_accounts$/.test(new URL(c.url).pathname))!;
    expect(acct.body.connection.state).toEqual({ authScheme: 'API_KEY', val: { status: 'ACTIVE', bearer_token: 'tok_live' } });
    expect(calls.some((c) => c.url.includes('/connected_accounts/link'))).toBe(false);
    expect(db.rows[0]).toMatchObject({ service: 'vercel', connectedAccountId: 'ca_direct', label: 'my vercel' });
  });

  it('sends an own-app OAuth service its client details on the login config, then the redirect', async () => {
    const { fetchMock, calls } = fakeApi({ noAuthConfigs: true });
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const r = await p.connect('twitter', { credentials: { client_id: 'cid', client_secret: 'shh' } });

    expect(r.ok).toBe(true);
    expect(r.redirectUrl).toBe('https://connect.composio.dev/link/lk_1'); // OAuth still needs the browser
    const cfg = calls.find((c) => c.method === 'POST' && c.url.includes('/auth_configs'))!;
    expect(cfg.body.auth_config).toMatchObject({ type: 'use_custom_auth', authScheme: 'OAUTH2', credentials: { client_id: 'cid', client_secret: 'shh' } });
    // Nothing was posted straight at an account — that road is for keys only.
    expect(calls.some((c) => c.method === 'POST' && /\/connected_accounts$/.test(new URL(c.url).pathname))).toBe(false);
  });

  it('never tries to sign in to a service that has no sign-in', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const [hn] = (await p.listServices()).filter((s) => s.slug === 'hackernews');
    expect(hn.noAuth).toBe(true);

    const r = await p.connect('hackernews');
    expect(r.ok).toBe(true);
    expect(r.done).toBe(true);
    expect(r.message).toMatch(/no sign-in/i);
    // Composio answers HTTP 400 for these ("works without an auth config") — asking would only
    // turn a usable service into an error message.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('splits what the owner must supply into the two halves the vendor reads', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const vercel = await p.getService('vercel');
    expect(vercel!.needsAuthConfig).toEqual([]);
    expect(vercel!.needsAccount!.map((f) => f.name)).toEqual(['bearer_token']);
    expect(vercel!.needsAccount![0].secret).toBe(true); // shown as a password box, not in the clear
    expect(vercel!.authMode).toBe('API_KEY');

    const twitter = await p.getService('twitter');
    expect(twitter!.needsAuthConfig!.map((f) => f.name)).toEqual(['client_id', 'client_secret']);
    expect(twitter!.needsAccount).toEqual([]);
    expect(twitter!.categories).toEqual([{ id: 'social', name: 'social' }]);
  });

  it('remembers the owner’s own name for an account, and forgets what it read a moment ago', async () => {
    const { fetchMock } = fakeApi({ accounts: [ACTIVE_GITHUB] });
    global.fetch = fetchMock as any;
    const db = prisma();
    db.serviceConnection.updateMany = async () => ({ count: 1 });
    const p = new ComposioProvider(connectors('k'), db);
    expect(await p.renameConnection('ca_1', 'work github')).toEqual({ ok: true });
    expect((await p.renameConnection('ca_1', '  ')).ok).toBe(false); // a blank name is not a name
    expect((await p.renameConnection('', 'x')).ok).toBe(false);
    expect(typeof p.refresh).toBe('function');
  });

  it('works without a database — the table is our own bookkeeping, not the source of truth', async () => {
    const { fetchMock } = fakeApi({ accounts: [ACTIVE_GITHUB] });
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k')); // no prisma at all
    expect((await p.listServices({ connectedOnly: true })).map((s) => s.slug)).toEqual(['github']);
    expect((await p.connect('github')).ok).toBe(true);
  });
});
