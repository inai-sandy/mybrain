// Worker runner — the host service that runs agent workers (BEA-1389, agent workers 4/10).
// Design: `specs/AGENT-WORKERS.md` §D, §F. Brief: `specs/briefs/AGENT-WORKERS-QUEUE.md` §4.
//
//   GET  /status                                   -> readiness, same shape as the codex runner's
//   POST /run   {jobId, runId, token, seed?, timeoutMs?, kit?}  -> ndjson stream, final {type:'result'}
//   POST /build {jobId, brief, model?, timeoutMs?} -> {ok, version, tests, log}   (piece 5 drives this)
//
// Why it lives on the host and not in the container: the app image has no `child_process` usage at
// all, and a second container must not write the same SQLite file. This is a sibling of
// `codex-runner` and follows the same discipline — the repo copy in `services/host/` is the source of
// truth, the live copy sits under /home/sandy, and both are documented in `services/host/README.md`.
//
// Three rules it never breaks:
//  1. **It never opens the database.** Everything a worker needs goes through the app's /api/worker/*
//     callback API, with a run-scoped token minted per spawn.
//  2. **Nothing dangerous comes from the request.** `NODE_OPTIONS`, the memory cap, the API base, the
//     cwd and the argv are all fixed here; the request supplies only ids, a token and a timeout.
//  3. **A worker never inherits the host's environment.** The child gets a small, listed env — the
//     token is the only secret it ever sees, and it arrives per spawn, never on disk.
const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = process.env.WORKER_RUNNER_HOST || '172.18.0.1';
// 8766 was the proposal in the design; on this VPS it is taken (the retired gws-runner still holds
// it, and 8765/8767/8768/8770 are the codex/gemini/claude/agent-helper runners). Confirmed free with
// `ss -ltnp` on 2026-08-22 and pinned here; override with WORKER_RUNNER_PORT either way.
const PORT = Number(process.env.WORKER_RUNNER_PORT || 8769);
// Where the version folders live (§D). Created by the install, not by this service — it runs as
// `sandy` and /srv is root-owned.
const ROOT = path.resolve(process.env.WORKER_ROOT || '/srv/mybrain-workers');
// What a worker calls back on. The app container publishes 3000 on the host.
const API = (process.env.WORKER_API || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const DEFAULT_TIMEOUT = Number(process.env.WORKER_TIMEOUT_MS || 300_000); // 5 min (§F)
const MAX_TIMEOUT = Number(process.env.WORKER_MAX_TIMEOUT_MS || 1_800_000); // 30 min ceiling
const BUILD_TIMEOUT = Number(process.env.WORKER_BUILD_TIMEOUT_MS || 900_000); // 15 min for a Codex build
const TEST_TIMEOUT = Number(process.env.WORKER_TEST_TIMEOUT_MS || 120_000);
const MEMORY_MB = Number(process.env.WORKER_MEMORY_MB || 512); // --max-old-space-size (§F)
// The app's kit version. The app sends its own on every /run (it is the authority); this is only the
// fallback for a hand-driven call.
const KIT_VERSION = String(process.env.WORKER_KIT_VERSION || '1');
// Optional: a kit copy on the host that /build pins into a new version folder. Piece 5 owns how the
// kit gets here; if it is not set or not there, the build simply says so.
const KIT_DIR = process.env.WORKER_KIT_DIR || '';

const MAX_LOG_LINES = 2000; // relayed log lines per run — a chatty worker may not eat the host's memory
const MAX_LINE = 2000;    // characters of any one relayed text line
const MAX_STEP = 16_000;  // characters of a JSON line worth relaying whole (a cut object is useless)
const MAX_STDERR = 8000;

// ---------------------------------------------------------------------------------------------
// Paths. A jobId comes off an HTTP request, so it is validated as an id and never as a path.
// ---------------------------------------------------------------------------------------------
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function jobDirOf(jobId) {
  const id = String(jobId || '');
  if (!JOB_ID_RE.test(id) || id === '.' || id === '..') return null;
  const dir = path.resolve(ROOT, id);
  // Belt and braces: the id passed the pattern, so this can only fail if ROOT itself is odd.
  if (path.dirname(dir) !== ROOT) return null;
  return dir;
}

/** The version folder `current` points at, proved to be inside the job's own folder. */
function currentDirOf(jobDir) {
  const link = path.join(jobDir, 'current');
  let real;
  try { real = fs.realpathSync(link); } catch (e) { return null; }
  let base;
  try { base = fs.realpathSync(jobDir); } catch (e) { return null; }
  if (real !== base && !real.startsWith(base + path.sep)) return null; // a symlink out of the folder
  return real;
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (e) { return null; }
}

/** `"2"`, `"2.1"`, `2` → 2. Anything unreadable → NaN, which fails the check honestly. */
function majorOf(v) {
  const m = /^\s*(\d+)/.exec(String(v == null ? '' : v));
  return m ? Number(m[1]) : NaN;
}

// Codex appends a `[projects."<cwd>"] trust_level="trusted"` entry the first time it runs in a folder.
// A build runs in a fresh version folder every time, so those entries would pile up for ever — prune
// every entry under the workers root, exactly as the skill road prunes its throwaway workspaces.
function pruneWorkerTrust() {
  try {
    const cfg = path.join(os.homedir(), '.codex', 'config.toml');
    const txt = fs.readFileSync(cfg, 'utf8');
    const root = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[projects\\."${root}[^"]*"\\]\\s*\\r?\\ntrust_level\\s*=\\s*"[^"]*"\\s*\\r?\\n?`, 'g');
    const cleaned = txt.replace(re, '');
    if (cleaned !== txt) fs.writeFileSync(cfg, cleaned);
  } catch (e) { /* best effort, never fatal */ }
}

// ---------------------------------------------------------------------------------------------
// One run (and one build) per job at a time. The app already holds a per-job lock (BEA-1388); this
// is the same guarantee one layer down, so a stray call cannot start a second worker over the first.
// ---------------------------------------------------------------------------------------------
const live = new Map(); // jobId -> { runId, kind, startedAt, kill }

function readBody(req) {
  // Same shape as the codex runner's (BEA-838): an oversized or dropped request must REJECT, never
  // leave the awaiting handler hanging.
  return new Promise((resolve, reject) => {
    let b = '';
    let settled = false;
    req.on('data', (c) => {
      b += c;
      if (b.length > 8_000_000 && !settled) { settled = true; req.pause(); reject(new Error('body too large')); }
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(b); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e || new Error('socket error')); } });
  });
}

function nodeVersion() {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--version'], { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

async function status() {
  const version = await nodeVersion();
  let rootOk = false;
  let workers = 0;
  try {
    rootOk = fs.statSync(ROOT).isDirectory();
    workers = fs.readdirSync(ROOT).filter((d) => !d.startsWith('.') && fs.existsSync(path.join(ROOT, d, 'current'))).length;
  } catch (e) { rootOk = false; }
  // Codex is only needed by /build, so it is reported but does not decide `ready` — a runner that can
  // run workers is ready even on a host where nobody has logged Codex in.
  const loggedIn = fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
  return {
    installed: rootOk,
    version: version || null,
    loggedIn,
    ready: rootOk && !!version,
    workdir: ROOT,
    runner: 'ok',
    engine: 'worker-runner',
    kit: KIT_VERSION,
    api: API,
    workers,
    running: [...live.values()].map((r) => ({ runId: r.runId, kind: r.kind, startedAt: r.startedAt })),
  };
}

// ---------------------------------------------------------------------------------------------
// POST /run — spawn one worker, relay what it says, settle honestly.
// ---------------------------------------------------------------------------------------------

/**
 * The environment a worker gets. Nothing of the host's own is inherited: the token is the only
 * secret in it, it is minted for this spawn and it is never written into the worker folder.
 * `NODE_OPTIONS` is emptied here on purpose — it is a way to inject flags into node and it may
 * never come from the request.
 */
function workerEnv(opts) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: os.homedir(),
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || '',
    NODE_ENV: 'production',
    NODE_OPTIONS: '', // fixed by the runner, never taken from the request
    MYBRAIN_API: API,
    MYBRAIN_TOKEN: opts.token,
    MYBRAIN_RUN_ID: opts.runId,
    MYBRAIN_JOB_ID: opts.jobId,
    MYBRAIN_KIT: opts.kit,
  };
  if (opts.seed) env.MYBRAIN_SEED = JSON.stringify(opts.seed);
  return env;
}

/** The run's frozen clock + randomness (§C). Numbers only — whatever else the body holds is dropped. */
function cleanSeed(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const now = Number(raw.now);
  const random = Number(raw.random);
  if (!Number.isFinite(now) || !Number.isFinite(random)) return null;
  return { now, random };
}

/**
 * Run one worker. `emit(obj)` gets every line as it happens; the promise settles with the final
 * result object. Never throws — a failure here IS the run's honest result.
 */
function runWorker(opts, emit) {
  return new Promise((resolve) => {
    const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1000, Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT));
    const args = [`--max-old-space-size=${MEMORY_MB}`, 'worker.mjs'];
    // No shell, argv fixed here, cwd pinned to the version folder — a worker can only ever be the
    // `worker.mjs` of the version `current` points at.
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: opts.dir,
        env: workerEnv(opts),
        detached: true, // its own process group, so a timeout kill takes its children with it
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ status: 'failed', rows: null, error: `The worker could not be started: ${String((e && e.message) || e)}` });
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stderr = '';
    let logged = 0;
    let lineBuf = '';
    let result = null;

    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } // negative pid = the whole process group
      catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
    };
    const killer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);

    // ONE budget for everything relayed, whatever kind of line it is: a runaway worker printing a
    // flood of JSON is exactly as expensive as one printing a flood of text.
    const relay = (obj) => {
      if (logged > MAX_LOG_LINES) return;
      if (logged === MAX_LOG_LINES) { logged++; emit({ type: 'log', line: `(the worker has said more than ${MAX_LOG_LINES} things — the rest is not being relayed)` }); return; }
      logged++;
      emit(obj);
    };
    const handleLine = (line) => {
      const s = String(line).trim();
      if (!s) return;
      let ev = null;
      if (s.startsWith('{') && s.length <= MAX_STEP) { try { ev = JSON.parse(s); } catch (e) { ev = null; } }
      if (ev && ev.type === 'result') { result = ev; return; } // the worker's own last word
      if (ev && typeof ev === 'object') { relay({ type: 'step', step: ev }); return; }
      // Anything else — plain text, or a JSON line too big to be worth relaying whole — is a log
      // line, truncated. A cut-off JSON object is worse than useless, so it is never half-relayed.
      relay({ type: 'log', line: s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}… (${s.length} characters, cut)` : s });
    };

    child.stdout.on('data', (d) => {
      lineBuf += d;
      if (lineBuf.length > 1_000_000) lineBuf = lineBuf.slice(-1_000_000); // a worker printing one huge line
      let i;
      while ((i = lineBuf.indexOf('\n')) >= 0) { handleLine(lineBuf.slice(0, i)); lineBuf = lineBuf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => {
      const text = String(d);
      if (stderr.length < MAX_STDERR) stderr += text;
      relay({ type: 'log', stream: 'err', line: text.trim().slice(0, MAX_LINE) });
    });

    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(r);
    };

    child.on('error', (e) => settle({ status: 'failed', rows: null, error: `The worker could not be started: ${String((e && e.message) || e)}` }));
    child.on('close', (code) => {
      handleLine(lineBuf); // flush a last partial line
      if (timedOut) {
        settle({ status: 'failed', rows: null, error: `The worker took too long and was stopped after ${Math.round(timeoutMs / 1000)}s.`, timedOut: true });
        return;
      }
      if (aborted) {
        settle({ status: 'failed', rows: null, error: 'The app stopped listening, so the worker was stopped.' });
        return;
      }
      if (result) {
        // The worker's own result line is the authority on status/rows (a pause says `waiting`).
        const status = ['done', 'failed', 'waiting'].indexOf(String(result.status)) >= 0 ? String(result.status) : (code === 0 ? 'done' : 'failed');
        settle({
          status,
          rows: typeof result.rows === 'number' ? result.rows : (result.rows == null ? null : result.rows),
          error: result.error ? String(result.error).slice(0, 2000) : (status === 'failed' ? (stderr.trim().slice(-800) || `the worker exited with code ${code}`) : null),
          waitpointId: result.waitpointId || undefined,
          output: result.output || undefined,
        });
        return;
      }
      if (code === 0) { settle({ status: 'done', rows: null, error: null }); return; }
      settle({ status: 'failed', rows: null, error: (stderr.trim().slice(-800) || `the worker exited with code ${code}`) });
    });

    // If the app goes away mid-run (a deploy, a dropped socket), the worker must not be orphaned on
    // the host — that is the runaway-agent family of bugs. Its journal makes the next spawn free.
    if (typeof opts.onAbort === 'function') opts.onAbort(() => { aborted = true; killGroup(); });
  });
}

