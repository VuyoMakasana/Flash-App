#!/bin/sh
# THE ONLY SCRIPT THAT WRITES TO PRODUCTION. Runs INSIDE the postgres:17
# container, started only by D-Apply.ps1 after every pre-check has passed.
# Re-checks the file's sha256 inside the container, then applies the file in
# ONE transaction; ON_ERROR_STOP means the first error aborts and rolls back
# everything (nothing is applied).
# Env: FLASH_PROD_DB_URL, FLASH_SQL_FILE (/m/...), FLASH_FILE_SHA, FLASH_CONFIRM
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
: "${FLASH_SQL_FILE:?FLASH_SQL_FILE is not set}"
: "${FLASH_FILE_SHA:?FLASH_FILE_SHA is not set}"
[ "${FLASH_CONFIRM:-}" = "yes-apply" ] || { echo "apply: not confirmed" >&2; exit 1; }
got="$(sha256sum "$FLASH_SQL_FILE" | cut -d' ' -f1)"
[ "$got" = "$FLASH_FILE_SHA" ] || { echo "apply: sha256 inside the container is $got, expected $FLASH_FILE_SHA; refusing" >&2; exit 1; }
echo "sha256 re-checked inside the container: $got"
psql "$FLASH_PROD_DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
  -v file_sha="$FLASH_FILE_SHA" -f "$FLASH_SQL_FILE"
echo "APPLY COMMITTED"
