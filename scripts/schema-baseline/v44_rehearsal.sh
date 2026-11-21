#!/usr/bin/env bash
# v44 rehearsal (feature_switches, L0.5a #84). DEVELOPER TOOL, LOCAL ONLY.
#
# Rebuilds production's state AFTER v43 in a throwaway postgres:17 container
# with --network none: the committed baseline (67 tables, RLS on all), owned
# by postgres (LOGIN, NOT superuser, BYPASSRLS); anon/authenticated revoked;
# service_role still granted; postgres's default privileges granting only
# service_role; supabase_admin's defaults still granting anon/authenticated
# (the accepted gap). Then rehearses v44:
#   apply -> seeds and rule 9 -> a founder flip survives a re-apply -> wrong
#   sha refused -> rollback -> guards -> CHECK -> apply under exclusive locks
#   on orders/users/admins (v44 must lock no existing table) -> final apply.
# Every step asserts; any failure exits non-zero.
#
# Run from the repo root:  bash scripts/schema-baseline/v44_rehearsal.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1

REPO="$(pwd)"
[ -f backend/src/db/migrations/v44_feature_switches.sql ] || { echo "run from the repo root" >&2; exit 1; }
HERE="scripts/schema-baseline"
WORK="$HERE/.v44-rehearsal-tmp"
NAME="flash-v44-rehearsal-$$"
F=/m/v44_feature_switches.sql
RF=/m/rollback/v44_feature_switches.rollback.sql

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -wa "$1"; else (cd "$1" && pwd); fi; }
fail() { echo "V44 REHEARSAL FAILED: $*" >&2; exit 1; }
pass() { echo "  [PASS] $*"; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
rm -rf "$WORK"; mkdir -p "$WORK"

# The working-tree baseline is v44's AFTER; v44 starts from v43's AFTER, so
# drop the feature_switches statements (CREATE TABLE block, PK, RLS line).
python -I - "$HERE/production_schema_baseline.sql" "$WORK/baseline_before.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read()
keep = [x for x in s.split('\n\n') if x.strip() and 'public.feature_switches' not in x]
open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write('\n\n'.join(keep) + '\n')
PY
python -I "$HERE/baseline_to_restorable.py" "$WORK/baseline_before.sql" > "$WORK/restorable_before.sql"
[ "$(grep -c '^CREATE TABLE ' "$WORK/restorable_before.sql")" = 67 ] || fail "fixture does not have 67 tables"
[ "$(grep -c ' ENABLE ROW LEVEL SECURITY;$' "$WORK/restorable_before.sql")" = 67 ] || fail "fixture does not have RLS on 67 tables (v43)"
SHA="$(sha256sum backend/src/db/migrations/v44_feature_switches.sql | cut -c1-64)"
WRONG="$(printf '%s' "$SHA" | tr '0-9a-f' '1-9a-f0')"

docker run -d --rm --name "$NAME" --network none --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_USER=supabase_admin -e POSTGRES_PASSWORD=rehearsal \
  -v "$(winpath "$REPO/backend/src/db/migrations"):/m:ro" \
  -v "$(winpath "$REPO/scripts/prod-migrations"):/p:ro" \
  -v "$(winpath "$REPO/$WORK"):/work" postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" psql -U supabase_admin -d postgres -At -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
echo "container $NAME: network=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME"), $(docker exec "$NAME" psql -U supabase_admin -d postgres -At -c 'SHOW server_version')"

