#!/bin/sh
# READ-ONLY. Run by the founder against production, never by Claude Code.
# migrate.js has never had a migration-tracking table on any branch, so there
# is no tracking table to SELECT from. This lists the NAMES of any table, in
# any schema, that looks like one (e.g. a Supabase CLI history table), so we
# know for certain. Reads pg_catalog directly, so tables the connecting role
# has no privileges on are still listed by name. Names only: no rows of any
# table are read.
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 --csv \
  -c "SET default_transaction_read_only = on" \
  -o /out/prod_migration_tables.csv \
  -c "SELECT n.nspname AS table_schema, c.relname AS table_name, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND c.relname ILIKE '%migrat%' ORDER BY 1, 2"
echo "wrote /out/prod_migration_tables.csv"
