#!/bin/bash
# Runs on the HOME SERVER (server489 VM) — pulls last night's VPS snapshot, verifies it, keeps history.
# Cron: 3:00 AM IST daily. Pull direction on purpose: a compromised VPS cannot reach these backups.
set -euo pipefail
# MUST be the ssh alias, not vpsbackup@<ip> — the alias in this box's ~/.ssh/config is what supplies
# the IdentityFile (~/.ssh/id_ed25519_vpsbackup). Using the raw user@ip authenticates with no key and
# fails "Permission denied (publickey)". (BEA-982 — the repo copy had drifted from the deployed one.)
VPS=vps-backup
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

# Mirror the VPS's managed Claude Code skill set into THIS machine's skills folder (BEA-982).
# True mirror (--delete) so removals propagate and this box never drifts or collects duplicates.
# GUARD: only ever mirror when the snapshot actually carried a non-empty skills dir — a missing or
# empty snapshot must never be able to wipe the local skills.
SKILLS_SRC="$DEST/skills"
if [ -d "$SKILLS_SRC" ] && [ -n "$(ls -A "$SKILLS_SRC" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.claude/skills"
  rsync -a --delete "$SKILLS_SRC/" "$HOME/.claude/skills/"
  echo "$(date -u +%FT%TZ) skills mirrored ($(ls -1 "$HOME/.claude/skills" | wc -l) skills)"
fi

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
