#!/bin/sh
# READ-ONLY. Run by the founder against production, never by Claude Code.
# Installed extensions with version and schema (catalog metadata only).
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 --csv \
  -c "SET default_transaction_read_only = on" \
  -o /out/prod_extensions.csv \
  -c "SELECT e.extname, e.extversion, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname"
echo "wrote /out/prod_extensions.csv"
