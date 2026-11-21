#!/usr/bin/env bash
# v43 grant rehearsal (FI-081, #73). DEVELOPER TOOL, LOCAL ONLY.
#
# The founder's step D rehearsal restores a SCHEMA dump taken with
# --no-privileges, so it cannot see grants or default privileges: half of v43.
# This rehearsal rebuilds production's real grant state, as reported by
# R-RlsReadiness.ps1 on 2026-11-21, in a throwaway postgres:17 container with
# --network none (it cannot reach anything):
#   - roles: supabase_admin (superuser, the container's bootstrap user);
#     postgres (LOGIN, NOT superuser, BYPASSRLS), owner of every table;
#     anon, authenticated (NOLOGIN), service_role (NOLOGIN, BYPASSRLS);
#   - all 67 tables from the committed baseline, owned by postgres;
#   - GRANT ALL on every table to anon, authenticated, service_role;
#   - default privileges FOR ROLE postgres and FOR ROLE supabase_admin IN
#     SCHEMA public granting tables, sequences, functions to all three;
#   - schema USAGE for all three;
#   - one sequence and one function owned by postgres (production has none;
#     they make the sequence/function revokes observable).
# Then: apply -> apply again (no change) -> wrong sha (refused, no change)
# -> rollback (RLS off, grants stay revoked) -> guards -> lock behaviour
# -> apply again. Every step asserts; any failure exits non-zero.
#
# Run from the repo root:  bash scripts/schema-baseline/v43_grant_rehearsal.sh
# Needs: docker. Never connects to anything but the container it starts.
set -euo pipefail
export MSYS_NO_PATHCONV=1

REPO="$(pwd)"
[ -f backend/src/db/migrations/v43_rls_public_lockdown.sql ] || { echo "run from the repo root" >&2; exit 1; }
HERE="scripts/schema-baseline"
WORK="$HERE/.v43-rehearsal-tmp"
NAME="flash-v43-grants-$$"
F=/m/v43_rls_public_lockdown.sql
RF=/m/rollback/v43_rls_public_lockdown.rollback.sql

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -wa "$1"; else (cd "$1" && pwd); fi; }
fail() { echo "V43 REHEARSAL FAILED: $*" >&2; exit 1; }
pass() { echo "  [PASS] $*"; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker rm -f "$NAME-locker" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
[ -n "${REHEARSAL_DEBUG:-}" ] && trap - EXIT
rm -rf "$WORK"; mkdir -p "$WORK"

python -I "$HERE/baseline_to_restorable.py" "$HERE/production_schema_baseline.sql" > "$WORK/restorable.sql"
# The baseline in this working tree is v43's AFTER; v43 must start from v42's
# AFTER, so strip the 67 ENABLE ROW LEVEL SECURITY statements if present.
grep -v ' ENABLE ROW LEVEL SECURITY;$' "$WORK/restorable.sql" > "$WORK/restorable_before.sql"
[ "$(grep -c '^CREATE TABLE ' "$WORK/restorable_before.sql")" = 67 ] || fail "fixture does not have 67 tables"
SHA="$(sha256sum backend/src/db/migrations/v43_rls_public_lockdown.sql | cut -c1-64)"
RSHA="$(sha256sum backend/src/db/migrations/rollback/v43_rls_public_lockdown.rollback.sql | cut -c1-64)"
WRONG="$(printf '%s' "$SHA" | tr '0-9a-f' '1-9a-f0')"

docker run -d --rm --name "$NAME" --network none --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_USER=supabase_admin -e POSTGRES_PASSWORD=rehearsal \
  -v "$(winpath "$REPO/backend/src/db/migrations"):/m:ro" \
  -v "$(winpath "$REPO/scripts/prod-migrations"):/p:ro" \
  -v "$(winpath "$REPO/$WORK"):/work" postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" psql -U supabase_admin -d postgres -At -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
echo "container $NAME: network=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME"), $(docker exec "$NAME" psql -U supabase_admin -d postgres -At -c 'SHOW server_version')"

