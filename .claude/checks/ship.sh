#!/usr/bin/env bash
# ship.sh <LINEAR-ISSUE-ID> — the ONLY path to "done".
# Runs tests -> standards check -> deploy to server -> confirm live. All-or-nothing.
# If ANY step fails, it exits non-zero and nothing ships: the issue must NOT be closed.
set -euo pipefail
ISSUE="${1:-unknown}"
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

echo "== SHIP ${ISSUE} =="

# 1) Tests  -----------------------------------------------------------------
test_cmd=""
[ -f ".claude/checks/test-command" ] && test_cmd="$(cat .claude/checks/test-command)"
if [ -z "$test_cmd" ] && [ -f package.json ] && grep -q '"test"' package.json; then
  test_cmd="npm test --silent"
fi
if [ -z "$test_cmd" ]; then
  echo "!! No test command configured. Put it in .claude/checks/test-command" >&2
  exit 1
fi
echo "-> tests: $test_cmd"
eval "$test_cmd"

# 2) Standards check (optional, project-specific) ---------------------------
if [ -x ".claude/checks/standards.sh" ]; then
  echo "-> standards check"
  .claude/checks/standards.sh
fi

# 3) Deploy to the server  (captured once at setup -> .claude/checks/deploy.sh)
echo "-> deploy"
if [ -x ".claude/checks/deploy.sh" ]; then
  .claude/checks/deploy.sh
else
  echo "!! No deploy.sh configured. Capture the EXACT VPS steps into .claude/checks/deploy.sh (see DEPLOY.md)." >&2
  exit 1
fi

# 4) Confirm it is live  (captured once at setup -> .claude/checks/healthcheck.sh)
if [ -x ".claude/checks/healthcheck.sh" ]; then
  echo "-> confirm live"
  .claude/checks/healthcheck.sh
fi

echo "== SHIPPED ${ISSUE} OK =="
