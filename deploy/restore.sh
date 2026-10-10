#!/bin/sh
# Restores a dump made by backup.sh into the database in PGDATABASE (docs/BACKUP.md).
#
#   restore.sh /backups/humanmsg-20261010-030000.dump
#
# Everything in the target database is replaced by the dump's content. One transaction: if the
# restore fails, the database stays as it was.
set -eu

file="${1:?usage: restore.sh <dump file>}"
[ -r "$file" ] || { echo "restore: cannot read $file" >&2; exit 1; }

pg_restore --clean --if-exists --no-owner --single-transaction --dbname="${PGDATABASE:?PGDATABASE is not set}" "$file"
echo "restore: $file restored into ${PGDATABASE}"
