#!/bin/sh
# READ-ONLY on production. Runs INSIDE the postgres:17 container; started by
# B-Backup.ps1. Full backup (schema + data) of the public schema, where every
# Flash table lives. pg_dump reads in one REPEATABLE READ READ ONLY snapshot
# and takes ACCESS SHARE locks only; --lock-wait-timeout=10s gives up rather
# than queue behind other locks. Custom format, for pg_restore.
# Usage: sh /p/backup_public.sh FILE_NAME   (written to /b/FILE_NAME)
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
name="$1"
case "$name" in */*|"") echo "backup: bad file name" >&2; exit 1 ;; esac
[ ! -e "/b/$name" ] || { echo "backup: /b/$name already exists" >&2; exit 1; }
pg_dump "$FLASH_PROD_DB_URL" \
  --format=custom --schema=public --no-owner --no-privileges \
  --lock-wait-timeout=10s \
  --file="/b/$name.partial"
mv "/b/$name.partial" "/b/$name"
echo "wrote $name"
