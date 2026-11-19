#!/bin/sh
# READ-ONLY. Run by the founder against production, never by Claude Code.
# Confirms the connection string reaches the right database and reports the
# server version. Every statement is a SELECT; the session is also switched to
# read-only first, so any write would be refused by the server.
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 -At -F ' = ' \
  -c "SET default_transaction_read_only = on" \
  -c "SELECT 'database', current_database()" \
  -c "SELECT 'server_version', current_setting('server_version')" \
  -c "SELECT 'server_version_num', current_setting('server_version_num')" \
  -c "SELECT 'session_read_only', current_setting('default_transaction_read_only')" \
  -c "SELECT 'public_table_count', count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
