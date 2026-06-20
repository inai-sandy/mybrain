#!/usr/bin/env bash
# healthcheck.sh — confirm My Brain is actually live after deploy.
# Retries while the freshly-(re)created container boots (~10-15s) so ship.sh doesn't report a
# false 502 the instant after deploy. Fails only if it never comes up within the window.
set -euo pipefail
URL="https://mybrain.1site.ai/api/health"
ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-12}"   # up to ~60s (12 x 5s)
SLEEP="${HEALTHCHECK_SLEEP:-5}"
out="$(mktemp)"

for i in $(seq 1 "$ATTEMPTS"); do
  code="$(curl -s -o "$out" -w '%{http_code}' --max-time 15 "$URL" || echo 000)"
  if [ "$code" = "200" ] && grep -q '"status":"ok"' "$out"; then
    echo "live: $URL -> 200 ok (after ${i} attempt(s))"
    rm -f "$out"
    exit 0
  fi
  echo "   …not ready yet (attempt ${i}/${ATTEMPTS}: HTTP ${code}); waiting ${SLEEP}s"
  sleep "$SLEEP"
done

echo "!! NOT healthy after ${ATTEMPTS} attempts: $URL -> HTTP ${code}" >&2
cat "$out" >&2 2>/dev/null || true
rm -f "$out"
exit 1
