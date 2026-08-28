#!/usr/bin/env bash
# uicheck.sh — the visual gate. Loads real screens in a real browser at laptop + phone
# width and fails on layout breakage that unit tests and an HTTP 200 cannot see.
#
#   uicheck.sh                 → check every route in .claude/checks/ui-routes
#   uicheck.sh /tasks /people  → check only these routes (what ship.sh passes for one issue)
#
# Exit 0 = clean (warnings may still print).  Exit 1 = a BLOCKING failure.
#
# WHY THE BLOCKING LIST IS SHORT
# Every blocking check below was calibrated against real, known-good pages until it produced
# ZERO false alarms. Checks that could not get there ship as warnings instead. This matters:
# a gate that cries wolf gets switched off, and then there is no gate at all.
# Notably, "text is invisible" and "tap target too small" are NOT blocking — on a Tailwind app
# `display:none` is how responsive design works, and small icons nest inside big tappable
# parents. Both looked like real bugs until they were tested against a good page.
#
# Config (all optional):
#   .claude/checks/live-url        base URL (else $BASE_URL)
#   .claude/checks/ui-routes       one route per line, '#' comments ok
#   .claude/checks/ui-state.json   saved login (cookies + storage), loaded READ-ONLY
#   .claude/checks/vendor/axe.min.js  if present, adds contrast/ARIA checks (warn-only)
#   UI_WIDTHS="1180 390"           viewport widths to test
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" || exit 1

command -v agent-browser >/dev/null 2>&1 || {
  echo "!! uicheck: agent-browser is not installed — cannot verify the UI." >&2; exit 1; }

BASE="${BASE_URL:-}"
[ -z "$BASE" ] && [ -f .claude/checks/live-url ] && BASE="$(tr -d '[:space:]' < .claude/checks/live-url)"
[ -z "$BASE" ] && { echo "!! uicheck: no base URL (.claude/checks/live-url or \$BASE_URL)." >&2; exit 1; }
BASE="${BASE%/}"

WIDTHS="${UI_WIDTHS:-1180 390}"
SHOTDIR=".claude/checks/ui-shots/${UI_LABEL:-latest}"
mkdir -p "$SHOTDIR"

# Routes: arguments win, else the configured list, else just the home page.
ROUTES=()
if [ "$#" -gt 0 ]; then
  ROUTES=("$@")
elif [ -f .claude/checks/ui-routes ]; then
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && ROUTES+=("$line")
  done < .claude/checks/ui-routes
fi
[ "${#ROUTES[@]}" -eq 0 ] && ROUTES=("/")

[ -f .claude/checks/ui-session ] && export AGENT_BROWSER_SESSION_NAME="$(tr -d '[:space:]' < .claude/checks/ui-session)"

AXE=""
[ -f .claude/checks/vendor/axe.min.js ] && AXE=".claude/checks/vendor/axe.min.js"

# Optional CSS selector that only exists when signed in (e.g. the main nav or a sign-out button).
AUTH_MARKER=""
[ -f .claude/checks/ui-auth-marker ] && AUTH_MARKER="$(head -1 .claude/checks/ui-auth-marker)"

# The saved login. `agent-browser close` (below) drops the live session, so without this every
# gate run after the first hits the login wall. Loaded before the first page; re-saved after a
# clean pass because the app's session cookie is a sliding token and a stale file expires.
STATE=".claude/checks/ui-state.json"
# Mint a fresh session before looking (BEA-1510). The saved cookie lasts a few hours, so it expires
# during any long working day — and an expired one makes this gate photograph a login page and fail
# the ship. That happened three times in one day, each fixed by hand. One API call removes the whole
# class of failure. If it cannot log in (no secrets, app down) the old state is left alone and the
# login-wall check below still catches it honestly.
[ -x .claude/checks/refresh-ui-session.sh ] && .claude/checks/refresh-ui-session.sh >/dev/null 2>&1
[ -f "$STATE" ] && agent-browser state load "$STATE" >/dev/null 2>&1 || true

