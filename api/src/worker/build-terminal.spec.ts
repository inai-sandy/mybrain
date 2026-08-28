import * as fs from 'fs';
import * as path from 'path';

/**
 * A build can be watched while it happens (BEA-1545).
 *
 * His ask: *"Codex is building it, then running it once… This takes a few minutes. During this step,
 * I want to see the terminal, and I also want to see the progress."* And, minutes later: *"I started
 * creating a new agent. I don't know the progress. It is still building."*
 *
 * A build was several silent minutes behind a spinner. The output existed — `runCommand` accumulated
 * it — but was handed back only when the process closed, and stored only at the end. So there was
 * nothing to show, and no way to tell working from wedged.
 */
const RUNNER = path.join(__dirname, '../../../services/host/worker-runner.server.js');
const runner = () => fs.readFileSync(RUNNER, 'utf8');
const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('the runner reports a build as it happens', () => {
  it('passes the output out as it arrives, not only at the end', () => {
    const s = runner();
    expect(s).toMatch(/function runCommand\(cmd, args, cwd, timeoutMs, env, onData\)/);
    expect(s).toMatch(/if \(onData\) onData\(String\(d\)\)/);
  });

  it('keeps a rolling tail for the build in flight', () => {
    const s = runner();
    expect(s).toMatch(/const BUILD_LOG_TAIL = /);
    expect(s).toMatch(/liveEntry\.append/);
  });

  // The NEWEST words are the ones worth reading — a head-truncated log would show the first minute
  // for ever and never the error that ended it.
  it('keeps the end of the log, not the beginning', () => {
    expect(runner()).toMatch(/\.slice\(-BUILD_LOG_TAIL\)/);
  });

  it('serves it on a read-only route', () => {
    const s = runner();
    expect(s).toMatch(/async function handleBuildLog/);
    expect(s).toMatch(/startsWith\('\/build-log'\)/);
  });

  // A build that finished while he was watching is the normal case, not an error.
  it('answers "not running" rather than failing once the build is over', () => {
    expect(runner()).toMatch(/running: false, log: ''/);
  });

  // Everything except /status sits behind the shared token; the log is a build's own output.
  it('is behind the runner token like every other route', () => {
    const s = runner();
    const guard = s.indexOf("this runner needs its shared token");
    const route = s.indexOf("startsWith('/build-log')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(route);
  });
});

describe('the app serves the terminal for both states', () => {
  it('one method answers the live tail and the stored log', () => {
    const s = read('worker/worker-build.service.ts');
    expect(s).toMatch(/async buildLog\(agentId: string\)/);
    expect(s).toMatch(/runner\?\.buildLog\?\./);      // live, from the host
    expect(s).toMatch(/workerBuild[\s\S]{0,200}findFirst/); // stored, once it is over
  });

  it('the client never throws while a build is being watched', () => {
    const s = read('worker/worker-runner.client.ts');
    expect(s).toMatch(/async buildLog\(jobId: string\)/);
    expect(s).toMatch(/catch \{\s*return \{ running: false, log: '' \};/);
  });

  it('the route exists on the worker controller', () => {
    expect(read('worker/worker-build.controller.ts')).toMatch(/@Get\('log'\)/);
  });
});
