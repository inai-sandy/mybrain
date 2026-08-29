// Worker runner — the host service that runs agent workers (BEA-1389, agent workers 4/10).
// Design: `specs/AGENT-WORKERS.md` §D, §F. Brief: `specs/briefs/AGENT-WORKERS-QUEUE.md` §4.
//
//   GET  /status                                   -> readiness, same shape as the codex runner's
//   POST /run   {jobId, runId, token, seed?, timeoutMs?, kit?}  -> ndjson stream, final {type:'result'}
//   POST /build {jobId, brief, files?, copyFrom?, model?, timeoutMs?, buildKey?} -> {ok, version, dir, tests, sessionId, log}
//   POST /promote {jobId, version, meta?}          -> {ok, version, previous} — the `current` symlink move
//   POST /parity {jobId, version, harness, files?, timeoutMs?} -> {ok, result, log} — measure one version
//                                                    in a throwaway copy, with no token and no network
//   POST /remove {jobId}                           -> {ok, removed} — the whole job folder, when the
//                                                    owner deletes the agent (BEA-1394 §I)
//
// Why it lives on the host and not in the container: the app image has no `child_process` usage at
// all, and a second container must not write the same SQLite file. This is a sibling of
// `codex-runner` and follows the same discipline — the repo copy in `services/host/` is the source of
// truth, the live copy sits under /home/sandy, and both are documented in `services/host/README.md`.
//
// Four rules it never breaks:
//  1. **It never opens the database.** Everything a worker needs goes through the app's /api/worker/*
//     callback API, with a run-scoped token minted per spawn.
//  2. **Nothing dangerous comes from the request.** `NODE_OPTIONS`, the memory cap, the API base, the
//     cwd and the argv are all fixed here; the request supplies only ids, a token and a timeout.
//  3. **A worker never inherits the host's environment.** The child gets a small, listed env — the
//     token is the only secret it ever sees, and it arrives per spawn, never on disk. The build's
//     tests and the parity measurement get the same treatment, and no network at all (BEA-1401).
//  4. **It never answers `ready` when it cannot do the job.** A workers root it cannot write and a
//     missing shared secret are both said out loud on /status and refused on every other route —
//     silence is the one failure this project is built not to have (BEA-1401).
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
// Where the version folders live (§D). The install creates it (it runs as `sandy` and /srv is
// root-owned); this service will happily create it too where it can, and REFUSES to work when it
// cannot — see `rootState()`.
const ROOT = path.resolve(process.env.WORKER_ROOT || '/srv/mybrain-workers');
// What a worker calls back on. The app container publishes 3000 on the host.
const API = (process.env.WORKER_API || 'http://127.0.0.1:3000').replace(/\/+$/, '');
/**
 * The wall clock is the LAST resort, not the first (BEA-1556).
 *
 * It was 5 minutes, set when a worker fetched at most 11 pages. BEA-1548 then taught workers to ask
 * for `pages: 'all'` — fetch until the source runs out — because stopping at a ceiling is what made
 * his agent ask him questions it could have answered itself. His Reddit job really needs 35 pages and
 * about 250 seconds, so the very next real run died at 300s having made 39 calls, still working.
 * I changed the workload and left the budget alone.
 *
 * 25 minutes, deliberately ABOVE the 20-minute stall watchdog, so for a genuinely wedged worker the
 * watchdog always fires first — it measures PROGRESS, not elapsed time, and says something useful:
 * "nothing was written for 20 minutes". A wall clock cannot tell a stuck worker from a busy one, so
 * it should only ever catch something pathological, never honest work.
 */
const DEFAULT_TIMEOUT = Number(process.env.WORKER_TIMEOUT_MS || 1_500_000); // 25 min (§F, raised in BEA-1556)
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
/**
 * The shared secret, and it is **required** since BEA-1401. `/build` starts a Codex session on text
 * the caller sends; `/run`, `/promote` and `/remove` start processes and move worker folders around.
 * "Only this host and its containers can reach 172.18.0.1" is a network fact, not a door — so the
 * door is now locked, and a runner started without a secret refuses every route but `/status` and
 * says exactly that (a runner that quietly accepted anonymous builds was the finding).
 */
const TOKEN = String(process.env.WORKER_RUNNER_TOKEN || '');
const NO_TOKEN_REASON =
  'this runner has no shared secret set (WORKER_RUNNER_TOKEN), so /run, /build, /promote, /parity and /remove are all refused — set the same value here and on the app';

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

/**
 * ONE NAMED VERSION, proved to be inside the job's own folder (BEA-1570).
 *
 * The pre-flight check has to run the version it has just BUILT, which by definition is not the one
 * `current` points at — promotion is what moves that symlink, and it happens after the check. Asking
 * for "whatever is live" meant a first build had nothing to run at all ("No worker is installed for
 * this job yet.", which killed every new agent) and a rebuild quietly ran the PREVIOUS version, so
 * the check had never once exercised the worker it was judging.
 *
 * The version comes off a request, so it is proved the same way `currentDirOf` proves the symlink:
 * digits only, then `realpath` compared against the job's own folder. Both guards are needed — the
 * pattern stops `../` and the realpath stops a planted symlink pointing out of the folder.
 */
