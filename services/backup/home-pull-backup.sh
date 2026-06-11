#!/bin/bash
# Runs on the HOME SERVER (server489 VM) — pulls last night's VPS snapshot, verifies it, keeps history.
# Cron: 3:00 AM IST daily. Pull direction on purpose: a compromised VPS cannot reach these backups.
set -euo pipefail
VPS=vpsbackup@31.97.226.201
BASE=/mnt/hdd/backups/vps
DAY=$(TZ=Asia/Kolkata date +%F)
DEST=$BASE/daily/$DAY
mkdir -p "$DEST"

rsync -a --timeout=120 -e "ssh -o BatchMode=yes" "$VPS:/var/backups/vps-snapshots/$DAY/" "$DEST/"

# Verify: checksums match, archives open, the database is genuinely intact
cd "$DEST"
sha256sum -c MANIFEST.sha256 > /dev/null
gunzip -t rag.sql.gz
TMP=$(mktemp)
gunzip -c mybrain.db.gz > "$TMP"
[ "$(sqlite3 "$TMP" 'PRAGMA integrity_check;')" = "ok" ]
rm -f "$TMP"

# First pull of each month is kept forever
M=$(TZ=Asia/Kolkata date +%Y-%m)
[ -d "$BASE/monthly/$M" ] || cp -r "$DEST" "$BASE/monthly/$M"

# Keep 30 daily snapshots
ls -1d "$BASE"/daily/20* 2>/dev/null | sort | head -n -30 | xargs -r rm -rf

# Tell the VPS the pull succeeded (drives the Telegram watchdog)
ssh -o BatchMode=yes "$VPS" 'touch /var/backups/vps-snapshots/.last-pull-ok'
echo "$(date -u +%FT%TZ) pull+verify ok $DAY"
