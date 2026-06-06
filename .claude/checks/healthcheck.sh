#!/usr/bin/env bash
# healthcheck.sh — confirm My Brain is actually live after deploy.
set -euo pipefail
URL="https://mybrain.1site.ai/api/health"
out="$(mktemp)"
code="$(curl -s -o "$out" -w '%{http_code}' --max-time 30 "$URL" || echo 000)"
if [ "$code" = "200" ] && grep -q '"status":"ok"' "$out"; then
  echo "live: $URL -> 200 ok"
  rm -f "$out"
else
  echo "!! NOT healthy: $URL -> HTTP $code" >&2
  cat "$out" >&2 2>/dev/null || true
  rm -f "$out"
  exit 1
fi