function versionDirOf(jobDir, version) {
  if (!/^\d{1,9}$/.test(String(version))) return null;
  const dir = path.join(jobDir, `v${Number(version)}`);
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { return null; }
  let base;
  try { base = fs.realpathSync(jobDir); } catch (e) { return null; }
  if (!real.startsWith(base + path.sep)) return null;
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

/**
 * Can this runner actually hold workers? (BEA-1401 — the finding that made this exist.)
 *
 * The shipped unit points `WORKER_ROOT` at `/srv/mybrain-workers`, which the owner's install line
 * creates and chowns. If that step is skipped, the folder is missing and `sandy` cannot make it —
 * and the old code found out only when a build died on EACCES, while `/status` still said `ready`
 * and `workers: 0`, so a promoted worker simply went invisible. So the root is PROVED here, on every
 * status and before every route that needs it: created where we can, then really written to.
 */
function rootState() {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
  } catch (e) {
    // EEXIST from a recursive mkdir means something IS there and is not a folder — the stat below
    // says that far more plainly than "it does not exist and cannot be created", so fall through.
    if (!e || e.code !== 'EEXIST') {
      return { ok: false, reason: `the workers root ${ROOT} does not exist and this service (running as ${userName()}) cannot create it: ${String((e && e.message) || e)}` };
    }
  }
  let stat = null;
  try { stat = fs.statSync(ROOT); } catch (e) {
    return { ok: false, reason: `the workers root ${ROOT} cannot be read: ${String((e && e.message) || e)}` };
  }
  if (!stat.isDirectory()) return { ok: false, reason: `the workers root ${ROOT} is not a folder` };
  const probe = path.join(ROOT, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    return { ok: false, reason: `the workers root ${ROOT} is not writable by ${userName()}: ${String((e && e.message) || e)}` };
  }
  return { ok: true, reason: null };
}

function userName() {
  try { return os.userInfo().username; } catch (e) { return 'this user'; }
}

