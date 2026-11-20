#!/bin/sh
# LOCAL ONLY. Runs INSIDE a throwaway postgres:17 container started by
# C-VerifyBackup.ps1 with --network none (it cannot reach any other database).
# Restores a backup into a new database, prints the table count and the row
# count of every table, and dumps the restored schema with the same flags as
# prod_dump_schema.sh. It also restores step A's schema-only dump the same
# way, so the two restored schemas can be compared like for like (a restored
# copy re-spells some CHECK expressions; see schema_delta.py).
# Usage: sh /p/verify_backup.sh /b/FILE.dump /work/STEP_A_RAW.sql
set -eu
dump="$1"; step_a="$2"
P="psql -X -q -v ON_ERROR_STOP=1 -U postgres"
$P -d postgres -c "CREATE DATABASE restore_check"
# A dump of the public schema re-creates the schema itself; drop the empty one first.
if pg_restore --list "$dump" | grep -Eq '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public '; then
  $P -d restore_check -c "DROP SCHEMA public CASCADE"
fi
pg_restore -U postgres -d restore_check --no-owner --no-privileges --exit-on-error "$dump"
echo "tables: $($P -d restore_check -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
echo "row counts (exact):"
$P -d restore_check -At -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1" | while IFS= read -r t; do
  printf '  %s = %s\n' "$t" "$($P -d restore_check -At -c "SELECT count(*) FROM public.\"$t\"")"
done
pg_dump -U postgres -d restore_check \
  --schema-only --no-owner --no-privileges \
  --no-publications --no-subscriptions \
  --schema=public \
  --lock-wait-timeout=10s \
  --file=/work/backup_schema_raw.sql
echo "wrote backup_schema_raw.sql"

$P -d postgres -c "CREATE DATABASE step_a_check"
if grep -q '^CREATE SCHEMA public;' "$step_a"; then
  $P -d step_a_check -c "DROP SCHEMA public CASCADE"
fi
$P -d step_a_check -f "$step_a" >/dev/null
pg_dump -U postgres -d step_a_check   --schema-only --no-owner --no-privileges   --no-publications --no-subscriptions   --schema=public   --lock-wait-timeout=10s   --file=/work/step_a_restored_raw.sql
echo "wrote step_a_restored_raw.sql"
