#!/bin/sh
# READ-ONLY. Runs INSIDE the postgres:17 container. Prints the migration
# ledger ("none" if the table does not exist yet). The session is switched to
# read-only first, so any write would be refused by the server.
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 -At -F '|' \
  -c "SET default_transaction_read_only = on" \
  -c "SELECT CASE WHEN to_regclass('public.schema_migrations_ledger') IS NULL THEN 'ledger|none' ELSE 'ledger|present' END" \
  > /tmp/ledger_state
cat /tmp/ledger_state
if grep -q '^ledger|present$' /tmp/ledger_state; then
  psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 -At -F '|' \
    -c "SET default_transaction_read_only = on" \
    -c "SELECT 'row', version, sha256, applied_at FROM public.schema_migrations_ledger ORDER BY version"
fi