async function handleRun(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    const msg = String((e && e.message) || '');
    // BEA-838 again: `readBody` PAUSES an oversized request, it does not destroy it — the socket has
    // to be destroyed after the 413 is flushed, or it is left half-drained on a keep-alive connection.
    if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ error: 'request body too large (8MB max)' }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; }
    if (/socket|aborted|ECONN|hang up/i.test(msg)) return; // client vanished — nothing to answer
    res.statusCode = 400; res.end(JSON.stringify({ error: 'bad body' })); return;
  }

  const jobId = String(body.jobId || '');
  const runId = String(body.runId || '');
  const token = String(body.token || '');
  const jobDir = jobDirOf(jobId);
  // A malformed request is a 400 in plain JSON. A request that is fine but cannot run — no worker
  // installed, kit too new, job busy — is a 200 ndjson stream whose one line is the honest result,
  // so the app has exactly one road to parse.
  if (!jobDir) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad or missing jobId' })); return; }
  if (!runId) { res.statusCode = 400; res.end(JSON.stringify({ error: 'no runId' })); return; }
  if (!token) { res.statusCode = 400; res.end(JSON.stringify({ error: 'no run token' })); return; }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {} };
  const finish = (r) => { try { res.end(JSON.stringify({ type: 'result', status: r.status, rows: r.rows === undefined ? null : r.rows, error: r.error || null, ...(r.waitpointId ? { waitpointId: r.waitpointId } : {}), ...(r.output ? { output: r.output } : {}), ...(r.timedOut ? { timedOut: true } : {}), ...(r.kitRefused ? { kitRefused: true } : {}) }) + '\n'); } catch (e) {} };

  if (live.has(jobId)) {
    const held = live.get(jobId);
    finish({ status: 'failed', rows: null, error: `This job is already running here (run ${held.runId}) — this start was refused.` });
    return;
  }

  const dir = currentDirOf(jobDir);
  if (!dir) { finish({ status: 'failed', rows: null, error: 'No worker is installed for this job yet.' }); return; }
  if (!fs.existsSync(path.join(dir, 'worker.mjs'))) { finish({ status: 'failed', rows: null, error: `The installed worker has no worker.mjs (${path.basename(dir)}).` }); return; }

  // The worker folders outlive the app image: `deploy.sh` rolls back by re-tagging `mybrain-app:prev`
  // and never touches /srv/mybrain-workers, so a rolled-back app can meet a worker built against a
  // newer kit. That worker is refused BEFORE it is spawned, and the run fails honestly (§F, DEPLOY.md).
  const appKit = String(body.kit || KIT_VERSION);
  const meta = readMeta(dir);
  const workerKit = meta && meta.kit != null ? meta.kit : null;
  if (workerKit === null) {
    finish({ status: 'failed', rows: null, error: `The installed worker (${path.basename(dir)}) has no readable meta.json, so its kit version is unknown — it needs a rebuild.` });
    return;
  }
  const wantMajor = majorOf(workerKit);
  const haveMajor = majorOf(appKit);
  if (!Number.isFinite(wantMajor) || !Number.isFinite(haveMajor)) {
    finish({ status: 'failed', rows: null, error: `Could not read the kit versions (worker "${workerKit}", app "${appKit}") — the worker needs a rebuild.` });
    return;
  }
  if (wantMajor > haveMajor) {
    finish({
      status: 'failed',
      rows: null,
      error: `This job's worker was built for kit v${wantMajor} and My Brain is on kit v${haveMajor}, so it was not started. The app can be rolled back to an older image; worker folders are not rolled back with it. Rebuild the worker, or run the job the old way.`,
      kitRefused: true,
    });
    return;
  }

  const seed = cleanSeed(body.seed);
  const startedAt = new Date().toISOString();
  let killer = null;
  live.set(jobId, { runId, kind: 'run', startedAt, kill: () => killer && killer() });
  // The RESPONSE is the signal, not the request: a fully-read request stream closes the moment its
  // body has been consumed, so watching that would kill every worker the instant it started.
  res.on('close', () => { if (!res.writableEnded && killer) killer(); });
  try {
    const r = await runWorker(
      { dir, jobId, runId, token, seed, kit: String(appKit), timeoutMs: body.timeoutMs, onAbort: (k) => { killer = k; } },
      emit,
    );
    finish(r);
  } finally {
    live.delete(jobId);
  }
}

