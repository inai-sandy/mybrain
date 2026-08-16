# Host-side engine files (versioned copies)

These files run OUTSIDE the container, on the VPS host. The live copies are:

- `/home/sandy/codex-runner/server.js` — the Codex runner (systemd `codex-runner`, http://172.18.0.1:8765). Restart after editing: `sudo systemctl restart codex-runner` (only when no agent/flow runs are live).
- `/home/sandy/mybrain-mcp/server.mjs` — the `mybrain` MCP server Codex spawns per session (search_brain / save_document / remember / ask_user / get_answer). No restart needed — a fresh copy spawns with each Codex session.
- `/home/sandy/gws-runner/server.js` — the Google Workspace bridge (systemd `gws-runner`, http://172.18.0.1:8766). It holds the Google login via the `gws` CLI, so the app never sees OAuth tokens.
  - `GET /status`, `POST /gws` (JSON/text), and **`POST /gws-file`** (binary → base64, BEA-1341).
  - `/gws-file` exists because `gws drive files export` never prints the document — it writes a file and prints only a receipt (`{bytes,mimeType,saved_file,status}`). Reading that receipt as content is what made every Google Doc import store the string `[object Object]`. This endpoint passes `-o out.bin` and returns the real bytes. It runs the CLI **inside a fresh temp dir**, because `gws` refuses an `--output` path outside its working directory.
  - Restart: `sudo systemctl restart gws-runner`. Without a password-capable sudo, `kill <pid>` also works — the unit is `Restart=always`.

Also required on the host (`~/.codex/config.toml`):

```toml
[mcp_servers.mybrain]
default_tools_approval_mode = "approve"   # BEA-795: without this, codex 0.139+ auto-cancels EVERY MCP tool call in exec mode
command = "/usr/bin/node"
args = ["/home/sandy/mybrain-mcp/server.mjs"]
```

After editing a live host file, copy it back here and commit, so the repo copy never drifts.
