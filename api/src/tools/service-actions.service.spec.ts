import { readFileSync } from 'fs';
import { join } from 'path';
import { ServiceActionsService } from './service-actions.service';
import { LlmService } from '../llm/llm.service';

/**
 * BEA-1347 — running a connected service's action, with NO engine turn, and every attempt logged.
 *
 * The three properties worth locking down:
 *  1. nothing here ever returns a description of what it would have done — every road but a real
 *     success throws, because a returned string falls through to a plain model call upstream;
 *  2. a `ToolCall` row exists for every attempt, success or failure, including the ones that never
 *     left the building;
 *  3. exactly ONE small model call, and only when there is something to fill in.
 */

const ACTION = {
  id: 'svc:github.create_an_issue',
  name: 'Create an issue',
  description: 'Creates an issue in a repository.',
  service: 'github',
  risky: false,
  schema: {
    type: 'object',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
  },
};

const ONE_ACCOUNT = [{ id: 'ca_1', label: 'sandy on GitHub', status: 'ACTIVE' }];

function harness(over: any = {}) {
  const rows: any[] = [];
  const prisma: any = { toolCall: { create: async ({ data }: any) => { rows.push(data); return data; } } };
  const provider: any = {
    getService: jest.fn(async () => (over.info === undefined ? { slug: 'github', name: 'GitHub', accounts: ONE_ACCOUNT } : over.info)),
    getAction: jest.fn(async () => (over.action === undefined ? ACTION : over.action)),
    execute: jest.fn(async () => (over.result === undefined ? { ok: true, data: { number: 7, html_url: 'https://github.com/x/y/issues/7' }, ms: 120 } : over.result)),
    refresh: jest.fn(),
  };
  const llm: any = {
    completeHelper: jest.fn(async () => (over.llmText === undefined ? '{"owner":"inai-sandy","repo":"mybrain","title":"A bug"}' : over.llmText)),
    complete: jest.fn(async () => 'INVENTED ANSWER FROM THE GENERAL MODEL'),
  };
  return { svc: new ServiceActionsService(provider, llm, prisma), rows, provider, llm };
}

