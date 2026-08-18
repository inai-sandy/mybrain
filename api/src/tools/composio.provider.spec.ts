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

/**
 * Event types, exactly as the live API answers them (BEA-1350): the vendor says per event whether it
 * is pushed (`webhook`) or looked up on a timer (`poll`), and a polled one carries its own interval
 * in minutes — the real default is 2, not the 15 the docs pages imply.
 */
const TRIGGERS: Record<string, any[]> = {
  slack: [{ slug: 'SLACK_RECEIVE_MESSAGE', name: 'New message', description: 'A message arrived', type: 'webhook', toolkit: { slug: 'slack' }, config: { type: 'object', properties: {}, required: [] } }],
  github: [
    { slug: 'GITHUB_ISSUE_CREATED_TRIGGER', name: 'Issue created', description: 'An issue was opened', type: 'poll', toolkit: { slug: 'github' }, config: { type: 'object', required: ['owner', 'repo'], properties: { owner: { title: 'Owner' }, repo: { title: 'Repo' }, interval: { default: 2 } } } },
  ],
  // Verified live: Sentry and Vercel really do have none. A connected service with nothing to
  // listen for is a normal answer, not a failure.
  sentry: [],
};

/** A stand-in for Composio's REST API — every route answers with a recorded shape. */
function fakeApi(opts: { accounts?: any[]; fail?: boolean; execFails?: boolean; noAuthConfigs?: boolean; subscription?: any; deleteMissing?: boolean } = {}) {
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
    // ---- events (BEA-1350), in the shapes recorded live in specs/COMPOSIO-API.md ----
    if (u.pathname.endsWith('/triggers_types')) {
      return json({ items: TRIGGERS[u.searchParams.get('toolkit_slugs') || ''] || [], total_items: 0, next_cursor: null });
    }
    if (u.pathname.endsWith('/upsert')) return json({ trigger_id: 'ti_made' });
    if (u.pathname.includes('/trigger_instances/manage/')) {
      return opts.deleteMissing ? ({ ok: false, status: 404, text: async () => 'gone' } as any) : json({ trigger_id: 'ti_made' });
    }
    if (u.pathname.endsWith('/webhook_subscriptions/event_types')) {
      return json({ items: [{ event_type: 'composio.trigger.message' }, { event_type: 'composio.trigger.disabled' }] });
    }
    if (u.pathname.endsWith('/webhook_subscriptions')) {
      if (method === 'POST') return json({ id: 'ws_1', webhook_url: body?.webhook_url, secret: 'whsec_new' });
      return json({ items: opts.subscription ? [opts.subscription] : [], next_cursor: null });
    }
    if (u.pathname.includes('/webhook_subscriptions/')) return json({ id: 'ws_1', webhook_url: body?.webhook_url, secret: 'whsec_moved' });
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
    // The vendor's `is_deprecated` rides along as `retired: true` — kept, never dropped (BEA-1365).
    expect(actions.find((a) => a.id === 'svc:github.old_thing')!.retired).toBe(true);
    expect(actions.find((a) => a.id === 'svc:github.create_issue')!.retired).toBeUndefined();
    expect(actions.find((a) => a.id === 'svc:github.delete_a_repository')!.risky).toBe(true);
    expect(actions.find((a) => a.id === 'svc:github.create_issue')!.risky).toBe(false);
    expect(actions[0].schema.properties.title.type).toBe('string');
  });

  /**
   * EVERY action, not the vendor's shortlist (BEA-1354). The catalog used to ask for `important=true`
   * and stop at 60; now the whole cursor-paged list is walked, and "important" is only a mark on
   * each action, read off its tags — never a filter and never a second request.
   */
  it('walks every page of a service’s actions with no important filter and no cap (BEA-1354)', async () => {
    const big = Array.from({ length: 2300 }, (_, i) => ({
      slug: `GITHUB_ACTION_${i}`, name: `Action ${i}`, description: '', input_parameters: {},
      tags: i % 100 === 0 ? ['openWorldHint', 'important'] : ['openWorldHint'],
      // Every 50th is one the vendor retired — 46 of them; the API's `total_items` counts them too.
      ...(i % 50 === 0 ? { is_deprecated: true } : {}),
    }));
    const calls: URL[] = [];
    global.fetch = (async (url: string) => {
      const u = new URL(String(url));
      calls.push(u);
      const json = (v: any) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) } as any);
      if (u.pathname.endsWith('/tools')) {
        // Cursor pagination exactly like the live API: `limit` honoured, `next_cursor` = the offset.
        const limit = Number(u.searchParams.get('limit'));
        const start = Number(u.searchParams.get('cursor') || 0);
        const items = big.slice(start, start + limit);
        const end = start + items.length;
        return json({ items, total_items: big.length, next_cursor: end < big.length ? String(end) : null });
      }
      return json({ items: [], next_cursor: null });
    }) as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const actions = await p.listActions('github');
    expect(actions.length).toBe(2300); // all of them — no 60, no 1000, and the retired ones stay in (BEA-1365)
    expect(actions.filter((a) => a.retired).length).toBe(46); // == the API's deprecated count, each tagged
    const toolCalls = calls.filter((u) => u.pathname.endsWith('/tools'));
    expect(toolCalls.length).toBe(3); // 1000-a-page walk, every page taken
    for (const u of toolCalls) expect(u.searchParams.get('important')).toBeNull(); // the shortlist is never asked for
    expect(actions.filter((a) => a.important).length).toBe(23); // the vendor's mark, from the tags
    expect(actions.find((a) => a.id === 'svc:github.action_1')!.important).toBeUndefined();
    // Asked a second time inside the cache window it does not walk again.
    await p.listActions('github');
    expect(calls.filter((u) => u.pathname.endsWith('/tools')).length).toBe(3);
  });

  it('bumps its generation whenever it forgets what it read, so the catalog knows its copy is stale', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const g0 = p.generation();
    p.refresh();
    expect(p.generation()).toBe(g0 + 1);
    await p.listActions('github');
    expect(p.generation()).toBe(g0 + 1); // a plain read changes nothing
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

  // ---- BEA-1364: a pure transport failure names its cause and is retried once ----

  const transportError = (code: string, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

  it('retries ONCE when fetch() itself rejects, and the second answer is the result', async () => {
    const real = fakeApi();
    let n = 0;
    global.fetch = (async (url: string, init: any) => {
      n += 1;
      if (n === 1) throw transportError('ECONNRESET', 'socket hang up');
      return real.fetchMock(url, init);
    }) as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const r = await p.execute('svc:github.create_issue', { title: 'hi' }, { connectionId: 'ca_1' });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
    expect(real.calls.filter((c) => c.url.includes('/tools/execute/'))).toHaveLength(1);
  });

  it('two transport failures name the cause; a vendor answer (HTTP error or successful:false) is never retried', async () => {
    let n = 0;
    global.fetch = (async () => { n += 1; throw transportError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN backend.composio.dev'); }) as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const r = await p.execute('svc:github.create_issue', { title: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('fetch failed (EAI_AGAIN: getaddrinfo EAI_AGAIN backend.composio.dev)');
    expect(n).toBe(2);
    // 200 + successful:false — the vendor's verdict, exactly one request
    const bad = fakeApi({ execFails: true });
    global.fetch = bad.fetchMock as any;
    const p2 = new ComposioProvider(connectors('k'), prisma());
    expect((await p2.execute('svc:github.create_issue', {})).ok).toBe(false);
    expect(bad.calls.filter((c) => c.url.includes('/tools/execute/'))).toHaveLength(1);
    // an HTTP 429 — also one request, and the old plain sentence
    let m = 0;
    global.fetch = (async () => { m += 1; return { ok: false, status: 429, text: async () => 'slow down' } as any; }) as any;
    const p3 = new ComposioProvider(connectors('k'), prisma());
    const limited = await p3.execute('svc:github.create_issue', {});
    expect(limited.error).toMatch(/rate-limiting/);
    expect(m).toBe(1);
    // a timeout — one request, never retried
    let t = 0;
    global.fetch = (async () => { t += 1; throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }) as any;
    const p4 = new ComposioProvider(connectors('k'), prisma());
    expect((await p4.execute('svc:github.create_issue', {})).error).toBe('Composio did not answer in time.');
    expect(t).toBe(1);
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

  // ---- events (BEA-1350) --------------------------------------------------------------------

  it('reads whether an event is instant or on a timer from the API, and never guesses', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());

    const [slack] = await p.listTriggers('slack');
    expect(slack).toMatchObject({ id: 'evt:slack.receive_message', name: 'New message', instant: true });
    expect(slack.everyMinutes).toBeUndefined();

    const [github] = await p.listTriggers('github');
    // The real default is 2 minutes. The docs pages say otherwise; the API wins.
    expect(github).toMatchObject({ id: 'evt:github.issue_created_trigger', instant: false, everyMinutes: 2 });
    expect(github.config.required).toEqual(['owner', 'repo']);
  });

  it('a service with no events answers with an empty list, not an error', async () => {
    const { fetchMock } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    expect(await p.listTriggers('sentry')).toEqual([]);
  });

  it('subscribes with OUR id and the vendor’s slug, and hands back what stops it again', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());

    const made = await p.createTriggerInstance('evt:github.issue_created_trigger', { owner: 'inai-sandy', repo: 'mybrain' }, { connectionId: 'ca_1' });
    expect(made).toEqual({ ok: true, instanceId: 'ti_made' });
    const call = calls.find((c) => c.url.includes('/upsert'));
    expect(call.url).toContain('/trigger_instances/GITHUB_ISSUE_CREATED_TRIGGER/upsert');
    expect(call.body).toEqual({ user_id: 'mybrain-owner', trigger_config: { owner: 'inai-sandy', repo: 'mybrain' }, connected_account_id: 'ca_1' });
  });

  it('refuses an id that is not ours, and never calls out with it', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    expect((await p.createTriggerInstance('svc:github.create_an_issue')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('deletes a subscription — and one that is already gone counts as done', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    expect((await p.deleteTriggerInstance('ti_made')).ok).toBe(true);
    expect(calls.find((c) => c.method === 'DELETE').url).toContain('/trigger_instances/manage/ti_made');

    // The wanted state is "not there", so a 404 is a success, not something to make the owner read.
    const gone = fakeApi({ deleteMissing: true });
    global.fetch = gone.fetchMock as any;
    const q = new ComposioProvider(connectors('k'), prisma());
    expect((await q.deleteTriggerInstance('ti_made')).ok).toBe(true);
    // Nothing to delete at all is a success too, without a request.
    expect((await q.deleteTriggerInstance('')).ok).toBe(true);
  });

  it('points event delivery at our address, and gives back the signing secret', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const r = await p.ensureEventDelivery('https://mybrain.1site.ai/api/tools/triggers/events/abc');
    expect(r).toMatchObject({ ok: true, signingSecret: 'whsec_new' });
    const made = calls.find((c) => c.method === 'POST' && c.url.endsWith('/webhook_subscriptions'));
    expect(made.body.webhook_url).toContain('/events/abc');
    expect(made.body.enabled_events).toContain('composio.trigger.message');
  });

  it('MOVES the one subscription that already exists rather than adding a second', async () => {
    const { fetchMock, calls } = fakeApi({ subscription: { id: 'ws_old', webhook_url: 'https://somewhere.else/hook', secret: 'whsec_old' } });
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    const r = await p.ensureEventDelivery('https://mybrain.1site.ai/api/tools/triggers/events/abc');
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('/webhook_subscriptions/ws_old'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/webhook_subscriptions'))).toBe(false);
  });

  it('leaves a subscription that is already pointing at us alone', async () => {
    const url = 'https://mybrain.1site.ai/api/tools/triggers/events/abc';
    const { fetchMock, calls } = fakeApi({ subscription: { id: 'ws_old', webhook_url: url, secret: 'whsec_old' } });
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    expect(await p.ensureEventDelivery(url)).toMatchObject({ ok: true, signingSecret: 'whsec_old' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('will not send events anywhere that is not https', async () => {
    const { fetchMock, calls } = fakeApi();
    global.fetch = fetchMock as any;
    const p = new ComposioProvider(connectors('k'), prisma());
    expect((await p.ensureEventDelivery('http://mybrain.1site.ai/hook')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
