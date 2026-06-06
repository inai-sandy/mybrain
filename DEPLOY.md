# Deploy — captured once, then locked

This is why deploy used to get skipped: it lived in Claude's memory. Now it's a fixed script the machine runs. `ship.sh` calls `.claude/checks/deploy.sh` and `.claude/checks/healthcheck.sh` — and a job can't be marked done unless they succeed.

## One-time setup (do this with the user the first time)
1. Watch/walk through how this project actually goes live on the VPS (srv929020).
2. Write those exact steps into `.claude/checks/deploy.sh` (start from `deploy.sh.example`):
   - push to `main`
   - ssh to the server, pull, rebuild/restart (e.g. `docker compose up -d --build`)
3. Write the live-check into `.claude/checks/healthcheck.sh` (start from `healthcheck.sh.example`): the real URL that should return 200.
4. `chmod +x .claude/checks/deploy.sh .claude/checks/healthcheck.sh`
5. Test it once by hand: `.claude/checks/ship.sh TEST` — confirm it deploys and the health check passes.

After that, deploy is automatic and un-skippable for every issue.
