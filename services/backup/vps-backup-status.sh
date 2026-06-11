#!/bin/bash
# Mirror backup freshness into the My Brain data volume so the app's watchdog can read it.
set -euo pipefail
DEST=/var/backups/vps-snapshots
LATEST=$(ls -1d "$DEST"/20* 2>/dev/null | sort | tail -1)
SNAP_AT=""; [ -n "$LATEST" ] && SNAP_AT=$(date -u -r "$LATEST" +%FT%TZ)
PULL_AT=""; [ -f "$DEST/.last-pull-ok" ] && PULL_AT=$(date -u -r "$DEST/.last-pull-ok" +%FT%TZ)
printf '{"lastSnapshotAt":"%s","lastPullAt":"%s","updatedAt":"%s"}\n' "$SNAP_AT" "$PULL_AT" "$(date -u +%FT%TZ)" \
  > /var/lib/docker/volumes/mybrain-data/_data/backup-status.json
