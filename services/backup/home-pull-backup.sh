#!/bin/bash
# Runs on the HOME SERVER (server489 VM) — pulls last night's VPS snapshot, verifies it, keeps history.
# Cron: 3:00 AM IST daily. Pull direction on purpose: a compromised VPS cannot reach these backups.
set -euo pipefail
VPS=vpsbackup@31.97.226.201
BASE=/mnt/hdd/backups/vps
DAY=$(TZ=Asia/Kolkata date +%F)
DEST=$BASE/daily/$DAY

# Telegram report via the My Brain app — secret lives in ~/.config/vps-backup.env (REPORT_SECRET=...)
REPORT_URL=https://mybrain.1site.ai/api/telegram/backup-report
[ -f "$HOME/.config/vps-backup.env" ] && . "$HOME/.config/vps-backup.env"
report() { # $1 = true|false, $2 = detail
  curl -s -m 20 -X POST "$REPORT_URL" -H 'Content-Type: application/json' \
    -d "{\"secret\":\"${REPORT_SECRET:-}\",\"ok\":$1,\"detail\":\"$2\"}" > /dev/null || true
}
trap 'report false "pull failed at line $LINENO on $DAY — see pull-vps-backup.log on the home server"' ERR

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
SIZE=$(du -sh "$DEST" | cut -f1)
report true "My Brain + RAG for $DAY, $SIZE, integrity checked"
echo "$(date -u +%FT%TZ) pull+verify ok $DAY ($SIZE)"