SA()  { docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d prodshape "$@"; }
PGQ() { docker exec -i "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d prodshape "$@"; }
APPLY() { docker exec "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U "${2:-postgres}" -d prodshape --single-transaction -v file_sha="$1" "${@:3}" -f "$F"; }
READY() { docker exec -e FLASH_PROD_DB_URL="postgresql://postgres@/prodshape?host=/var/run/postgresql" -e FLASH_BACKEND_ROLE=postgres "$NAME" sh /p/rls_readiness.sh > "$WORK/$1.txt"; }
DUMP() { docker exec "$NAME" pg_dump -U supabase_admin -d prodshape --schema-only --schema=public --restrict-key=v43rehearsal > "$WORK/$1.sql"; }  # WITH privileges; fixed nonce so equal schemas give equal bytes
val() { grep "^summary|" "$WORK/$1.txt" | tr '|' '\n' | grep "^$2=" | cut -d= -f2; }
rls_count() { PGQ -c "SELECT count(*) FILTER (WHERE relrowsecurity) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')"; }

echo "== 1. production-shaped roles, ownership and grants"
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
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SEQUENCE public.rehearsal_seq;
CREATE FUNCTION public.rehearsal_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
INSERT INTO public.users (name, email, password_hash) VALUES ('Rehearsal One', 'one@rehearsal.invalid', 'x'), ('Rehearsal Two', 'two@rehearsal.invalid', 'x');
SQL
SA <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL
READY r0
grep -E '^(role|owners|summary|verdict|default_acl|sequence|function)\|' "$WORK/r0.txt" | sed 's/^/  /'
grep -q '^owners|postgres$' "$WORK/r0.txt" && grep -q '^role|postgres|super=false|bypassrls=true' "$WORK/r0.txt" \
  && [ "$(val r0 tables)" = 67 ] && [ "$(val r0 tables_with_anon_or_auth_privs)" = 67 ] && [ "$(val r0 rls_enabled)" = 0 ] \
  && grep -q '^default_acl|postgres|tables|public|.*anon=' "$WORK/r0.txt" && grep -q '^default_acl|supabase_admin|tables|public|.*anon=' "$WORK/r0.txt" \
  || fail "the fixture does not match production's readiness output"
pass "fixture matches production: 67 tables owned by postgres (super=false, bypassrls=true), all granted to anon/authenticated, both default ACLs grant them"

echo "== 2. apply (as postgres, exactly step D's psql flags)"
T0=$(date +%s%3N); APPLY "$SHA" >/dev/null; T1=$(date +%s%3N)
echo "  apply took $((T1 - T0)) ms (including docker exec start-up)"
READY r1; DUMP d1
[ "$(val r1 rls_enabled)" = 67 ] && [ "$(val r1 tables_with_anon_or_auth_privs)" = 0 ] && grep -q '^verdict|OK' "$WORK/r1.txt" || fail "after apply: $(grep '^summary' "$WORK/r1.txt")"
pass "rls_enabled=67, tables_with_anon_or_auth_privs=0, verdict OK"
grep -q '^sequence|rehearsal_seq|postgres|0|0$' "$WORK/r1.txt" || fail "sequence still granted: $(grep '^sequence' "$WORK/r1.txt")"
grep -q '^function|rehearsal_fn()|postgres|f|f|' "$WORK/r1.txt" || fail "function still executable: $(grep '^function' "$WORK/r1.txt")"
pass "sequence and function no longer granted to anon/authenticated"
if grep '^default_acl|postgres|' "$WORK/r1.txt" | grep -qE '(anon|authenticated)='; then fail "postgres default ACL still mentions anon/authenticated"; fi
pass "postgres default ACLs no longer mention anon/authenticated: $(grep '^default_acl|postgres|' "$WORK/r1.txt" | cut -d'|' -f3,5 | paste -sd' ')"
grep -q '^default_acl|supabase_admin|tables|public|.*anon=' "$WORK/r1.txt" || fail "supabase_admin default ACL changed (it must be left alone)"
pass "supabase_admin default ACLs untouched (accepted gap)"
[ "$(SA -At -c "SELECT has_table_privilege('service_role','public.users','SELECT')")" = t ] || fail "service_role lost privileges (must be left alone)"
[ "$(SA -At -c "SELECT has_schema_privilege('anon','public','USAGE')")" = t ] || fail "schema USAGE changed (must be left alone)"
pass "service_role privileges and schema USAGE untouched"
[ "$(SA -At -c "SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace")" = 0 ] || fail "policies were created"
[ "$(SA -At -c "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relforcerowsecurity")" = 0 ] || fail "FORCE was used"
pass "no policies, no FORCE"
[ "$(PGQ -c "SELECT count(*) FROM public.users")" = 2 ] || fail "postgres can no longer read users"
PGQ -c "BEGIN; INSERT INTO public.users (name, email, password_hash) VALUES ('w','w@rehearsal.invalid','x'); UPDATE public.users SET name = 'w2' WHERE email = 'w@rehearsal.invalid'; DELETE FROM public.users WHERE email = 'w@rehearsal.invalid'; ROLLBACK;" >/dev/null
pass "postgres (owner, BYPASSRLS, not superuser) still reads and writes"
if SA -At -c "SET ROLE anon; SELECT count(*) FROM public.users" >/dev/null 2>&1; then fail "anon can still read users"; fi
pass "anon: permission denied on users"
[ "$(SA -At -c "BEGIN; GRANT SELECT ON public.users TO anon; SET ROLE anon; SELECT count(*) FROM public.users; ROLLBACK;" | grep -E '^[0-9]+$')" = 0 ] || fail "RLS did not hide rows from a re-granted anon"
pass "defence in depth: even with SELECT re-granted, anon sees 0 rows (RLS, no policies)"

echo "== 3. apply again (must change nothing)"
APPLY "$SHA" >/dev/null; READY r2; DUMP d2
cmp -s "$WORK/r1.txt" "$WORK/r2.txt" && cmp -s "$WORK/d1.sql" "$WORK/d2.sql" || fail "second apply changed something"
[ "$(PGQ -c "SELECT count(*) FROM public.schema_migrations_ledger WHERE version = 'v43'")" = 1 ] || fail "ledger row count"
pass "readiness output and full dump (with privileges) byte-identical; one v43 ledger row"

echo "== 4. wrong file_sha (must be refused, no change)"
if APPLY "$WRONG" postgres 2>"$WORK/wrong.err"; then fail "wrong sha accepted"; fi
grep -m1 ERROR "$WORK/wrong.err" | sed 's/^/  /'
DUMP d3; cmp -s "$WORK/d1.sql" "$WORK/d3.sql" || fail "refused apply changed something"
pass "refused; full dump unchanged"

echo "== 5. rollback (RLS off; grants stay revoked; ledger row gone)"
docker exec "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d prodshape --single-transaction -f "$RF" >/dev/null
READY r3
[ "$(val r3 rls_enabled)" = 0 ] && [ "$(val r3 tables_with_anon_or_auth_privs)" = 0 ] || fail "after rollback: $(grep '^summary' "$WORK/r3.txt")"
if grep '^default_acl|postgres|' "$WORK/r3.txt" | grep -qE '(anon|authenticated)='; then fail "rollback re-granted default privileges"; fi
[ "$(PGQ -c "SELECT count(*) FROM public.schema_migrations_ledger WHERE version = 'v43'")" = 0 ] || fail "ledger row not removed"
pass "rls_enabled=0, tables_with_anon_or_auth_privs=0, postgres defaults still clean, ledger row removed"
if docker exec "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d prodshape --single-transaction -f "$RF" 2>"$WORK/rb2.err"; then fail "second rollback accepted"; fi
pass "a second rollback is refused: $(grep -m1 -o 'v43 rollback: [^;]*' "$WORK/rb2.err")"

echo "== 6. guards (in the rolled-back state; each attempt must change nothing)"
DUMP g0
if APPLY "$SHA" postgres -c "CREATE TABLE public.zz_unexpected (x int)" 2>"$WORK/g1.err"; then fail "extra table accepted"; fi
grep -q 'unexpected: {zz_unexpected}' "$WORK/g1.err" || fail "extra-table message: $(cat "$WORK/g1.err")"
pass "an unexpected table is refused: $(grep -m1 -o 'found [0-9]* tables; missing: [^;]*; unexpected: [^;]*' "$WORK/g1.err")"
if APPLY "$SHA" postgres -c "DROP TABLE public.app_ratings" 2>"$WORK/g2.err"; then fail "missing table accepted"; fi
grep -q 'missing: {app_ratings}' "$WORK/g2.err" || fail "missing-table message: $(cat "$WORK/g2.err")"
pass "a missing table is refused: $(grep -m1 -o 'found [0-9]* tables; missing: [^;]*' "$WORK/g2.err")"
SA -c "CREATE ROLE outsider LOGIN NOSUPERUSER NOBYPASSRLS" >/dev/null
if APPLY "$SHA" outsider 2>"$WORK/g3.err"; then fail "a role without access was accepted"; fi
grep -q 'v43: role outsider would lose access' "$WORK/g3.err" || fail "role guard message: $(cat "$WORK/g3.err")"
pass "a role that would lose access is refused (v43's own message, before anything else)"
DUMP g1d; cmp -s "$WORK/g0.sql" "$WORK/g1d.sql" || fail "a refused attempt changed something"
pass "full dump unchanged after all refused attempts"

echo "== 7. locks"
MODE_RLS="$(PGQ -c "BEGIN; ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; SELECT string_agg(mode, ',') FROM pg_locks WHERE relation = 'public.orders'::regclass AND pid = pg_backend_pid(); ROLLBACK;" | grep Lock)"
MODE_REV="$(PGQ -c "BEGIN; REVOKE ALL ON public.orders FROM service_role; SELECT COALESCE(string_agg(mode, ','), 'none') FROM pg_locks WHERE relation = 'public.orders'::regclass AND pid = pg_backend_pid(); ROLLBACK;" | grep -E 'Lock|none')"
echo "  ENABLE ROW LEVEL SECURITY on orders holds: $MODE_RLS"
echo "  REVOKE on orders holds: $MODE_REV"
echo "$MODE_RLS" | grep -q AccessExclusiveLock || fail "expected ACCESS EXCLUSIVE for ENABLE RLS"
docker exec -d "$NAME" psql -X -q -U postgres -d prodshape -c "BEGIN; SELECT count(*) FROM public.orders; SELECT pg_sleep(30); COMMIT;"
for _ in $(seq 1 20); do [ "$(SA -At -c "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.relation = 'public.orders'::regclass AND a.query LIKE '%pg_sleep(30)%'")" -ge 1 ] && break; sleep 0.5; done
pass "a long-running reader holds a lock on orders (as a slow request or cron would)"
T0=$(date +%s%3N)
if APPLY "$SHA" postgres 2>"$WORK/lock.err"; then fail "apply succeeded behind a lock (expected lock_timeout)"; fi
T1=$(date +%s%3N)
grep -m1 -o 'ERROR:  canceling statement due to lock timeout' "$WORK/lock.err" >/dev/null || fail "expected a lock timeout: $(cat "$WORK/lock.err")"
[ "$(rls_count)" = 0 ] || fail "a partial apply happened"
pass "apply gave up after $((T1 - T0)) ms with 'canceling statement due to lock timeout'; RLS still off on all tables (nothing applied)"
SA -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(30)%' AND pid <> pg_backend_pid()" >/dev/null

echo "== 8. apply again after the rollback (back to the applied state)"
APPLY "$SHA" >/dev/null; READY r4; DUMP d4
cmp -s "$WORK/r1.txt" "$WORK/r4.txt" && cmp -s "$WORK/d1.sql" "$WORK/d4.sql" || fail "re-apply after rollback differs from the first apply"
pass "readiness output and full dump byte-identical to the first apply"
if [ -n "${REHEARSAL_KEEP_DIR:-}" ]; then cp "$WORK"/r0.txt "$WORK"/r1.txt "$WORK"/r3.txt "$REHEARSAL_KEEP_DIR"/; fi
echo "V43 GRANT REHEARSAL PASSED"
