#!/usr/bin/env bash
# preflight.sh — run BEFORE a build batch starts. Read-only: it changes nothing.
#
# The point: find EVERY missing prerequisite in one pass and print it plainly, so the user is
# asked for all of it once — instead of a batch dying at 2am on a missing login or a missing key.
#
# Exit 0 = clear to build.  Exit 1 = at least one BLOCKER (do not start the batch).
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" || exit 1

BLOCKERS=(); WARNINGS=(); NEEDED=()
block() { BLOCKERS+=("$1"); }
warn()  { WARNINGS+=("$1"); }
need()  { NEEDED+=("$1"); }   # something only the user can give us

echo "== PREFLIGHT: $(basename "$PWD") =="

# --- 1. git + GitHub ------------------------------------------------------
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  block "This folder is not a git repo. Run: git init"
else
  if ! git remote get-url origin >/dev/null 2>&1; then
    block "No GitHub remote ('origin'). ship.sh cannot push. Fix once: gh repo create <name> --private --source=. --remote=origin --push"
  fi
  dirty="$(git status --porcelain | wc -l)"
  [ "$dirty" -gt 0 ] && warn "$dirty file(s) are uncommitted right now — left over from a previous run. Deal with these before starting, or they'll be swept into the first issue's commit."
  br="$(git branch --show-current 2>/dev/null)"
  def="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  [ -z "$def" ] && def="main"
  [ -n "$br" ] && [ "$br" != "$def" ] && warn "You're on branch '$br', not '$def' — an earlier issue may be half-finished."
  if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    ahead="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
    [ "$ahead" != "0" ] && warn "$ahead commit(s) are not on GitHub yet."
  fi
  leftover="$(git branch --format='%(refname:short)' | grep -c '^feature/' || true)"
  [ "$leftover" -gt 0 ] && warn "$leftover leftover feature branch(es) — issues that never finished shipping."
  for pat in '.env' 'secrets.env'; do
    grep -qF "$pat" .gitignore 2>/dev/null || warn "'$pat' is not in .gitignore — secrets could reach GitHub."
  done
fi

if ! command -v gh >/dev/null 2>&1; then
  warn "The 'gh' command isn't installed (only needed to create repos, not to push)."
elif ! gh auth status >/dev/null 2>&1; then
  need "A GitHub login: run 'gh auth login' (pushing will fail until this is done)."
fi

# --- 2. the ship pipeline -------------------------------------------------
[ -x .claude/checks/ship.sh ] || block "Missing .claude/checks/ship.sh — there is no path to 'done'."

if [ ! -f .claude/checks/test-command ]; then
  if [ -f package.json ] && grep -q '"test"' package.json; then
    warn "No .claude/checks/test-command; will fall back to 'npm test'."
  else
    block "No test command. Write it into .claude/checks/test-command — ship.sh refuses to ship without one."
  fi
fi

if [ ! -x .claude/checks/deploy.sh ]; then
  block "No .claude/checks/deploy.sh — deploy has never been captured for this project (see DEPLOY.md). A batch cannot finish an issue."
fi
[ -x .claude/checks/healthcheck.sh ] || warn "No .claude/checks/healthcheck.sh — nothing will confirm the site is actually live."
[ -f .claude/checks/live-url ] || warn "No .claude/checks/live-url — the ship log won't record where it went live."

# --- 3. secrets the deploy needs -----------------------------------------
# Any ${VAR} the deploy script passes through must actually have a value, or the app
# boots half-configured. Ask for all the missing ones at once.
if [ -f .claude/checks/deploy.sh ]; then
  if grep -q 'secrets.env' .claude/checks/deploy.sh && [ ! -f .claude/checks/secrets.env ]; then
    need "The server secrets file .claude/checks/secrets.env is missing (deploy.sh expects it). It holds things like the admin login, session secret and API keys."
  fi
  vars="$(grep -oE '\$\{[A-Z][A-Z0-9_]+' .claude/checks/deploy.sh | sed 's/^\${//' | sort -u)"
  missing=""; optional=""
  for v in $vars; do
    # Skip anything the script sets itself (PORT="8080", CIP="$(docker inspect …)") — not a secret.
    grep -qE "^[[:space:]]*${v}=" .claude/checks/deploy.sh && continue
    val=""
    [ -f .claude/checks/secrets.env ] && [ -r .claude/checks/secrets.env ] && \
      val="$(grep -E "^(export )?${v}=" .claude/checks/secrets.env | head -1 | cut -d= -f2- | tr -d "\"'")"
    [ -z "$val" ] && val="${!v:-}"
    [ -n "$val" ] && continue
    if grep -qE "\\\$\{${v}:-\}" .claude/checks/deploy.sh; then
      optional="$optional $v"          # ${VAR:-}  → tolerated empty, but the feature is dead
    elif grep -qE "\\\$\{${v}:-[^}]" .claude/checks/deploy.sh; then
      continue                          # ${VAR:-sensible-default} → genuinely fine
    else
      missing="$missing $v"             # no default → the deploy will break
    fi
  done
  [ -n "$missing" ] && need "These deploy values MUST have a value or the deploy breaks — put them in .claude/checks/secrets.env:$missing"
  [ -n "$optional" ] && warn "Empty (optional) settings — whatever they switch on simply won't work until you give me the value:$optional"
