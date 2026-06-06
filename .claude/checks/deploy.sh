#!/usr/bin/env bash
# deploy.sh — exact steps to put My Brain live on the VPS. The ONLY deploy path (called by ship.sh).
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-/home/sandy/mybrain}"

IMAGE="mybrain-app:latest"
NAME="mybrain-app"
PORT="8080"
CADDYFILE="/opt/beakn-home-visit-app/infra/caddy/Caddyfile"

# Load server-side secrets (admin login, session secret, service keys) — never committed.
if [ -f .claude/checks/secrets.env ]; then set -a; . .claude/checks/secrets.env; set +a; fi

echo "-> build image"
sudo docker build -t "$IMAGE" .

echo "-> (re)create container on mcp-network"
sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo docker run -d --name "$NAME" --restart unless-stopped \
  --network mcp-network \
  -v mybrain-data:/app/data \
  -e NODE_ENV=production -e PORT="$PORT" \
  -e DATABASE_URL="file:/app/data/mybrain.db" \
  -e ADMIN_EMAIL="${ADMIN_EMAIL:-}" \
  -e ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  -e SESSION_SECRET="${SESSION_SECRET:-}" \
  -e CONNECTOR_KEY="${CONNECTOR_KEY:-}" \
  -e SUPERMEMORY_API_KEY="${SUPERMEMORY_API_KEY:-}" \
  -e SUPERMEMORY_PROJECT="${SUPERMEMORY_PROJECT:-}" \
  -e NOTION_TOKEN="${NOTION_TOKEN:-}" \
  -e TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  -e RAINDROP_TOKEN="${RAINDROP_TOKEN:-}" \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  "$IMAGE"

echo "-> ensure Caddy route"
if ! sudo grep -q 'mybrain.1site.ai' "$CADDYFILE"; then
  echo "!! Caddy route for mybrain.1site.ai missing in $CADDYFILE — add it once, then re-run." >&2
  exit 1
fi
sudo docker exec caddy caddy reload -c /etc/caddy/Caddyfile >/dev/null 2>&1 || true

echo "deploy: $NAME is running on mcp-network:$PORT"
