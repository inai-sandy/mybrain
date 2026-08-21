import { readFileSync } from 'fs';
import { join } from 'path';
import { GATED_TOOLS, generateWhatsAppActions, WhatsAppProvider } from './whatsapp.provider';
import { SERVICE_TOOL_ID_RE } from './service-provider';
import { ServiceActionsService } from './service-actions.service';
import { ServiceGatesService, GatePause } from './service-gates.service';
import { SocialService } from '../social/social.service';

/**
 * BEA-1384 — WhatsApp (our gateway's MCP) as the THIRD ServiceProvider.
 *
 * The fixture is the live server's `tools/list` answer (2026-08-21, 16 tools). Nothing in these
 * tests reaches the network: `useTools()` seeds the list, `fetch` is stubbed where a call is the
 * thing under test. The locking points from the issue: the provider registers all its tools, the
 * gating map holds (EVERY send + delete_template gated, every read free), a missing token is an
 * honest not-configured state, and one mocked end-to-end run goes through the ONE recorded call
 * site (`ServiceActionsService.runDetailed`) — a read runs, a send pauses at the gate.
 */
const TOOLS = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'whatsapp-mcp-tools.json'), 'utf8'));

const SENDS = ['send_template', 'send_text', 'send_list', 'send_rfq'];
const READS = ['get_conversation', 'list_messages', 'check_replies', 'broadcast_status', 'get_stats', 'list_numbers', 'list_broadcasts', 'list_categories', 'list_templates'];

function provider(tools: any[] = TOOLS): WhatsAppProvider {
  const p = new WhatsAppProvider();
  p.useTools(tools);
  return p;
}

