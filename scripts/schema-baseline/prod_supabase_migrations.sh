#!/bin/sh
# READ-ONLY. Run by the founder against production, never by Claude Code.
# Shows whether Supabase tooling (CLI / dashboard migrations) ever applied
# migrations to this project. One SELECT of two columns only (version, name);
# the `statements` column, which holds the SQL text, is deliberately not read.
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 --csv \
  -c "SET default_transaction_read_only = on" \
  -o /out/prod_supabase_migrations.csv \
  -c "SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version"
echo "wrote /out/prod_supabase_migrations.csv"
