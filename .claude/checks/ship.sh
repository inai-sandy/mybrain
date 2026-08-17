#!/usr/bin/env bash
# ship.sh <LINEAR-ISSUE-ID> ["commit message"] — the ONLY path to "done".
#
# Fixed order, all-or-nothing. If ANY step fails it exits non-zero and the issue must NOT be closed.
#   1 tests
#   2 standards check
#   3 COMMIT on the work branch      <- so the deployed build provably matches a commit
#   4 deploy to the server
#   5 confirm live
#   6 UI GATE — real browser, laptop + phone widths   <- looks at the screen, not just HTTP 200
#   7 merge into the default branch  <- only after it is proven live AND proven to look right
#   8 push to GitHub
#   9 log it (issue, sha, url, time) + delete the merged work branch
#  10 assert nothing is left behind (clean tree, nothing unpushed)
#
# `ship.sh TEST` = deploy rehearsal only (steps 1,2,4,5,6) — used once at setup to prove
# deploy AND the UI gate both work before they ever guard real work.
#
# Which screens the UI gate checks:
#   UI_ROUTES="/things /things/new" ship.sh ABC-12 "ABC-12: ..."   <- just this issue's screens
#   (unset)                                                        <- every route in .claude/checks/ui-routes
#   UI_ROUTES="-"                                                  <- skip (non-UI issue, e.g. a cron job)
set -euo pipefail
ISSUE="${1:-unknown}"
MSG="${2:-${ISSUE}: ship}"
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

REHEARSAL=0
[ "$ISSUE" = "TEST" ] && REHEARSAL=1

echo "== SHIP ${ISSUE} =="

# Which branch is the "live" one? Ask the remote, then fall back to what exists locally.
default_branch() {
  local b c
  b="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')" || true
  if [ -z "$b" ]; then
    for c in main master; do
      if git show-ref -q --verify "refs/heads/$c"; then b="$c"; break; fi
    done
  fi
  printf '%s' "$b"
}
MAIN="$(default_branch)"
BRANCH="$(git branch --show-current || true)"
[ -z "$MAIN" ] && { echo "!! Can't work out the default branch (no main/master)." >&2; exit 1; }

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

# 3) Commit this issue's work on the work branch ----------------------------
# Done BEFORE deploy: deploy.sh builds from the working folder, so committing first
# guarantees what goes live is exactly what is in the commit.
if [ "$REHEARSAL" = "0" ]; then
  echo "-> commit"
  # The ship log is local machinery, not project code — keep it out of git so step 9's
  # "nothing left behind" check doesn't trip over it.
  if [ ! -f .gitignore ] || ! grep -qxF '.claude/checks/ship-log.tsv' .gitignore; then
    printf '.claude/checks/ship-log.tsv\n' >> .gitignore
  fi
  git add -A
  # Belt and braces: never let a secrets file reach a commit, even by accident.
  secret_re='(^|/)(\.env(\..+)?|secrets\.env|[^/]+\.pem|[^/]+\.key)$'
  if git diff --cached --name-only | grep -Eq "$secret_re"; then
    echo "!! A secrets file is staged:" >&2
    git diff --cached --name-only | grep -E "$secret_re" >&2
    echo "!! Add it to .gitignore and unstage it. Nothing has been committed." >&2
    git reset -q
    exit 1
  fi
  if git diff --cached --quiet; then
    echo "   nothing new to commit (already committed)"
  else
    git commit -q -m "$MSG"
    echo "   committed $(git rev-parse --short HEAD) on ${BRANCH:-detached HEAD}"
  fi
fi

# 4) Deploy to the server  (captured once at setup -> .claude/checks/deploy.sh)
echo "-> deploy"
if [ -x ".claude/checks/deploy.sh" ]; then
  .claude/checks/deploy.sh
else
  echo "!! No deploy.sh configured. Capture the EXACT VPS steps into .claude/checks/deploy.sh (see DEPLOY.md)." >&2
  exit 1
fi

# 5) Confirm it is live  (captured once at setup -> .claude/checks/healthcheck.sh)
if [ -x ".claude/checks/healthcheck.sh" ]; then
  echo "-> confirm live"
  .claude/checks/healthcheck.sh