async function status() {
  const version = await nodeVersion();
  const root = rootState();
  let workers = 0;
  if (root.ok) {
    try {
      workers = fs.readdirSync(ROOT).filter((d) => !d.startsWith('.') && fs.existsSync(path.join(ROOT, d, 'current'))).length;
    } catch (e) { workers = 0; }
  }
  // Codex is only needed by /build, so it is reported but does not decide `ready` — a runner that can
  // run workers is ready even on a host where nobody has logged Codex in.
  const loggedIn = fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
  // Every reason it cannot work, in plain words. `ready:true` with nothing behind it is the failure
  // this whole block exists to prevent (BEA-1401).
  const why = [];
  if (!root.ok) why.push(root.reason);
  if (!version) why.push('node could not be run here');
  if (!TOKEN) why.push(NO_TOKEN_REASON);
  return {
    installed: root.ok,
    version: version || null,
    loggedIn,
    ready: root.ok && !!version && !!TOKEN,
    reason: why.length ? why.join(' · ') : null,
    locked: !!TOKEN,
    workdir: ROOT,
    runner: 'ok',
    engine: 'worker-runner',
    kit: KIT_VERSION,
    api: API,
    // The runner's own body limits, DECLARED so the app can trim to fit before sending (BEA-1577).
    // These numbers live here and only here — the app reads them off /status, never restates them.
    limits: { fileBytes: MAX_FILE_BYTES, filesBytes: MAX_FILES_BYTES },
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
    // Reachable by run id while it lives, so `/stop` can kill it on request (BEA-1541).
    if (opts.runId) LIVE.set(String(opts.runId), { kill: killGroup, jobId: opts.jobId || null, startedAt: Date.now() });

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
      if (opts.runId) LIVE.delete(String(opts.runId));
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
  // Every field is written out by hand here, so a new one has to be added in BOTH places or it is
  // silently dropped on the way to the app (the trap BEA-1389 wrote down). `notStarted` is the
  // newest: it marks a refusal that happened BEFORE the spawn, so the app knows the worker road was
  // simply unavailable and the run can go the old way instead of failing (BEA-1394).
  const finish = (r) => { try { res.end(JSON.stringify({ type: 'result', status: r.status, rows: r.rows === undefined ? null : r.rows, error: r.error || null, ...(r.waitpointId ? { waitpointId: r.waitpointId } : {}), ...(r.output ? { output: r.output } : {}), ...(r.timedOut ? { timedOut: true } : {}), ...(r.kitRefused ? { kitRefused: true } : {}), ...(r.notStarted ? { notStarted: true } : {}) }) + '\n'); } catch (e) {} };

  // A runner that cannot hold workers says so instead of reporting "no worker is installed" — the
  // two look identical from the app, and only one of them is the owner's job being missing (BEA-1401).
  const root = rootState();
  if (!root.ok) {
    finish({ status: 'failed', rows: null, error: `The worker runner cannot use its workers folder, so nothing was started — ${root.reason}.`, notStarted: true });
    return;
  }

  if (live.has(jobId)) {
    const held = live.get(jobId);
    finish({ status: 'failed', rows: null, error: `This job is already running here (run ${held.runId}) — this start was refused.`, notStarted: true });
    return;
  }

  // An explicit `version` runs THAT program; without one this is exactly as it always was — the
  // live worker via `current` — so nothing that already works changes (BEA-1570).
  const wantVersion = body.version == null || body.version === '' ? null : body.version;
  const dir = wantVersion === null ? currentDirOf(jobDir) : versionDirOf(jobDir, wantVersion);
  if (!dir) {
    finish({
      status: 'failed',
      rows: null,
      error: wantVersion === null
        ? 'No worker is installed for this job yet.'
        : `This job has no version v${String(wantVersion).slice(0, 12)} to run.`,
      notStarted: true,
    });
    return;
  }
  if (!fs.existsSync(path.join(dir, 'worker.mjs'))) { finish({ status: 'failed', rows: null, error: `The installed worker has no worker.mjs (${path.basename(dir)}).`, notStarted: true }); return; }

  // The worker folders outlive the app image: `deploy.sh` rolls back by re-tagging `mybrain-app:prev`
  // and never touches /srv/mybrain-workers, so a rolled-back app can meet a worker built against a
  // newer kit. That worker is refused BEFORE it is spawned, and the run fails honestly (§F, DEPLOY.md).
  const appKit = String(body.kit || KIT_VERSION);
  const meta = readMeta(dir);
  const workerKit = meta && meta.kit != null ? meta.kit : null;
  if (workerKit === null) {
    finish({ status: 'failed', rows: null, error: `The installed worker (${path.basename(dir)}) has no readable meta.json, so its kit version is unknown — it needs a rebuild.`, notStarted: true });
    return;
  }
  const wantMajor = majorOf(workerKit);
  const haveMajor = majorOf(appKit);
  if (!Number.isFinite(wantMajor) || !Number.isFinite(haveMajor)) {
    finish({ status: 'failed', rows: null, error: `Could not read the kit versions (worker "${workerKit}", app "${appKit}") — the worker needs a rebuild.`, notStarted: true });
    return;
  }
  if (wantMajor > haveMajor) {
    finish({
      status: 'failed',
      rows: null,
      error: `This job's worker was built for kit v${wantMajor} and My Brain is on kit v${haveMajor}, so it was not started. The app can be rolled back to an older image; worker folders are not rolled back with it. Rebuild the worker, or run the job the old way.`,
      kitRefused: true,
      notStarted: true,
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

/**
 * The environment every child of this runner gets that is NOT a worker: the build's tests and the
 * parity measurement. Small and listed, exactly like `workerEnv()` — the host's own environment is
 * full of real keys and none of it is any of their business (BEA-1401).
 */
function childEnv() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: os.homedir(),
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || '',
    NODE_ENV: 'production',
    NODE_OPTIONS: '', // fixed here, never inherited
  };
}

/**
 * A preload module that takes the network away from a child (BEA-1401). `/parity` gets this
 * guarantee from the harness the app writes; a build's tests are written by Codex, so it has to come
 * from outside them — `node --import <this> --test worker.test.mjs`.
 *
 * It lives in a private folder made by THIS process (0700, unique name): a fixed path under /tmp
 * would be a file another user could put there first, and it is imported into a process of ours.
 */
const NO_NETWORK_SOURCE = `// Written by the My Brain worker runner. A build's tests may not reach the network (BEA-1401).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const refuse = (what) => { throw new Error('These tests may never call anything outside their own folder — ' + what + ' was blocked.'); };
globalThis.fetch = () => refuse('fetch');
const net = require('node:net');
net.Socket.prototype.connect = () => refuse('a socket');
net.connect = () => refuse('a socket');
net.createConnection = () => refuse('a socket');
const tls = require('node:tls');
tls.connect = () => refuse('a TLS connection');
for (const [name, mod] of [['http', require('node:http')], ['https', require('node:https')]]) {
  mod.request = () => refuse('an ' + name + ' request');
  mod.get = () => refuse('an ' + name + ' request');
}
const dns = require('node:dns');
dns.lookup = () => refuse('a DNS lookup');
dns.resolve = () => refuse('a DNS lookup');
if (dns.promises) { dns.promises.lookup = () => refuse('a DNS lookup'); dns.promises.resolve = () => refuse('a DNS lookup'); }
`;

let noNetworkFile = '';
function noNetworkUrl() {
  if (!noNetworkFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybrain-runner-'));
    try { fs.chmodSync(dir, 0o700); } catch (e) { /* best effort */ }
    noNetworkFile = path.join(dir, 'no-network.mjs');
    fs.writeFileSync(noNetworkFile, NO_NETWORK_SOURCE);
  }
  return `file://${noNetworkFile}`;
}

/**
 * Live workers, by runId — what `/stop` reaches for (BEA-1541).
 *
 * Before this the ONLY thing that could kill a worker was its own timeout. The app could mark a run
 * "cancelled" in its database while the process carried on to the end, still writing sheets and
 * sending messages. A stop that does not stop is worse than no stop at all.
 */
const LIVE = new Map(); // runId -> { kill, jobId, startedAt }

/** Run one command in a folder, detached, killed as a group at the timeout. Never throws. */
function runCommand(cmd, args, cwd, timeoutMs, env, onData) {
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
    // `onData` is what makes a build watchable (BEA-1545). Output was accumulated here and handed
    // back only when the process closed, so for the several minutes a Codex build takes there was
    // nothing to show and he was left guessing whether it was working or wedged.
    child.stdout.on('data', (d) => { if (stdout.length < 200_000) stdout += d; try { if (onData) onData(String(d)); } catch (e) {} });
    child.stderr.on('data', (d) => { if (stderr.length < 100_000) stderr += d; try { if (onData) onData(String(d)); } catch (e) {} });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, stdout, stderr: String((e && e.message) || e), timedOut }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

// The build's own files — the brief, the pinned kit, the saved answers the tests stand on — are
// written by the app (BEA-1390), because the app is the only side that knows the plan, the kit it is
// running and which `ToolSample`s a version was tested against. They arrive as a plain
// `{ "<relative path>": "<contents>" }` map, and every path is checked as a path, never trusted.
/** How much of a running build's output is kept for `/build-log` — the newest words only. */
const BUILD_LOG_TAIL = 20_000;

const MAX_FILES = 200;
const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES_BYTES = 6_000_000;

/** A relative path inside `dir`, or null. No absolutes, no `..`, no `.`, no empty segments. */
function safeFilePath(dir, rel) {
  const r = String(rel == null ? '' : rel).trim().replace(/\\/g, '/');
  if (!r || r.length > 200) return null;
  if (path.isAbsolute(r) || /^[A-Za-z]:/.test(r)) return null;
  if (r.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  const full = path.resolve(dir, r);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return full;
}

/** Every path and size checked BEFORE anything is created, so a bad request leaves no folder behind. */
function checkFiles(files) {
  if (files === undefined || files === null) return [];
  if (typeof files !== 'object' || Array.isArray(files)) throw new Error('"files" must be a { path: contents } object');
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES) throw new Error(`too many files (${entries.length}, at most ${MAX_FILES})`);
  let total = 0;
  const clean = [];
  for (const [rel, content] of entries) {
    if (!safeFilePath(path.resolve('/tmp/check'), rel)) throw new Error(`bad file path "${String(rel).slice(0, 80)}"`);
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const size = Buffer.byteLength(text);
    if (size > MAX_FILE_BYTES) throw new Error(`"${rel}" is ${size} bytes — at most ${MAX_FILE_BYTES}`);
    total += size;
    if (total > MAX_FILES_BYTES) throw new Error(`the files add up to more than ${MAX_FILES_BYTES} bytes`);
    clean.push([rel, text]);
  }
  return clean;
}

function writeFiles(dir, clean) {
  for (const [rel, text] of clean) {
    const full = safeFilePath(dir, rel);
    if (!full) throw new Error(`bad file path "${rel}"`); // checked already; belt and braces
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return clean.map(([rel]) => rel);
}

/**
 * The Codex session this build ran in, read off its own `--json` event stream. It goes into
 * `meta.json` (§D) so a build can be traced back to the turn that wrote it.
 */
function sessionIdOf(out) {
  // `codex exec --json` announces the thread first: {"type":"thread.started","thread_id":"…"} — the
  // same field the codex runner reuses to resume a session. The older key names are kept as a
  // fallback so a Codex upgrade cannot quietly empty `meta.sessionId`.
  const m = /"(?:thread_id|session_id|conversation_id)"\s*:\s*"([^"]{6,})"/.exec(String(out || ''));
  return m ? m[1] : null;
}

/** Node's own test runner prints TAP: `# pass 7` / `# fail 0`. */
function parseTap(out) {
  const pass = /^#\s*pass\s+(\d+)/m.exec(out);
  const fail = /^#\s*fail\s+(\d+)/m.exec(out);
  if (!pass && !fail) return null;
  return { passed: pass ? Number(pass[1]) : 0, failed: fail ? Number(fail[1]) : 0, at: new Date().toISOString() };
}


/**
 * Hold a long request open so the caller's HTTP client does not give up on it (BEA-1469).
 *
 * Node's `fetch` (undici) aborts a request whose response HEADERS have not arrived within 300
 * seconds, and again if the BODY goes quiet for 300 seconds. Neither is configurable from a plain
 * `fetch()` call. `/build` and `/parity` answer nothing until the whole job is done, so any Codex
 * turn over five minutes died at exactly five minutes — with a "fetch failed" that looked like the
 * runner being down while the runner was in fact working perfectly.
 *
 * That really happened, and it wasted a whole build: Codex wrote the program at 13:21:07 and the app
 * gave up at 13:21:28, twenty-one seconds after it had already succeeded.
 *
 * The fix is to say something immediately and keep saying it: headers go out at once, then a newline
 * every twenty seconds. `JSON.parse` ignores leading whitespace, so the caller still just reads the
 * final JSON body and nothing about the client had to change.
 */
function holdOpen(res) {
  try {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.flushHeaders && res.flushHeaders();
  } catch (e) { /* the caller may already be gone */ }
  const t = setInterval(() => { try { res.write('\n'); } catch (e) { /* gone */ } }, 20_000);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

async function handleBuild(req, res) {
  // EVERY refusal below happens BEFORE any Codex session exists, and says so: `notStarted: true`,
  // the same fact `/run` already carries for its own pre-spawn refusals (BEA-1394). The repair loop
  // counts attempts against a cause, and a refusal in which Codex was never asked anything must not
  // use one up — the app reads this field instead of parsing error prose (BEA-1577).
  const refuse = (code, error) => { res.statusCode = code; res.end(JSON.stringify({ ok: false, error, notStarted: true })); };
  let body = {};
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ ok: false, error: 'request body too large (8MB max)', notStarted: true }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; }
    if (/socket|aborted|ECONN|hang up/i.test(msg)) return;
    refuse(400, 'bad body'); return;
  }
  const jobId = String(body.jobId || '');
  const brief = String(body.brief || '');
  const jobDir = jobDirOf(jobId);
  if (!jobDir) { refuse(400, 'bad or missing jobId'); return; }
  if (!brief.trim()) { refuse(400, 'no brief'); return; }
  if (live.has(jobId)) { refuse(409, `This job is busy here (${live.get(jobId).kind}) — try again when it settles.`); return; }
  // Checked before the folder is made: a bad file map must not leave a junk version behind.
  let files = [];
  try { files = checkFiles(body.files); }
  catch (e) { refuse(400, String((e && e.message) || e)); return; }

  // A repair starts from the version that broke (BEA-1393): its worker.mjs and its tests are copied
  // into the new folder first, and the app's files land on top. Only a version of THIS job may be
  // copied, and `meta.json` is left behind — the new version has not been built yet, let alone
  // promoted, and a stale meta would make the runner's kit check read the wrong worker's number.
  // This build's own key (BEA-1493). It goes into the Codex child's environment, the MCP server sends
  // it with every try_action, and the trial calls come back attributable to exactly this build — so
  // "what did that build touch?" is a lookup instead of a guess from a time window. Sanitised
  // because it is caller text that becomes an environment variable.
  const buildKey = String(body.buildKey || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 64);
  const copyFrom = body.copyFrom === undefined || body.copyFrom === null ? null : Math.floor(Number(body.copyFrom));
  if (copyFrom !== null && (!Number.isFinite(copyFrom) || copyFrom < 1)) { refuse(400, 'bad copyFrom'); return; }
  const fromDir = copyFrom === null ? null : path.join(jobDir, `v${copyFrom}`);
  if (fromDir && !fs.existsSync(path.join(fromDir, 'worker.mjs'))) { refuse(400, `v${copyFrom} has no worker.mjs — there is nothing to start from.`); return; }

  const version = nextVersion(jobDir);
  const dir = path.join(jobDir, `v${version}`);
  const log = [];
  /** Stops the keepalive that holds the caller's connection open (BEA-1469). Null until it starts. */
  let stopHolding = null;
  // A rolling tail of what the build is saying, so `/build-log` can show it while it runs (BEA-1545).
  const liveEntry = { runId: `build-v${version}`, kind: 'build', startedAt: new Date().toISOString(), kill: () => {}, log: '' };
  liveEntry.append = (chunk) => {
    liveEntry.log = (liveEntry.log + chunk).slice(-BUILD_LOG_TAIL); // keep the END: the newest lines are the ones worth reading
  };
  live.set(jobId, liveEntry);
  try {
    // These three are still BEFORE any Codex session, so they carry `notStarted` too (BEA-1577).
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, version, error: `could not create ${dir}: ${String((e && e.message) || e)}`, notStarted: true }));
      return;
    }
    if (fromDir) {
      try {
        fs.cpSync(fromDir, dir, { recursive: true, filter: (src) => path.basename(src) !== 'meta.json' && !path.basename(src).startsWith('.') });
        log.push(`started from v${copyFrom}`);
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, version, error: `could not copy v${copyFrom}: ${String((e && e.message) || e)}`, notStarted: true }));
        return;
      }
    }
    // The app's own files first (the pinned kit, its docs, the saved answers the tests stand on).
    try {
      const written = writeFiles(dir, files);
      if (written.length) log.push(`wrote ${written.length} file${written.length === 1 ? '' : 's'} from the app: ${written.slice(0, 12).join(', ')}${written.length > 12 ? `, +${written.length - 12} more` : ''}`);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, version, error: `could not write the build's files: ${String((e && e.message) || e)}`, notStarted: true }));
      return;
    }
    // A kit copy on the host is the fallback for a hand-driven build; the app normally sends its own,
    // because the app is the authority on which kit it is running.
    if (!fs.existsSync(path.join(dir, 'kit'))) {
      if (KIT_DIR && fs.existsSync(KIT_DIR)) {
        try { fs.cpSync(KIT_DIR, path.join(dir, 'kit'), { recursive: true }); log.push(`kit pinned from ${KIT_DIR}`); }
        catch (e) { log.push(`kit copy failed: ${String((e && e.message) || e)}`); }
      } else {
        log.push('no kit in the request and no WORKER_KIT_DIR — this build has no parts box');
      }
    }
    /**
     * THE FOLDER DESCRIBES ITSELF AS SOON AS IT EXISTS (BEA-1570).
     *
     * `meta.json` used to be written only by `/promote`, which made it the second half of the same
     * chicken-and-egg as the `current` symlink: the pre-flight check runs BEFORE promotion, so it
     * met a folder with no `meta.json`, could not read its kit version, and refused to start it —
     * *"has no readable meta.json, so its kit version is unknown"*. A first build could still never
     * go live, just one step further along than before.
     *
     * The kit is pinned into the folder right above, so the version already KNOWS its kit here.
     * Writing it now is simply telling the truth earlier. `/promote` still merges whatever the app
     * sends, so nothing it recorded is lost — this only fills in what was missing.
     */
    if (!fs.existsSync(path.join(dir, 'meta.json'))) {
      try {
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
          jobId, version, kit: String(body.kit || KIT_VERSION), builtAt: new Date().toISOString(), promoted: false,
        }, null, 2));
      } catch (e) { log.push(`could not write meta.json: ${String((e && e.message) || e)}`); }
    }
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), brief);

    const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-s', 'workspace-write', '-C', dir];
    if (body.model) args.push('-m', String(body.model));
    // THE BRIEF GOES BY FILE WHEN IT IS BIG (BEA-1503).
    //
    // It used to be pushed as one argv, always. Linux caps a SINGLE argument at 128KB
    // (MAX_ARG_STRLEN), and a brief carries the FULL document of every tool the owner named — and
    // GitHub's document lists 833 actions. The first agent ever built against GitHub produced a
    // 179KB brief and died with `spawn E2BIG`: codex never started, no worker.mjs was written, and
    // the build failed with an error that said nothing whatever about size. Any agent using a large
    // service was simply unbuildable, and nothing said so.
    //
    // BRIEF.md is already written into the build folder on the line above, and `-C dir` makes that
    // the working directory, so a pointer costs nothing. Small briefs still go inline — that is the
    // path every working build so far has taken, and there is no reason to move them off it.
    const ARG_LIMIT = 96_000; // under MAX_ARG_STRLEN, with room for the rest of the command line
    const briefBytes = Buffer.byteLength(brief, 'utf8');
    if (briefBytes > ARG_LIMIT) {
      args.push('Read BRIEF.md in this folder. It is your whole instruction — follow it exactly.');
      log.push(`brief is ${Math.round(briefBytes / 1024)}KB — passed as BRIEF.md rather than on the command line`);
    } else {
      args.push(brief);
    }
    const timeoutMs = Math.min(3_600_000, Math.max(30_000, Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : BUILD_TIMEOUT));
    // From here on the caller waits minutes, so start talking to it NOW (BEA-1469). Everything above
    // is fast and still answers with a real status code; everything below answers 200 with an
    // `ok:false` body, which is what the client already reads.
    stopHolding = holdOpen(res);
    const built = await runCommand('codex', args, dir, timeoutMs, buildKey ? { ...process.env, MYBRAIN_BUILD_KEY: buildKey } : process.env, liveEntry.append);
    const sessionId = sessionIdOf(built.stdout);
    pruneWorkerTrust();
    log.push(built.timedOut ? `codex was stopped after ${Math.round(timeoutMs / 1000)}s` : `codex exited ${built.code}`);
    if (built.stderr.trim()) log.push(built.stderr.trim().slice(-2000));

    const wrote = fs.existsSync(path.join(dir, 'worker.mjs'));
    let tests = null;
    if (wrote && fs.existsSync(path.join(dir, 'worker.test.mjs'))) {
      // The tests run in the SAME box `/parity` measures in (BEA-1401): none of the host's own
      // environment, and no network at all. A generated test that passes because it quietly fetched
      // something live would be worthless as a promotion gate, and the host's environment is full of
      // real keys. The Codex turn above is a different thing — it is a network process by nature,
      // sandboxed by `-s workspace-write` — and that difference is written down in the README.
      const ran = await runCommand(process.execPath, ['--import', noNetworkUrl(), '--test', 'worker.test.mjs'], dir, TEST_TIMEOUT, childEnv(), liveEntry.append);
      tests = parseTap(ran.stdout + ran.stderr) || { passed: 0, failed: ran.code === 0 ? 0 : 1, at: new Date().toISOString() };
      log.push(ran.timedOut ? 'the tests were stopped at the timeout' : `tests exited ${ran.code}`);
      if (ran.stdout.trim()) log.push(ran.stdout.trim().slice(-4000));
    } else if (wrote) {
      log.push('the build wrote no worker.test.mjs');
    } else {
      // SAY WHY, not just what (BEA-1503). "Codex did not write a worker.mjs" was the whole error for
      // a build that never started at all — `spawn E2BIG`, because the brief was too big for one
      // command-line argument. The real cause was in the log and not in the error, which is what made
      // it look like a Codex failure rather than an OS limit.
      const spawnFailed = /spawn \w+|ENOENT|E2BIG|EACCES/.test(String(built.stderr || '') + String(built.error || ''));
      log.push(
        spawnFailed
          ? `codex could not be started at all (${String(built.stderr || built.error || '').trim().slice(0, 200)}) — nothing was built`
          : 'the build wrote no worker.mjs',
      );
    }

    const ok = wrote && !!tests && tests.failed === 0 && tests.passed > 0;
    // No promotion here: moving `current` is the build turn's decision (piece 5, POST /promote), not
    // the runner's — green tests are the only thing that may move a job onto a new worker.
    res.end(JSON.stringify({ ok, version, dir, wrote, tests, sessionId, timedOut: !!built.timedOut, log: log.join('\n').slice(-20_000) }));
  } finally {
    if (stopHolding) stopHolding();
    live.delete(jobId);
  }
}

