#!/usr/bin/env bash
# checks.test.sh — locking tests for the ship tooling (BEA-1608). Run by .claude/checks/test-command.
#
# Runs the REAL deploy.sh / ship.sh / uicheck.sh / preflight.sh inside a throwaway project folder,
# with a fake `sudo`, `docker`, `curl`, `sleep` and `agent-browser` first on PATH. The fake docker
# keeps a tiny image table + "which image is the container running"; the fake curl answers 200 only
# when the live image is on the healthy list — so "roll back to a healthy image" is really exercised.
# Nothing here touches the real container.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKS="$(cd "$HERE/.." && pwd)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/       | /'; }
assert_contains() { # haystack needle name
  if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else fail "$3 (expected to see: $2)" "$1"; fi; }
assert_not_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then fail "$3 (must NOT see: $2)" "$1"; else ok "$3"; fi; }
assert_eq() { if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (got '$1', wanted '$2')"; fi; }

# ---- a fresh fake project + fake docker world per scenario ---------------------------------
WORLDS=()
trap 'for w in "${WORLDS[@]:-}"; do [ -n "$w" ] && rm -rf "$w"; done' EXIT
world() {
  T="$(mktemp -d)"; STUB="$T/stub"; BIN="$T/bin"; WORLDS+=("$T")
  mkdir -p "$T/.claude/checks" "$STUB" "$BIN"
  cp "$CHECKS/deploy.sh" "$CHECKS/ship.sh" "$CHECKS/uicheck.sh" "$CHECKS/preflight.sh" "$T/.claude/checks/"
  echo "mybrain.1site.ai { }" > "$T/Caddyfile"
  echo "https://example.invalid" > "$T/.claude/checks/live-url"
  echo "true" > "$T/.claude/checks/test-command"
  : > "$STUB/log"; : > "$STUB/images"; : > "$STUB/healthy"
  ( cd "$T" && git init -q -b main . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )

  cat > "$BIN/sudo" <<'S'
#!/usr/bin/env bash
[ "${1:-}" = "-n" ] && shift
exec "$@"
S
  cat > "$BIN/sleep" <<'S'
#!/usr/bin/env bash
exit 0
S
  cat > "$BIN/curl" <<'S'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$STUB_DIR/log"
id="$(cat "$STUB_DIR/container" 2>/dev/null || true)"
if [ -n "$id" ] && grep -qx "$id" "$STUB_DIR/healthy"; then printf '200'; else printf '000'; fi
S
  cat > "$BIN/agent-browser" <<'S'
#!/usr/bin/env bash
printf 'agent-browser %s\n' "$*" >> "$STUB_DIR/log"
exit 0
S
  cat > "$BIN/docker" <<'S'
#!/usr/bin/env bash
# fake docker: images = "ref id" lines, container = id of the image the container runs.
set -u
printf 'docker %s\n' "$*" >> "$STUB_DIR/log"
IMG="$STUB_DIR/images"; CT="$STUB_DIR/container"
id_of() { awk -v r="$1" '$1==r{print $2}' "$IMG" | tail -1; }
set_id() { grep -v "^$1 " "$IMG" > "$IMG.tmp" || true; echo "$1 $2" >> "$IMG.tmp"; mv "$IMG.tmp" "$IMG"; }
case "${1:-} ${2:-}" in
  "image inspect")
    shift 2; fmt=""; ref=""
    while [ $# -gt 0 ]; do case "$1" in --format) fmt="$2"; shift 2 ;; *) ref="$1"; shift ;; esac; done
    id="$(id_of "$ref")"; [ -z "$id" ] && { echo "Error: No such image: $ref" >&2; exit 1; }
    if [ -n "$fmt" ]; then echo "sha256:$id"; else echo "[{\"Id\":\"sha256:$id\"}]"; fi ;;
  "tag "*)
    id="$(id_of "$2")"; [ -z "$id" ] && { echo "Error: No such image: $2" >&2; exit 1; }; set_id "$3" "$id" ;;
  "build "*)
    shift; ref=""; while [ $# -gt 0 ]; do case "$1" in -t) ref="$2"; shift 2 ;; *) shift ;; esac; done
    set_id "$ref" "${STUB_BUILD_ID:-bbbbbbbbbbbb}" ;;
  "run "*)
    ref="${*: -1}"; id="$(id_of "$ref")"; [ -z "$id" ] && { echo "Unable to find image '$ref'" >&2; exit 125; }
    echo "$id" > "$CT"; echo "containerid" ;;
  "inspect "*)
    [ -f "$CT" ] || { echo "Error: No such object: mybrain-app" >&2; exit 1; }; echo "sha256:$(cat "$CT")" ;;
  "rm "*|"exec "*|"version "*) exit 0 ;;
  *) echo "fake docker: unhandled: $*" >&2; exit 1 ;;