describe('an outside-service action runs for real, and is written down (BEA-1347)', () => {
  it('runs the action and returns what actually came back', async () => {
    const { svc, provider, rows } = harness();
    const out = await svc.run('svc:github.create_an_issue', 'File a bug about the login button', { runId: 'run1', runKind: 'flow', nodeId: 'n3' });

    expect(provider.execute).toHaveBeenCalledWith('svc:github.create_an_issue', { owner: 'inai-sandy', repo: 'mybrain', title: 'A bug' }, { connectionId: 'ca_1' });
    expect(out).toContain('GitHub: Create an issue');
    expect(out).toContain('https://github.com/x/y/issues/7');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, service: 'github', action: 'svc:github.create_an_issue', runId: 'run1', runKind: 'flow', nodeId: 'n3', accountId: 'ca_1', ms: 120 });
    expect(JSON.parse(rows[0].arguments)).toEqual({ owner: 'inai-sandy', repo: 'mybrain', title: 'A bug' });
  });

  it('writes a failed row and throws the provider\'s real reason — never a model answer', async () => {
    // Shaped like a real refusal: GitHub's 404 arrives as the far end's own JSON payload, and the
    // owner should read the reason inside it, not the brackets around it.
    const error = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}';
    const { svc, rows, llm } = harness({ result: { ok: false, error, ms: 90 } });
    const err = await svc.run('svc:github.create_an_issue', 'file it', {}).catch((e) => e);
    expect(String(err.message)).toContain('Not Found (404)');
    expect(String(err.message)).not.toContain('documentation_url');
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error).toContain('Not Found');
    // The whole point: no quiet hop to a model that would describe the issue it did not create.
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('says "connect github first", with somewhere to go, when nothing is connected', async () => {
    const { svc, provider, rows } = harness({ info: { slug: 'github', name: 'GitHub', accounts: [] } });
    await expect(svc.run('svc:github.create_an_issue', 'file it', {})).rejects.toThrow(/connect github first/i);
    await expect(svc.run('svc:github.create_an_issue', 'file it', {})).rejects.toThrow(/\/tools/);
    expect(provider.execute).not.toHaveBeenCalled();
    // A connection made a moment ago can sit behind the provider's read cache — ask again before
    // telling the owner to connect something he just connected.
    expect(provider.refresh).toHaveBeenCalled();
    expect(rows.every((r) => r.ok === false)).toBe(true);
  });

  it('stops when a login was started but never finished, and says which', async () => {
    const { svc, provider } = harness({ info: { slug: 'github', name: 'GitHub', accounts: [{ id: 'ca_x', label: 'work github', status: 'INITIALIZING' }] } });
    await expect(svc.run('svc:github.create_an_issue', 'file it', {})).rejects.toThrow(/work github.*INITIALIZING/i);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('refuses to guess between two accounts, and names them the way the owner named them', async () => {
    const accounts = [
      { id: 'ca_aaa111', label: 'personal github', status: 'ACTIVE' },
      { id: 'ca_bbb222', label: 'work github', status: 'ACTIVE' },
    ];
    const { svc, provider, rows } = harness({ info: { slug: 'github', name: 'GitHub', accounts } });
    const err = await svc.run('svc:github.create_an_issue', 'file it', {}).catch((e) => e);
    expect(String(err.message)).toContain('personal github');
    expect(String(err.message)).toContain('work github');
    // The raw id means nothing to anybody, and is not what the owner can answer with.
    expect(String(err.message)).not.toContain('ca_aaa111');
    expect(provider.execute).not.toHaveBeenCalled();
    expect(rows[0].ok).toBe(false);
  });

  it('uses the account the step was configured with, by the owner\'s own name for it', async () => {
    const accounts = [
      { id: 'ca_aaa111', label: 'personal github', status: 'ACTIVE' },
      { id: 'ca_bbb222', label: 'work github', status: 'ACTIVE' },
    ];
    const { svc, provider } = harness({ info: { slug: 'github', name: 'GitHub', accounts } });
    await svc.run('svc:github.create_an_issue', 'file it', { accountId: 'work github' });
    expect(provider.execute).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { connectionId: 'ca_bbb222' });
  });
});