// ---------------------------------------------------------------------------------------------
// POST /parity — measure ONE version against the saved answers (BEA-1393, the promotion guard).
//
// The app sends the harness (it writes the ruler, never Codex) and the saved answers both versions
// are to be measured on. The version folder itself is never touched: everything happens in a
// throwaway copy that is deleted afterwards, so a live worker cannot be edited by a measurement.
//
// The child gets **no token and no API address**, and the harness replaces `fetch` — a repair loop
// must be unable to spend a single credit, and this is where that is true rather than promised.
// ---------------------------------------------------------------------------------------------
const PARITY_TIMEOUT = Number(process.env.WORKER_PARITY_TIMEOUT_MS || 120_000);
const PARITY_FILE = '.parity.mjs';
const PARITY_MARK = 'PARITY_RESULT ';

/** The harness's own line out of whatever the child printed. Anything else is log. */
function readParity(out) {
  const lines = String(out || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(PARITY_MARK);
    if (at === -1) continue;
    try { return JSON.parse(lines[i].slice(at + PARITY_MARK.length)); } catch (e) { return null; }
  }
  return null;
}

async function handleParity(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ ok: false, error: 'request body too large (8MB max)' }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; }
    if (/socket|aborted|ECONN|hang up/i.test(msg)) return;
    res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad body' })); return;
  }
  const jobId = String(body.jobId || '');
  const jobDir = jobDirOf(jobId);
  const version = Math.floor(Number(body.version));
  const harness = String(body.harness || '');
  if (!jobDir) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad or missing jobId' })); return; }
  if (!Number.isFinite(version) || version < 1) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad or missing version' })); return; }
  if (!harness.trim()) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'no harness' })); return; }
  let files = [];
  try { files = checkFiles(body.files); }
  catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); return; }

  const dir = path.join(jobDir, `v${version}`);
  if (!fs.existsSync(path.join(dir, 'worker.mjs'))) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: `v${version} has no worker.mjs — there is nothing to measure.` })); return; }
  if (live.has(jobId)) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: `This job is busy here (${live.get(jobId).kind}) — try again when it settles.` })); return; }

  const tmp = path.join(jobDir, `.parity-v${version}-${process.pid}-${Date.now()}`);
  const log = [];
  // It holds the job's slot while it measures, like a run or a build does: a /build for the same job
  // starting mid-copy would be copying a folder that is being read.
  live.set(jobId, { runId: `parity-v${version}`, kind: 'parity', startedAt: new Date().toISOString(), kill: () => {} });
  // The answer is built first and sent LAST, after the copy is gone: a caller that reads the reply
  // and then looks at the folder must never see the measurement's leftovers (found by its own test).
  let reply = null;
  let code = 200;
  try {
    fs.cpSync(dir, tmp, { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
    fs.writeFileSync(path.join(tmp, PARITY_FILE), harness);
    const written = writeFiles(tmp, files);
    if (written.length) log.push(`measured against ${written.length} file${written.length === 1 ? '' : 's'} from the app`);
    const timeoutMs = Math.min(600_000, Math.max(5_000, Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : PARITY_TIMEOUT));
    // No token, no API: a parity child cannot call the app, let alone a vendor. (The same small
    // environment a build's tests get — one function, so the two cannot drift apart.)
    const ran = await runCommand(process.execPath, [`--max-old-space-size=${MEMORY_MB}`, PARITY_FILE], tmp, timeoutMs, childEnv());
    const result = readParity(ran.stdout);
    if (ran.timedOut) log.push(`the parity run was stopped after ${Math.round(timeoutMs / 1000)}s`);
    if (ran.stderr.trim()) log.push(ran.stderr.trim().slice(-2000));
    reply = result
      ? { ok: true, version, result, log: log.join('\n').slice(-8000) }
      : { ok: false, version, error: ran.timedOut ? 'the parity run did not finish in time' : 'the parity run said nothing about what it produced', log: log.join('\n').slice(-8000) };
  } catch (e) {
    code = 500;
    reply = { ok: false, version, error: `the parity run could not be set up: ${String((e && e.message) || e)}` };
  } finally {
    live.delete(jobId);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a leftover copy is swept by the next one */ }
    res.statusCode = code;
    res.end(JSON.stringify(reply || { ok: false, version, error: 'the parity run said nothing' }));
  }
}

