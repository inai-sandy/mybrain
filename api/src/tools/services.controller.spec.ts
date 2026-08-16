import { ServicesController } from './services.controller';

/**
 * BEA-1346 — what the `/tools` page is served.
 *
 * Two things are pinned here because both were nearly got wrong. The categories are counted from
 * the services themselves (the vendor's own category endpoint answers with duplicates and with
 * names nothing is filed under, so a filter built from it offers dead choices). And the browse row
 * is trimmed on purpose: 1,209 fat rows is over a megabyte on a phone, so what a card does not draw
 * does not travel — it is one request away on `GET /:slug`.
 */

const GITHUB = {
  slug: 'github',
  name: 'GitHub',
  category: 'developer tools',
  categories: [{ id: 'developer-tools', name: 'developer tools' }, { id: 'popular', name: 'popular' }],
  connected: true,
  accounts: [{ id: 'ca_1', label: 'work', status: 'ACTIVE' }],
  description: 'x'.repeat(400),
  logo: 'l',
  actionCount: 871,
  triggerCount: 46,
  managedAuth: true,
  noAuth: false,
  authSchemes: ['OAUTH2'],
  authMode: 'OAUTH2',
  needs: [],
  needsAuthConfig: [],
  needsAccount: [],
};
const VERCEL = {
  slug: 'vercel',
  name: 'Vercel',
  category: 'developer tools',
  categories: [{ id: 'developer-tools', name: 'developer tools' }],
  connected: false,
  accounts: [],
  actionCount: 131,
  triggerCount: 0,
  managedAuth: false,
  noAuth: false,
  needs: [{ name: 'bearer_token', label: 'Bearer token' }],
  needsAccount: [{ name: 'bearer_token', label: 'Bearer token' }],
  needsAuthConfig: [],
};

function provider(over: any = {}) {
  return {
    status: async () => over.status ?? { configured: true, reachable: true, serviceCount: 1209 },
    listServices: async () => over.services ?? [GITHUB, VERCEL],
    getService: async (slug: string) => (over.services ?? [GITHUB, VERCEL]).find((s: any) => s.slug === slug) || null,
    connect: async (...args: any[]) => { over.connectCalls?.push(args); return over.connect ?? { ok: true }; },
    disconnect: async () => over.disconnect ?? { ok: true },
    renameConnection: async (...args: any[]) => { over.renameCalls?.push(args); return { ok: true }; },
    refresh: () => { over.refreshed = (over.refreshed || 0) + 1; },
    ...over.extra,
  } as any;
}

