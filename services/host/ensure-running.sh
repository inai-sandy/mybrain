#!/usr/bin/env bash
# MAKE THE WORKER RUNNER SURVIVE A REBOOT — AND A CRASH (BEA-1510)
#
# The runner is the host process that actually executes agent workers. Until now it was started by
# hand, so a reboot silently ended it: every agent quietly fell back to the engine road and said so on
# the run, which is the fallback working as designed but is not what he wants running for days.
#
# The proper home for this is the systemd unit already in the repo
# (services/host/mybrain-worker-runner.service) — installing it needs root, which this account does
# not have without a password. Cron does not, and it buys one thing systemd would have given anyway:
# run from @reboot AND every few minutes, this restarts the runner after a crash too.
#
# Idempotent on purpose. It is safe to run every minute, and safe to run while the runner is healthy:
# it does nothing at all unless the port is actually dead.

set -uo pipefail

HOST="${WORKER_RUNNER_HOST:-172.18.0.1}"
PORT="${WORKER_RUNNER_PORT:-8769}"
DIR="/home/sandy/worker-runner"
LOG="$DIR/run.log"

log() { printf '%s ensure: %s\n' "$(date -Is)" "$1" >>"$LOG"; }

# Already answering? Then there is nothing to do. Checking the PORT rather than a process name is
# deliberate — a process that is alive but wedged and not listening is the case that matters, and a
# pgrep would call that healthy.
if curl -sf -m 5 "http://$HOST:$PORT/status" >/dev/null 2>&1; then
  exit 0
fi

# It is not answering. If a stale process is still holding the port, it has to go first, or the new
# one dies on EADDRINUSE — which is exactly what happened twice by hand.
STALE="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)"
if [ -n "${STALE:-}" ]; then
  log "port $PORT held by pid $STALE but not answering — stopping it"
  kill "$STALE" 2>/dev/null
  sleep 3
  kill -9 "$STALE" 2>/dev/null
  sleep 1
fi

# The secret lives in a file that is never in git. Without it the runner still starts and says on
# /status that it is closed, rather than running anonymously — so a missing file is not fatal here.
set -a
# shellcheck disable=SC1091
[ -f "$DIR/runner.env" ] && . "$DIR/runner.env"
set +a

export WORKER_RUNNER_HOST="$HOST"
export WORKER_RUNNER_PORT="$PORT"
export WORKER_ROOT="${WORKER_ROOT:-/srv/mybrain-workers}"
export WORKER_API="${WORKER_API:-https://mybrain.1site.ai}"

log "starting the runner"
# setsid so it outlives the cron shell; nohup so a closed stdout cannot kill it.
setsid nohup /usr/bin/node "$DIR/server.js" >>"$LOG" 2>&1 </dev/null &

# Confirm it really came up, and say so either way. A start script that reports nothing is how you end
# up believing something is running for a week.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -sf -m 5 "http://$HOST:$PORT/status" >/dev/null 2>&1; then
    log "runner is up on $HOST:$PORT"
    exit 0
  fi
done

log "runner did NOT come up within 10s — see the lines above"
exit 1
