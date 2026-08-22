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

## Rollback does not roll the workers back (BEA-1389)

`deploy.sh` rolls back by re-tagging `mybrain-app:prev` and re-creating the container. It does **not**
touch `/srv/mybrain-workers`, where the agent workers live (`specs/AGENT-WORKERS.md` §D), and it does
not restart the host services in `services/host/`.

So a rolled-back app can meet a worker that was built against a **newer kit**. The worker runner
checks this before it spawns anything: if `meta.kit`'s major is above the kit version the app sends
on `/run`, it refuses to start the worker and fails the run with a plain sentence ("built for kit v2
and My Brain is on kit v1 … rebuild the worker, or run the job the old way"). Nothing runs half-built
and nothing pretends to have run.

What that means in practice after a rollback: the affected jobs fail honestly and stay on their old
road until the app is forward again or the worker is rebuilt. Nothing to undo by hand.

**A rebuild is a Codex session, so it is never automatic (BEA-1390).** The build turn runs on the
owner's tap (`POST /api/agent/agents/:id/worker/build`) and puts a version live only when that
version's own tests pass — a deploy, a rollback and a restart never build or promote anything. The
kit the build pins comes out of the image (`dist/worker/kit`, copied there by the Dockerfile because
`tsc` does not carry plain files), so an app image and the workers it builds always agree on the kit.
