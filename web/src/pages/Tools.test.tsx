import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tools } from './Tools';

/**
 * BEA-1346 — the `/tools` page.
 *
 * The eight states the issue names are each pinned here, because seven of them are exactly the ones
 * that never get looked at: no key, a key that nobody answers, a search that finds nothing, a
 * service with two accounts, one whose sign-in has expired, one with no ready-made sign-in, and one
 * that needs no sign-in at all. A page that only works on the happy path is not done.
 */

vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));

const GITHUB = {
  slug: 'github', name: 'GitHub', category: 'Developer tools', categories: ['developer-tools'],
  description: 'Code hosting', logo: 'https://logos.example/github', actionCount: 871, triggerCount: 46,
  managedAuth: true, noAuth: false, connected: true, needsCount: 0,
  accounts: [
    { id: 'ca_1', label: 'work github', status: 'ACTIVE', connectedAt: '2026-08-16T00:00:00Z' },
    { id: 'ca_2', label: 'personal github', status: 'ACTIVE', connectedAt: '2026-08-16T00:00:00Z' },
  ],
};
const VERCEL = {
  slug: 'vercel', name: 'Vercel', category: 'Developer tools', categories: ['developer-tools'],
  description: 'Deployments', actionCount: 131, triggerCount: 0,
  managedAuth: false, noAuth: false, connected: false, accounts: [], needsCount: 1,
};
const SLACK = {
  slug: 'slack', name: 'Slack', category: 'Team collaboration', categories: ['team-collaboration'],
  description: 'Chat', actionCount: 158, triggerCount: 9,
  managedAuth: true, noAuth: false, connected: true, needsCount: 0,
  accounts: [{ id: 'ca_x', label: 'our slack', status: 'EXPIRED' }],
};
const HN = {
  slug: 'hackernews', name: 'Hacker News', category: 'News', categories: ['news'],
  description: 'Stories', actionCount: 5, triggerCount: 0,
  managedAuth: false, noAuth: true, connected: false, accounts: [], needsCount: 0,
};

const OK = {
  status: { configured: true, reachable: true, serviceCount: 1209 },
  connectedCount: 2,
  categories: [{ id: 'developer-tools', label: 'Developer tools', count: 2 }, { id: 'news', label: 'News', count: 1 }],
  services: [GITHUB, VERCEL, SLACK, HN],
};

const VERCEL_FULL = { ...VERCEL, needs: [{ name: 'bearer_token', label: 'Bearer token', required: true, secret: true }], needsAuthConfig: [], needsAccount: [{ name: 'bearer_token', label: 'Bearer token', required: true, secret: true }] };

type Routes = { list?: any; one?: any; connect?: any; del?: any; patch?: any; listFails?: boolean };
function mockFetch(r: Routes = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  global.fetch = vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (u.includes('/connect')) return { ok: true, json: async () => r.connect ?? { ok: true } };
    if (u.includes('/connections/')) return { ok: true, json: async () => (method === 'DELETE' ? r.del ?? { ok: true } : r.patch ?? { ok: true }) };
    if (/\/api\/tools\/services\/[^?]/.test(u)) return { ok: true, json: async () => ({ service: r.one ?? null }) };
    if (r.listFails) throw new Error('offline');
    return { ok: true, json: async () => r.list ?? OK };
  }) as any;
  return calls;
}

const draw = () => render(<MemoryRouter><Tools /></MemoryRouter>);

/** A connected service shows twice — once under "Your connections", once in the full list. Open the first. */
async function openCard(name: string) {
  const hits = await screen.findAllByText(name);
  fireEvent.click(hits[0].closest('button')!);
}