SA()  { docker exec -i "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U supabase_admin -d prodshape "$@"; }
PGQ() { docker exec -i "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d prodshape "$@"; }
APPLY() { docker exec "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d prodshape --single-transaction -v file_sha="$1" "${@:2}" -f "$F"; }
ROLLBACK() { docker exec "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d prodshape --single-transaction -f "$RF"; }
READY() { docker exec -e FLASH_PROD_DB_URL="postgresql://postgres@/prodshape?host=/var/run/postgresql" -e FLASH_BACKEND_ROLE=postgres "$NAME" sh /p/rls_readiness.sh > "$WORK/$1.txt"; }
DUMP() { docker exec "$NAME" pg_dump -U supabase_admin -d prodshape --schema-only --schema=public --restrict-key=v44rehearsal > "$WORK/$1.sql"; }
ROWS() { PGQ -c "SELECT string_agg(key || '=' || enabled || '/' || COALESCE(updated_by::text, '-'), ' ' ORDER BY key) FROM public.feature_switches"; }
val() { grep "^summary|" "$WORK/$1.txt" | tr '|' '\n' | grep "^$2=" | cut -d= -f2; }
SEEDS='boosts=false/- card_payments=true/- cash_orders=true/- driver_payouts=false/- new_orders=true/- premium=false/- signups=true/- store_portal_writes=true/-'

echo "== 1. production's post-v43 state"
docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE;
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
GRANT anon, authenticated, service_role TO postgres;
CREATE DATABASE prodshape OWNER postgres;
SQL
docker exec "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d prodshape -c "DROP SCHEMA public CASCADE"
docker cp "$WORK/restorable_before.sql" "$NAME:/tmp/restorable_before.sql" >/dev/null
docker exec "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d prodshape -f /tmp/restorable_before.sql >/dev/null
PGQ <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
INSERT INTO public.schema_migrations_ledger (version, sha256) VALUES
  ('v42', 'b4dd4c841c00672c3bbbb11fcc80e840e56af7d7d10623e851b2034332df55fd'),
  ('v43', '4c26cb102bf3f30d2ea6d8c7f1d83ee6c79d1835a80e268a021b4b115eb11689');
SQL
SA <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
SQL
READY r0
[ "$(val r0 tables)" = 67 ] && [ "$(val r0 rls_enabled)" = 67 ] && [ "$(val r0 tables_with_anon_or_auth_privs)" = 0 ] && grep -q '^verdict|OK' "$WORK/r0.txt" || fail "fixture is not production's post-v43 state: $(grep '^summary' "$WORK/r0.txt")"
pass "fixture = production after v43: $(grep '^summary' "$WORK/r0.txt" | cut -d'|' -f2-)"

echo "== 2. apply (as postgres, step D's psql flags)"
APPLY "$SHA" >/dev/null
[ "$(ROWS)" = "$SEEDS" ] || fail "seed rows: $(ROWS)"
pass "8 seed rows, exactly as decided: $(ROWS | sed 's#/-##g')"
READY r1
[ "$(val r1 tables)" = 68 ] && [ "$(val r1 rls_enabled)" = 68 ] && [ "$(val r1 tables_with_anon_or_auth_privs)" = 0 ] && grep -q '^verdict|OK' "$WORK/r1.txt" || fail "readiness after v44: $(grep '^summary' "$WORK/r1.txt")"
pass "readiness: $(grep '^summary' "$WORK/r1.txt" | cut -d'|' -f2-), verdict OK"
grep -q '^table|feature_switches|postgres|t|f|t|t|0|0$' "$WORK/r1.txt" || fail "feature_switches row: $(grep '^table|feature_switches' "$WORK/r1.txt")"
pass "feature_switches: owner postgres, RLS on, not forced, backend exempt, 0 anon / 0 authenticated privileges"
[ "$(SA -c "SELECT count(*) FROM pg_policy WHERE polrelid = 'public.feature_switches'::regclass")" = 0 ] || fail "policies exist"
[ "$(SA -c "SELECT has_table_privilege('service_role','public.feature_switches','SELECT')")" = t ] || fail "service_role was expected to get postgres's default grant (consistent with every other table)"
pass "no policies; service_role has the same default grant as every other table (left alone, as decided)"
[ "$(PGQ -c "SELECT enabled FROM public.feature_switches WHERE key = 'card_payments'")" = t ] || fail "postgres cannot read"
if SA -c "SET ROLE anon; SELECT count(*) FROM public.feature_switches" >/dev/null 2>&1; then fail "anon can read feature_switches"; fi
pass "postgres (BYPASSRLS owner) reads it; anon: permission denied"
if PGQ -c "INSERT INTO public.feature_switches (key, enabled) VALUES ('maintenance_mode', false)" >/dev/null 2>&1; then fail "CHECK accepted an unknown key"; fi
pass "CHECK refuses an unknown key"

echo "== 3. the founder flips a switch; a re-apply must NOT reset it"
PGQ -c "UPDATE public.feature_switches SET enabled = false, updated_at = now(), updated_by = '00000000-0000-0000-0000-0000000000a1' WHERE key = 'card_payments'"
FLIPPED="$(ROWS)"; DUMP d1
APPLY "$SHA" >/dev/null
[ "$(ROWS)" = "$FLIPPED" ] || fail "re-apply changed switch values: $(ROWS)"
DUMP d2; cmp -s "$WORK/d1.sql" "$WORK/d2.sql" || fail "re-apply changed the schema or privileges"
[ "$(PGQ -c "SELECT count(*) FROM public.schema_migrations_ledger WHERE version = 'v44'")" = 1 ] || fail "ledger rows"
pass "card_payments stays off (updated_by kept); full dump with privileges byte-identical; one v44 ledger row"

echo "== 4. wrong file_sha (must be refused, no change)"
if APPLY "$WRONG" 2>"$WORK/wrong.err"; then fail "wrong sha accepted"; fi
grep -m1 ERROR "$WORK/wrong.err" | sed 's/^/  /'
DUMP d3; cmp -s "$WORK/d1.sql" "$WORK/d3.sql" && [ "$(ROWS)" = "$FLIPPED" ] || fail "refused apply changed something"
pass "refused; dump and rows unchanged"

echo "== 5. rollback"
ROLLBACK >/dev/null
[ "$(SA -c "SELECT to_regclass('public.feature_switches') IS NULL")" = t ] || fail "table still exists"
[ "$(PGQ -c "SELECT count(*) FROM public.schema_migrations_ledger WHERE version = 'v44'")" = 0 ] || fail "ledger row not removed"
DUMP d4; READY r4
[ "$(val r4 tables)" = 67 ] && [ "$(val r4 rls_enabled)" = 67 ] || fail "rollback did not return to 67/67"
pass "table dropped, ledger row removed, back to tables=67 rls_enabled=67"
if ROLLBACK 2>"$WORK/rb2.err"; then fail "second rollback accepted"; fi
pass "a second rollback is refused: $(grep -m1 -o 'v44 rollback: [^;]*' "$WORK/rb2.err")"

echo "== 6. guards (each must change nothing)"
if APPLY "$SHA" -c "ALTER TABLE public.schema_migrations_ledger DISABLE ROW LEVEL SECURITY" 2>"$WORK/g1.err"; then fail "applied without v43"; fi
grep -q 'v44: v43 (RLS lockdown) must be applied first' "$WORK/g1.err" || fail "v43 guard message: $(cat "$WORK/g1.err")"
pass "refused when v43 is not in place (checked on the schema, so step D's schema-only rehearsal works)"
if APPLY "$SHA" -c "CREATE TABLE public.feature_switches (key text PRIMARY KEY, enabled boolean)" 2>"$WORK/g2.err"; then fail "wrong shape accepted"; fi
grep -q 'v44: public.feature_switches exists with an unexpected shape' "$WORK/g2.err" || fail "shape guard message: $(cat "$WORK/g2.err")"
pass "refused when a feature_switches table with another shape already exists"
DUMP d5; cmp -s "$WORK/d4.sql" "$WORK/d5.sql" || fail "a refused attempt changed something"
pass "dump unchanged after the refused attempts"

echo "== 7. v44 locks no existing table: apply while orders, users and admins are held ACCESS EXCLUSIVE"
docker exec -d "$NAME" psql -X -q -U supabase_admin -d prodshape -c "BEGIN; LOCK TABLE public.orders, public.users, public.admins IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(30); COMMIT;"
for _ in $(seq 1 20); do [ "$(SA -c "SELECT count(*) FROM pg_locks WHERE mode = 'AccessExclusiveLock' AND relation IN ('public.orders'::regclass, 'public.users'::regclass, 'public.admins'::regclass)")" = 3 ] && break; sleep 0.5; done
[ "$(SA -c "SELECT count(*) FROM pg_locks WHERE mode = 'AccessExclusiveLock' AND relation IN ('public.orders'::regclass, 'public.users'::regclass, 'public.admins'::regclass)")" = 3 ] || fail "could not hold the locks"
T0=$(date +%s%3N); APPLY "$SHA" >/dev/null || fail "v44 waited on or failed behind locks on existing tables"; T1=$(date +%s%3N)
[ "$(ROWS)" = "$SEEDS" ] || fail "seeds after re-apply: $(ROWS)"
pass "applied in $((T1 - T0)) ms while orders/users/admins were exclusively locked; seeds back to the defaults"
SA -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(30)%' AND pid <> pg_backend_pid()" >/dev/null
READY r5; cmp -s <(grep -v '^session' "$WORK/r1.txt") <(grep -v '^session' "$WORK/r5.txt") || fail "readiness after re-apply differs from the first apply"
pass "readiness output identical to the first apply"
echo "V44 REHEARSAL PASSED"