// ---------------------------------------------------------------------------------------------
// POST /promote — the `current` symlink move, and the same move back for a rollback. The app
// decides (green tests, and only green tests); the runner is the only thing that can touch the
// disk, so it does the move. `meta` is written into the version folder first, so a promoted worker
// is never live for a moment without the facts of how it was built (§D).
// ---------------------------------------------------------------------------------------------
async function handlePromote(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ ok: false, error: 'request body too large (8MB max)' }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; }
    if (/socket|aborted|ECONN|hang up/i.test(msg)) return;
    res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad body' })); return;
  }
  const jobId = String(body.jobId || '');
  const version = Math.floor(Number(body.version));
  const jobDir = jobDirOf(jobId);
  if (!jobDir) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad or missing jobId' })); return; }
  if (!Number.isFinite(version) || version < 1) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad or missing version' })); return; }
  if (live.has(jobId)) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: `This job is busy here (${live.get(jobId).kind}) — nothing was promoted.` })); return; }

  const dir = path.join(jobDir, `v${version}`);
  if (!fs.existsSync(path.join(dir, 'worker.mjs'))) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: `v${version} has no worker.mjs — there is nothing to promote.` }));
    return;
  }
  const previousDir = currentDirOf(jobDir);
  const previous = previousDir ? path.basename(previousDir) : null;
  try {
    if (body.meta && typeof body.meta === 'object') {
      const existing = readMeta(dir) || {};
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...existing, ...body.meta }, null, 2));
    }
    // Atomic: a new symlink under a temporary name, then renamed over `current`. A reader either
    // sees the old version or the new one, never a missing link.
    const tmp = path.join(jobDir, `.current.${process.pid}.${Date.now()}`);
    fs.symlinkSync(`v${version}`, tmp, 'dir');
    fs.renameSync(tmp, path.join(jobDir, 'current'));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: `could not promote v${version}: ${String((e && e.message) || e)}`, previous }));
    return;
  }
  res.end(JSON.stringify({ ok: true, version, previous, dir }));
}