describe('ServicesController (BEA-1346)', () => {
  it('answers immediately, and with nothing to browse, when there is no key', async () => {
    const p = provider({ status: { configured: false, reachable: false, message: 'No key.' } });
    let listed = false;
    p.listServices = async () => { listed = true; return []; };
    const r = await new ServicesController(p).list();
    expect(r.status.configured).toBe(false);
    expect(r.services).toEqual([]);
    expect(r.categories).toEqual([]);
    expect(listed).toBe(false); // never a wasted round trip to a vendor we cannot talk to
  });

  it('says the vendor is unreachable rather than pretending there are no services', async () => {
    const p = provider({ status: { configured: true, reachable: false, message: 'It did not answer in time.' } });
    const r = await new ServicesController(p).list();
    expect(r.status.reachable).toBe(false);
    expect(r.status.message).toBe('It did not answer in time.');
    expect(r.services).toEqual([]);
  });

  it('builds the category filter by counting the services themselves, biggest first', async () => {
    const r = await new ServicesController(provider()).list();
    expect(r.categories).toEqual([
      { id: 'developer-tools', label: 'Developer Tools', count: 2 },
      { id: 'popular', label: 'Popular', count: 1 },
    ]);
    expect(r.connectedCount).toBe(1);
  });

  it('trims a browse row to what a card draws', async () => {
    const r = await new ServicesController(provider()).list();
    const gh = r.services.find((s) => s.slug === 'github')!;
    expect(gh.description!.length).toBe(180); // not the full 400
    expect(gh.categories).toEqual(['developer-tools', 'popular']);
    expect(gh.category).toBe('Developer Tools'); // the vendor's lower-casing tidied for display
    expect(gh.accounts).toEqual([{ id: 'ca_1', label: 'work', status: 'ACTIVE' }]);
    expect(gh.actionCount).toBe(871);
    // The heavy half stays behind — the page asks for it when a service is opened.
    expect((gh as any).needs).toBeUndefined();
    expect((gh as any).needsAccount).toBeUndefined();
    expect(r.services.find((s) => s.slug === 'vercel')!.needsCount).toBe(1);
  });

  it('leaves a properly-written category alone and fixes only the lower-cased ones', async () => {
    const svcs = [
      { ...VERCEL, categories: [{ id: 'crm', name: 'crm' }] },
      { ...VERCEL, slug: 'x', categories: [{ id: 'ai-agents', name: 'ai agents' }] },
      { ...VERCEL, slug: 'y', categories: [{ id: 'other', name: 'Other / Miscellaneous' }] },
    ];
    const r = await new ServicesController(provider({ services: svcs })).list();
    expect(r.categories.map((c) => c.label).sort()).toEqual(['AI Agents', 'CRM', 'Other / Miscellaneous']);
  });

  it('hands over the whole of one service when it is opened, and says so plainly when it is not there', async () => {
    const c = new ServicesController(provider());
    const one = await c.one('vercel');
    expect(one.service!.needsAccount).toEqual([{ name: 'bearer_token', label: 'Bearer token' }]);
    const missing = await c.one('nope');
    expect(missing.service).toBeNull();
    expect(missing.message).toMatch(/could not find/i);
  });

  it('passes the owner’s credentials straight through and re-reads after anything changes', async () => {
    const over: any = { connectCalls: [], renameCalls: [], connect: { ok: true, done: true } };
    const c = new ServicesController(provider(over));
    await c.connect('vercel', { label: 'mine', credentials: { bearer_token: 't' } });
    expect(over.connectCalls[0]).toEqual(['vercel', { label: 'mine', credentials: { bearer_token: 't' } }]);
    expect(over.refreshed).toBe(1);

    await c.disconnect('ca_1');
    expect(over.refreshed).toBe(2);

    await c.rename('ca_1', { label: 'work gmail' });
    expect(over.renameCalls[0]).toEqual(['ca_1', 'work gmail']);
  });

  it('compresses the big browse answer, and only when the browser asked', async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ ...VERCEL, slug: `s${i}`, name: `Service ${i}`, description: 'y'.repeat(180) }));
    const c = new ServicesController(provider({ services: many }));
    const fake = (accept?: string) => {
      const headers: any = {};
      return {
        req: { headers: accept ? { 'accept-encoding': accept } : {} },
        setHeader: (k: string, v: string) => { headers[k] = v; },
        send: (b: any) => { headers._body = b; },
        end: (b: any) => { headers._body = b; },
        headers,
      } as any;
    };
    const zipped = fake('gzip, deflate, br');
    await c.listRoute(zipped);
    expect(zipped.headers['Content-Encoding']).toBe('gzip');
    expect(zipped.headers['Vary']).toBe('Accept-Encoding');
    expect(Buffer.isBuffer(zipped.headers._body)).toBe(true);
    expect(zipped.headers._body.length).toBeLessThan(60_000); // from ~180KB of JSON

    const plain = fake();
    await c.listRoute(plain);
    expect(plain.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(plain.headers._body).services).toHaveLength(400);
  });

  it('does not re-read after a connect that went nowhere', async () => {
    const over: any = { connectCalls: [], connect: { ok: false, needsCredentials: true, fields: [] } };
    const c = new ServicesController(provider(over));
    const r = await c.connect('vercel', {});
    expect(r.needsCredentials).toBe(true);
    expect(over.refreshed).toBeUndefined();
  });
});
