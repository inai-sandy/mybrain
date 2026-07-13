# Off-server backups — VPS → home server

Nightly pipeline protecting the My Brain + RAG data:

1. **2:30 AM IST, VPS** (`vps-backup-snapshot.sh`, root cron): sqlite `.backup` of mybrain.db,
   `pg_dump` of the RAG database, container envs needed for restore (incl. CONNECTOR_KEY),
   sha256 manifest. Kept 3 days locally in `/var/backups/vps-snapshots/<date>/`, readable only
   by the no-sudo `vpsbackup` user.
2. **3:00 AM IST, home server** (`home-pull-backup.sh`, sandy cron on server489 VM): rsync-pulls
   the snapshot to `/mnt/hdd/backups/vps/daily/<date>/`, verifies checksums + gzip + sqlite
   integrity EVERY night, keeps 30 daily + first-of-month forever, then touches
   `.last-pull-ok` on the VPS.
3. **10:00 AM IST, app watchdog** (`TelegramService.backupAlertText`): `vps-backup-status.sh`
   (4:00 UTC root cron) mirrors snapshot/pull freshness into `/app/data/backup-status.json`;
   the app telegrams the owner if the last pull is missing or older than 36h.

**Restore (disaster):** copy `mybrain.db.gz` back into the mybrain-data volume (gunzip first),
`gunzip -c rag.sql.gz | docker exec -i rag-postgres psql -U rag rag`, recreate containers with
the envs from `restore-secrets.txt`.

## Recordings audio (BEA-976)

Sessions recorded by EMO Cam live as opus chunk files in the `mybrain-data` volume under
`recordings/<recordingId>/chunk-N.opus`. The nightly snapshot copies **chunks written in the
last 2 days** into each day's snapshot (`<DAY>/recordings/...`) with sha256 lines appended to
`MANIFEST.sha256`. Chunks are immutable, so the home server's day archive accumulates the
complete history. The app archives sessions after **90 days**: local chunk files are deleted
and the recording flips to `archived` (marks + transcripts stay in the DB).

**Restore an archived session's audio:** on the home server, search the day archives around the
recording's date (`grep -r <recordingId> */MANIFEST.sha256` or `ls */recordings/`), copy the
session's folder back to the VPS at
`/var/lib/docker/volumes/mybrain-data/_data/recordings/<recordingId>/`, then set its status
back to `done`:
`sqlite3 .../mybrain.db "UPDATE Recording SET status='done' WHERE id='<recordingId>';"`
Playback works immediately — no restart needed.