// ---------------------------------------------------------------------------------------------
// POST /remove {jobId} — the housekeeping half of "deleting an agent deletes its worker"
// (BEA-1394 — `specs/AGENT-WORKERS.md` §I). The app owns the rows; the disk is ours, so it asks.
//
// It removes the WHOLE job folder — every version, the `current` symlink, the briefs and the saved
// answers a build was tested against. Idempotent: a job that has no folder is already in the state
// the caller wants, so that answers ok. A job with something running here is refused rather than
// pulled out from under itself — the app deletes the run rows first, so the spawn is already
// orphaned and will die at its timeout, and a second delete of a folder nobody wants is harmless.
// ---------------------------------------------------------------------------------------------
/**
 * STOP a run's worker, now (BEA-1541).
 *
 * The only thing that could ever kill a worker before this was its own timeout. Cancelling in the app
 * changed the database and nothing else, so the process ran to completion — still fetching, still
 * writing to his sheets, still sending WhatsApp messages, minutes after he pressed stop.
 *
 * Kills the whole process GROUP (the worker is spawned detached for exactly this reason), so anything
 * the worker started dies with it. Answers `ok:true, stopped:false` when there was nothing to stop —
 * a run that already finished is not an error, and the caller should not have to care about the race.
 */
/**
 * What a build is saying, WHILE it says it (BEA-1545).
 *
 * A build takes minutes and returned nothing until it finished, so his only signal was a spinner and
 * a guess. This serves the rolling tail the build is writing right now — read-only, no side effects,
 * and it answers `running:false` once the build is over rather than erroring, because "it finished
 * while you were watching" is the normal case, not a fault.
 */
