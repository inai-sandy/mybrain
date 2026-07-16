#!/bin/bash
# Nightly data snapshot for off-server backup (pulled by the home server).
# Snapshots: My Brain SQLite DB, RAG Postgres, and the container envs needed to restore.
set -euo pipefail
DEST=/var/backups/vps-snapshots
DAY=$(TZ=Asia/Kolkata date +%F)
OUT="$DEST/$DAY"
mkdir -p "$OUT"

# 1. My Brain SQLite — online-safe .backup, then compress
sqlite3 /var/lib/docker/volumes/mybrain-data/_data/mybrain.db ".backup '$OUT/mybrain.db'"
gzip -f "$OUT/mybrain.db"

# 2. RAG memories — Postgres dump
docker exec rag-postgres pg_dump -U rag rag | gzip > "$OUT/rag.sql.gz"

# 3. Restore secrets — container envs (incl. CONNECTOR_KEY); without these a restored DB can't decrypt its connectors
{
  echo "# mybrain-app env ($DAY)"
  docker inspect mybrain-app --format '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}'
  echo "# rag-mcp env"
  docker inspect rag-mcp --format '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}'
} > "$OUT/restore-secrets.txt"

# 4. Recordings audio (BEA-976): chunks written in the last 2 days ride each day's snapshot.
#    Chunk files are immutable once written, so the home server's day archive accumulates the
#    complete history even though the VPS prunes chunks after 90 days.
REC=/var/lib/docker/volumes/mybrain-data/_data/recordings
if [ -d "$REC" ] && find "$REC" -type f -mtime -2 | grep -q .; then
  mkdir -p "$OUT/recordings"
  ( cd "$REC" && find . -type f -mtime -2 -print0 | rsync -a --files-from=- --from0 . "$OUT/recordings/" )
fi

# 5. Claude Code skills (BEA-982) — the managed skill set. Rides the snapshot so it is both backed up
#    off-server AND available for the home server to mirror into its own ~/.claude/skills.
SKILLS=/home/sandy/.claude/skills
if [ -d "$SKILLS" ] && [ -n "$(ls -A "$SKILLS" 2>/dev/null)" ]; then
  mkdir -p "$OUT/skills"
  rsync -a --delete "$SKILLS/" "$OUT/skills/"
fi

# 6. Manifest with checksums (lets the home server verify the transfer)
( cd "$OUT" && sha256sum mybrain.db.gz rag.sql.gz restore-secrets.txt > MANIFEST.sha256 )
if [ -d "$OUT/recordings" ]; then
  ( cd "$OUT" && find recordings -type f -exec sha256sum {} + >> MANIFEST.sha256 )
fi
if [ -d "$OUT/skills" ]; then
  ( cd "$OUT" && find skills -type f -exec sha256sum {} + >> MANIFEST.sha256 )
fi

# 7. Readable by the pull user, writable by nobody but root
chown -R root:vpsbackup "$OUT"
chmod 750 "$OUT"
chmod 640 "$OUT"/*
# Directories need 750 (traversable) — the blanket 640 above would otherwise make them unreadable.
for sub in recordings skills; do
  if [ -d "$OUT/$sub" ]; then
    find "$OUT/$sub" -type d -exec chmod 750 {} +
    find "$OUT/$sub" -type f -exec chmod 640 {} +
  fi
done

# 8. Keep only 3 days locally (the home server holds the real history)
find "$DEST" -maxdepth 1 -type d -name '20*' -mtime +3 -exec rm -rf {} +

/usr/local/bin/vps-backup-status.sh