// ---------------------------------------------------------------------------------------------
// POST /build — the plumbing piece 5 drives: a fresh Codex session inside a NEW version folder,
// then that version's own tests. It does NOT write the brief (piece 5 does) and it does NOT promote
// — promotion is a `current` symlink move and belongs to the build turn, with its own rules.
// ---------------------------------------------------------------------------------------------
function nextVersion(jobDir) {
  let max = 0;
  try {
    for (const d of fs.readdirSync(jobDir)) {
      const m = /^v(\d+)$/.exec(d);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch (e) { /* the job has no folder yet */ }
  return max + 1;
}

/** Run one command in a folder, detached, killed as a group at the timeout. Never throws. */
function runCommand(cmd, args, cwd, timeoutMs, env) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env: env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e), timedOut: false }); return; }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < 200_000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 100_000) stderr += d; });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, stdout, stderr: String((e && e.message) || e), timedOut }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** Node's own test runner prints TAP: `# pass 7` / `# fail 0`. */
function parseTap(out) {
  const pass = /^#\s*pass\s+(\d+)/m.exec(out);
  const fail = /^#\s*fail\s+(\d+)/m.exec(out);
  if (!pass && !fail) return null;
  return { passed: pass ? Number(pass[1]) : 0, failed: fail ? Number(fail[1]) : 0, at: new Date().toISOString() };
}