async function handleBuildLog(req, res) {
  const url = new URL(req.url, 'http://x');
  const jobId = String(url.searchParams.get('jobId') || '');
  if (!jobId) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'missing jobId' })); return; }
  const found = live.get(jobId);
  if (!found || found.kind !== 'build') { res.end(JSON.stringify({ ok: true, running: false, log: '' })); return; }
  res.end(JSON.stringify({
    ok: true,
    running: true,
    startedAt: found.startedAt,
    ranForMs: Date.now() - new Date(found.startedAt).getTime(),
    log: String(found.log || ''),
  }));
}

async function handleStop(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ ok: false, error: 'request body too large (8MB max)' }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; }
    if (/socket|aborted|ECONN|hang up/i.test(msg)) return;
    res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad body' })); return;
  }
  const runId = String(body.runId || '');
  if (!runId) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'missing runId' })); return; }
  const found = LIVE.get(runId);
  if (!found) { res.end(JSON.stringify({ ok: true, stopped: false, why: 'nothing of that run is running here' })); return; }
  try { found.kill(); } catch (e) { /* it may have exited between the lookup and the kill */ }
  LIVE.delete(runId);
  log(`stopped run ${runId} on request`);
  res.end(JSON.stringify({ ok: true, stopped: true, jobId: found.jobId, ranForMs: Date.now() - found.startedAt }));
}

