// gws-runner — a tiny host-side bridge so the containerized My Brain app can drive the host's
// Google Workspace CLI (`gws`), which holds the user's Google login. The app POSTs an argv array;
// we run `gws <argv>` with execFile (no shell, no injection) and return parsed JSON. Bound to the
// Docker gateway so only local containers/host can reach it. Mirrors the codex-runner pattern.
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = process.env.GWS_RUNNER_HOST || '172.18.0.1';
const PORT = Number(process.env.GWS_RUNNER_PORT || 8766);
const GWS = process.env.GWS_BIN || 'gws';
const MAX_ARGV = 40;
// Matches the office-file upload cap in the app (api/src/documents/office-convert.ts).
const MAX_FILE_BYTES = 40 * 1024 * 1024;

function runGws(argv, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(GWS, argv, { timeout, maxBuffer: 24 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      let json = null;
      try { json = JSON.parse(out); } catch { /* not json */ }
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        json,
        text: json ? undefined : out.slice(0, 200000),
        stderr: String(stderr || '').slice(0, 4000),
      });
    });
  });
}

/**
 * Run a gws command that produces BINARY, and return it as base64. (BEA-1341)
 *
 * `gws drive files export|get` never writes the document to stdout — it saves a file and prints only
 * a receipt ({bytes, mimeType, saved_file, status}). The /gws endpoint above stringifies stdout, so
 * that receipt is all the app ever saw, which is how Drive imports ended up storing "[object Object]".
 * Here we pass `-o <tmpfile>` (the CLI's documented flag for binary responses), read the bytes, and
 * hand them back safely encoded. The temp file is always removed, including on failure.
 */
function runGwsToFile(argv, timeout = 120000) {
  return new Promise((resolve) => {
    // gws refuses an --output path outside its working directory ("resolves to ... which is outside
    // the current directory"), so run it INSIDE a throwaway dir and use a relative filename.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-'));
    const tmp = path.join(dir, 'out.bin');
    execFile(GWS, [...argv, '-o', 'out.bin'], { cwd: dir, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let base64 = null;
      let bytes = 0;
      let tooBig = false;
      try {
        const st = fs.statSync(tmp);
        bytes = st.size;
        if (bytes > MAX_FILE_BYTES) tooBig = true;
        else base64 = fs.readFileSync(tmp).toString('base64');
      } catch { /* the command produced no file */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
      resolve({
        ok: !err && !tooBig && bytes > 0,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        bytes,
        tooBig,
        base64,
        stderr: String(stderr || '').slice(0, 4000),
      });
    });
  });
}

async function status() {
  // `gws auth status` emits JSON natively and does NOT accept --format.
  const r = await runGws(['auth', 'status'], 10000);
  const a = r.json || {};
  const connected = !!a.auth_method && a.auth_method !== 'none';
  return { installed: true, connected, authMethod: a.auth_method || 'none', email: a.user || a.email || a.account || null, raw: a, runner: 'ok' };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      b += c;
      // Resolve from the SAME branch that destroys the socket — destroy() means 'end' never fires,
      // so the old code left the promise (and the response) hanging forever.
      if (b.length > 1_000_000) { req.destroy(); finish(''); }
    });
    req.on('end', () => finish(b));
    req.on('error', () => finish(''));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return res.end(JSON.stringify(await status()));
    }
    if (req.method === 'POST' && req.url === '/gws') {
      const body = await readBody(req);
      let argv = [];
      try { argv = JSON.parse(body).argv; } catch { /* ignore */ }
      if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV || argv.some((x) => typeof x !== 'string')) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'bad argv' }));
      }
      return res.end(JSON.stringify(await runGws(argv)));
    }
    // Binary sibling of /gws — same argv contract, returns base64 instead of text. (BEA-1341)
    if (req.method === 'POST' && req.url === '/gws-file') {
      const body = await readBody(req);
      let argv = [];
      try { argv = JSON.parse(body).argv; } catch { /* ignore */ }
      if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV || argv.some((x) => typeof x !== 'string')) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'bad argv' }));
      }
      // This endpoint owns the output flag. A caller-supplied -o would write the bytes somewhere we
      // never read, and the request would fail with a confusing "download failed".
      // Match attached forms too (-oFILE, --output=FILE), not just the bare tokens.
      if (argv.some((a) => /^-o./.test(a) || a === '-o' || /^--output(=|$)/.test(a))) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'argv must not set --output' }));
      }
      return res.end(JSON.stringify(await runGwsToFile(argv)));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});
server.listen(PORT, HOST, () => console.log(`gws-runner on http://${HOST}:${PORT}`));
