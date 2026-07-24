// Codex runner — host-side bridge so the containerized My Brain app can use the host's Codex (on the
// user's ChatGPT subscription). Direct-Codex engine (replaces Hermes).
//   GET  /status                  -> readiness
//   POST /run {prompt, cwd?, sandbox?, model?, sessionId?, addDir?, timeoutMs?}
//        -> { text, sessionId, events, usage }   (sessionId is the thread_id, reuse it to continue a session)
const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = process.env.CODEX_RUNNER_HOST || '172.18.0.1';
const PORT = Number(process.env.CODEX_RUNNER_PORT || 8765);
const WORKDIR = process.env.CODEX_WORKDIR || path.join(os.homedir(), 'brain-agent');
const DEFAULT_TIMEOUT = Number(process.env.CODEX_TURN_TIMEOUT_MS || 240000); // 4 min, matches old bridge
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const SKILLS_BASE = process.env.CODEX_SKILLS_BASE || '/home/sandy/.claude/skills'; // where installed skill folders live

// Codex auto-appends a `[projects."<cwd>"] trust_level="trusted"` entry the first time it runs in a dir.
// Per-run skill workspaces are throwaway, so those entries are dead weight — prune them so config.toml
// can't grow unbounded. Runs at startup (no turn in flight) — safe, best-effort.
function pruneSkillWsTrust() {
  try {
    const cfg = path.join(os.homedir(), '.codex', 'config.toml');
    const txt = fs.readFileSync(cfg, 'utf8');
    const cleaned = txt.replace(/\[projects\."[^"]*skill-ws[^"]*"\]\s*\r?\ntrust_level\s*=\s*"[^"]*"\s*\r?\n?/g, '');
    if (cleaned !== txt) fs.writeFileSync(cfg, cleaned);
  } catch (e) {}
}

