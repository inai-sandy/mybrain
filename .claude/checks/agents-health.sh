#!/usr/bin/env bash
# agents-health.sh — the Agents module, checked every night, without anyone asking.
#
# WHY THIS EXISTS
# The module was verified end to end by hand (BEA-1513, BEA-1524→1531). A verification is a
# photograph: true when it was taken. This turns it into a habit — the same probes, run nightly
# against the live site, so drift shows up on its own instead of the next time someone looks.
#
# It is READ-ONLY. It creates nothing, changes nothing and deletes nothing. The one thing it does
# besides read is send a Telegram message, and only when something is actually wrong.
#
#   agents-health.sh            check, print, alert on failure
#   agents-health.sh --quiet    same, but print only on failure (what cron runs)
#   agents-health.sh --no-alert check and print, never message
#
# Exit 0 = everything healthy.  Exit 1 = something is wrong (and he has been told).

set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-/home/sandy/mybrain}" || exit 1

QUIET=0; ALERT=1
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    --no-alert) ALERT=0 ;;
  esac
done

BASE="$(tr -d '[:space:]' < .claude/checks/live-url 2>/dev/null || echo 'https://mybrain.1site.ai')"
BASE="${BASE%/}"
JAR="$(mktemp)"; TMP="$(mktemp -d)"
trap 'rm -rf "$JAR" "$TMP"' EXIT

PROBLEMS=(); NOTES=()
say() { [ "$QUIET" = "1" ] || echo "$1"; }

# ---------------------------------------------------------------- sign in
# shellcheck disable=SC1091
. .claude/checks/secrets.env 2>/dev/null
if [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
  PROBLEMS+=("no admin credentials on this machine — the check could not sign in")
else
  BODY="$(ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" python3 -c \
    'import json,os;print(json.dumps({"email":os.environ["ADMIN_EMAIL"],"password":os.environ["ADMIN_PASSWORD"]}))')"
  CODE="$(curl -s -c "$JAR" -m 30 -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
    -d "$BODY" -o /dev/null -w '%{http_code}')"
  case "$CODE" in
    200|201) say "  signed in" ;;
    *) PROBLEMS+=("the app refused the health check's login (HTTP $CODE) — everything below is unchecked") ;;
  esac
fi

# Nothing else is meaningful without a session, and a check that silently passes when it could not
# look is the login-wall trap all over again (BEA-1510).
if [ "${#PROBLEMS[@]}" -eq 0 ]; then

  # ------------------------------------------------------------ every agent answers
  curl -s -b "$JAR" -m 60 "$BASE/api/agent/agents" -o "$TMP/agents.json" 2>/dev/null
  N_AGENTS="$(python3 -c "
import json,sys
try:
    d=json.load(open('$TMP/agents.json'))
except Exception:
    print(-1); raise SystemExit