echo "== UI CHECK: ${BASE} =="
echo "   ${#ROUTES[@]} route(s) x widths: ${WIDTHS}"

FAILURES=(); WARNINGS=()

# The in-page probe. Returns JSON. Kept in one place so both widths run identical logic.
probe_js() {
cat <<'PROBE'
(() => {
  const vw = window.innerWidth;
  const o = { vw, docW: document.documentElement.scrollWidth };

  // BLOCKING 1 — the page itself is wider than the screen (the classic phone break).
  o.pageOverflow = o.docW > vw + 2;
  o.widest = [...document.querySelectorAll('body *')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > vw + 2 && r.height > 0; })
    .slice(0, 4)
    .map(el => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
      + ' [' + Math.round(el.getBoundingClientRect().width) + 'px]');

  // BLOCKING 2 — a table wider than its box with nothing to scroll it: columns are simply lost.
  o.clippedTables = [...document.querySelectorAll('table')].filter(t => {
    let a = t.parentElement, scrolls = false;
    while (a) { const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll') { scrolls = true; break; } a = a.parentElement; }
    return t.parentElement && t.scrollWidth > t.parentElement.clientWidth + 2 && !scrolls;
  }).length;

  // BLOCKING 2b — content that starts ON screen and runs OFF it, with nothing to scroll it.
  //
  // This is the bug BLOCKING 1 and 2 both miss, and it has shipped three times in one week: an agent
  // card 478px wide in a 343px grid cell, and a run line pushed to 684px by an unbroken sheet URL.
  // The page does NOT scroll sideways (the overflow is hidden), so BLOCKING 1 passes; it is not a
  // <table>, so BLOCKING 2 passes. The text is simply cut off mid-word and there is no way to read it.
  //
  // Calibration — every clause below exists to stop a false alarm on a known-good page:
  //   left < vw       a drawer/menu parked off-screen STARTS off-screen; this bug starts on-screen.
  //   +8px            rounding and sub-pixel layout, not a real overflow.
  //   no scrolling ancestor   content inside overflow-x:auto is correct by design.
  //   has text        an oversized decorative box nobody reads is not this bug.
  //   visible         display:none is zero-sized; visibility/opacity:0 is deliberate.
  //   not aria-hidden decorative duplicates.
  o.runsOffScreen = [...document.querySelectorAll('main *, [role=main] *')].filter(el => {
    if (!(el.textContent || '').trim()) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.left < vw && r.right > vw + 8)) return false;
    let a = el.parentElement;
    while (a) { const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll') return false; a = a.parentElement; }
    return true;
  }).map(el => Math.round(el.getBoundingClientRect().right) + 'px: ' + (el.textContent || '').trim().slice(0, 40));

  // BLOCKING 3 — nothing actually rendered (white screen of death).
  const bodyText = (document.body.innerText || '').trim();
  o.visibleChars = bodyText.length;
  o.interactive = document.querySelectorAll('a,button,input,select,textarea,[role=button]').length;

  // BLOCKING 4 — we are looking at a login wall instead of the app.
  // Without this, an expired session makes every route "pass" and the gate silently
  // approves broken screens all night. A gate that lies is worse than no gate.
  o.looksLikeLogin = /sign in|sign up|log ?in|please authenticate|unauthorized/i.test(bodyText.slice(0, 400))
    && o.interactive < 8;
  o.marker = null;
  const sel = __AUTH_MARKER__;
  if (sel) { try { o.marker = !!document.querySelector(sel); } catch (e) { o.marker = null; } }

  // WARN — text that occupies space but cannot be read. display:none and visibility:hidden are
  // EXCLUDED on purpose: that is how responsive layouts hide things per breakpoint.
  // opacity:0 with a transition is excluded too — that is a scroll/enter animation mid-flight.
  o.unreadable = [...document.querySelectorAll('h1,h2,h3,h4,p,span,button,a,label,td,th')].filter(el => {
    if (!el.textContent.trim()) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    // NB: transition-property computes to 'all' by default, so it proves nothing.
    // A real transition has a non-zero DURATION.
    const animating = parseFloat(s.transitionDuration) > 0 || s.animationName !== 'none';
    if (parseFloat(s.opacity) === 0 && animating) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    return parseFloat(s.opacity) === 0;
  }).length;

  // WARN — tap targets under the WCAG 2.2 AA floor of 24px. Only the OUTERMOST interactive
  // element counts; an icon nested inside a big link is not a real target.
  o.smallTaps = [...document.querySelectorAll('a,button,input,select,[role=button]')].filter(el => {
    const r = el.getBoundingClientRect();
    if (!r.height || !r.width) return false;
    if (el.parentElement && el.parentElement.closest('a,button,[role=button]')) return false;
    return r.height < 24 || r.width < 24;
  }).length;

  return JSON.stringify(o);
})()
PROBE
}

