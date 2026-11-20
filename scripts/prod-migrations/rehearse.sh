#!/bin/sh
# LOCAL ONLY. Runs INSIDE a throwaway postgres:17 container started by
# D-Apply.ps1 with --network none. Restores production's BEFORE schema dump
# (from step A), then applies the migration file exactly the way step D will:
#   0. the restored start state            -> /work/rehearsal_before.sql
#   1. apply with the real file_sha        -> /work/rehearsal_after_1.sql
#   2. apply again (must be a no-op)       -> /work/rehearsal_after_2.sql
#   3. apply with a WRONG file_sha         -> must FAIL and change nothing
#   4. optional rollback file, then dump   -> /work/rehearsal_rolled_back.sql
# A restored copy re-spells some CHECK expressions, so step D compares the
# CHANGE (rehearsal_before -> after_1) with the expected change, never the
# absolute fingerprints (schema_delta.py).
# Usage: sh /p/rehearse.sh /work/before_raw.sql /m/FILE.sql SHA [/m/rollback/FILE.sql]
set -eu
before="$1"; file="$2"; sha="$3"; rollback="${4:-}"
P="psql -X -q -v ON_ERROR_STOP=1 -U postgres"
D="pg_dump -U postgres -d rehearsal --schema-only --no-owner --no-privileges --no-publications --no-subscriptions --schema=public --lock-wait-timeout=10s"
$P -d postgres -c "CREATE DATABASE rehearsal"
if grep -q '^CREATE SCHEMA public;' "$before"; then
  $P -d rehearsal -c "DROP SCHEMA public CASCADE"
fi
$P -d rehearsal -f "$before" >/dev/null
echo "restored BEFORE schema: $($P -d rehearsal -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") tables"
$D -f /work/rehearsal_before.sql

echo "-- 1. apply"
$P -d rehearsal --single-transaction -v file_sha="$sha" -f "$file"
$D -f /work/rehearsal_after_1.sql
echo "-- 2. apply again"
$P -d rehearsal --single-transaction -v file_sha="$sha" -f "$file"
$D -f /work/rehearsal_after_2.sql
echo "ledger rows: $($P -d rehearsal -At -c "SELECT version || ' ' || sha256 FROM public.schema_migrations_ledger ORDER BY version")"
echo "-- 3. apply with a wrong file_sha (must fail)"
wrong="$(printf '%s' "$sha" | tr '0-9a-f' '1-9a-f0')"
if $P -d rehearsal --single-transaction -v file_sha="$wrong" -f "$file" 2>/work/rehearsal_wrong_sha.err; then
  echo "REHEARSAL FAILED: a wrong file_sha was accepted" >&2; exit 1
fi
echo "refused as expected: $(grep -m 1 'ERROR' /work/rehearsal_wrong_sha.err)"
$D -f /work/rehearsal_after_3.sql
if [ -n "$rollback" ]; then
  echo "-- 4. rollback"
  $P -d rehearsal --single-transaction -f "$rollback"
  $D -f /work/rehearsal_rolled_back.sql
fi
echo "REHEARSAL STEPS COMPLETED"
