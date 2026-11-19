#!/bin/sh
# READ-ONLY. Run by the founder against production, never by Claude Code.
# Schema only: no table data is read or written. pg_dump runs inside a
# REPEATABLE READ READ ONLY transaction and takes only ACCESS SHARE locks.
# --lock-wait-timeout=10s makes it give up rather than queue if a lock is not
# granted within 10 seconds, so it can never sit waiting behind production DDL.
# The same flags must be used for every local dump it is compared against.
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
pg_dump "$FLASH_PROD_DB_URL" \
  --schema-only --no-owner --no-privileges \
  --no-publications --no-subscriptions \
  --schema=public \
  --lock-wait-timeout=10s \
  --file=/out/prod_schema_public.sql
echo "wrote /out/prod_schema_public.sql"