run_probe() {  # -> raw JSON on stdout
  # The probe is one expression, so the marker selector is substituted into it rather than
  # assigned in a separate statement.
  local marker_js='null'
  [ -n "$AUTH_MARKER" ] && marker_js="$(printf '%s' "$AUTH_MARKER" \
    | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')"
  probe_js | sed "s|__AUTH_MARKER__|${marker_js}|" | agent-browser eval --stdin 2>/dev/null \
    | python3 -c 'import sys,json
raw=sys.stdin.read().strip()
try:
    v=json.loads(raw)
    print(v if isinstance(v,str) else json.dumps(v))
except Exception:
    print("")'
}

for W in $WIDTHS; do
  agent-browser set viewport "$W" 900 >/dev/null 2>&1
  for R in "${ROUTES[@]}"; do
    case "$R" in /*) path="$R" ;; *) path="/$R" ;; esac
    label="$(printf '%s' "$path" | sed 's#[^A-Za-z0-9]#_#g')"
    agent-browser console --clear >/dev/null 2>&1

    if ! agent-browser open "${BASE}${path}" >/dev/null 2>&1; then
      FAILURES+=("[${W}px] ${path} — page did not load at all")
      continue
    fi
    sleep 2

    json="$(run_probe)"
    if [ -z "$json" ]; then
      FAILURES+=("[${W}px] ${path} — could not inspect the page (script error or blank document)")
      continue
    fi

    # agent-browser resolves relative paths against its own temp dir — always pass an absolute one.
    agent-browser screenshot "${PWD}/${SHOTDIR}/${label}-${W}.png" >/dev/null 2>&1

    P_OVER=false; P_DOCW=0; P_VW=0; P_TABLES=0; P_CHARS=0; P_INTER=0; P_UNREAD=0; P_TAPS=0
    P_LOGIN=false; P_MARKER=none; P_WIDEST=""; P_OFFSCR=0; P_OFFSCR_EG=""
    eval "$(printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
g = lambda k, dv=0: d.get(k, dv)
out = [
  "P_OVER=" + str(g("pageOverflow", False)).lower(),
  "P_DOCW=" + str(g("docW")),
  "P_VW=" + str(g("vw")),
  "P_TABLES=" + str(g("clippedTables")),
  "P_CHARS=" + str(g("visibleChars")),
  "P_INTER=" + str(g("interactive")),
  "P_UNREAD=" + str(g("unreadable")),
  "P_TAPS=" + str(g("smallTaps")),
  "P_LOGIN=" + str(g("looksLikeLogin", False)).lower(),
  "P_MARKER=" + ("none" if g("marker", None) is None else str(g("marker")).lower()),
  "P_WIDEST=" + json.dumps(", ".join(g("widest", []))),
  "P_OFFSCR=" + str(len(g("runsOffScreen", []))),
  "P_OFFSCR_EG=" + json.dumps(" | ".join(g("runsOffScreen", [])[:3])),
]
print("\n".join(out))
')"

    # --- blocking ---
    [ "$P_OVER" = "true" ] && \
      FAILURES+=("[${W}px] ${path} — page is wider than the screen (${P_DOCW}px in ${P_VW}px)${P_WIDEST:+ — widest: ${P_WIDEST}}")
    [ "${P_TABLES:-0}" -gt 0 ] && \
      FAILURES+=("[${W}px] ${path} — ${P_TABLES} table(s) cut off with no way to scroll them")
    [ "${P_OFFSCR:-0}" -gt 0 ] && \
      FAILURES+=("[${W}px] ${path} — ${P_OFFSCR} thing(s) start on screen and run off it with no way to scroll: ${P_OFFSCR_EG}")
    if [ "${P_CHARS:-0}" -lt 20 ] && [ "${P_INTER:-0}" -lt 2 ]; then
      FAILURES+=("[${W}px] ${path} — the page rendered essentially nothing (${P_CHARS} characters)")
    fi

    # Are we even logged in? An expired session turns every route into a login page, and a
    # login page passes every layout check — so the gate would report "all clean" while the
    # real screens went unchecked. Treat that as a hard failure, never a pass.
    case "$path" in
      *login*|*signin*|*sign-in*|*register*|*signup*) : ;;   # deliberately testing the login screen
      *)
        if [ "$P_LOGIN" = "true" ]; then
          FAILURES+=("[${W}px] ${path} — hit a LOGIN WALL, not the app. The saved browser session has expired, so nothing here was really checked. Refresh it: AGENT_BROWSER_SESSION_NAME=<name> agent-browser open <site> (log in), then agent-browser state save.")
        elif [ "$P_MARKER" = "false" ]; then
          FAILURES+=("[${W}px] ${path} — the logged-in marker from .claude/checks/ui-auth-marker is missing, so this page was probably not reached as a signed-in user.")
        fi ;;
    esac

    errs="$(agent-browser console 2>/dev/null | grep -ciE '^\[(error|pageerror)\]' || true)"
    [ "${errs:-0}" -gt 0 ] && \
      FAILURES+=("[${W}px] ${path} — ${errs} JavaScript error(s) in the console")

    # --- warnings ---
    [ "${P_UNREAD:-0}" -gt 0 ] && \
      WARNINGS+=("[${W}px] ${path} — ${P_UNREAD} element(s) take up space but can't be read")
    [ "${P_TAPS:-0}" -gt 0 ] && \
      WARNINGS+=("[${W}px] ${path} — ${P_TAPS} tap target(s) under 24px")

    if [ -n "$AXE" ]; then
      a11y="$( { cat "$AXE"; printf '\n(() => { window.__axeReady = true; return "ok"; })()'; } \
        | agent-browser eval --stdin >/dev/null 2>&1
        printf 'axe.run({runOnly:["color-contrast","label","image-alt","button-name","link-name"]}).then(r=>r.violations.length)' \
        | agent-browser eval --stdin 2>/dev/null | tr -dc '0-9')"
      [ -n "$a11y" ] && [ "$a11y" -gt 0 ] && \
        WARNINGS+=("[${W}px] ${path} — ${a11y} accessibility issue(s) (contrast / labels)")
    fi
  done
done

# Keep the login fresh for the next run — only when this run really was signed in.
if [ ${#FAILURES[@]} -eq 0 ] && [ -f "$STATE" ]; then
  agent-browser state save "$STATE" >/dev/null 2>&1 || true
fi
agent-browser close >/dev/null 2>&1 || true

printf '\n'
if [ ${#WARNINGS[@]} -gt 0 ]; then
  echo "WORTH A LOOK:"
  for w in "${WARNINGS[@]}"; do echo "  ! $w"; done
fi
if [ ${#FAILURES[@]} -gt 0 ]; then
  echo "BROKEN (this issue is NOT done):"
  for f in "${FAILURES[@]}"; do echo "  x $f"; done
  echo "   screenshots: ${SHOTDIR}/"
  echo "== UI CHECK FAILED =="
  exit 1
fi
echo "== UI CHECK OK == (${#ROUTES[@]} route(s), widths ${WIDTHS}; screenshots in ${SHOTDIR}/)"
exit 0