async function handleBuild(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ ok: false, error: 'request body too large (8MB max)' }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; }
    if (/socket|aborted|ECONN|hang up/i.test(msg)) return;
    res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad body' })); return;
  }
  const jobId = String(body.jobId || '');
  const brief = String(body.brief || '');
  const jobDir = jobDirOf(jobId);
  if (!jobDir) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad or missing jobId' })); return; }
  if (!brief.trim()) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'no brief' })); return; }
  if (live.has(jobId)) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: `This job is busy here (${live.get(jobId).kind}) — try again when it settles.` })); return; }

  const version = nextVersion(jobDir);
  const dir = path.join(jobDir, `v${version}`);
  const log = [];
  live.set(jobId, { runId: `build-v${version}`, kind: 'build', startedAt: new Date().toISOString(), kill: () => {} });
  try {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, version, error: `could not create ${dir}: ${String((e && e.message) || e)}` }));
      return;
    }
    // The kit is pinned into the version folder so a worker keeps the parts box it was tested with.
    if (KIT_DIR && fs.existsSync(KIT_DIR)) {
      try { fs.cpSync(KIT_DIR, path.join(dir, 'kit'), { recursive: true }); log.push(`kit pinned from ${KIT_DIR}`); }
      catch (e) { log.push(`kit copy failed: ${String((e && e.message) || e)}`); }
    } else {
      log.push('no kit copy configured (WORKER_KIT_DIR) — the brief must bring its own');
    }
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), brief);

    const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-s', 'workspace-write', '-C', dir];
    if (body.model) args.push('-m', String(body.model));
    args.push(brief);
    const timeoutMs = Math.min(3_600_000, Math.max(30_000, Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : BUILD_TIMEOUT));
    const built = await runCommand('codex', args, dir, timeoutMs, process.env);
    pruneWorkerTrust();
    log.push(built.timedOut ? `codex was stopped after ${Math.round(timeoutMs / 1000)}s` : `codex exited ${built.code}`);
    if (built.stderr.trim()) log.push(built.stderr.trim().slice(-2000));

    const wrote = fs.existsSync(path.join(dir, 'worker.mjs'));
    let tests = null;
    if (wrote && fs.existsSync(path.join(dir, 'worker.test.mjs'))) {
      const ran = await runCommand(process.execPath, ['--test', 'worker.test.mjs'], dir, TEST_TIMEOUT, { ...process.env, NODE_OPTIONS: '' });
      tests = parseTap(ran.stdout + ran.stderr) || { passed: 0, failed: ran.code === 0 ? 0 : 1, at: new Date().toISOString() };
      log.push(ran.timedOut ? 'the tests were stopped at the timeout' : `tests exited ${ran.code}`);
      if (ran.stdout.trim()) log.push(ran.stdout.trim().slice(-4000));
    } else if (wrote) {
      log.push('the build wrote no worker.test.mjs');
    } else {
      log.push('the build wrote no worker.mjs');
    }

    const ok = wrote && !!tests && tests.failed === 0 && tests.passed > 0;
    // No promotion here: moving `current` is the build turn's decision (piece 5), not the runner's.
    res.end(JSON.stringify({ ok, version, dir, tests, log: log.join('\n').slice(-20_000) }));
  } finally {
    live.delete(jobId);
  }
}

