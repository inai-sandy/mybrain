import { ChatService } from './chat.service';
import { ChatToolsService } from './chat-tools.service';
import { ServiceActionsService } from '../tools/service-actions.service';
import { ServiceGatesService } from '../tools/service-gates.service';

/**
 * BEA-1349 — Chat can use the services the owner has connected.
 *
 * Everything underneath is already locked down by BEA-1347 and BEA-1348, so these tests are about
 * the join, and about the four promises that are easy to break from here:
 *
 *  1. **With nothing connected, Chat is byte-for-byte the chat it was.** No extra model call, no
 *     mention of tools, no new failure. This is the screen the owner is on every day.
 *  2. A real action runs — and leaves a `ToolCall` row, exactly like an agent run.
 *  3. A gated action shows an inline confirm and sends NOTHING until he taps; a tap on Run then
 *     re-runs the *approved* arguments rather than asking a model to fill them in again.
 *  4. A failure reaches him in the service's own words, never as an apology or an invented success.
 *
 * The gate and the runner used here are the REAL ones (with a fake provider underneath), because a
 * stubbed gate would prove nothing about the thing this issue is riskiest in.
 */

const CREATE = {
  id: 'svc:github.create_an_issue',
  name: 'Create an issue',
  description: 'Creates an issue in a repository.',
  service: 'github',
  risky: false,
  schema: { type: 'object', required: ['owner', 'repo', 'title'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } } },
};
const DELETE = {
  id: 'svc:github.delete_a_repository',
  name: 'Delete a repository',
  description: 'Deletes a repository.',
  service: 'github',
  risky: true,
  schema: { type: 'object', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
};

const CATALOG = [
  { id: CREATE.id, name: 'GitHub: Create an issue', group: 'Services', kind: 'tool', connected: true, description: 'Creates an issue in a repository.', service: 'github', risky: false },
  { id: DELETE.id, name: 'GitHub: Delete a repository', group: 'Services', kind: 'tool', connected: true, description: 'Deletes a repository.', service: 'github', risky: true },
] as any[];

/** A tiny stand-in for Prisma that only knows the tables this path touches. */
function db() {
  const messages: any[] = [];
  const toolCalls: any[] = [];
  const gates: any[] = [];
  const session = { id: 's1', scope: 'everything', summary: null, title: null, docId: null };
  let n = 0;
  const matches = (row: any, where: any) => Object.entries(where || {}).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
  return {
    messages, toolCalls, gates, session,
    prisma: {
      chatSession: { findUnique: async () => session, update: async () => ({}) },
      chatMessage: {
        findUnique: async ({ where }: any) => messages.find((m) => m.id === where.id) || null,
        findMany: async () => messages.slice(),
        create: async ({ data }: any) => { const row = { id: `m${++n}`, createdAt: new Date(), starred: false, ...data }; messages.push(row); return row; },
        update: async ({ where, data }: any) => { const m = messages.find((x) => x.id === where.id); Object.assign(m, data); return m; },
        // The conditional claim, with a real round trip in front of it: the two callers' reads
        // genuinely interleave, and only the matching WHERE decides who wins.
        updateMany: async ({ where, data }: any) => {
          await new Promise((r) => setImmediate(r));
          const m = messages.find((x) => x.id === where.id);
          if (!m) return { count: 0 };
          if (where.NOT?.gate?.contains && String(m.gate || '').includes(where.NOT.gate.contains)) return { count: 0 };
          Object.assign(m, data);
          return { count: 1 };
        },
      },
      item: { findUnique: async () => null, findFirst: async () => null },
      setting: { findUnique: async () => null, upsert: async () => ({}) },
      toolCall: { create: async ({ data }: any) => { toolCalls.push(data); return data; } },
      serviceGate: {
        findFirst: async ({ where }: any) => gates.filter((g) => matches(g, where)).pop() || null,
        findMany: async ({ where }: any) => gates.filter((g) => matches(g, where)),
        create: async ({ data }: any) => { const row = { id: `g${++n}`, createdAt: new Date(), usedAt: null, ...data }; gates.push(row); return row; },
        update: async ({ where, data }: any) => { const g = gates.find((x) => x.id === where.id); Object.assign(g, data); return g; },
        deleteMany: async () => ({}),
      },
    } as any,
  };
}

function harness(over: { connected?: any[]; service?: string | null; action?: string | null; result?: any } = {}) {
  const d = db();
  const provider: any = {
    getService: jest.fn(async () => ({ slug: 'github', name: 'GitHub', accounts: [{ id: 'ca_1', label: 'mybrain-owner', status: 'ACTIVE' }] })),
    getAction: jest.fn(async (id: string) => (id === DELETE.id ? DELETE : CREATE)),
    execute: jest.fn(async () => over.result ?? { ok: true, data: { number: 7, html_url: 'https://github.com/inai-sandy/mybrain/issues/7' }, ms: 120 }),
    refresh: jest.fn(),
    listActions: jest.fn(async () => []),
  };
  const llm: any = {
    completeWith: jest.fn(async (_cfg: any, _prompt: string, _max: number, label: string) => {
      if (label === 'chat-tools-service') return JSON.stringify({ service: over.service === undefined ? 'github' : over.service });
      if (label === 'chat-tools-action') return JSON.stringify({ action: over.action === undefined ? CREATE.id : over.action });
      if (label === 'chat-router') return '{"search":false,"query":""}';
      return 'All done.';
    }),
    completeHelper: jest.fn(async () => '{"owner":"inai-sandy","repo":"mybrain","title":"A bug"}'),
    complete: jest.fn(async () => 'INVENTED ANSWER'),
  };
  const memory: any = { searchScoped: jest.fn(async () => []), resolveRefs: jest.fn(async () => ({})) };
  const prompts: any = { get: jest.fn(async () => 'PROMPT') };
  const catalog: any = { connectedServiceTools: jest.fn(async () => (over.connected === undefined ? CATALOG : over.connected)) };

  const gatesSvc = new ServiceGatesService(d.prisma, provider);
  const actions = new ServiceActionsService(provider, llm, d.prisma, gatesSvc);
  const tools = new ChatToolsService(llm, prompts, catalog, actions, gatesSvc);
  const chat = new ChatService(d.prisma, memory, llm, prompts, tools);
  return { ...d, chat, tools, provider, llm, catalog, prompts, memory };
}

const promptFor = (llm: any, label: string) => (llm.completeWith.mock.calls.find((c: any[]) => c[3] === label) || [])[1] || '';

describe('Chat can use connected services (BEA-1349)', () => {
  it('changes NOTHING when no service is connected — no tool call, no extra model call, no mention of tools', async () => {
    const { chat, llm, provider, toolCalls } = harness({ connected: [] });
    const r = await chat.sendMessage('s1', 'Create a GitHub issue in inai-sandy/mybrain about the login button');

    // The picker never ran, so nothing was spent finding out there was nothing to find.
    const labels = llm.completeWith.mock.calls.map((c: any[]) => c[3]);
    expect(labels.filter((l: string) => l.startsWith('chat-tools'))).toHaveLength(0);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(toolCalls).toHaveLength(0);
    // The reply is the ordinary one: the model's answer, no chips, no card, nothing new.
    expect(r!.message.content).toBe('All done.');
    expect(r!.message.tools).toEqual([]);
    expect(r!.message.gate).toBeUndefined();
    // And the answer prompt is the one it always was.
    expect(promptFor(llm, 'chat')).not.toMatch(/connected services/i);
  });

  it('runs the action rather than describing it, and writes a ToolCall row like any agent run', async () => {
    const { chat, provider, toolCalls, llm, messages, memory } = harness();
    const r = await chat.sendMessage('s1', 'File a bug in inai-sandy/mybrain about the login button');

    expect(provider.execute).toHaveBeenCalledWith(CREATE.id, { owner: 'inai-sandy', repo: 'mybrain', title: 'A bug' }, { connectionId: 'ca_1' });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ ok: true, service: 'github', action: CREATE.id, runKind: 'chat', runId: 's1', accountId: 'ca_1' });
    // Keyed on the chat's own message, which is what makes an approval spendable exactly once.
    expect(toolCalls[0].nodeId).toBe(messages[0].id);

    // The reply names the service and the action, with what came back and a link.
    expect(r!.message.tools).toHaveLength(1);
    expect(r!.message.tools[0]).toMatchObject({ serviceName: 'GitHub', action: 'Create an issue', ok: true, link: 'https://github.com/inai-sandy/mybrain/issues/7' });
    expect(r!.message.tools[0].result).toBe('number: 7');
    // A turn a service answered does not also go rummaging in his notes for source chips.
    expect(memory.searchScoped).not.toHaveBeenCalled();
    expect(r!.message.sources).toEqual([]);
    // And the written reply is grounded in what really happened, not left to guess.
    expect(promptFor(llm, 'chat')).toContain('https://github.com/inai-sandy/mybrain/issues/7');
  });

  it('stops on an action that cannot be undone, sends nothing, and asks right there in the thread', async () => {
    const { chat, provider, toolCalls, messages } = harness({ action: DELETE.id });
    const r = await chat.sendMessage('s1', 'Delete the inai-sandy/mybrain repository');

    expect(provider.execute).not.toHaveBeenCalled();
    expect(r!.message.gate).toBeTruthy();
    expect(r!.message.gate.headline).toContain('Delete a repository on GitHub');
    expect(r!.message.gate.detail).toContain('inai-sandy');
    // His own message is one inch above the card — it is not read back to him inside it.
    expect(r!.message.gate.detail).not.toMatch(/why:/i);
    // Two buttons, from the one place that owns them — and no decision yet.
    expect(r!.message.gate.options).toHaveLength(2);
    expect(r!.message.gate.decision).toBeUndefined();
    // The raw arguments never leave the server — the browser gets the card, not the payload.
    expect((r!.message.gate as any).args).toBeUndefined();
    expect((r!.message.gate as any).input).toBeUndefined();
    // …but the server kept them, or the approved re-run would have nothing to run.
    expect(JSON.parse(messages[1].gate).args).toEqual({ owner: 'inai-sandy', repo: 'mybrain' });
    // The attempt is on the record even though nothing left the building.
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ ok: false, gated: true, runKind: 'chat' });
  });

  it('runs EXACTLY what he approved when he taps Run — the arguments are never filled again', async () => {
    const { chat, provider, llm, gates } = harness({ action: DELETE.id });
    const r = await chat.sendMessage('s1', 'Delete the inai-sandy/mybrain repository');
    const fills = llm.completeHelper.mock.calls.length;

    const done = await chat.answerGate(r!.message.id, 'yes');

    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(provider.execute).toHaveBeenCalledWith(DELETE.id, { owner: 'inai-sandy', repo: 'mybrain' }, { connectionId: 'ca_1' });
    // The whole point of an approval: no second guess between the question and the doing.
    expect(llm.completeHelper.mock.calls.length).toBe(fills);
    expect(gates.some((g: any) => g.decision === 'approved' && g.scope === 'once')).toBe(true);
    expect(done!.message.gate.decision).toBe('approved');
    expect(done!.message.tools[0]).toMatchObject({ ok: true, serviceName: 'GitHub', action: 'Delete a repository' });
  });

  it('runs nothing and says so when he taps Cancel', async () => {
    const { chat, provider, gates } = harness({ action: DELETE.id });
    const r = await chat.sendMessage('s1', 'Delete the inai-sandy/mybrain repository');

    const stopped = await chat.answerGate(r!.message.id, 'no');

    expect(provider.execute).not.toHaveBeenCalled();
    expect(stopped!.message.content).toMatch(/nothing was done/i);
    expect(stopped!.message.gate.decision).toBe('rejected');
    expect(gates.some((g: any) => g.decision === 'rejected')).toBe(true);
    // And it cannot be quietly answered again the other way.
    expect((await chat.answerGate(r!.message.id, 'yes'))!.error).toMatch(/already answered/i);
  });

  it('takes one answer only — a second tap on Run cannot run it twice', async () => {
    const { chat, provider } = harness({ action: DELETE.id });
    const r = await chat.sendMessage('s1', 'Delete the inai-sandy/mybrain repository');
    // Both taps land before either finishes — the claim is written before anything runs, so the
    // second one finds the card already taken.
    const [a, b] = await Promise.all([chat.answerGate(r!.message.id, 'yes'), chat.answerGate(r!.message.id, 'yes')]);
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect([a!.error, b!.error].filter(Boolean)).toHaveLength(1);
  });

  it('shows the service\'s real reason when it refuses — never an apology or an invented success', async () => {
    const error = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}';
    const { chat, toolCalls, llm } = harness({ result: { ok: false, error, ms: 90 } });
    const r = await chat.sendMessage('s1', 'File a bug in inai-sandy/mybrain about the login button');

    expect(r!.message.content).toContain('Not Found (404)');
    expect(r!.message.content).not.toContain('documentation_url');
    expect(r!.message.tools[0]).toMatchObject({ ok: false });
    expect(r!.message.tools[0].error).toContain('Not Found');
    expect(toolCalls[0].ok).toBe(false);
    // No model was asked to write up a failure — that is how a refusal becomes a polite fiction.
    expect(llm.completeWith.mock.calls.some((c: any[]) => c[3] === 'chat')).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('never makes him wait on a slow catalog — the turn carries on without tools', async () => {
    const { chat, tools, catalog, provider, llm } = harness();
    // A key set and an outside service that is not answering: the catalog itself takes as long as
    // it takes, and the chat message must not.
    catalog.connectedServiceTools.mockImplementation(() => new Promise(() => undefined));
    (tools as any).known = null;

    const started = Date.now();
    const r = await chat.sendMessage('s1', 'File a bug in inai-sandy/mybrain about the login button');

    expect(Date.now() - started).toBeLessThan(4000);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(llm.completeWith.mock.calls.some((c: any[]) => c[3].startsWith('chat-tools'))).toBe(false);
    expect(r!.message.content).toBe('All done.');
  });

  it('never runs an action the owner does not actually have', async () => {
    const { chat, provider, toolCalls } = harness({ action: 'svc:github.launch_the_missiles' });
    const r = await chat.sendMessage('s1', 'Do the thing');
    expect(provider.execute).not.toHaveBeenCalled();
    expect(toolCalls).toHaveLength(0);
    expect(r!.message.tools).toEqual([]);
  });

  /**
   * The catalog holds EVERY action of a service now (BEA-1354, GitHub ~800). The second pick prompt
   * must not paste them all: it carries the best keyword matches for his words, capped at 60 — and
   * the one he is asking for is on it even when it sits at the far end of the list.
   */
  it('shows the second pick a keyword-ranked slice of a huge service, never all of it', async () => {
    const filler = Array.from({ length: 800 }, (_, i) => ({
      id: `svc:github.thing_${i}`, name: `GitHub: Thing ${i}`, group: 'Services', kind: 'tool', connected: true, description: `Does thing number ${i}.`, service: 'github', risky: false,
    }));
    const { chat, llm } = harness({ connected: [...filler, ...CATALOG] });
    await chat.sendMessage('s1', 'Create an issue in inai-sandy/mybrain called "A bug"');
    const prompt = promptFor(llm, 'chat-tools-action');
    const lines = prompt.split('\n').filter((l: string) => l.startsWith('- svc:github.'));
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines[0]).toContain(CREATE.id); // the best match for his words is first, not 800th
    expect(prompt).not.toContain('svc:github.thing_799');
  });

  it('leaves an ordinary message alone even with a service connected', async () => {
    const { chat, provider, llm, toolCalls } = harness({ service: null });
    const r = await chat.sendMessage('s1', 'What did I save about pricing last week?');

    // It asked whether this was a job for a service, was told no, and stopped there.
    expect(llm.completeWith.mock.calls.some((c: any[]) => c[3] === 'chat-tools-service')).toBe(true);
    expect(llm.completeWith.mock.calls.some((c: any[]) => c[3] === 'chat-tools-action')).toBe(false);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(toolCalls).toHaveLength(0);
    expect(r!.message.content).toBe('All done.');
  });
});
