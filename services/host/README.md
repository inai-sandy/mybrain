# Host-side engine files (versioned copies)

These files run OUTSIDE the container, on the VPS host. The live copies are:

- `/home/sandy/codex-runner/server.js` — the Codex runner (systemd `codex-runner`, http://172.18.0.1:8765). Restart after editing: `sudo systemctl restart codex-runner` (only when no agent/flow runs are live).
- `/home/sandy/worker-runner/server.js` — the **worker runner** (systemd `mybrain-worker-runner`, http://172.18.0.1:8769). Runs agent workers. Restart after editing: `sudo systemctl restart mybrain-worker-runner` (only when no worker runs are live). Install steps below.
- `/home/sandy/mybrain-mcp/server.mjs` — the `mybrain` MCP server Codex spawns per session (search_brain / save_document / remember / ask_user / get_answer). No restart needed — a fresh copy spawns with each Codex session.
- ~~`/home/sandy/gws-runner/server.js`~~ — the Google Workspace (`gws` CLI) bridge is **retired** (BEA-1351). Google
  reads go through the ServiceProvider seam now (`api/src/google/google-workspace.service.ts`), on the Gmail /
  Drive / Calendar accounts connected at `/tools`. The host process can be stopped and removed once you are
  satisfied: `sudo systemctl disable --now gws-runner`, then revoke the old Google grant for the `gws` CLI in
  your Google account's third-party access page. The app no longer reads `GWS_RUNNER_URL`. **It is still
  listening on 8766**, which is why the worker runner took 8769 instead.

Also required on the host (`~/.codex/config.toml`):

```toml
[mcp_servers.mybrain]
default_tools_approval_mode = "approve"   # BEA-795: without this, codex 0.139+ auto-cancels EVERY MCP tool call in exec mode
command = "/usr/bin/node"
args = ["/home/sandy/mybrain-mcp/server.mjs"]
```

After editing a live host file, copy it back here and commit, so the repo copy never drifts.

---

## The worker runner (BEA-1389)

`worker-runner.server.js` + `mybrain-worker-runner.service`. It runs agent workers — one spawned
`node worker.mjs` per run — and it is the only part of the worker road that can touch a process.

**Ports on this VPS, checked with `ss -ltnp` on 2026-08-22**: 8765 codex-runner · 8766 gws-runner
(retired but still listening) · 8767 gemini-runner · 8768 claude-runner · 8770 agent-helper. The
design proposed 8766; it is **taken**, so the runner is pinned to **8769**. Both sides are
env-overridable: `WORKER_RUNNER_PORT` here, `WORKER_RUNNER_URL` on the app (in `deploy.sh`).

### Routes

| Route | What it does |
| --- | --- |
| `GET /status` | `{installed, version, loggedIn, ready, workdir, runner, engine, kit, api, workers, running}` — the same keys the codex runner answers, so the engine pill can show it unchanged. |
| `POST /run {jobId, runId, token, seed?, kit?, timeoutMs?}` | Spawns `node --max-old-space-size=512 worker.mjs` in `<root>/<jobId>/current`, detached. Answers **ndjson**: `{type:'step', step}` per JSON line the worker prints, `{type:'log', line}` for anything else, and a final `{type:'result', status, rows, error}`. |
| `POST /build {jobId, brief, files?, copyFrom?, model?, timeoutMs?}` | Makes `<root>/<jobId>/vN`, writes the app's `files` into it (the pinned kit, its docs, `plan.json`, the saved answers under `samples/`), writes `BRIEF.md`, runs one fresh `codex exec -s workspace-write -C vN`, then `node --test worker.test.mjs`. Answers `{ok, version, dir, wrote, tests, sessionId, log}`. **It does not promote** — moving `current` is the build turn's call. `copyFrom: <version>` copies that version's folder into the new one first (never its `meta.json`), which is how a **repair** starts from the worker that broke (BEA-1393). |
| `POST /parity {jobId, version, harness, files?, timeoutMs?}` | Measures ONE version against the saved answers, for the repair loop's promotion guard (BEA-1393). The version folder is **copied** to a throwaway `.parity-*` beside it, the app's `harness` is written in as `.parity.mjs`, the app's `files` (the fixtures and `contract.json`) land on top, and `node .parity.mjs` runs there with **no token and no API address**. Answers `{ok, version, result:{ok, error, rows, columns, rowKeys, calls}, log}`. The copy is deleted before the answer is sent, so a caller that reads the reply never sees leftovers. |
| `POST /promote {jobId, version, meta?}` | Writes `meta.json` into `v<version>` (when `meta` is given) and moves the `current` symlink to it, atomically. Answers `{ok, version, previous}`. A **rollback is the same call** with an older version, and it leaves that version's own `meta.json` alone. Refused (400) when the version has no `worker.mjs`, and (409) while the job is busy here. |

A malformed request (bad `jobId`, no `runId`, no token, no brief) is a plain `400`. A request that is
fine but cannot run — no worker installed, kit too new, the job already running here — is a `200`
ndjson stream whose one line is the honest failed result, so the app has one road to parse.

### Rules it keeps

- **It never opens the database.** Everything goes through the app's `/api/worker/*` callback API.
- **The worker's environment is built here, not taken from the request.** `NODE_OPTIONS` is emptied,
  the heap cap and argv are fixed, cwd is pinned to the version folder, there is no shell, and the
  host's own environment is **not** inherited — the run token is the only secret a worker ever sees,
  it is minted per spawn by the app, and it is never written into the worker folder.
- **A timeout kills the process group** (`detached: true`, `kill(-pid)`), so a hung worker's children
  die with it. Default 300 s, ceiling 30 min. The app dropping the connection kills it too — an
  orphan on the host is the runaway-agent family of bugs.
- **A worker built for a newer kit is refused before it is spawned.** `deploy.sh` rolls back by
  re-tagging `mybrain-app:prev` and never touches `/srv/mybrain-workers`, so a rolled-back app can
  meet a newer worker. See DEPLOY.md.
- **One run (or build) per job at a time**, under the app's own per-job lock (BEA-1388).
- **A worker that will not stop talking is cut off** after 2,000 relayed lines (steps, logs and
  stderr share one budget) with a line saying so; the run still settles on the worker's own result.
- **Codex trust entries are pruned** at boot and after every build — a build runs in a new folder
  each time, and `~/.codex/config.toml` would otherwise grow for ever.

### Environment

| Variable | Default | What it is |
| --- | --- | --- |
| `WORKER_RUNNER_HOST` / `WORKER_RUNNER_PORT` | `172.18.0.1` / `8769` | Where it listens (the Docker gateway). |
| `WORKER_ROOT` | `/srv/mybrain-workers` | The version folders (§D). |
| `WORKER_API` | `http://127.0.0.1:3000` | What a worker calls back on. **On this VPS it must be set** (the unit sets it to `https://mybrain.1site.ai`): the app container publishes no host port at all — Caddy reaches it over the Docker network — so a worker on the host cannot call `127.0.0.1:3000`. Confirmed from the host on 2026-08-22. |
| `WORKER_TIMEOUT_MS` / `WORKER_MAX_TIMEOUT_MS` | `300000` / `1800000` | Default and ceiling for a run. |
| `WORKER_BUILD_TIMEOUT_MS` / `WORKER_TEST_TIMEOUT_MS` | `900000` / `120000` | The build turn and its tests. |
| `WORKER_MEMORY_MB` | `512` | `--max-old-space-size`. |
| `WORKER_KIT_VERSION` | `1` | Fallback only — the app sends its own kit version on every `/run`. |
| `WORKER_KIT_DIR` | *(unset)* | A kit copy on the host that `/build` pins into a new version folder. |
| `WORKER_RUNNER_TOKEN` | *(unset)* | Optional shared secret. When set, `/run` and `/build` need `x-runner-token` with the same value (`/status` stays open). Off by default, like every other host runner here — lock it when piece 5 starts sending real briefs to `/build`, and set the same value on the app. |

### Install (needs root — the owner runs this once)

`sandy` has NOPASSWD sudo only for `docker`, so these four steps need the owner:

```bash
# 1. the workers root, owned by the user the service runs as
sudo mkdir -p /srv/mybrain-workers
sudo chown sandy:sandy /srv/mybrain-workers
sudo chmod 755 /srv/mybrain-workers

# 2. the live copy of the service
mkdir -p /home/sandy/worker-runner
cp /home/sandy/mybrain/services/host/worker-runner.server.js /home/sandy/worker-runner/server.js

# 3. the unit
sudo cp /home/sandy/mybrain/services/host/mybrain-worker-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mybrain-worker-runner

# 4. prove it
curl -s http://172.18.0.1:8769/status
systemctl status mybrain-worker-runner --no-pager
```

Until step 1 exists, `/status` answers `installed:false, ready:false` and says so honestly rather
than creating anything itself.

### Updating and rolling back

```bash
# update: copy the repo copy over the live one and restart (only when no worker run is live)
cp /home/sandy/mybrain/services/host/worker-runner.server.js /home/sandy/worker-runner/server.js
sudo systemctl restart mybrain-worker-runner

# roll back: check out the previous repo copy and do the same
git -C /home/sandy/mybrain show <older-sha>:services/host/worker-runner.server.js > /home/sandy/worker-runner/server.js
sudo systemctl restart mybrain-worker-runner
```

Rolling the service back never touches `/srv/mybrain-workers` — the workers themselves are versioned
by their own folders (`current` is a symlink, so a worker rollback is a symlink move).

### How it is proved

`api/src/worker/worker-runner.spec.ts` runs the real file as its own process, against the real
`WorkerController` + `WorkerTokenService` behind a real HTTP listener, with real tokens: steps stream
as they happen, a hung worker is killed at the timeout, a kit-too-new worker is refused unstarted,
and the child's environment is checked from inside the child. It was also driven by hand on the VPS
on 172.18.0.1:8769 with `curl -N` before it shipped.