/**
 * Optional shared secret. Off by default, exactly like every other host runner on this VPS — the
 * only thing that can reach 172.18.0.1 is this host and its containers. It is here so the door can
 * be locked deliberately when piece 5 starts sending real briefs to `/build`, which is the one route
 * that runs a Codex session with a caller's text: set `WORKER_RUNNER_TOKEN` here and send the same
 * value as `x-runner-token` from the app. `/status` stays open — it is a readiness probe.
 */
function allowed(req) {
  const want = process.env.WORKER_RUNNER_TOKEN || '';
  if (!want) return true;
  const got = String(req.headers['x-runner-token'] || '');
  if (got.length !== want.length) return false;
  let same = 0;
  for (let i = 0; i < want.length; i++) same |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return same === 0;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify(await status())); return; }
    if (!allowed(req)) { res.statusCode = 401; res.end(JSON.stringify({ error: 'this runner needs its shared token' })); return; }
    if (req.method === 'POST' && req.url === '/run') { await handleRun(req, res); return; }
    if (req.method === 'POST' && req.url === '/build') { await handleBuild(req, res); return; }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    if (res.writableEnded) return;
    if (!res.headersSent) res.statusCode = 500;
    try { res.end(JSON.stringify({ error: String((e && e.message) || e) })); } catch (e2) {}
  }
});

pruneWorkerTrust();
server.listen(PORT, HOST, () => console.log(`worker-runner on http://${HOST}:${PORT} — workers in ${ROOT}, callbacks to ${API}, kit v${KIT_VERSION}`));