fi

# --- 4. can we actually deploy? ------------------------------------------
if grep -qE '(^|[^a-z])docker ' .claude/checks/deploy.sh 2>/dev/null; then
  if ! command -v docker >/dev/null 2>&1; then
    block "deploy.sh uses docker, but docker isn't installed here."
  # Test the EXACT command deploy.sh runs. `sudo -n true` is the wrong probe: the sandy account has
  # NOPASSWD scoped to /usr/bin/docker only (/etc/sudoers.d/sandy-docker), so generic sudo is denied
  # while `sudo docker` works — and that mismatch falsely flagged every batch since 2026-08-16.
  elif grep -q 'sudo docker' .claude/checks/deploy.sh && ! sudo -n docker version >/dev/null 2>&1; then
    need "Password-free 'sudo docker' (deploy.sh runs it and would hang overnight waiting for a password)."
  fi
fi
# Can a failed UI gate roll back? ship.sh runs `deploy.sh --rollback` after a gate failure, which needs
# the previous image (mybrain-app:prev) to exist. A read-only dry run says whether it does. A missing
# prev is worth knowing, never a blocker — the first deploy has none. (BEA-1608)
if [ -x .claude/checks/deploy.sh ] && grep -q -- '--rollback' .claude/checks/deploy.sh; then
  rb_rc=0
  rb_out="$(.claude/checks/deploy.sh --rollback --dry-run 2>&1)" || rb_rc=$?
  if [ "$rb_rc" -eq 0 ]; then
    echo "-- rollback ready (prev image present): ${rb_out}"
  elif [ "$rb_rc" -eq 2 ]; then
    warn "no previous image yet — a failed gate could not roll back (the first deploy will create one)."
  else
    warn "could not check the rollback path (deploy.sh --rollback --dry-run exited ${rb_rc}): ${rb_out}"
  fi
elif [ -x .claude/checks/deploy.sh ]; then
  warn "deploy.sh has no --rollback — a failed UI gate would leave the broken build live."
fi
avail="$(df -BG --output=avail . 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ -n "$avail" ]; then
  [ "$avail" -lt 5 ]  && block "Only ${avail}GB disk free — a docker build will fail. Clear space first (/clean-server)."
  [ "$avail" -ge 5 ] && [ "$avail" -lt 15 ] && warn "Only ${avail}GB disk free — docker builds may struggle."
fi

# --- 5. is the base healthy right now? -----------------------------------
if [ -x .claude/checks/healthcheck.sh ]; then
  if HEALTHCHECK_ATTEMPTS=2 HEALTHCHECK_SLEEP=2 .claude/checks/healthcheck.sh >/dev/null 2>&1; then
    echo "-- site is up right now"
  else
    warn "The site is NOT responding before we even start. Fix the base first — otherwise every issue will look broken."
  fi
fi

# --- 6. leftovers --------------------------------------------------------
[ -f .claude/checks/.building ] && warn "A '.building' marker is already here — either another build run is live right now, or a previous one crashed. Don't run two at once in the same folder."

# --- report --------------------------------------------------------------
printf '\n'
if [ ${#NEEDED[@]} -gt 0 ]; then
  echo "NEEDED FROM THE USER (ask for all of these together):"
  for i in "${NEEDED[@]}"; do echo "  * $i"; done
fi
if [ ${#BLOCKERS[@]} -gt 0 ]; then
  echo "BLOCKERS (do not start the batch):"
  for i in "${BLOCKERS[@]}"; do echo "  x $i"; done
fi
if [ ${#WARNINGS[@]} -gt 0 ]; then
  echo "WORTH KNOWING:"
  for i in "${WARNINGS[@]}"; do echo "  ! $i"; done
fi

if [ ${#BLOCKERS[@]} -eq 0 ] && [ ${#NEEDED[@]} -eq 0 ]; then
  [ ${#WARNINGS[@]} -eq 0 ] && echo "ALL CLEAR — everything needed to run a batch is in place."
  echo "== PREFLIGHT OK =="
  exit 0
fi
echo "== PREFLIGHT NOT CLEAR: ${#BLOCKERS[@]} blocker(s), ${#NEEDED[@]} thing(s) needed from the user =="
exit 1
