#!/bin/sh
# READ-ONLY. OPTIONAL. Run by the founder against production, never by Claude Code.
# Reads the `statements` column (the SQL text Supabase tooling applied) for
# exactly two rows: the 2026-10-02 flash_site_marketing_tables migration and
# the drop_flash_site_marketing_tables migration that followed 46 minutes later.
# Needed only to answer: did the DROP remove tables that held real data, or
# create/drop anything outside the public schema? See docs/SCHEMA_BASELINE.md §3.
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 --csv \
  -c "SET default_transaction_read_only = on" \
  -o /out/prod_supabase_marketing_statements.csv \
  -c "SELECT version, name, statements FROM supabase_migrations.schema_migrations WHERE version IN ('20261002220018', '20261002224608') ORDER BY version"
echo "wrote /out/prod_supabase_marketing_statements.csv"
