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
| `GET /status` | `{installed, version, loggedIn, ready, reason, locked, workdir, runner, engine, kit, api, workers, running}` — the same keys the codex runner answers, so the engine pill can show it unchanged, plus the two BEA-1401 added. **`ready` is a promise, not a hope**: it is false, with `reason` in plain words, when the workers root cannot be created or written, or when no shared secret is set (every route but this one is then refused). The old code answered `ready:true, workers:0` on a root it could not use — a promoted worker simply went invisible and the next build died on EACCES. |
| `POST /run {jobId, runId, token, seed?, kit?, timeoutMs?}` | Spawns `node --max-old-space-size=512 worker.mjs` in `<root>/<jobId>/current`, detached. Answers **ndjson**: `{type:'step', step}` per JSON line the worker prints, `{type:'log', line}` for anything else, and a final `{type:'result', status, rows, error}`. |
| `POST /build {jobId, brief, files?, copyFrom?, model?, timeoutMs?}` | Makes `<root>/<jobId>/vN`, writes the app's `files` into it (the pinned kit, its docs, `plan.json`, the saved answers under `samples/`), writes `BRIEF.md`, runs one fresh `codex exec -s workspace-write -C vN`, then `node --test worker.test.mjs`. Answers `{ok, version, dir, wrote, tests, sessionId, log}`. **It does not promote** — moving `current` is the build turn's call. `copyFrom: <version>` copies that version's folder into the new one first (never its `meta.json`), which is how a **repair** starts from the worker that broke (BEA-1393). |
| `POST /parity {jobId, version, harness, files?, timeoutMs?}` | Measures ONE version against the saved answers, for the repair loop's promotion guard (BEA-1393). The version folder is **copied** to a throwaway `.parity-*` beside it, the app's `harness` is written in as `.parity.mjs`, the app's `files` (the fixtures and `contract.json`) land on top, and `node .parity.mjs` runs there with **no token and no API address**. Answers `{ok, version, result:{ok, error, rows, columns, rowKeys, calls}, log}`. The copy is deleted before the answer is sent, so a caller that reads the reply never sees leftovers. |
| `POST /promote {jobId, version, meta?}` | Writes `meta.json` into `v<version>` (when `meta` is given) and moves the `current` symlink to it, atomically. Answers `{ok, version, previous}`. A **rollback is the same call** with an older version, and it leaves that version's own `meta.json` alone. Refused (400) when the version has no `worker.mjs`, and (409) while the job is busy here. |

| `POST /remove {jobId}` | Deletes the whole job folder — every version, the `current` symlink, the briefs and the saved answers (BEA-1394 §I, "deleting an agent deletes its worker"). Answers `{ok, removed}`; a job with no folder answers `ok` with `removed:false`, because that is already the state the caller wants. Refused (409) while the job is busy here. The app calls it from `deleteAgent`, best effort — a runner that is down never leaves the owner with a job he cannot delete. |

