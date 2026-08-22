import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { makeWorld } from './worker-harness.testing';

/**
 * The worker runner, over real HTTP, on this machine (BEA-1389, agent workers 4/10).
 *
 * Nothing here is mocked away from the two things the piece is: `services/host/worker-runner.server.js`
 * really runs as its own process and really spawns a worker, and the worker really calls back into
 * the REAL `WorkerController` with a REAL token minted by the REAL `WorkerTokenService` — served over
 * a real HTTP listener, because "the routes are mounted where the caller looks for them" is exactly
 * the class of bug an in-process test cannot see.
 *
 * The `worker.mjs` files below are hand-written fixtures for this suite alone. Nothing generates a
 * worker yet — that is piece 5 — and none of this is production code.
 */

const RUNNER = path.join(__dirname, '..', '..', '..', 'services', 'host', 'worker-runner.server.js');
const KIT = path.join(__dirname, 'kit', 'kit.js');

const JOB = { id: 'job1', name: 'Fixture job', tools: [], toolArgs: {}, outputDest: 'document' };

// ---------------------------------------------------------------------------------------------
// The app: the real controller and the real token service behind a real listener.
// ---------------------------------------------------------------------------------------------
async function startApp() {
  const world = await makeWorld({ job: JOB, samples: [] });
  const server = http.createServer(async (req, res) => {
    const route = String(req.url || '').replace(/^\/api\/worker\//, '');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    const id = world.tokens.verify(String(req.headers['x-worker-token'] || ''));
    if (!id) { res.statusCode = 401; res.end(JSON.stringify({ error: 'This route is for a worker run, and needs its own run token.' })); return; }
    const handler = (world.controller as any)[route];
    if (typeof handler !== 'function') { res.statusCode = 404; res.end(JSON.stringify({ error: `no worker route "${route}"` })); return; }
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    try {
      // Identity comes off the token, never off the body — exactly as the guard does it.
      const answer = handler.length === 1
        ? await handler.call(world.controller, body)
        : await handler.call(world.controller, { worker: id }, body);
      res.end(JSON.stringify(answer ?? {}));
    } catch (e: any) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(e?.response?.message || e?.message || e) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { world, server, url: `http://127.0.0.1:${port}` };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// ---------------------------------------------------------------------------------------------
// The runner: the real file, as its own process, with the workers root pointed at a temp folder.
// ---------------------------------------------------------------------------------------------
async function startRunner(root: string, api: string, extraEnv: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [RUNNER], {
    env: {
      ...process.env,
      WORKER_RUNNER_HOST: '127.0.0.1',
      WORKER_RUNNER_PORT: String(port),
      WORKER_ROOT: root,
      WORKER_API: api,
      WORKER_KIT_VERSION: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  const until = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${url}/status`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error('the worker runner never came up');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, url, port };
}

/** Read an ndjson stream, keeping the moment each line arrived. */
async function ndjson(res: Response): Promise<{ line: any; at: number }[]> {
  const out: { line: any; at: number }[] = [];
  const reader = (res.body as any).getReader();
  const decode = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decode.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const s = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (s) out.push({ line: JSON.parse(s), at: Date.now() });
    }
  }
  if (buf.trim()) out.push({ line: JSON.parse(buf.trim()), at: Date.now() });
  return out;
}

/** One installed worker: `<root>/<jobId>/v1/{worker.mjs,meta.json,kit/kit.js}` + the `current` symlink. */
function install(root: string, jobId: string, source: string, meta: Record<string, any> = {}) {
  const dir = path.join(root, jobId, 'v1');
  fs.mkdirSync(path.join(dir, 'kit'), { recursive: true });
  fs.copyFileSync(KIT, path.join(dir, 'kit', 'kit.js'));
  fs.writeFileSync(path.join(dir, 'worker.mjs'), source);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ jobId, version: 1, kit: '1', builtBy: 'the BEA-1389 test', ...meta }));
  const link = path.join(root, jobId, 'current');
  try { fs.unlinkSync(link); } catch { /* first install */ }
  fs.symlinkSync(dir, link, 'dir');
  return dir;
}

describe('the worker runner (BEA-1389)', () => {
  let root = '';
  let app: Awaited<ReturnType<typeof startApp>>;
  let runner: Awaited<ReturnType<typeof startRunner>>;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybrain-workers-'));
    app = await startApp();
    runner = await startRunner(root, app.url, { MYBRAIN_HOST_SECRET: 'this must never reach a worker' });
  });

  afterAll(async () => {
    try { runner.child.kill('SIGKILL'); } catch { /* already gone */ }
    await new Promise<void>((r) => app.server.close(() => r()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function run(body: Record<string, any>) {
    const res = await fetch(`${runner.url}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res;
  }

  it('says what it is, in the shape the engine pill reads', async () => {
    const s = await (await fetch(`${runner.url}/status`)).json();
    expect(s).toMatchObject({ installed: true, loggedIn: expect.any(Boolean), ready: true, workdir: root, runner: 'ok', engine: 'worker-runner', kit: '1' });
    expect(String(s.version)).toMatch(/^v\d+\./);
  });

  it('spawns a worker, streams its steps as they happen, and lands them on the run', async () => {
    install(root, 'job1', `
      import { makeKit } from './kit/kit.js';
      const kit = makeKit({});
      await kit.step('Started the fixture worker', 'done', 'one');
      process.stdout.write(JSON.stringify({ type: 'progress', label: 'halfway' }) + '\\n');
      await new Promise((r) => setTimeout(r, 500));
      await kit.step('Finished the fixture worker', 'done', 'two');
      await kit.finish({ rows: 2 });
      process.stdout.write(JSON.stringify({ type: 'result', status: 'done', rows: 2 }) + '\\n');
    `);
    const spawnToken = await app.world.tokens.mint('run-stream', 'job1');
    const res = await run({ jobId: 'job1', runId: 'run-stream', token: spawnToken.token, seed: spawnToken.seed, kit: '1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const lines = await ndjson(res);

    const last = lines[lines.length - 1].line;
    expect(last).toEqual({ type: 'result', status: 'done', rows: 2, error: null });

    // The worker's own printed line arrived as a step, well before the run settled — that is what
    // "steps appear on the run screen as they happen" means over this stream.
    const mid = lines.find((l) => l.line.type === 'step' && l.line.step?.label === 'halfway');
    expect(mid).toBeTruthy();
    expect(lines[lines.length - 1].at - (mid as any).at).toBeGreaterThan(300);

    // …and the kit's own steps went to the app, over HTTP, on the minted token.
    const labels = app.world.agent.steps.map((s: any) => s.label);
    expect(labels).toEqual(['Started the fixture worker', 'Finished the fixture worker']);
    expect(app.world.agent.finished[0]).toMatchObject({ status: 'done' });
    expect(app.world.agent.runKinds).toContain('worker');
  });

  it('kills a hung worker at the timeout and fails the run honestly', async () => {
    install(root, 'hang', `
      import { makeKit } from './kit/kit.js';
      const kit = makeKit({});
      await kit.step('About to hang', 'running');
      setInterval(() => {}, 1000);           // never exits on its own
    `);
    const spawnToken = await app.world.tokens.mint('run-hang', null);
    const started = Date.now();
    const res = await run({ jobId: 'hang', runId: 'run-hang', token: spawnToken.token, timeoutMs: 1500 });
    const lines = await ndjson(res);
    const last = lines[lines.length - 1].line;
    // The stream only settles when the process is really gone — the kill is the proof, not a claim.
    expect(last.status).toBe('failed');
    expect(last.timedOut).toBe(true);
    expect(last.error).toMatch(/took too long/i);
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it('refuses a worker built for a newer kit, and says why, without starting it', async () => {
    const dir = install(root, 'newkit', `
      import * as fs from 'fs';
      fs.writeFileSync('ran.txt', 'the worker should never have started');
    `, { kit: '2' });
    const spawnToken = await app.world.tokens.mint('run-newkit', null);
    const lines = await ndjson(await run({ jobId: 'newkit', runId: 'run-newkit', token: spawnToken.token, kit: '1' }));
    const last = lines[lines.length - 1].line;
    expect(last.status).toBe('failed');
    expect(last.kitRefused).toBe(true);
    expect(last.error).toMatch(/kit v2/);
    expect(last.error).toMatch(/kit v1/);
    expect(last.error).toMatch(/rebuild/i);
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
  });

  it('fixes the worker process itself: no host environment, no NODE_OPTIONS, a capped heap, a pinned cwd', async () => {
    install(root, 'env', `
      import { makeKit } from './kit/kit.js';
      const kit = makeKit({});
      await kit.step('what I can see', 'done', JSON.stringify({
        nodeOptions: process.env.NODE_OPTIONS,
        hostSecret: process.env.MYBRAIN_HOST_SECRET ?? null,
        token: !!process.env.MYBRAIN_TOKEN,
        api: process.env.MYBRAIN_API,
        runId: process.env.MYBRAIN_RUN_ID,
        heap: process.execArgv.join(' '),
        cwd: process.cwd(),
      }));
      process.stdout.write(JSON.stringify({ type: 'result', status: 'done', rows: 0 }) + '\\n');
    `);
    const spawnToken = await app.world.tokens.mint('run-env', null);
    app.world.agent.steps.length = 0;
    // NODE_OPTIONS in the request is ignored: the runner fixes it, whatever the body says.
    await ndjson(await run({ jobId: 'env', runId: 'run-env', token: spawnToken.token, env: { NODE_OPTIONS: '--throw-deprecation' }, NODE_OPTIONS: '--throw-deprecation' }));
    const seen = JSON.parse(app.world.agent.steps[0].detail);
    expect(seen.nodeOptions).toBe('');
    expect(seen.hostSecret).toBeNull(); // the runner's own environment does not reach a worker
    expect(seen.token).toBe(true);
    expect(seen.api).toBe(app.url);
    expect(seen.runId).toBe('run-env');
    expect(seen.heap).toContain('--max-old-space-size=512');
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(path.join(root, 'env', 'v1')));
  });

  it('refuses a jobId that is not an id, and a job with no worker installed', async () => {
    for (const jobId of ['../etc', 'a/b', '', '.']) {
      const res = await fetch(`${runner.url}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, runId: 'r', token: 't' }),
      });
      expect(res.status).toBe(400);
    }
    const lines = await ndjson(await run({ jobId: 'nothing-here', runId: 'r', token: 't' }));
    expect(lines[lines.length - 1].line).toMatchObject({ type: 'result', status: 'failed' });
    expect(lines[lines.length - 1].line.error).toMatch(/No worker is installed/i);
  });

  it('stops relaying a worker that will not stop talking', async () => {
    install(root, 'flood', `
      for (let i = 0; i < 3000; i++) process.stdout.write(JSON.stringify({ type: 'noise', i }) + '\\n');
      process.stdout.write('x'.repeat(5000) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'result', status: 'done', rows: 0 }) + '\\n');
    `);
    const lines = await ndjson(await run({ jobId: 'flood', runId: 'run-flood', token: 't' }));
    const relayed = lines.filter((l) => l.line.type !== 'result');
    expect(relayed.length).toBeLessThanOrEqual(2001); // the budget, plus its own "that's enough" line
    expect(relayed[relayed.length - 1].line.line).toMatch(/not being relayed/);
    // …and the run itself still settles honestly on the worker's own result line.
    expect(lines[lines.length - 1].line).toMatchObject({ type: 'result', status: 'done', rows: 0 });
  });

  it('can be locked with a shared token, and is open by default', async () => {
    const locked = await startRunner(root, app.url, { WORKER_RUNNER_TOKEN: 'sesame' });
    try {
      expect((await fetch(`${locked.url}/status`)).status).toBe(200); // the readiness probe stays open
      const shut = await fetch(`${locked.url}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job1', runId: 'r', token: 't' }) });
      expect(shut.status).toBe(401);
      const open = await fetch(`${locked.url}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-runner-token': 'sesame' },
        body: JSON.stringify({ jobId: 'nope!', runId: 'r', token: 't' }),
      });
      expect(open.status).toBe(400); // through the door, and refused on its own merits
    } finally {
      try { locked.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  // -------------------------------------------------------------------------------------------
  // The build turn's half of the runner (BEA-1390): the app's files land in a NEW version folder,
  // ONE fresh Codex session runs in it, its tests are really run, and `current` moves only when the
  // app says so. Codex itself is a stand-in here — a real build turn is minutes long and is proved
  // live, not in the test suite — but every other part is the real file doing the real thing.
  // -------------------------------------------------------------------------------------------
  describe('building a worker (BEA-1390)', () => {
    let buildRunner: Awaited<ReturnType<typeof startRunner>>;
    let bin = '';

    beforeAll(async () => {
      bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
      // A stand-in for Codex: it writes the two files a build must produce, and writes a FAILING
      // test when the brief asks for one — so the same runner proves both roads.
      fs.writeFileSync(
        path.join(bin, 'codex'),
        `#!/bin/sh
printf '%s\\n' "$*" > argv.txt
echo '{"id":"0","msg":{"type":"session_configured","session_id":"fake-session-42"}}'
cat > worker.mjs <<'EOF'
export async function run(kit) { return { rows: 1 }; }
EOF
if [ -f BRIEF.md ] && grep -q "MAKE THE TESTS FAIL" BRIEF.md; then
cat > worker.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './worker.mjs';
test('the rows are counted', async () => { assert.equal((await run({})).rows, 99); });
EOF
else
cat > worker.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from './worker.mjs';
test('the rows are counted', async () => { assert.equal((await run({})).rows, 1); });
test('the saved answers came through', () => {
  const index = JSON.parse(readFileSync(new URL('./samples/index.json', import.meta.url)));
  assert.equal(index.sources.length, 1);
});
EOF
fi
exit 0
`,
        { mode: 0o755 },
      );
      buildRunner = await startRunner(root, app.url, { PATH: `${bin}:${process.env.PATH}` });
    });

    afterAll(() => {
      try { buildRunner.child.kill('SIGKILL'); } catch { /* already gone */ }
      try { fs.rmSync(bin, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    const build = async (body: Record<string, any>) =>
      (await fetch(`${buildRunner.url}/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as any;
    const promote = async (body: Record<string, any>) => {
      const res = await fetch(`${buildRunner.url}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };

    const FILES = {
      'kit/kit.js': fs.readFileSync(KIT, 'utf8'),
      'kit/KIT.md': '# kit\n',
      'plan.json': '{"sources":[]}',
      'samples/index.json': JSON.stringify({ sources: [{ sourceId: 'svc:instagram.search_hashtag', file: 'samples/a.json' }] }),
      'samples/a.json': JSON.stringify({ answer: { ok: true, table: { columns: ['id'], rows: [['p1']] } } }),
    };

    it('writes the app\'s files, runs ONE fresh Codex session in the new folder, and runs its tests', async () => {
      const out = await build({ jobId: 'built', brief: 'Write the worker.', files: FILES });
      expect(out).toMatchObject({ ok: true, version: 1, wrote: true, sessionId: 'fake-session-42' });
      expect(out.tests).toMatchObject({ passed: 2, failed: 0 });

      const dir = path.join(root, 'built', 'v1');
      expect(fs.existsSync(path.join(dir, 'worker.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'worker.test.mjs'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf8')).toBe('Write the worker.');
      expect(fs.readFileSync(path.join(dir, 'samples', 'index.json'), 'utf8')).toContain('search_hashtag');
      expect(fs.readFileSync(path.join(dir, 'kit', 'kit.js'), 'utf8')).toContain('makeKit');
      // the sandbox and the cwd are the point: `codex exec resume` cannot change either, so a build
      // must be a fresh session, in workspace-write, pinned to this version folder
      const argv = fs.readFileSync(path.join(dir, 'argv.txt'), 'utf8');
      expect(argv).toContain('-s workspace-write');
      expect(argv).toContain(`-C ${dir}`);
      expect(argv).not.toContain('resume');

      // …and it does NOT promote: nothing is live until the app says so.
      expect(fs.existsSync(path.join(root, 'built', 'current'))).toBe(false);
    });

    it('a build whose tests fail is not ok, and still leaves nothing live', async () => {
      const out = await build({ jobId: 'redtests', brief: 'Write the worker. MAKE THE TESTS FAIL', files: FILES });
      expect(out.ok).toBe(false);
      expect(out.tests).toMatchObject({ passed: 0, failed: 1 });
      expect(fs.existsSync(path.join(root, 'redtests', 'current'))).toBe(false);
    });

    it('promotion is the symlink move, and a rollback is the same move back', async () => {
      await build({ jobId: 'promoted', brief: 'Write the worker.', files: FILES });
      const first = await promote({ jobId: 'promoted', version: 1, meta: { jobId: 'promoted', version: 1, kit: '1', planHash: 'sha256:aaa', tests: { passed: 2, failed: 0 } } });
      expect(first.body).toMatchObject({ ok: true, version: 1, previous: null });
      expect(fs.realpathSync(path.join(root, 'promoted', 'current'))).toBe(fs.realpathSync(path.join(root, 'promoted', 'v1')));
      expect(JSON.parse(fs.readFileSync(path.join(root, 'promoted', 'v1', 'meta.json'), 'utf8'))).toMatchObject({ planHash: 'sha256:aaa', kit: '1' });

      const second = await build({ jobId: 'promoted', brief: 'Write the worker again.', files: FILES });
      expect(second.version).toBe(2);
      const moved = await promote({ jobId: 'promoted', version: 2, meta: { planHash: 'sha256:bbb' } });
      expect(moved.body).toMatchObject({ ok: true, version: 2, previous: 'v1' });
      expect(fs.realpathSync(path.join(root, 'promoted', 'current'))).toBe(fs.realpathSync(path.join(root, 'promoted', 'v2')));

      const back = await promote({ jobId: 'promoted', version: 1 });
      expect(back.body).toMatchObject({ ok: true, version: 1, previous: 'v2' });
      expect(fs.realpathSync(path.join(root, 'promoted', 'current'))).toBe(fs.realpathSync(path.join(root, 'promoted', 'v1')));
      // a rollback does not rewrite the version's own meta
      expect(JSON.parse(fs.readFileSync(path.join(root, 'promoted', 'v1', 'meta.json'), 'utf8')).planHash).toBe('sha256:aaa');
    });

    it('refuses to promote a version that has no worker in it', async () => {
      fs.mkdirSync(path.join(root, 'empty', 'v1'), { recursive: true });
      const out = await promote({ jobId: 'empty', version: 1 });
      expect(out.status).toBe(400);
      expect(out.body.error).toMatch(/no worker\.mjs/i);
      expect(fs.existsSync(path.join(root, 'empty', 'current'))).toBe(false);
    });

    it('a file map that tries to escape the folder is refused, and no folder is left behind', async () => {
      for (const bad of ['../escape.txt', '/etc/passwd', 'a/../../b.txt']) {
        const out = await build({ jobId: 'escape', brief: 'x', files: { [bad]: 'no' } });
        expect(out.ok).toBe(false);
        expect(String(out.error)).toMatch(/bad file path/i);
      }
      expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false);
    });
  });

  it('runs one worker per job at a time', async () => {
    install(root, 'twice', `
      await new Promise((r) => setTimeout(r, 2500));
      process.stdout.write(JSON.stringify({ type: 'result', status: 'done', rows: 1 }) + '\\n');
    `);
    const first = run({ jobId: 'twice', runId: 'run-a', token: 'ta', timeoutMs: 6000 });
    await new Promise((r) => setTimeout(r, 400));
    const second = await ndjson(await run({ jobId: 'twice', runId: 'run-b', token: 'tb', timeoutMs: 6000 }));
    expect(second[second.length - 1].line.error).toMatch(/already running/i);
    const firstLines = await ndjson(await first);
    expect(firstLines[firstLines.length - 1].line).toMatchObject({ status: 'done', rows: 1 });
  });
});
