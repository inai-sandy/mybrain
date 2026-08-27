#!/usr/bin/env bash
# REFRESH THE UI GATE'S LOGIN (BEA-1510)
#
# The gate drives a real browser against the live site with a saved session. That session is a signed
# cookie with a few hours' life, so it expires during any long working day — and when it does, the
# gate correctly refuses to pass (it would otherwise be photographing a login page and calling the UI
# fine). Today that blocked three ships and each was fixed by hand.
#
# This mints a fresh one the same way the app does, straight from the API, and writes it in the
# storage-state shape the browser tool loads. No browser automation, so nothing here can hang on a
# form that moved.
#
# The password is read from secrets.env and never printed.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

STATE=".claude/checks/ui-state.json"
BASE="$(cat .claude/checks/live-url 2>/dev/null || echo 'https://mybrain.1site.ai')"
BASE="${BASE%/}"

# shellcheck disable=SC1091
. .claude/checks/secrets.env 2>/dev/null

if [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "refresh-ui-session: no ADMIN_EMAIL/ADMIN_PASSWORD in .claude/checks/secrets.env" >&2
  exit 1
fi

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

CODE="$(curl -s -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":$(printf '%s' "$ADMIN_EMAIL" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"password\":$(printf '%s' "$ADMIN_PASSWORD" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" \
  -o /dev/null -w '%{http_code}')"

if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
  echo "refresh-ui-session: the app refused the login (HTTP $CODE)" >&2
  exit 1
fi

# Netscape cookie jar -> Playwright storage state. Written via python because the quoting rules of
# both formats are fiddly and a half-written state file fails as a login wall, which is the very
# thing this exists to stop.
JAR="$JAR" STATE="$STATE" python3 <<'PY'
import json, os

cookies = []
for line in open(os.environ['JAR']):
    http_only = line.startswith('#HttpOnly_')
    if http_only:
        line = line[len('#HttpOnly_'):]
    elif line.startswith('#') or not line.strip():
        continue
    parts = line.rstrip('\n').split('\t')
    if len(parts) != 7:
        continue
    domain, _flag, path, secure, expires, name, value = parts
    cookies.append({
        'name': name, 'value': value, 'domain': domain, 'path': path,
        'expires': int(expires) if expires.isdigit() else -1,
        'httpOnly': http_only, 'secure': secure.upper() == 'TRUE', 'sameSite': 'Lax',
    })

if not cookies:
    raise SystemExit('refresh-ui-session: the login returned no cookie')

open(os.environ['STATE'], 'w').write(json.dumps({'cookies': cookies, 'origins': []}, indent=2))
print(f"refresh-ui-session: wrote {len(cookies)} cookie(s) to {os.environ['STATE']}")
PY