A malformed request (bad `jobId`, no `runId`, no token, no brief) is a plain `400`. A request that is
fine but cannot run — no worker installed, kit too new, the job already running here — is a `200`
ndjson stream whose one line is the honest failed result, so the app has one road to parse. That
line carries **`notStarted: true`** whenever the refusal happened BEFORE the spawn: the dispatch
switch (BEA-1394) reads it to tell "the worker road was unavailable" (run it the old way for this
run) from "the worker ran and failed" (a real failure, and the repair loop's business).

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
- **Every route but `/status` needs the shared secret** (BEA-1401). `/build` starts a Codex session on
  text the caller sends; "only this host can reach 172.18.0.1" is a network fact, not a door. A runner
  started with no `WORKER_RUNNER_TOKEN` answers `401` on all five routes and says so on `/status` —
  it never quietly runs anonymously.
- **A build's tests cannot reach the network, and get none of the host's environment** (BEA-1401) —
  the same guarantee `/parity` has, and true in the same way rather than promised: the child gets the
  small listed environment `childEnv()` builds (no keys, no `MYBRAIN_*`) and is started with
  `node --import <a preload> --test worker.test.mjs`, where the preload replaces `fetch`, the `net`,
  `tls`, `http`, `https` and `dns` entry points with a throw. **The Codex turn itself is NOT
  isolated**, said plainly rather than implied: `codex exec` is a network process by nature, it needs
  the host's Codex login, and it is sandboxed by `-s workspace-write` and pinned to the version
  folder. That is the honest boundary — the model may reach the internet while it writes the worker;
  the tests that decide whether the worker goes live may not.

### Environment

| Variable | Default | What it is |
| --- | --- | --- |
| `WORKER_RUNNER_HOST` / `WORKER_RUNNER_PORT` | `172.18.0.1` / `8769` | Where it listens (the Docker gateway). |
| `WORKER_ROOT` | `/srv/mybrain-workers` | The version folders (§D). The unit sets the same path; the install below creates it owned by `sandy`. If it cannot be created or written, the runner says so on `/status` (`ready:false`) and refuses every route that needs it — it never pretends. |
| `WORKER_API` | `http://127.0.0.1:3000` | What a worker calls back on. **On this VPS it must be set** (the unit sets it to `https://mybrain.1site.ai`): the app container publishes no host port at all — Caddy reaches it over the Docker network — so a worker on the host cannot call `127.0.0.1:3000`. Confirmed from the host on 2026-08-22. |
| `WORKER_TIMEOUT_MS` / `WORKER_MAX_TIMEOUT_MS` | `300000` / `1800000` | Default and ceiling for a run. |
| `WORKER_BUILD_TIMEOUT_MS` / `WORKER_TEST_TIMEOUT_MS` | `900000` / `120000` | The build turn and its tests. |
| `WORKER_MEMORY_MB` | `512` | `--max-old-space-size`. |
| `WORKER_KIT_VERSION` | `1` | Fallback only — the app sends its own kit version on every `/run`. |
| `WORKER_KIT_DIR` | *(unset)* | A kit copy on the host that `/build` pins into a new version folder. |
| `WORKER_RUNNER_TOKEN` | *(unset — and then everything is refused)* | **Required** since BEA-1401. `/run`, `/build`, `/promote`, `/parity` and `/remove` all need `x-runner-token` with this exact value; `/status` stays open, because it is the readiness probe, and it reports `locked` and `ready:false` while the secret is missing. The app sends it from `WORKER_RUNNER_TOKEN` in `.claude/checks/secrets.env` → `deploy.sh`. It is never in git: on the host it lives in `/home/sandy/worker-runner/runner.env` (0600), which the unit reads. |

### Install (needs root — the owner runs this once)

`sandy` has NOPASSWD sudo only for `docker`, so these steps need the owner:

```bash
# 1. the workers root, owned by the user the service runs as
sudo mkdir -p /srv/mybrain-workers
sudo chown sandy:sandy /srv/mybrain-workers
sudo chmod 755 /srv/mybrain-workers

# 2. the live copy of the service
mkdir -p /home/sandy/worker-runner
cp /home/sandy/mybrain/services/host/worker-runner.server.js /home/sandy/worker-runner/server.js

# 3. the shared secret — the SAME value as WORKER_RUNNER_TOKEN in the app's
#    .claude/checks/secrets.env. Never in git, on either side.
printf 'WORKER_RUNNER_TOKEN=%s\n' "$(grep -m1 '^WORKER_RUNNER_TOKEN=' /home/sandy/mybrain/.claude/checks/secrets.env | cut -d= -f2-)" \
  > /home/sandy/worker-runner/runner.env
chmod 600 /home/sandy/worker-runner/runner.env

# 4. the unit
sudo cp /home/sandy/mybrain/services/host/mybrain-worker-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mybrain-worker-runner

# 5. prove it — `ready` must be true, and `reason` must be null
curl -s http://172.18.0.1:8769/status
systemctl status mybrain-worker-runner --no-pager
```

Skip step 1 and the runner is up but honest: `installed:false, ready:false` and a `reason` that names
the folder and the user, with every build and run refused for the same reason. Skip step 3 and it is
`locked:false, ready:false` and every route but `/status` answers `401`. Neither is a silent failure,
and neither is a crash loop — while the runner is not ready, a job's run simply goes the plan
runner's way and says so on the run (the BEA-1394 fallback).

**Until the owner runs this, the runner is started by hand** and uses `/home/sandy/worker-root`
(`/srv` needs root). That is the one root the live process may use before the install; the unit, this
README and the spec all name `/srv/mybrain-workers` for after it:

```bash
cd /home/sandy/worker-runner && WORKER_API=https://mybrain.1site.ai WORKER_ROOT=/home/sandy/worker-root \
  WORKER_RUNNER_TOKEN="$(grep -m1 '^WORKER_RUNNER_TOKEN=' /home/sandy/mybrain/.claude/checks/secrets.env | cut -d= -f2-)" \
  setsid nohup node /home/sandy/worker-runner/server.js >> run.log 2>&1 < /dev/null &
```

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


## Keeping the worker runner alive (BEA-1510)

The runner is the host process that executes agent workers. Started by hand it dies with the box, and
every agent then quietly falls back to the engine road — the fallback working as designed, but not
something to leave running for days.

**The proper way** is the systemd unit beside this file:

```
sudo cp services/host/mybrain-worker-runner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mybrain-worker-runner
```

That needs root. On a box where this account has no passwordless root, `ensure-running.sh` does the
same job from the user's own crontab:

```
@reboot sleep 20 && /home/sandy/worker-runner/ensure-running.sh
*/3 * * * *      /home/sandy/worker-runner/ensure-running.sh
```

`@reboot` covers a restart; the three-minute line covers a crash **and a wedge** — it checks the
PORT, not a process name, because a process that is alive but no longer listening is exactly the case
a `pgrep` would call healthy. If something stale is holding the port it is stopped first, or the new
one dies on `EADDRINUSE` (which happened twice doing this by hand).

It is idempotent: while the runner answers `/status` it does nothing at all, so running it every three
minutes costs one curl. Every start and every failure is written to `run.log` with a timestamp —
a start script that reports nothing is how you end up believing something is running for a week.

**Proved before shipping**: no-op while healthy (same pid before and after), recovers a killed
runner, and clears a wedged process that held the port without answering.

If you later install the systemd unit, remove the two crontab lines — two things restarting one
process would fight over the port.