fi

# 6) UI gate — does it actually LOOK right? --------------------------------
# A health check only proves the server answered. It cannot see a table cut off at phone
# width, a page wider than the screen, a blank render, or a JS error. This can, and a
# failure here means the work does NOT reach the default branch.
UI_STATUS="skipped"
if [ -x ".claude/checks/uicheck.sh" ] && [ "${UI_ROUTES:-}" != "-" ]; then
  echo "-> ui gate (laptop + phone)"
  # shellcheck disable=SC2086
  if UI_LABEL="$ISSUE" .claude/checks/uicheck.sh ${UI_ROUTES:-}; then
    UI_STATUS="passed"
  else
    UI_STATUS="failed"
    echo "!! The UI gate failed — this issue is NOT done." >&2
    if [ -x ".claude/checks/deploy.sh" ] && .claude/checks/deploy.sh --rollback 2>/dev/null; then
      echo "!! Rolled back to the previous build, so the live site is not left looking broken." >&2
    else
      echo "!! NOTE: could not roll back automatically (deploy.sh has no --rollback)." >&2
      echo "!! The site is live with this build. Fix it or roll back by hand." >&2
    fi
    echo "!! Screenshots: .claude/checks/ui-shots/${ISSUE}/" >&2
    exit 1
  fi
fi

if [ "$REHEARSAL" = "1" ]; then
  echo "== REHEARSAL OK: deploy + health check + ui gate (${UI_STATUS}) all work."
  echo "   (No commit/merge/push in TEST mode.) =="
  exit 0
fi

# 7) Merge into the default branch — only now that it is proven live -------
# A failed deploy or health check exits above, so the default branch never gets a broken build.
if [ -n "$BRANCH" ] && [ "$BRANCH" != "$MAIN" ]; then
  echo "-> merge ${BRANCH} -> ${MAIN}"
  git switch -q "$MAIN"
  git merge -q --no-ff -m "Merge ${BRANCH} (${ISSUE})" "$BRANCH"
else
  echo "-> already on ${MAIN}, no merge needed"
fi

# 8) Push to GitHub -------------------------------------------------------
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "!! No 'origin' remote — the work is committed locally but NOT on GitHub." >&2
  echo "!! Create one once, then re-run:  gh repo create <name> --private --source=. --remote=origin --push" >&2
  exit 1
fi
echo "-> push"
git push -q origin "$MAIN"

# 9) Record it, and clean up the work branch ------------------------------
LIVE_URL="-"
[ -f ".claude/checks/live-url" ] && LIVE_URL="$(cat .claude/checks/live-url)"
if [ "$LIVE_URL" = "-" ] && [ -f ".claude/checks/healthcheck.sh" ]; then
  LIVE_URL="$(grep -oEm1 'https://[a-zA-Z0-9./_-]+' .claude/checks/healthcheck.sh || true)"
  [ -z "$LIVE_URL" ] && LIVE_URL="-"
fi
printf '%s\t%s\t%s\t%s\t%s\tui:%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ISSUE" "$(git rev-parse --short HEAD)" "${BRANCH:-$MAIN}" "$LIVE_URL" "$UI_STATUS" \
  >> .claude/checks/ship-log.tsv

if [ -n "$BRANCH" ] && [ "$BRANCH" != "$MAIN" ]; then
  git branch -q -d "$BRANCH" 2>/dev/null || echo "   (work branch ${BRANCH} kept — not fully merged)"
fi

# 10) Assert nothing was left behind -------------------------------------
leftover="$(git status --porcelain)"
if [ -n "$leftover" ]; then
  echo "!! Files are still uncommitted after shipping — this issue is NOT done:" >&2
  echo "$leftover" >&2
  exit 1
fi
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  ahead="$(git rev-list --count '@{u}..HEAD')"
  if [ "$ahead" != "0" ]; then
    echo "!! ${ahead} commit(s) not pushed to GitHub — this issue is NOT done." >&2
    exit 1
  fi
fi

echo "== SHIPPED ${ISSUE} OK == ($(git rev-parse --short HEAD) on ${MAIN}, live: ${LIVE_URL})"
