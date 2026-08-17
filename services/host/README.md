# Host-side engine files (versioned copies)

These files run OUTSIDE the container, on the VPS host. The live copies are:

- `/home/sandy/codex-runner/server.js` — the Codex runner (systemd `codex-runner`, http://172.18.0.1:8765). Restart after editing: `sudo systemctl restart codex-runner` (only when no agent/flow runs are live).
- `/home/sandy/mybrain-mcp/server.mjs` — the `mybrain` MCP server Codex spawns per session (search_brain / save_document / remember / ask_user / get_answer). No restart needed — a fresh copy spawns with each Codex session.
- ~~`/home/sandy/gws-runner/server.js`~~ — the Google Workspace (`gws` CLI) bridge is **retired** (BEA-1351). Google
  reads go through the ServiceProvider seam now (`api/src/google/google-workspace.service.ts`), on the Gmail /
  Drive / Calendar accounts connected at `/tools`. The host process can be stopped and removed once you are
  satisfied: `sudo systemctl disable --now gws-runner`, then revoke the old Google grant for the `gws` CLI in
  your Google account's third-party access page. The app no longer reads `GWS_RUNNER_URL`.

Also required on the host (`~/.codex/config.toml`):

```toml
[mcp_servers.mybrain]
default_tools_approval_mode = "approve"   # BEA-795: without this, codex 0.139+ auto-cancels EVERY MCP tool call in exec mode
command = "/usr/bin/node"
args = ["/home/sandy/mybrain-mcp/server.mjs"]
```

After editing a live host file, copy it back here and commit, so the repo copy never drifts.
