#!/bin/sh
# READ-ONLY. Run by the founder against production, never by Claude Code.
# Confirms that migration v41's S1 guards are FALSE on production:
#   1. the seeded store row (id below) already exists  -> the INSERT is skipped
#   2. flash_inventory.store_id is already NOT NULL with that DEFAULT
#      -> SET DEFAULT / SET NOT NULL are skipped
# Returns counts and catalog metadata only; no row contents are printed.
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 -At -F ' = ' \
  -c "SET default_transaction_read_only = on" \
  -c "SELECT 'seed_store_row_exists', count(*) FROM public.stores WHERE id = '91fff27c-c2bb-4f06-8147-c72cb9f8db7a'::uuid" \
  -c "SELECT 'flash_inventory.store_id is_nullable', is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flash_inventory' AND column_name = 'store_id'" \
  -c "SELECT 'flash_inventory.store_id default_is_seed_store', (column_default = '''91fff27c-c2bb-4f06-8147-c72cb9f8db7a''::uuid') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flash_inventory' AND column_name = 'store_id'" \
  -c "SELECT 'flash_inventory rows with NULL store_id', count(*) FROM public.flash_inventory WHERE store_id IS NULL"