esac
S
  chmod +x "$BIN"/*
  export STUB_DIR="$STUB"
  export CLAUDE_PROJECT_DIR="$T" CADDYFILE="$T/Caddyfile" HEALTH_URL="https://example.invalid/api/health"
  export PATH="$BIN:$PATH"
}
image()     { echo "$1 $2" >> "$STUB/images"; }   # ref id
healthy()   { echo "$1" >> "$STUB/healthy"; }
live()      { cat "$STUB/container" 2>/dev/null || echo none; }
logof()     { cat "$STUB/log"; }
run_deploy() { "$T/.claude/checks/deploy.sh" "$@"; }

PREV=aaaaaaaaaaaa; CUR=cccccccccccc; NEW=bbbbbbbbbbbb

# ============================================================================================
echo "# deploy.sh --rollback with NO previous image"
world; image mybrain-app:latest $CUR; healthy $CUR; echo $CUR > "$STUB/container"
out="$(run_deploy --rollback 2>&1)"; rc=$?
assert_eq "$rc" 2 "exits 2"
assert_contains "$out" "no previous image to roll back to — the site is live with the current build ($CUR)" "says so, with the live image id"
assert_not_contains "$(logof)" "docker run" "never re-created the container"
assert_not_contains "$(logof)" "docker tag" "never touched a tag"
assert_not_contains "$(logof)" "docker build" "never built"
assert_eq "$(live)" "$CUR" "the current build is still live"

echo "# deploy.sh --rollback --dry-run / --check-rollback"
world; image mybrain-app:latest $CUR; image mybrain-app:prev $PREV; healthy $CUR; echo $CUR > "$STUB/container"
out="$(run_deploy --rollback --dry-run 2>&1)"; rc=$?
assert_eq "$rc" 0 "dry run with prev exits 0"
assert_contains "$out" "previous image mybrain-app:prev is present ($PREV); live now: $CUR; nothing was touched" "dry run reports prev"
out="$(run_deploy --check-rollback 2>&1)"; rc=$?
assert_eq "$rc" 0 "--check-rollback exits 0 too"
assert_not_contains "$(logof)" "docker run" "dry run never ran a container"
assert_not_contains "$(logof)" "docker tag" "dry run never re-tagged"
assert_not_contains "$(logof)" "docker build" "dry run never built"
assert_eq "$(live)" "$CUR" "dry run left the live image alone"
world; image mybrain-app:latest $CUR
out="$(run_deploy --rollback --dry-run 2>&1)"; rc=$?
assert_eq "$rc" 2 "dry run with no prev exits 2"
assert_not_contains "$(logof)" "docker run" "…and touches nothing"

echo "# deploy.sh --rollback with a previous image: tag + run + health, no build"
world; image mybrain-app:latest $CUR; image mybrain-app:prev $PREV; healthy $CUR; healthy $PREV; echo $CUR > "$STUB/container"
out="$(run_deploy --rollback 2>&1)"; rc=$?
assert_eq "$rc" 0 "exits 0"
assert_contains "$(logof)" "docker tag mybrain-app:prev mybrain-app:latest" "prev was re-tagged as latest"
assert_contains "$(logof)" "docker run -d --name mybrain-app" "the container was re-created"
assert_contains "$(logof)" "curl -s -o /dev/null -w %{http_code} https://example.invalid/api/health" "health was waited for"
assert_not_contains "$(logof)" "docker build" "nothing was built"
assert_eq "$(live)" "$PREV" "the previous image is live"
assert_contains "$out" "rollback: live is the previous build (image $PREV)" "prints what is live"
order="$(logof | grep -nE 'docker (tag|run)' | head -2 | tr '\n' ' ')"
case "$order" in *"tag mybrain-app:prev"*"docker run"*) ok "tag happened before run" ;; *) fail "tag happened before run" "$order" ;; esac

echo "# deploy.sh --rollback whose container never becomes healthy"
world; image mybrain-app:latest $CUR; image mybrain-app:prev $PREV; healthy $CUR; echo $CUR > "$STUB/container"
out="$(run_deploy --rollback 2>&1)"; rc=$?
assert_eq "$rc" 1 "exits 1"
assert_contains "$out" "did NOT become healthy" "says the rollback did not come up"

echo "# deploy.sh with no argument: unchanged tag dance + build + health"
world; image mybrain-app:latest $CUR; healthy $CUR; healthy $NEW; echo $CUR > "$STUB/container"
out="$(run_deploy 2>&1)"; rc=$?
assert_eq "$rc" 0 "exits 0"
assert_contains "$(logof)" "docker tag mybrain-app:latest mybrain-app:prev" "kept the live image as prev first"
assert_contains "$(logof)" "docker build -t mybrain-app:latest ." "built"
assert_eq "$(awk '$1=="mybrain-app:prev"{print $2}' "$STUB/images")" "$CUR" "prev now holds the old build"
assert_eq "$(live)" "$NEW" "the new build is live"
assert_contains "$out" "deploy: mybrain-app is running on mcp-network:8080" "prints the usual done line"
first="$(logof | grep -E 'docker (tag|build)' | head -1)"
assert_contains "$first" "docker tag mybrain-app:latest mybrain-app:prev" "the tag came before the build"

echo "# deploy.sh with no argument, new build unhealthy: rolls back on its own (as before)"
world; image mybrain-app:latest $CUR; healthy $CUR; echo $CUR > "$STUB/container"
out="$(run_deploy 2>&1)"; rc=$?
assert_eq "$rc" 1 "exits 1"
assert_contains "$out" "rolled back to the previous image — the deploy FAILED but the site is back up" "says so"
assert_eq "$(live)" "$CUR" "the old build is live again"

echo "# deploy.sh --live-image and an unknown option"
world; image mybrain-app:latest $CUR; echo $CUR > "$STUB/container"
assert_eq "$(run_deploy --live-image 2>&1)" "$CUR" "--live-image prints the live id"
out="$(run_deploy --bogus 2>&1)"; rc=$?
assert_eq "$rc" 2 "unknown option exits 2"
assert_not_contains "$(logof)" "docker build" "unknown option never deploys"

# ============================================================================================
echo "# uicheck.sh fails loudly when the login refresh fails, before any screenshot"
world
cat > "$T/.claude/checks/refresh-ui-session.sh" <<'S'
#!/usr/bin/env bash
echo "refresh-ui-session: the app refused the login (HTTP 401)" >&2
exit 1
S
chmod +x "$T/.claude/checks/refresh-ui-session.sh"
out="$(cd "$T" && .claude/checks/uicheck.sh /agent 2>&1)"; rc=$?
assert_eq "$rc" 1 "exits 1"
assert_contains "$out" "== UI CHECK FAILED == (could not log in: refresh-ui-session: the app refused the login (HTTP 401))" "names the refresh's own reason"
assert_not_contains "$(logof)" "agent-browser screenshot" "took no screenshot"
assert_not_contains "$(logof)" "agent-browser open" "never opened a page"

echo "# uicheck.sh carries on when the refresh works"
world
cat > "$T/.claude/checks/refresh-ui-session.sh" <<'S'
#!/usr/bin/env bash
echo "refresh-ui-session: wrote 1 cookie(s)"
S
chmod +x "$T/.claude/checks/refresh-ui-session.sh"
out="$(cd "$T" && .claude/checks/uicheck.sh /agent 2>&1)"
assert_not_contains "$out" "could not log in" "no login complaint"
assert_contains "$(logof)" "agent-browser open https://example.invalid/agent" "went on to open the page"

# ============================================================================================
echo "# ship.sh TEST: the gate fails and the previous build really goes back live"
world; image mybrain-app:latest $CUR; healthy $CUR; healthy $NEW; echo $CUR > "$STUB/container"
cat > "$T/.claude/checks/refresh-ui-session.sh" <<'S'
#!/usr/bin/env bash
echo "refresh-ui-session: the app refused the login (HTTP 401)" >&2
exit 1
S
chmod +x "$T/.claude/checks/refresh-ui-session.sh"
out="$(cd "$T" && UI_ROUTES="/agent" .claude/checks/ship.sh TEST 2>&1)"; rc=$?
assert_eq "$rc" 1 "ship exits 1"
assert_contains "$out" "== UI CHECK FAILED == (could not log in:" "the gate said why it failed"
assert_contains "$out" "roll back the failed build (was image $NEW)" "names the failed build"
assert_contains "$out" "Rolled back — live is the previous build ($CUR)" "says rolled back, with the previous id"
assert_not_contains "$out" "Could NOT roll back" "does not also say it could not"
assert_eq "$(live)" "$CUR" "the previous build IS live"
assert_eq "$(logof | grep -c 'docker build')" "1" "built exactly once (the rollback did not rebuild)"

echo "# ship.sh TEST: the gate fails on a first deploy (no prev) — says it could NOT roll back"
world; healthy $NEW
cat > "$T/.claude/checks/refresh-ui-session.sh" <<'S'
#!/usr/bin/env bash
echo "refresh-ui-session: no ADMIN_EMAIL/ADMIN_PASSWORD in .claude/checks/secrets.env" >&2
exit 1
S
chmod +x "$T/.claude/checks/refresh-ui-session.sh"
out="$(cd "$T" && UI_ROUTES="/agent" .claude/checks/ship.sh TEST 2>&1)"; rc=$?
assert_eq "$rc" 1 "ship exits 1"
assert_contains "$out" "Could NOT roll back — the site is live with THIS build ($NEW)" "says the new build is live"
assert_not_contains "$out" "Rolled back —" "never claims a rollback"
assert_eq "$(live)" "$NEW" "the new build is live"

echo "# ship.sh TEST with an OLD deploy.sh (no --rollback flag): never passes it an argument"
world; healthy $NEW
cat > "$T/.claude/checks/deploy.sh" <<'S'
#!/usr/bin/env bash
# an old-style deploy that parses no arguments: any call is a full deploy
echo "old-deploy args=[$*]" >> "$STUB_DIR/log"
S
chmod +x "$T/.claude/checks/deploy.sh"
cat > "$T/.claude/checks/refresh-ui-session.sh" <<'S'
#!/usr/bin/env bash
echo "refresh-ui-session: the app refused the login (HTTP 401)" >&2
exit 1
S
chmod +x "$T/.claude/checks/refresh-ui-session.sh"
out="$(cd "$T" && UI_ROUTES="/agent" .claude/checks/ship.sh TEST 2>&1)"; rc=$?
assert_eq "$rc" 1 "ship exits 1"
assert_contains "$out" "could not roll back automatically (deploy.sh has no --rollback)" "says the old deploy.sh cannot roll back"
assert_not_contains "$out" "Rolled back —" "never claims a rollback"
assert_eq "$(logof | grep -c 'old-deploy args=')" "1" "the old deploy.sh was called exactly once (the real deploy), never with --rollback or --live-image"
assert_contains "$(logof)" "old-deploy args=[]" "…and with no argument"

# ============================================================================================
echo "# preflight.sh reports the rollback path"
world; image mybrain-app:latest $CUR; image mybrain-app:prev $PREV; echo $CUR > "$STUB/container"
out="$(cd "$T" && .claude/checks/preflight.sh 2>&1)"
assert_contains "$out" "-- rollback ready (prev image present)" "prev present → ready"
world; image mybrain-app:latest $CUR; echo $CUR > "$STUB/container"
out="$(cd "$T" && .claude/checks/preflight.sh 2>&1)"
assert_contains "$out" "  ! no previous image yet — a failed gate could not roll back" "no prev → worth knowing"
blk="$(printf '%s' "$out" | sed -n '/^BLOCKERS/,/^WORTH KNOWING\|^== PREFLIGHT/p' | grep -c 'previous image' || true)"
assert_eq "$blk" "0" "a missing prev is never a blocker"
assert_not_contains "$(logof)" "docker run" "preflight touched nothing"

echo
echo "checks tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