async function handleRemove(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ ok: false, error: 'request body too large (8MB max)' }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; }
    if (/socket|aborted|ECONN|hang up/i.test(msg)) return;
    res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad body' })); return;
  }
  const jobId = String(body.jobId || '');
  const jobDir = jobDirOf(jobId);
  // `jobDirOf` is the only path guard there is: the id must match the pattern AND resolve to a direct
  // child of the workers root. Nothing here ever joins a caller's string onto a path by itself.
  if (!jobDir) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad or missing jobId' })); return; }
  if (live.has(jobId)) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: `This job is busy here (${live.get(jobId).kind}) — nothing was removed.` })); return; }
  if (!fs.existsSync(jobDir)) { res.end(JSON.stringify({ ok: true, removed: false, dir: jobDir })); return; }
  try {
    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: `could not remove the worker folder: ${String((e && e.message) || e)}` }));
    return;
  }
  // The build turn prunes these after every build; a removed folder must not leave one behind either.
  pruneWorkerTrust();
  res.end(JSON.stringify({ ok: true, removed: true, dir: jobDir }));
}

/**
 * The shared secret, and it is required (BEA-1401). `/build` runs a Codex session on text the caller
 * sends and `/run` starts a process, so "nothing but this host can reach 172.18.0.1" is not a door.
 * Set `WORKER_RUNNER_TOKEN` here and the same value on the app, which sends it as `x-runner-token`.
 * A runner with no secret set refuses every route but `/status` — it never quietly runs anonymously.
 * `/status` stays open: it is a readiness probe, and it says the door is unlocked rather than hiding it.
 */
function allowed(req) {
  if (!TOKEN) return false;
  const got = String(req.headers['x-runner-token'] || '');
  if (got.length !== TOKEN.length) return false;
  let same = 0;
  for (let i = 0; i < TOKEN.length; i++) same |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return same === 0;
}

/**
 * NODE'S OWN 300-SECOND WALL (BEA-1563).
 *
 * `http.Server.requestTimeout` defaults to 300_000 and closes ANY request that takes longer — which
 * is every real `/run` and `/build` this server exists to serve. It is why raising `DEFAULT_TIMEOUT`
 * to 25 minutes changed nothing: his worker finished the whole job — sheet created, WhatsApp sent —
 * and the app still recorded "the worker runner could not be reached (fetch failed)" at 301 seconds,
 * because Node had hung up on the connection while the work carried on.
 *
 * Both are disabled deliberately. This server's requests are LONG by design, and it is not exposed to
 * the internet — it listens on the Docker bridge behind a shared token. The real protections are the
 * per-run timeout that kills the process group, the app's own client timeout, and the stall watchdog.
 */
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify(await status())); return; }
    // A closed door refused this request before anything at all ran — `notStarted`, so the app can
    // tell it from work that ran and failed (BEA-1577; `/run` says the same inside its own stream).
    if (!TOKEN) { res.statusCode = 401; res.end(JSON.stringify({ error: NO_TOKEN_REASON, notStarted: true })); return; }
    if (!allowed(req)) { res.statusCode = 401; res.end(JSON.stringify({ error: 'this runner needs its shared token', notStarted: true })); return; }
    if (req.method === 'POST' && req.url === '/run') { await handleRun(req, res); return; }
    // Everything below writes to the workers root, so a root it cannot use is a plain refusal with
    // the reason in it — never a half-made version folder, and never a silent success (BEA-1401).
    if (req.method === 'POST' && ['/build', '/promote', '/parity', '/remove'].indexOf(String(req.url)) >= 0) {
      const root = rootState();
      if (!root.ok) { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: `The worker runner cannot use its workers folder — ${root.reason}.`, notStarted: true })); return; }
    }
    if (req.method === 'POST' && req.url === '/build') { await handleBuild(req, res); return; }
    if (req.method === 'POST' && req.url === '/promote') { await handlePromote(req, res); return; }
    if (req.method === 'POST' && req.url === '/parity') { await handleParity(req, res); return; }
    if (req.method === 'GET' && String(req.url).startsWith('/build-log')) { await handleBuildLog(req, res); return; }
    if (req.method === 'POST' && req.url === '/stop') { await handleStop(req, res); return; }
    if (req.method === 'POST' && req.url === '/remove') { await handleRemove(req, res); return; }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    if (res.writableEnded) return;
    if (!res.headersSent) res.statusCode = 500;
    try { res.end(JSON.stringify({ error: String((e && e.message) || e) })); } catch (e2) {}
  }
});

pruneWorkerTrust();
// A run or a build takes minutes on purpose; Node's defaults are written for ordinary web requests.
server.requestTimeout = 0;   // no ceiling on how long one request may take (BEA-1563)
server.headersTimeout = 0;   // and none on how long the headers may take to arrive
server.keepAliveTimeout = 75_000;

server.listen(PORT, HOST, () => {
  console.log(`worker-runner on http://${HOST}:${PORT} — workers in ${ROOT}, callbacks to ${API}, kit v${KIT_VERSION}`);
  // Loud at boot, as well as honest on /status: the two ways this service can be up and useless
  // (BEA-1401). It does not exit — a crash loop hides the reason in a restart storm, and the app's
  // own fallback reads `ready:false` and simply runs the job the old way, saying so on the run.
  const root = rootState();
  if (!root.ok) console.error(`!! worker-runner CANNOT HOLD WORKERS: ${root.reason} — every run and build will be refused until this is fixed`);
  if (!TOKEN) console.error(`!! worker-runner is UNLOCKED and therefore closed: ${NO_TOKEN_REASON}`);
});