describe('/tools (BEA-1346)', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('state 1 — no key: says so in plain English with a way to fix it, not an empty grid', async () => {
    mockFetch({ list: { status: { configured: false, reachable: false }, services: [], categories: [], connectedCount: 0 } });
    draw();
    expect(await screen.findByText(/No key yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings/i })).toHaveAttribute('href', '/settings/connections');
    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument(); // no dead search box over nothing
  });

  it('state 2 — key works, nothing connected: invites a first connection and still browses everything', async () => {
    mockFetch({ list: { ...OK, connectedCount: 0, services: [{ ...VERCEL }, { ...HN }] } });
    draw();
    expect(await screen.findByText(/Nothing connected yet/i)).toBeInTheDocument();
    expect(screen.getByText(/2 services are ready to browse/i)).toBeInTheDocument();
    expect(screen.queryByText('Your connections')).not.toBeInTheDocument();
    expect(screen.getByText('Vercel')).toBeInTheDocument();
  });

  it('state 3 — loading: shimmering cards, never a blank screen or a bare spinner', async () => {
    let release: (v: any) => void = () => undefined;
    global.fetch = vi.fn(() => new Promise((res) => { release = res; })) as any;
    draw();
    expect(screen.getByTestId('tools-loading')).toBeInTheDocument();
    release({ ok: true, json: async () => OK });
    await waitFor(() => expect(screen.queryByTestId('tools-loading')).not.toBeInTheDocument());
  });

  it('state 4 — a search that finds nothing says so kindly, and searching reaches every service', async () => {
    mockFetch();
    draw();
    await screen.findByLabelText('Search');
    // The search is over the whole list the server sent, not only what is connected.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'deployments' } });
    await waitFor(() => expect(screen.getByTestId('dt-count')).toHaveTextContent('1 result'));
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzzz-nothing' } });
    expect(await screen.findByTestId('dt-empty')).toHaveTextContent(/No service matches that/i);
    expect(screen.getByTestId('dt-count')).toHaveTextContent('0 results');
  });

  it('state 5 — several accounts of one service are listed separately, each with its own name', async () => {
    mockFetch({ one: GITHUB });
    draw();
    await openCard('GitHub');
    const panel = within(await screen.findByRole('dialog'));
    expect(panel.getByText('2 accounts')).toBeInTheDocument();
    expect(panel.getByText('work github')).toBeInTheDocument();
    expect(panel.getByText('personal github')).toBeInTheDocument();
    // Adding another must never read as replacing the ones there.
    expect(screen.getByRole('button', { name: /Add another account/i })).toBeInTheDocument();
    expect(screen.getByText(/Adding another keeps the ones you have/i)).toBeInTheDocument();
  });

  it('state 6 — an expired connection says so in English and offers Reconnect', async () => {
    mockFetch({ one: SLACK });
    draw();
    // The card itself flags it before anything is opened.
    const card = (await screen.findAllByText('Slack'))[0].closest('button')!;
    expect(within(card).getByText(/Reconnect/i)).toBeInTheDocument();
    fireEvent.click(card);
    expect(await screen.findByText(/Sign-in has expired/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Reconnect$/i }).length).toBeGreaterThan(0);
  });

  it('state 7 — no ready-made sign-in: says what to supply, and asks for it rather than a dead Connect', async () => {
    const calls = mockFetch({ one: VERCEL_FULL, connect: { ok: false, needsCredentials: true, fields: VERCEL_FULL.needs } });
    draw();
    await openCard('Vercel');
    // Told BEFORE clicking anything.
    expect(await screen.findByText(/no ready-made sign-in/i)).toBeInTheDocument();
    expect(screen.getByText(/bearer token/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Set up with your own key/i }));
    const box = await screen.findByLabelText(/Bearer token/i);
    expect(box).toHaveAttribute('type', 'password'); // a secret is never typed in the clear
    // Nothing typed yet, so there is nothing to send.
    expect(screen.getByRole('button', { name: /^Connect$/i })).toBeDisabled();

    fireEvent.change(box, { target: { value: 'tok_123' } });
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/connect') && c.body?.credentials?.bearer_token === 'tok_123')).toBe(true));
  });

  it('state 8 — the service is down: says which, keeps the door open, and never claims the data is gone', async () => {
    mockFetch({ list: { status: { configured: true, reachable: false, message: 'It did not answer in time.' }, services: [], categories: [], connectedCount: 0 } });
    draw();
    expect(await screen.findByText(/cannot reach the tools service/i)).toBeInTheDocument();
    expect(screen.getByText(/It did not answer in time\./)).toBeInTheDocument();
    expect(screen.getByText(/connected services keep working/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('a service needing no sign-in says it is ready, and is never offered a Connect button', async () => {
    mockFetch({ one: HN });
    draw();
    await openCard('Hacker News');
    const panel = within(await screen.findByRole('dialog'));
    expect(panel.getByText(/No sign-in needed/i)).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /^Connect$/i })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /Set up/i })).not.toBeInTheDocument();
  });

  it('disconnecting confirms first, and only then asks the server', async () => {
    const calls = mockFetch({ one: SLACK });
    draw();
    await openCard('Slack');
    fireEvent.click(await screen.findByLabelText(/Disconnect our slack/i));
    expect(await screen.findByText(/Disconnect this account\?/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false); // nothing has happened yet

    fireEvent.click(screen.getByRole('button', { name: /^Disconnect$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/connections/ca_x'))).toBe(true));
  });

  it('renaming an account saves the owner’s own name for it', async () => {
    const calls = mockFetch({ one: GITHUB });
    draw();
    await openCard('GitHub');
    fireEvent.click(await screen.findByLabelText(/Rename work github/i));
    const box = screen.getByLabelText('Account name');
    fireEvent.change(box, { target: { value: 'the work one' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.body?.label === 'the work one')).toBe(true));
  });

  it('a one-click connect sends the owner off and then waits, rather than sticking on “connecting”', async () => {
    mockFetch({ one: { ...GITHUB, accounts: [] }, connect: { ok: true, redirectUrl: 'https://connect.example/link/lk_1', connectionId: 'ca_new', status: 'INITIALIZING' } });
    (window as any).open = vi.fn(() => ({ location: { href: '' }, close: vi.fn() }));
    draw();
    await openCard('GitHub');
    fireEvent.click(await screen.findByRole('button', { name: /^Connect$/i }));
    expect(await screen.findByText(/Waiting for you to finish signing in/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop waiting/i })).toBeInTheDocument();
    // The tab is opened on the click itself, before the request — a pop-up blocker would eat it otherwise.
    expect((window as any).open).toHaveBeenCalled();
    // …and with NO feature string: real browsers return null from window.open when `noopener` or
    // `noreferrer` is passed, which would strand a blank tab and break every one-click sign-in.
    const feats = (window as any).open.mock.calls[0][2];
    expect(feats === undefined || !/noopener|noreferrer/.test(String(feats))).toBe(true);
  });

  it('a request that never lands is an honest failure, not an empty page', async () => {
    mockFetch({ listFails: true });
    draw();
    expect(await screen.findByText(/could not load your tools/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing has changed/i)).toBeInTheDocument();
  });
});