/** One SSE answer the way the gateway sends it (stateless streamable HTTP). */
const sseResponse = (payload: any) => ({
  ok: true,
  status: 200,
  text: async () => `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
});

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.WHATSAPP_MCP_TOKEN;
});

describe('generation from tools/list — every tool, nothing hand-written (BEA-1384)', () => {
  const actions = generateWhatsAppActions(TOOLS);

  it('yields exactly one action per tool — the live server had 16', () => {
    expect(TOOLS.length).toBe(16);
    expect(actions.length).toBe(TOOLS.length);
  });

  it('every id has the one shape, is unique, and never names the vendor', () => {
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(SERVICE_TOOL_ID_RE);
      expect(id.startsWith('svc:whatsapp.')).toBe(true);
      expect(id).not.toContain('postbox');
    }
  });

  it('the gating map: EVERY send and delete_template are risky; every read and the undoable writes are not', () => {
    const byName = new Map(actions.map((a) => [a.id.split('.')[1], a]));
    for (const name of [...SENDS, 'delete_template']) {
      expect(byName.get(name)?.risky).toBe(true);
    }
    for (const name of [...READS, 'create_template', 'generate_pdf']) {
      expect(byName.get(name)?.risky).toBe(false);
    }
    // The hand-kept set matches what the fixture holds — a send the set does not know would ship ungated.
    for (const g of GATED_TOOLS) expect(byName.has(g)).toBe(true);
  });

  it('a new delete_* tool on the gateway is gated by the name rule before the hand list learns it', () => {
    const [a] = generateWhatsAppActions([{ name: 'delete_broadcast', description: '', inputSchema: { type: 'object' } }]);
    expect(a.risky).toBe(true);
  });

  it('reads carry method GET (so the builder can sample broadcast_status and get_stats); the rest POST', () => {
    const byName = new Map(actions.map((a) => [a.id.split('.')[1], a]));
    for (const name of READS) expect(byName.get(name)?.method).toBe('GET');
    for (const name of [...SENDS, 'create_template', 'delete_template', 'generate_pdf']) expect(byName.get(name)?.method).toBe('POST');
  });

  it('argument schemas ride through from the server', () => {
    const send = actions.find((a) => a.id === 'svc:whatsapp.send_text')!;
    expect(Object.keys(send.schema.properties)).toEqual(expect.arrayContaining(['to', 'body']));
  });
});

describe('honest not-configured state (no token)', () => {
  it('status says not configured, connectedOnly lists nothing, and execute refuses without a network call', async () => {
    const p = provider();
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const s = await p.status();
    expect(s.configured).toBe(false);
    expect(s.reachable).toBe(false);
    expect(s.message).toMatch(/token/i);

    expect(await p.listServices({ connectedOnly: true })).toEqual([]);
    // Browsable, honestly marked not connected — never a fake success.
    const [info] = await p.listServices();
    expect(info.connected).toBe(false);
    expect(info.accounts).toEqual([]);

    const r = await p.execute('svc:whatsapp.list_templates', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not set up/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ownership and execution', () => {
  it('owns every svc:whatsapp.* id and nothing else — the general provider blocks the service, so this must catch the unknowns too', () => {
    const p = provider();
    expect(p.owns('svc:whatsapp.send_text')).toBe(true);
    expect(p.owns('svc:whatsapp.some_future_tool')).toBe(true);
    expect(p.owns('svc:github.create_issue')).toBe(false);
    expect(p.owns('whatsapp')).toBe(false);
  });

  it('execute parses the SSE answer back to the tool\'s own JSON', async () => {
    process.env.WHATSAPP_MCP_TOKEN = 'tm_test';
    const p = provider();
    global.fetch = jest.fn(async () =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify([{ label: 'My Brain reminders' }]) }] } }),
    ) as any;
    const r = await p.execute('svc:whatsapp.list_numbers', {});
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([{ label: 'My Brain reminders' }]);
    expect(r.credits).toBeUndefined(); // the gateway does not meter — never a phantom cost
    // The token travels in the header and never in anything readable.
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer tm_test');
  });

  it('a send the gateway reports as failed FAILS the step with Meta\'s real reason — never a quiet success', async () => {
    process.env.WHATSAPP_MCP_TOKEN = 'tm_test';
    const p = provider();
    const verdict = { status: 'failed', error: 'Re-engagement message: outside the 24h window' };
    global.fetch = jest.fn(async () =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(verdict) }] } }),
    ) as any;
    const r = await p.execute('svc:whatsapp.send_text', { to: '919885698665', body: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/24h window/);
    expect(r.data).toEqual(verdict);
  });

  it('an MCP isError answer is a plain failure with the tool\'s own sentence', async () => {
    process.env.WHATSAPP_MCP_TOKEN = 'tm_test';
    const p = provider();
    global.fetch = jest.fn(async () =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Template "x" is not APPROVED.' }] } }),
    ) as any;
    const r = await p.execute('svc:whatsapp.send_template', { to: '919885698665', template: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not APPROVED');
  });

  it('a 401 never echoes the token', async () => {
    process.env.WHATSAPP_MCP_TOKEN = 'tm_secret_value';
    const p = provider();
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => '{}' })) as any;
    const r = await p.execute('svc:whatsapp.list_numbers', {});
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('tm_secret_value');
    expect(r.error).toMatch(/rejected the server token/i);
  });
});

// ---- the ONE recorded call site: runDetailed routes here, records, and gates the sends ----------

describe('end-to-end through ServiceActionsService (mocked network)', () => {
  const prismaStub = () => {
    const rows: any[] = [];
    return {
      rows,
      toolCall: { create: jest.fn(async ({ data }: any) => rows.push(data)) },
      serviceGate: { findFirst: jest.fn(async () => null), create: jest.fn(async () => undefined), update: jest.fn(async () => undefined) },
    } as any;
  };
  const composioStub = () => ({ getService: jest.fn(async () => null), execute: jest.fn() }) as any;
  const llmStub = () => ({ completeHelper: jest.fn(async () => '{}') }) as any;

  function harness() {
    process.env.WHATSAPP_MCP_TOKEN = 'tm_test';
    const wa = provider();
    const prisma = prismaStub();
    const gates = new ServiceGatesService(prisma, undefined, wa);
    const actions = new ServiceActionsService(composioStub(), llmStub(), prisma, gates, undefined, wa);
    return { wa, prisma, actions };
  }

  it('a read runs ungated through runDetailed and writes the ToolCall row', async () => {
    const { prisma, actions } = harness();
    global.fetch = jest.fn(async () =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ templates: [] }) }] } }),
    ) as any;
    const r = await actions.runDetailed('svc:whatsapp.list_templates', '', { runKind: 'agent', runId: 'run1', nodeId: 'n1', args: {}, argsPinned: true });
    expect(r.ok).toBe(true);
    expect(r.serviceName).toBe('WhatsApp');
    expect(prisma.rows.length).toBe(1);
    expect(prisma.rows[0]).toMatchObject({ service: 'whatsapp', action: 'svc:whatsapp.list_templates', ok: true, gated: false, credits: null });
  });

  it('a send stops at the can\'t-undo gate: GatePause thrown, the held row written, nothing sent', async () => {
    const { prisma, actions } = harness();
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    await expect(
      actions.runDetailed('svc:whatsapp.send_text', '', { runKind: 'agent', runId: 'run1', nodeId: 'n1', args: { to: '919885698665', body: 'hello' }, argsPinned: true }),
    ).rejects.toBeInstanceOf(GatePause);
    expect(fetchSpy).not.toHaveBeenCalled(); // the message never left the building
    expect(prisma.rows.length).toBe(1);
    expect(prisma.rows[0]).toMatchObject({ service: 'whatsapp', action: 'svc:whatsapp.send_text', ok: false, gated: true });
  });

  it('every one of the five gated actions pauses; every read does not', async () => {
    const { actions } = harness();
    global.fetch = jest.fn(async () =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }),
    ) as any;
    for (const name of [...SENDS, 'delete_template']) {
      await expect(
        actions.runDetailed(`svc:whatsapp.${name}`, '', { runKind: 'agent', runId: 'r', nodeId: name, args: { to: 'x', name: 'x', template: 'x', category: 'x', summary: 'x', body: 'x', rows: [], items: [{ component: 'x', quantity: 1 }] }, argsPinned: true }),
      ).rejects.toBeInstanceOf(GatePause);
    }
    for (const name of READS) {
      const r = await actions.runDetailed(`svc:whatsapp.${name}`, '', { runKind: 'agent', runId: 'r', nodeId: name, args: { number: 'x', since: 'x', broadcastId: 'x' }, argsPinned: true });
      expect(r.ok).toBe(true);
    }
  });
});

// ---- the Social page: the WhatsApp platform, and a gated run answered ---------------------------

describe('SocialService with the WhatsApp provider (BEA-1384)', () => {
  const scStub = () => ({
    owns: jest.fn(async () => false),
    getAction: jest.fn(async () => null),
    status: jest.fn(async () => ({ configured: false, reachable: false })),
    listServices: jest.fn(async () => []),
    reload: jest.fn(async () => undefined),
    creditBalance: jest.fn(async () => 0),
    specState: jest.fn(() => ({ source: 'none', opCount: 0, platformCount: 0 })),
  }) as any;

  function harness() {
    process.env.WHATSAPP_MCP_TOKEN = 'tm_test';
    const wa = provider();
    // A stateful ServiceGate stub: a recorded approval is found again by the re-run, exactly as
    // the real table behaves — that is the whole approve-then-run contract.
    const gateRows: any[] = [];
    const prisma = {
      toolCall: { create: jest.fn(async () => undefined), aggregate: jest.fn(async () => ({ _sum: { credits: 0 } })) },
      serviceGate: {
        findFirst: jest.fn(async ({ where }: any) =>
          gateRows.find((r) => Object.entries(where || {}).every(([k, v]) => (k === 'usedAt' ? r.usedAt === v : r[k] === v))) || null,
        ),
        create: jest.fn(async ({ data }: any) => { const row = { id: `g${gateRows.length + 1}`, usedAt: null, ...data }; gateRows.push(row); return row; }),
        update: jest.fn(async ({ where, data }: any) => { const row = gateRows.find((r) => r.id === where.id); if (row) Object.assign(row, data); return row; }),
      },
      setting: { findUnique: jest.fn(async () => null) },
    } as any;
    const gates = new ServiceGatesService(prisma, undefined, wa);
    const actions = new ServiceActionsService(composioNull(), llmNull(), prisma, gates, undefined, wa);
    const social = new SocialService(scStub(), actions, prisma, wa);
    return { wa, social };
  }
  const composioNull = () => ({ getService: jest.fn(async () => null), execute: jest.fn() }) as any;
  const llmNull = () => ({ completeHelper: jest.fn(async () => '{}') }) as any;

  it('the overview grid carries the WhatsApp tile — unmetered, with its own connected state', async () => {
    const { social } = harness();
    const o = await social.overview();
    const wa = o.platforms.find((p) => p.slug === 'whatsapp');
    expect(wa).toBeTruthy();
    expect(wa!.metered).toBe(false);
    expect(wa!.connected).toBe(true);
    expect(wa!.actionCount).toBe(16);
  });

  it('the platform page answers WhatsApp\'s own actions and its own connection state', async () => {
    const { social } = harness();
    const page = await social.platform('whatsapp');
    expect(page).toBeTruthy();
    expect(page!.actions.length).toBe(16);
    expect(page!.connection?.configured).toBe(true);
    expect(page!.platform.metered).toBe(false);
  });

  it('running a gated send answers a GATE (a question), and a no records the refusal and sends nothing', async () => {
    const { social } = harness();
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const r = await social.run('svc:whatsapp.send_text', { to: '919885698665', body: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBeTruthy();
    expect(r.gate!.actionId).toBe('svc:whatsapp.send_text');
    expect(r.gate!.runId).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();

    const no = await social.answerGate(r.gate!, 'no');
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/nothing was done/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a yes re-runs the step with the EXACT approved arguments and the send goes out once', async () => {
    const { social } = harness();
    const noCall = jest.fn();
    global.fetch = noCall as any;
    const r = await social.run('svc:whatsapp.send_text', { to: '919885698665', body: 'hello' });
    expect(r.gate).toBeTruthy();
    expect(noCall).not.toHaveBeenCalled();

    const sent: any = jest.fn(async () =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'sent', id: 'm1' }) }] } }),
    );
    global.fetch = sent;
    const yes = await social.answerGate(r.gate!, 'yes');
    expect(yes.ok).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    const body = JSON.parse(sent.mock.calls[0][1].body);
    expect(body.params).toEqual({ name: 'send_text', arguments: { to: '919885698665', body: 'hello' } });
  });

  it('running a read answers data immediately, no gate', async () => {
    const { social } = harness();
    global.fetch = jest.fn(async () =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ total: 0, items: [] }) }] } }),
    ) as any;
    const r = await social.run('svc:whatsapp.get_conversation', { number: '919885698665' });
    expect(r.ok).toBe(true);
    expect(r.gate).toBeUndefined();
  });
});
