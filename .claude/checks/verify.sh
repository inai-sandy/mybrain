#!/usr/bin/env bash
# Stop hook — during an ACTIVE build, block ending the turn while tests are red.
# Only enforces when a build is in progress (marker file), so ordinary chat is never trapped.
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0
[ -f ".claude/checks/.building" ] || exit 0     # not building → don't gate

# Test command: configured file wins, else auto-detect.
test_cmd=""
[ -f ".claude/checks/test-command" ] && test_cmd="$(cat .claude/checks/test-command)"
if [ -z "$test_cmd" ]; then
  if [ -f package.json ] && grep -q '"test"' package.json; then
    test_cmd="npm test --silent"
  elif { [ -f pytest.ini ] || [ -d tests ]; } && command -v pytest >/dev/null 2>&1; then
    test_cmd="pytest -q"
  fi
fi
[ -z "$test_cmd" ] && exit 0                     # no tests yet → don't gate

if ! eval "$test_cmd" >/tmp/cc-verify.out 2>&1; then
  echo "Tests are failing — fix them before finishing. Last output:" >&2
  tail -n 30 /tmp/cc-verify.out >&2
  exit 2
fi
exit 0
