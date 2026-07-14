#!/usr/bin/env bash
# deploy.sh — exact steps to put My Brain live on the VPS. The ONLY deploy path (called by ship.sh).
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-/home/sandy/mybrain}"

IMAGE="mybrain-app:latest"
PREV_IMAGE="mybrain-app:prev"
NAME="mybrain-app"
PORT="8080"
CADDYFILE="/opt/beakn-home-visit-app/infra/caddy/Caddyfile"
HEALTH_URL="https://mybrain.1site.ai/api/health"

# Load server-side secrets (admin login, session secret, service keys) — never committed.
if [ -f .claude/checks/secrets.env ]; then set -a; . .claude/checks/secrets.env; set +a; fi

# (Re)create the container from $IMAGE. Used for the normal deploy AND for rollback, so the exact
# run flags live in one place. (BEA-823)
run_container() {
  sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
  sudo docker run -d --name "$NAME" --restart unless-stopped \
    --network mcp-network \
    -v mybrain-data:/app/data \
    -v /var/www/ideas:/var/www/ideas \
    -v /home/sandy/.claude/skills:/scan/sandy/skills \
    -v /home/beakn/.claude/skills:/scan/beakn/skills \
    -v /root/.claude/skills:/scan/root/skills:ro \
    -v /home/sandy/.claude/projects:/scan/sandy/projects:ro \
    -v /home/beakn/.claude/projects:/scan/beakn/projects:ro \
    -v /root/.claude/projects:/scan/root/projects:ro \
    -e SKILLS_SCAN_DIRS="/scan/sandy/skills,/scan/beakn/skills,/scan/root/skills" \
    -e TRANSCRIPT_SCAN_DIRS="/scan/sandy/projects,/scan/beakn/projects,/scan/root/projects" \
    -e DEPLOY_SKILLS_DIRS="sandy:/scan/sandy/skills,beakn:/scan/beakn/skills" \
    -e NODE_ENV=production -e PORT="$PORT" \
    -e IDEAS_MD_DIR="/var/www/ideas" \
    -e GWS_RUNNER_URL="http://172.18.0.1:8766" \
    -e HERMES_URL="${HERMES_URL:-http://172.18.0.1:9119}" \
    -e HERMES_USER="${HERMES_USER:-mybrain}" \
    -e HERMES_PASSWORD="${HERMES_PASSWORD:-}" \
    -e AGENT_HELPER_URL="${AGENT_HELPER_URL:-http://172.18.0.1:8770}" \
    -e AGENT_HELPER_TOKEN="${AGENT_HELPER_TOKEN:-}" \
    -e DATABASE_URL="file:/app/data/mybrain.db" \
    -e ADMIN_EMAIL="${ADMIN_EMAIL:-}" \
    -e ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
    -e SESSION_SECRET="${SESSION_SECRET:-}" \
    -e CONNECTOR_KEY="${CONNECTOR_KEY:-}" \
    -e SUPERMEMORY_API_KEY="${SUPERMEMORY_API_KEY:-}" \
    -e SUPERMEMORY_PROJECT="${SUPERMEMORY_PROJECT:-}" \
    -e RAG_MCP_URL="http://rag-mcp:8050/sse" \
    -e NOTION_TOKEN="${NOTION_TOKEN:-}" \
    -e TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
    -e RAINDROP_TOKEN="${RAINDROP_TOKEN:-}" \
    -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    -e POSTBOX_URL="${POSTBOX_URL:-https://postbox.1site.ai/api}" \
    -e POSTBOX_API_KEY="${POSTBOX_API_KEY:-}" \
    -e POSTBOX_REMINDER_TEMPLATE="${POSTBOX_REMINDER_TEMPLATE:-reminder_nudge_v3}" \
    -e POSTBOX_REMINDER_LANG="${POSTBOX_REMINDER_LANG:-en}" \
    -e REMINDER_TZ_OFFSET_MINUTES="${REMINDER_TZ_OFFSET_MINUTES:-330}" \
    "$IMAGE"
}

ensure_caddy() {
  if ! sudo grep -q 'mybrain.1site.ai' "$CADDYFILE"; then
    echo "!! Caddy route for mybrain.1site.ai missing in $CADDYFILE — add it once, then re-run." >&2
    exit 1
  fi
  sudo docker exec caddy caddy reload -c /etc/caddy/Caddyfile >/dev/null 2>&1 || true
}

# Wait for the live health endpoint to return 200 (the DB-backed readiness check). (BEA-825)
wait_healthy() {
  for _ in $(seq 1 24); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)" = "200" ]; then return 0; fi
    sleep 5
  done
  return 1
}

# Keep the currently-live image as a rollback point BEFORE we overwrite the tag. No-op on first deploy.
if sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
  sudo docker tag "$IMAGE" "$PREV_IMAGE"
fi

echo "-> build image"
# If the build fails, set -e exits here — the running container is untouched, so nothing to roll back.
sudo docker build -t "$IMAGE" .

echo "-> (re)create container on mcp-network"
run_container

echo "-> ensure Caddy route"
ensure_caddy

echo "-> confirm the new container is healthy (roll back if not)"
if wait_healthy; then
  echo "deploy: $NAME is running on mcp-network:$PORT"
else
  echo "!! new container did NOT become healthy — rolling back" >&2
  if sudo docker image inspect "$PREV_IMAGE" >/dev/null 2>&1; then
    sudo docker tag "$PREV_IMAGE" "$IMAGE"
    run_container
    ensure_caddy
    if wait_healthy; then
      echo "!! rolled back to the previous image — the deploy FAILED but the site is back up." >&2
    else
      echo "!! rollback did not become healthy either — manual attention needed." >&2
    fi
  else
    echo "!! no previous image to roll back to — manual attention needed." >&2
  fi
  exit 1
fi