function codexVersion() {
  return new Promise((resolve) => {
    execFile('codex', ['--version'], { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}
async function status() {
  const version = await codexVersion();
  const loggedIn = fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
  return { installed: !!version, version: version || null, loggedIn, ready: !!version && loggedIn, workdir: WORKDIR, runner: 'ok', engine: 'codex-direct' };
}
function readBody(req) {
  // BEA-838: an oversized or dropped request must REJECT — destroying the socket without settling
  // the promise left the awaiting handler (and its client) hanging forever.
  return new Promise((resolve, reject) => {
    let b = '';
    let settled = false;
    req.on('data', (c) => {
      b += c;
      // pause (don't destroy) so the route can still deliver a clean 413 before the socket closes
      if (b.length > 8_000_000 && !settled) { settled = true; req.pause(); reject(new Error('body too large')); }
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(b); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e || new Error('socket error')); } });
  });
}

// Run one turn through `codex exec` (or `codex exec resume <id>` to continue). Streams JSONL events on
// stdout; the final answer is written to a temp file via -o. We parse the thread_id (session) + items.
function run(opts) {
  const { prompt } = opts;
  return new Promise((resolve) => {
    let work = opts.cwd && path.isAbsolute(opts.cwd) ? opts.cwd : WORKDIR;
    // Move A: a skill block — copy the skill's real folder (SKILL.md + assets + scripts) into a fresh
    // per-run workspace, run Codex there. The native sandbox refuses file ops here, so skills (trusted,
    // user-installed, on our own host) run with bypass. Workspace is removed after the turn.
    let tempWs = null;
    if (opts.skill) {
      const slug = String(opts.skill).replace(/[^a-zA-Z0-9._-]/g, ''); // no path traversal
      const src = path.join(SKILLS_BASE, slug);
      if (slug && fs.existsSync(src)) {
        // keep the workspace under WORKDIR (a trusted root) so Codex doesn't append a new trust entry per run
        tempWs = path.join(WORKDIR, 'skill-ws', `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
        try { fs.mkdirSync(tempWs, { recursive: true }); fs.cpSync(src, tempWs, { recursive: true }); work = tempWs; }
        catch (e) { try { fs.rmSync(tempWs, { recursive: true, force: true }); } catch (e2) {} tempWs = null; }
      }
    }
    try { if (!fs.existsSync(work)) fs.mkdirSync(work, { recursive: true }); } catch (e) {}
    const out = path.join(os.tmpdir(), `codex-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`);
    // Skills run SANDBOXED (workspace-write: read+write limited to the per-run workspace), not bypass.
    // The native sandbox works now that unprivileged userns is enabled on the host. bypass stays opt-in only.
    const sb = SANDBOXES.has(opts.sandbox) ? opts.sandbox : (tempWs ? 'workspace-write' : 'read-only');
    const bypass = !!opts.bypass;
    // `codex exec resume` inherits the session's cwd + sandbox and rejects -s/-C/-o/--color; it accepts --json.
    let args;
    if (opts.sessionId) {
      args = ['exec', 'resume', '--json', '--skip-git-repo-check'];
      if (opts.model) args.push('-m', String(opts.model));
      args.push(String(opts.sessionId), prompt);
    } else {
      args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never'];
      if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
      else args.push('-s', sb);
      args.push('-C', work, '-o', out);
      if (opts.model) args.push('-m', String(opts.model));
      if (opts.addDir) for (const d of [].concat(opts.addDir)) if (d) args.push('--add-dir', String(d));
      args.push(prompt);
    }

    // detached: codex gets its OWN process group, so a timeout kill takes its tool/sandbox children
    // with it instead of orphaning them on the host (BEA-837; runaway-agent family).
    const child = spawn('codex', args, { cwd: work, env: process.env, detached: true });
    let stdout = '', stderr = '';
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
    let timedOut = false;
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } // negative pid = the whole process group
      catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
    };
    const killer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(killer); resolve({ text: '', error: String((e && e.message) || e) }); });
    child.on('close', (code) => {
      clearTimeout(killer);
      let sessionId = opts.sessionId || null;
      const events = [];
      let usage = null;
      let finalMsg = '';
      for (const line of stdout.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let ev;
        try { ev = JSON.parse(s); } catch (e) { continue; }
        if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
        else if (ev.type === 'turn.completed') usage = ev.usage || null;
        else if (ev.type === 'item.completed' && ev.item) {
          if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') finalMsg = ev.item.text; // keep the last one
          events.push({
            type: ev.item.type,
            name: ev.item.name || ev.item.server || ev.item.tool || undefined,
            text: typeof ev.item.text === 'string' ? ev.item.text.slice(0, 2000) : undefined,
          });
        }
      }
      // prefer the final agent message from the stream (works for resume too); fall back to the -o file
      let text = finalMsg;
      if (!text) { try { text = fs.readFileSync(out, 'utf8'); } catch (e) {} }
      try { fs.unlinkSync(out); } catch (e) {}
      if (tempWs) { try { fs.rmSync(tempWs, { recursive: true, force: true }); } catch (e) {} } // clean the per-run skill workspace
      const error = timedOut
        ? 'The model took too long and was stopped.'
        : (!text && code !== 0 ? (stderr.trim() || `codex exited with code ${code}`).slice(0, 800) : null);
      resolve({ text: String(text || '').trim(), sessionId, events, usage, error });
    });
    if (child.stdin) child.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/status') {
    try { res.end(JSON.stringify(await status())); }
    catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String((e && e.message) || e) })); }
    return;
  }
  if (req.method === 'POST' && req.url === '/run') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); }
    catch (e) {
      const msg = String((e && e.message) || '');
      if (/too large/.test(msg)) { res.statusCode = 413; try { res.end(JSON.stringify({ error: 'request body too large (8MB max)' }), () => req.destroy()); } catch (e2) { try { req.destroy(); } catch (e3) {} } return; } // BEA-838
      if (/socket|aborted|ECONN|hang up/i.test(msg)) return; // client vanished — nothing to answer
      // plain bad JSON falls through with {} and gets the usual 400 below
    }
    const prompt = body && body.prompt ? String(body.prompt) : '';
    if (!prompt) { res.statusCode = 400; res.end(JSON.stringify({ error: 'no prompt' })); return; }
    const r = await run(body);
    if (!r.text && r.error) { res.statusCode = 500; res.end(JSON.stringify({ error: r.error, sessionId: r.sessionId || null })); return; }
    res.end(JSON.stringify({ text: r.text, sessionId: r.sessionId || null, events: r.events || [], usage: r.usage || null }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});
pruneSkillWsTrust();
server.listen(PORT, HOST, () => console.log(`codex-runner (direct) on http://${HOST}:${PORT}`));
