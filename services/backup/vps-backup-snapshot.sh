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

# 4. Manifest with checksums (lets the home server verify the transfer)
( cd "$OUT" && sha256sum mybrain.db.gz rag.sql.gz restore-secrets.txt > MANIFEST.sha256 )

# 5. Readable by the pull user, writable by nobody but root
chown -R root:vpsbackup "$OUT"
chmod 750 "$OUT"
chmod 640 "$OUT"/*

# 6. Keep only 3 days locally (the home server holds the real history)
find "$DEST" -maxdepth 1 -type d -name '20*' -mtime +3 -exec rm -rf {} +

/usr/local/bin/vps-backup-status.sh