items=d if isinstance(d,list) else d.get('agents',d.get('items',[]))
open('$TMP/ids.txt','w').write(''.join(a['id']+'\n' for a in items))
print(len(items))" 2>/dev/null || echo -1)"

  if [ "$N_AGENTS" -lt 0 ]; then
    PROBLEMS+=("the agents list did not come back as readable JSON")
  else
    say "  $N_AGENTS agents"
    BROKEN=0
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      for path in "" "/worker"; do
        c="$(curl -s -b "$JAR" -o /dev/null -m 30 -w '%{http_code}' "$BASE/api/agent/agents/$id$path")"
        [ "$c" = "200" ] || BROKEN=$((BROKEN+1))
      done
    done < "$TMP/ids.txt"
    [ "$BROKEN" -gt 0 ] && PROBLEMS+=("$BROKEN agent endpoint(s) are not answering")
    say "  agent endpoints not answering: $BROKEN"
  fi

  # ------------------------------------------------------------ data hygiene
  # Read straight from the database: a stuck run or a held lock is invisible over HTTP.
  HYG="$(sudo docker exec mybrain-app node -e '
  const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();
  (async()=>{
    const out={};
    out.stuck   = await p.agentRun.count({where:{status:"running", startedAt:{lt:new Date(Date.now()-6*3600e3)}}});
    out.waits   = await p.waitpoint.count({where:{status:"pending", createdAt:{lt:new Date(Date.now()-24*3600e3)}}});
    out.locks   = await p.jobRunLock.count({where:{expiresAt:{lt:new Date()}}});
    const ids=new Set((await p.agent.findMany({select:{id:true}})).map(a=>a.id));
    out.orphanRuns   = (await p.agentRun.findMany({select:{agentId:true}})).filter(r=>r.agentId&&!ids.has(r.agentId)).length;
    out.orphanBuilds = (await p.workerBuild.findMany({select:{agentId:true}})).filter(b=>!ids.has(b.agentId)).length;
    // A job the SYSTEM switched off and never switched back on (BEA-1514). His own pauses carry no reason.
    out.selfPaused   = await p.agent.count({where:{enabled:false, NOT:{pausedReason:null}}});
    console.log(JSON.stringify(out));
    await p.$disconnect();})();' 2>/dev/null | tail -1)"

  if [ -z "$HYG" ]; then
    NOTES+=("could not read the database directly — hygiene counts were skipped")
  else
    read -r STUCK WAITS LOCKS ORUNS OBUILDS SELFP <<<"$(printf '%s' "$HYG" | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(d['stuck'],d['waits'],d['locks'],d['orphanRuns'],d['orphanBuilds'],d['selfPaused'])")"
    say "  stuck:$STUCK stale-questions:$WAITS expired-locks:$LOCKS orphan-runs:$ORUNS orphan-builds:$OBUILDS self-paused:$SELFP"
    [ "${STUCK:-0}"   -gt 0 ] && PROBLEMS+=("$STUCK run(s) have been 'running' for over 6 hours")
    [ "${WAITS:-0}"   -gt 0 ] && PROBLEMS+=("$WAITS question(s) have been waiting on you for over a day")
    [ "${LOCKS:-0}"   -gt 0 ] && PROBLEMS+=("$LOCKS job lock(s) are past their expiry and still held")
    [ "${ORUNS:-0}"   -gt 0 ] && PROBLEMS+=("$ORUNS run(s) belong to an agent that no longer exists")
    [ "${OBUILDS:-0}" -gt 0 ] && PROBLEMS+=("$OBUILDS worker build(s) belong to an agent that no longer exists")
    # Not a failure — a job CAN legitimately pause itself. It is worth saying, because before
    # BEA-1514 one sat switched off for hours after it had started working again.
    [ "${SELFP:-0}"   -gt 0 ] && NOTES+=("$SELFP job(s) have switched themselves off — check they are not stuck that way")
  fi

  # ------------------------------------------------------------ the worker runner
  RC="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "${WORKER_RUNNER_URL:-http://172.18.0.1:8769}/status" 2>/dev/null)"
  say "  worker runner: HTTP ${RC:-none}"
  [ "$RC" = "200" ] || PROBLEMS+=("the worker runner is not answering (HTTP ${RC:-unreachable}) — worker jobs will fall back to the old road")
fi

# ---------------------------------------------------------------- report
if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  say "== AGENTS HEALTHY =="
  for n in ${NOTES+"${NOTES[@]}"}; do say "   note: $n"; done
  exit 0
fi

echo "== AGENTS NEED ATTENTION =="
for p in "${PROBLEMS[@]}"; do echo "   x $p"; done
for n in ${NOTES+"${NOTES[@]}"}; do echo "   note: $n"; done

# Tell him, in plain words. Only on failure — a nightly "all fine" is noise that gets muted, and a
# muted channel is how the one real alert gets missed.
if [ "$ALERT" = "1" ]; then
  MSG="Agents check found something:"$'\n'
  for p in "${PROBLEMS[@]}"; do MSG="$MSG"$'\n'"• $p"; done
  MSG="$MSG"$'\n\n'"Nothing has been changed — this is a read-only check."
  TOKEN="$(sudo docker exec mybrain-app printenv TELEGRAM_BOT_TOKEN 2>/dev/null | tr -d '\r\n')"
  CHAT="$(sudo docker exec mybrain-app node -e '
    const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();
    (async()=>{const s=await p.setting.findUnique({where:{key:"telegram.chatId"}});
      console.log(s&&s.value?String(s.value).replace(/"/g,""):"");await p.$disconnect();})();' 2>/dev/null | tail -1 | tr -d '\r\n')"
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
    curl -s -m 20 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=${MSG}" -o /dev/null \
      && echo "   (told you on Telegram)"
  else
    echo "   (could not reach Telegram — no token or chat id)"
  fi
fi
exit 1
