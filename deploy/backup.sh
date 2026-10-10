#!/bin/sh
# Daily PostgreSQL backup with rotation (service "backup" in docker-compose.prod.yml).
#
#   backup.sh         run forever: one backup every day at BACKUP_AT (UTC)
#   backup.sh once    make one backup now and exit (manual run, checks)
#
# Connection: the standard PG* variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
# BACKUP_DIR (default /backups) holds the dumps, BACKUP_AT (default 03:00) is the daily time,
# BACKUP_KEEP_DAYS (default 14) is how long a dump is kept.
set -eu

DIR="${BACKUP_DIR:-/backups}"
AT="${BACKUP_AT:-03:00}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') backup: $*"; }

backup_once() {
  name="${PGDATABASE:-db}-$(date -u +%Y%m%d-%H%M%S).dump"
  tmp="$DIR/.$name.tmp"
  # The custom format is compressed and lets pg_restore restore selectively
  if ! pg_dump --format=custom --no-owner --file="$tmp"; then
    rm -f "$tmp"
    log "FAILED: pg_dump"
    return 1
  fi
  # A dump that pg_restore cannot read is not a backup
  if ! pg_restore --list "$tmp" >/dev/null; then
    rm -f "$tmp"
    log "FAILED: the dump is unreadable"
    return 1
  fi
  mv "$tmp" "$DIR/$name"
  log "created $name ($(wc -c <"$DIR/$name") bytes)"
  # Rotation runs only after a successful dump, so a failing database never empties the directory
  find "$DIR" -maxdepth 1 -name "${PGDATABASE:-db}-*.dump" -mtime "+$KEEP_DAYS" -print -delete |
    while read -r old; do log "removed $old"; done
}

mkdir -p "$DIR"

if [ "${1:-}" = "once" ]; then
  backup_once
  exit $?
fi

log "daily at $AT UTC, keeping $KEEP_DAYS days in $DIR"
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $AT:00" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  sleep $((next - now))
  # A failed backup is logged and retried tomorrow; the loop must survive it
  backup_once || true
done