describe('the arguments are filled from the action\'s own schema, in ONE small call (BEA-1347)', () => {
  it('asks a NAMED helper, not the app\'s general model', async () => {
    const { svc, llm } = harness();
    await svc.run('svc:github.create_an_issue', 'file a bug', {});
    expect(llm.completeHelper).toHaveBeenCalledTimes(1);
    expect(llm.completeHelper.mock.calls[0][0]).toBe('service-args');
    // Small and capped — the point of this path is that it costs no engine turn.
    expect(llm.completeHelper.mock.calls[0][2]).toBeLessThanOrEqual(1000);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('shows the model the real fields, and keeps only fields the schema knows', async () => {
    const { svc, llm, provider } = harness({ llmText: '```json\n{"owner":"a","repo":"b","title":"c","sudo":true}\n```' });
    await svc.run('svc:github.create_an_issue', 'file a bug', {});
    const prompt = llm.completeHelper.mock.calls[0][1];
    expect(prompt).toContain('owner (string, REQUIRED)');
    expect(prompt).toContain('Issue title');
    expect(prompt).toContain('file a bug');
    // A field the action never offered is dropped rather than sent on.
    expect(provider.execute.mock.calls[0][1]).toEqual({ owner: 'a', repo: 'b', title: 'c' });
  });

  it('makes no model call at all when the action takes no arguments', async () => {
    const action = { ...ACTION, name: 'Get the authenticated user', schema: { type: 'object', properties: {} } };
    const { svc, llm, provider } = harness({ action });
    await svc.run('svc:github.get_the_authenticated_user', 'who am i', {});
    expect(llm.completeHelper).not.toHaveBeenCalled();
    expect(provider.execute.mock.calls[0][1]).toEqual({});
  });

  it('makes no model call when the owner pinned the arguments on the step', async () => {
    const { svc, llm, provider } = harness();
    await svc.run('svc:github.create_an_issue', '', { args: { owner: 'o', repo: 'r', title: 't' } });
    expect(llm.completeHelper).not.toHaveBeenCalled();
    expect(provider.execute.mock.calls[0][1]).toEqual({ owner: 'o', repo: 'r', title: 't' });
  });

  it('stops rather than run an action with a required field missing', async () => {
    const { svc, provider, rows } = harness({ llmText: '{"owner":"a","repo":"b"}' });
    await expect(svc.run('svc:github.create_an_issue', 'file it', {})).rejects.toThrow(/title/);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(rows[0].ok).toBe(false);
  });

  it('stops rather than invent details when the model answers with nothing', async () => {
    const { svc, provider, rows } = harness({ llmText: null });
    await expect(svc.run('svc:github.create_an_issue', 'file it', {})).rejects.toThrow(/could not be worked out/i);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(rows[0].ok).toBe(false);
  });

  it('masks anything that looks like a secret before writing the arguments down', async () => {
    const action = {
      ...ACTION,
      name: 'Create a secret',
      schema: { type: 'object', required: [], properties: { name: { type: 'string' }, encrypted_value: { type: 'string' }, api_key: { type: 'string' } } },
    };
    const { svc, rows } = harness({ action, llmText: '{"name":"DEPLOY","api_key":"sk-live-123"}' });
    await svc.run('svc:github.create_a_secret', 'x', {});
    expect(rows[0].arguments).toContain('DEPLOY');
    expect(rows[0].arguments).not.toContain('sk-live-123');
  });
});

describe('the model that fills service arguments is a named, changeable one (BEA-1248)', () => {
  it('is registered, so Settings can point it somewhere', () => {
    expect(LlmService.HELPERS['service-args']).toBeTruthy();
  });

  it('has a card in Settings — a registered key the owner cannot reach is half a fix', () => {
    const settings = readFileSync(join(__dirname, '../../../web/src/pages/Settings.tsx'), 'utf8');
    expect(settings).toContain('/api/llm-config/helper/service-args');
  });

  it('never reaches the app\'s loose general model', () => {
    const src = readFileSync(join(__dirname, 'service-actions.service.ts'), 'utf8');
    expect(src).not.toMatch(/this\.llm\.complete\(/);
    expect(src).toContain("completeHelper?.('service-args'");
  });
});

describe('runDetailed — the same run, answered as a shape (BEA-1356)', () => {
  it('a success carries the provider\'s whole answer, the cost and the ms; the row is written once', async () => {
    const { svc, rows, provider } = harness({ result: { ok: true, data: { success: true, credits_charged: 2, posts: [1, 2] }, ms: 80, credits: 2 } });
    const r = await svc.runDetailed('svc:github.create_an_issue', 'x', { args: { owner: 'a', repo: 'b', title: 'c' }, argsPinned: true, runKind: 'social' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ success: true, credits_charged: 2, posts: [1, 2] });
    expect(r.credits).toBe(2);
    expect(r.ms).toBe(80);
    expect(r.text).toContain('GitHub: Create an issue');
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, credits: 2, runKind: 'social' });
  });

  it('a failure is returned (not thrown), with the status so a screen can tell 402 apart; run() still throws', async () => {
    const a = harness({ result: { ok: false, error: 'The account is out of credits.', ms: 30, credits: 0, status: 402 } });
    const r = await a.svc.runDetailed('svc:github.create_an_issue', 'x', { args: { owner: 'a', repo: 'b', title: 'c' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(402);
    expect(r.outOfCredits).toBe(true);
    expect(r.error).toContain('out of credits');
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].ok).toBe(false);

    const b = harness({ result: { ok: false, error: 'nope', status: 500 } });
    await expect(b.svc.run('svc:github.create_an_issue', 'x', { args: { owner: 'a', repo: 'b', title: 'c' } })).rejects.toThrow(/nope/);
  });

  it('argsPinned with nothing filled in never calls the model', async () => {
    const { svc, llm, provider } = harness({ action: { ...ACTION, schema: { type: 'object', properties: { q: { type: 'string' } } } } });
    const r = await svc.runDetailed('svc:github.create_an_issue', 'x', { args: {}, argsPinned: true });
    expect(r.ok).toBe(true);
    expect(llm.completeHelper).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledWith('svc:github.create_an_issue', {}, { connectionId: 'ca_1' });
  });
});
