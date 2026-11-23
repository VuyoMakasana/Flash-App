#!/usr/bin/env bash
# v45 rehearsal (admin TOTP, #91). DEVELOPER TOOL, LOCAL ONLY.
#
# Rebuilds production's state AFTER v44 in a throwaway postgres:17 container
# with --network none: the v44 baseline (68 tables, RLS on all; the fixture's
# normalized form must hash to v45's BEFORE), owned by postgres (LOGIN, NOT
# superuser, BYPASSRLS); anon/authenticated revoked; service_role granted;
# postgres's default privileges granting only service_role; supabase_admin's
# defaults still granting anon/authenticated (the accepted gap); one admin.
# Then rehearses v45:
#   apply -> readiness and rule 9 -> every admins_totp_check / recovery-code
#   rule -> re-apply with MFA data present changes nothing -> wrong sha
#   refused -> rollback -> guards -> locks: applies while other busy tables
#   are exclusively locked; fails cleanly in ~5 s while admins is in use ->
#   final apply.
# Every step asserts; any failure exits non-zero.
#
# Run from the repo root:  bash scripts/schema-baseline/v45_rehearsal.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1

REPO="$(pwd)"
[ -f backend/src/db/migrations/v45_admin_totp.sql ] || { echo "run from the repo root" >&2; exit 1; }
HERE="scripts/schema-baseline"
WORK="$HERE/.v45-rehearsal-tmp"
NAME="flash-v45-rehearsal-$$"
F=/m/v45_admin_totp.sql
RF=/m/rollback/v45_admin_totp.rollback.sql
BEFORE_SHA=83a42d48864dbd9e6eeee0a8ed0b1d0aa5e1a59ed5967778e5fc7560f9ceb001
ADMIN=00000000-0000-0000-0000-0000000000a1
H1=$(printf 'a%.0s' $(seq 1 64))
H2=$(printf 'b%.0s' $(seq 1 64))

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -wa "$1"; else (cd "$1" && pwd); fi; }
fail() { echo "V45 REHEARSAL FAILED: $*" >&2; exit 1; }
pass() { echo "  [PASS] $*"; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
rm -rf "$WORK"; mkdir -p "$WORK"

# The working-tree baseline is v45's AFTER. v45 starts from v44's AFTER: drop
# the admin_mfa_recovery_codes statements and the admins TOTP lines.
python -I - "$HERE/production_schema_baseline.sql" "$WORK/baseline_before.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read()
out = []
for b in s.split('\n\n'):
    b = b.strip('\n')
    if not b or 'public.admin_mfa_recovery_codes' in b:
        continue
    if b.startswith('CREATE TABLE public.admins ('):
        lines = [l for l in b.split('\n') if 'totp_' not in l]
        i = lines.index(');')
        lines[i - 1] = lines[i - 1].rstrip(',')
        b = '\n'.join(lines)
    out.append(b)
open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write('\n\n'.join(out) + '\n')
PY
[ "$(sha256sum "$WORK/baseline_before.sql" | cut -c1-64)" = "$BEFORE_SHA" ] || fail "the derived starting baseline is not v45's BEFORE (v44's AFTER)"
python -I "$HERE/baseline_to_restorable.py" "$WORK/baseline_before.sql" > "$WORK/restorable_before.sql"
[ "$(grep -c '^CREATE TABLE ' "$WORK/restorable_before.sql")" = 68 ] || fail "fixture does not have 68 tables"
SHA="$(sha256sum backend/src/db/migrations/v45_admin_totp.sql | cut -c1-64)"
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
DUMP() { docker exec "$NAME" pg_dump -U supabase_admin -d prodshape --schema=public --restrict-key=v45rehearsal > "$WORK/$1.sql"; }
REFUSED() { # sql, label: the statement must fail
  if PGQ -c "$1" >/dev/null 2>"$WORK/refused.err"; then fail "accepted: $2"; fi
  pass "refused: $2 ($(grep -m1 -o 'violates [a-z ]*constraint "[a-z_]*"' "$WORK/refused.err" || head -c 120 "$WORK/refused.err"))"
}
val() { grep "^summary|" "$WORK/$1.txt" | tr '|' '\n' | grep "^$2=" | cut -d= -f2; }
MFA() { PGQ -c "SELECT COALESCE(totp_secret_enc,'-') || ' ' || COALESCE(totp_enrolled_at::text,'-') || ' ' || COALESCE(totp_last_step::text,'-') FROM public.admins WHERE id = '$ADMIN'"; }
CODES() { PGQ -c "SELECT count(*) || '/' || count(used_at) FROM public.admin_mfa_recovery_codes"; }

echo "== 1. production's post-v44 state"
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
PGQ <<SQL
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
INSERT INTO public.schema_migrations_ledger (version, sha256) VALUES
  ('v42', 'b4dd4c841c00672c3bbbb11fcc80e840e56af7d7d10623e851b2034332df55fd'),
  ('v43', '4c26cb102bf3f30d2ea6d8c7f1d83ee6c79d1835a80e268a021b4b115eb11689'),
  ('v44', '332926f437bf11a68f36b59810ff1f9881b1e6808ebffebfba22c6332c74d68c');
INSERT INTO public.admins (id, name, email, password_hash) VALUES ('$ADMIN', 'Founder', 'founder@example.test', 'x');
SQL
SA <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
SQL
READY r0
[ "$(val r0 tables)" = 68 ] && [ "$(val r0 rls_enabled)" = 68 ] && [ "$(val r0 tables_with_anon_or_auth_privs)" = 0 ] && grep -q '^verdict|OK' "$WORK/r0.txt" || fail "fixture is not production's post-v44 state: $(grep '^summary' "$WORK/r0.txt")"
pass "fixture = production after v44 (its baseline hashes to BEFORE ${BEFORE_SHA:0:8}): $(grep '^summary' "$WORK/r0.txt" | cut -d'|' -f2-)"

echo "== 2. apply (as postgres, step D's psql flags), with an existing admin row"
APPLY "$SHA" >/dev/null
READY r1
[ "$(val r1 tables)" = 69 ] && [ "$(val r1 rls_enabled)" = 69 ] && [ "$(val r1 tables_with_anon_or_auth_privs)" = 0 ] && grep -q '^verdict|OK' "$WORK/r1.txt" || fail "readiness after v45: $(grep '^summary' "$WORK/r1.txt")"
pass "readiness: $(grep '^summary' "$WORK/r1.txt" | cut -d'|' -f2-), verdict OK"
grep -q '^table|admin_mfa_recovery_codes|postgres|t|f|t|t|0|0$' "$WORK/r1.txt" || fail "admin_mfa_recovery_codes row: $(grep '^table|admin_mfa_recovery_codes' "$WORK/r1.txt")"
cmp -s <(grep '^table|admins|' "$WORK/r0.txt") <(grep '^table|admins|' "$WORK/r1.txt") || fail "the admins readiness row changed"
pass "admin_mfa_recovery_codes: owner postgres, RLS on, not forced, backend exempt, 0 anon / 0 authenticated; admins row unchanged"
[ "$(SA -c "SELECT count(*) FROM pg_policy WHERE polrelid = 'public.admin_mfa_recovery_codes'::regclass")" = 0 ] || fail "policies exist"
if SA -c "SET ROLE anon; SELECT count(*) FROM public.admin_mfa_recovery_codes" >/dev/null 2>&1; then fail "anon can read admin_mfa_recovery_codes"; fi
if SA -c "SET ROLE anon; SELECT totp_secret_enc FROM public.admins" >/dev/null 2>&1; then fail "anon can read admins.totp_secret_enc"; fi
pass "no policies; anon: permission denied on the new table and on the new admins columns"
[ "$(MFA)" = "- - -" ] || fail "the existing admin's new columns are not NULL: $(MFA)"
pass "the existing admin is untouched (not enrolled: all three columns NULL)"

echo "== 3. the constraints (each refused change leaves nothing behind)"
REFUSED "UPDATE public.admins SET totp_secret_enc = 'v1:aa:bb:cc' WHERE id = '$ADMIN'" "a secret without an enrolment time"
REFUSED "UPDATE public.admins SET totp_enrolled_at = now() WHERE id = '$ADMIN'" "an enrolment time without a secret"
REFUSED "UPDATE public.admins SET totp_last_step = 1 WHERE id = '$ADMIN'" "a last step before enrolment"
REFUSED "UPDATE public.admins SET totp_secret_enc = 'plain-secret', totp_enrolled_at = now() WHERE id = '$ADMIN'" "a secret not in the encrypted v<n>:iv:tag:ct format"
REFUSED "UPDATE public.admins SET totp_secret_enc = 'v1:aa:bb:cc', totp_enrolled_at = now(), totp_last_step = -1 WHERE id = '$ADMIN'" "a negative time step"
PGQ -c "UPDATE public.admins SET totp_secret_enc = 'v1:aa_-:bb:cc', totp_enrolled_at = now(), totp_last_step = 59000000 WHERE id = '$ADMIN'"
pass "accepted: a valid enrolment (versioned secret, enrolment time, last step)"
[ "$(PGQ -c "UPDATE public.admins SET totp_last_step = 59000001 WHERE id = '$ADMIN' AND (totp_last_step IS NULL OR totp_last_step < 59000001) RETURNING 1")" = 1 ] || fail "a later step was not accepted"
[ -z "$(PGQ -c "UPDATE public.admins SET totp_last_step = 59000001 WHERE id = '$ADMIN' AND (totp_last_step IS NULL OR totp_last_step < 59000001) RETURNING 1")" ] || fail "the same step was accepted twice"
pass "the replay guard the code will use: step 59000001 accepted once, refused the second time"
REFUSED "INSERT INTO public.admin_mfa_recovery_codes (admin_id, code_hash) VALUES ('$ADMIN', 'ABC')" "a code hash that is not lowercase hex sha256"
REFUSED "INSERT INTO public.admin_mfa_recovery_codes (admin_id, code_hash) VALUES ('00000000-0000-0000-0000-0000000000ff', '$H1')" "a code for an admin that does not exist"
PGQ -c "INSERT INTO public.admin_mfa_recovery_codes (admin_id, code_hash) VALUES ('$ADMIN', '$H1'), ('$ADMIN', '$H2')"
REFUSED "INSERT INTO public.admin_mfa_recovery_codes (admin_id, code_hash) VALUES ('$ADMIN', '$H1')" "the same code twice for one admin"
USE="UPDATE public.admin_mfa_recovery_codes SET used_at = now() WHERE admin_id = '$ADMIN' AND code_hash = '$H1' AND used_at IS NULL RETURNING 1"
[ "$(PGQ -c "$USE")" = 1 ] && [ -z "$(PGQ -c "$USE")" ] || fail "a recovery code was usable more than once"
pass "single use: the code is consumed once, the second use matches nothing; codes $(CODES) (total/used)"
DUMP d1; M1="$(MFA)"; C1="$(CODES)"

echo "== 4. re-apply with MFA data present: nothing changes"
APPLY "$SHA" >/dev/null
DUMP d2; cmp -s "$WORK/d1.sql" "$WORK/d2.sql" || fail "re-apply changed the schema or privileges"
[ "$(MFA)" = "$M1" ] && [ "$(CODES)" = "$C1" ] || fail "re-apply changed MFA data"
[ "$(PGQ -c "SELECT count(*) FROM public.schema_migrations_ledger WHERE version = 'v45'")" = 1 ] || fail "ledger rows"
pass "enrolment and codes kept; full dump with privileges byte-identical; one v45 ledger row"

echo "== 5. wrong file_sha (must be refused, no change)"
if APPLY "$WRONG" 2>"$WORK/wrong.err"; then fail "wrong sha accepted"; fi
grep -m1 ERROR "$WORK/wrong.err" | sed 's/^/  /'
DUMP d3; cmp -s "$WORK/d1.sql" "$WORK/d3.sql" && [ "$(MFA)" = "$M1" ] || fail "refused apply changed something"
pass "refused; dump and data unchanged"

echo "== 6. deleting an admin removes their codes (ON DELETE CASCADE)"
PGQ -c "INSERT INTO public.admins (id, name, email, password_hash) VALUES ('00000000-0000-0000-0000-0000000000a2', 'Temp', 'temp@example.test', 'x');
        INSERT INTO public.admin_mfa_recovery_codes (admin_id, code_hash) VALUES ('00000000-0000-0000-0000-0000000000a2', '$H1');
        DELETE FROM public.admins WHERE id = '00000000-0000-0000-0000-0000000000a2';"
[ "$(CODES)" = "$C1" ] || fail "cascade: $(CODES)"
pass "a deleted admin's codes go with them; the other admin's are untouched ($(CODES))"

echo "== 7. rollback"
ROLLBACK >/dev/null
[ "$(SA -c "SELECT to_regclass('public.admin_mfa_recovery_codes') IS NULL")" = t ] || fail "table still exists"
[ "$(SA -c "SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.admins'::regclass AND attname LIKE 'totp_%' AND NOT attisdropped")" = 0 ] || fail "TOTP columns still exist"
[ "$(PGQ -c "SELECT count(*) FROM public.schema_migrations_ledger WHERE version = 'v45'")" = 0 ] || fail "ledger row not removed"
[ "$(PGQ -c "SELECT count(*) FROM public.admins WHERE id = '$ADMIN'")" = 1 ] || fail "the admin row was lost"
READY r4
[ "$(val r4 tables)" = 68 ] && [ "$(val r4 rls_enabled)" = 68 ] || fail "rollback did not return to 68/68"
pass "table and columns dropped, ledger row removed, the admin kept, back to tables=68 rls_enabled=68"
if ROLLBACK 2>"$WORK/rb2.err"; then fail "second rollback accepted"; fi
pass "a second rollback is refused: $(grep -m1 -o 'v45 rollback: [^;]*' "$WORK/rb2.err")"
DUMP d4

echo "== 8. guards (each must change nothing)"
if APPLY "$SHA" -c "DROP TABLE public.feature_switches" 2>"$WORK/g1.err"; then fail "applied without v44"; fi
grep -q 'v45: v44 (public.feature_switches) must be applied first' "$WORK/g1.err" || fail "v44 guard: $(cat "$WORK/g1.err")"
pass "refused without v44 (a schema fact)"
if APPLY "$SHA" -c "ALTER TABLE public.schema_migrations_ledger DISABLE ROW LEVEL SECURITY" 2>"$WORK/g2.err"; then fail "applied without v43"; fi
grep -q 'v45: v43 (RLS lockdown) must be applied first' "$WORK/g2.err" || fail "v43 guard: $(cat "$WORK/g2.err")"
pass "refused without v43 (a schema fact)"
if APPLY "$SHA" -c "ALTER TABLE public.admins ADD COLUMN totp_last_step bigint" 2>"$WORK/g3.err"; then fail "a partial set of TOTP columns was accepted"; fi
grep -q 'v45: public.admins has an unexpected TOTP column or constraint shape' "$WORK/g3.err" || fail "admins shape guard: $(cat "$WORK/g3.err")"
pass "refused when admins already has some TOTP columns (never silently skipped)"
if APPLY "$SHA" -c "CREATE TABLE public.admin_mfa_recovery_codes (id uuid PRIMARY KEY)" 2>"$WORK/g4.err"; then fail "wrong table shape accepted"; fi
grep -q 'v45: public.admin_mfa_recovery_codes exists with an unexpected shape' "$WORK/g4.err" || fail "table shape guard: $(cat "$WORK/g4.err")"
pass "refused when an admin_mfa_recovery_codes table with another shape exists"
DUMP d5; cmp -s "$WORK/d4.sql" "$WORK/d5.sql" || fail "a refused attempt changed something"
pass "dump unchanged after the refused attempts"

echo "== 9. locks"
HOLD() { docker exec -d "$NAME" psql -X -q -U supabase_admin -d prodshape -c "BEGIN; LOCK TABLE $1 IN $2 MODE; SELECT pg_sleep(30); COMMIT;"; }
HELD() { SA -c "SELECT count(*) FROM pg_locks WHERE granted AND mode = '$2' AND relation IN ($1)"; }
FREE() { SA -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(30)%' AND pid <> pg_backend_pid()" >/dev/null; sleep 1; }
OTHERS="public.orders, public.users, public.drivers, public.stores, public.admin_actions, public.feature_switches"
OTHER_IDS="'public.orders'::regclass, 'public.users'::regclass, 'public.drivers'::regclass, 'public.stores'::regclass, 'public.admin_actions'::regclass, 'public.feature_switches'::regclass"
HOLD "$OTHERS" "ACCESS EXCLUSIVE"
for _ in $(seq 1 20); do [ "$(HELD "$OTHER_IDS" AccessExclusiveLock)" = 6 ] && break; sleep 0.5; done
[ "$(HELD "$OTHER_IDS" AccessExclusiveLock)" = 6 ] || fail "could not hold the locks on the other tables"
# Timed inside the transaction: from before the file's first statement to
# after its last, i.e. an upper bound on how long admins is held (step 2 to COMMIT).
IN_TX_MS="$(docker exec "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d prodshape --single-transaction -v file_sha="$SHA" \
  -c "SELECT set_config('flash.t0', clock_timestamp()::text, true)" -f "$F" \
  -c "SELECT round(extract(epoch FROM clock_timestamp() - current_setting('flash.t0')::timestamptz) * 1000)" | tail -n 1)" \
  || fail "v45 waited on or failed behind locks on tables other than admins"
[ -n "$IN_TX_MS" ] && [ "$IN_TX_MS" -lt 5000 ] || fail "in-transaction time: '$IN_TX_MS'"
pass "applied while orders, users, drivers, stores, admin_actions and feature_switches were exclusively locked; the whole file took ${IN_TX_MS} ms inside its transaction (an upper bound on how long admins is locked)"
FREE
ROLLBACK >/dev/null
HOLD "public.admins" "ACCESS SHARE"
for _ in $(seq 1 20); do [ "$(HELD "'public.admins'::regclass" AccessShareLock)" -ge 1 ] && break; sleep 0.5; done
T0=$(date +%s%3N)
if APPLY "$SHA" >/dev/null 2>"$WORK/lock.err"; then fail "v45 applied while admins was in use (it must wait for its lock)"; fi
T1=$(date +%s%3N)
grep -q 'lock timeout' "$WORK/lock.err" || fail "expected a lock timeout: $(cat "$WORK/lock.err")"
[ $((T1 - T0)) -lt 15000 ] || fail "waited $((T1 - T0)) ms, not ~5 s"
FREE
DUMP d6; cmp -s "$WORK/d4.sql" "$WORK/d6.sql" || fail "the timed-out attempt changed something"
pass "while an open transaction reads admins, v45 gives up after $((T1 - T0)) ms (lock_timeout 5s) and changes nothing"

echo "== 10. final apply"
APPLY "$SHA" >/dev/null
READY r5; cmp -s <(grep -v '^session' "$WORK/r1.txt") <(grep -v '^session' "$WORK/r5.txt") || fail "readiness after the final apply differs from the first apply"
pass "readiness output identical to the first apply"
echo "V45 REHEARSAL PASSED"
