#!/usr/bin/env bash
# Schema check (docs/SCHEMA_BASELINE.md §10).
#
# Builds a FRESH database from backend/src/db/migrate.js inside a throwaway,
# local-only Postgres container and compares it with the committed production
# baseline (scripts/schema-baseline/production_schema_baseline.sql).
#
# Exit 0 only if ALL of these hold:
#   - migrate.js succeeds, prints no v41 skip, and v41, v42 and v43 report completion;
#   - the fresh dump and the baseline are non-empty and have the expected
#     CREATE TABLE counts (so "identical because empty" can never pass);
#   - normalize_schema.py --compare reports no unaccepted difference;
#   - normalize_schema.py --self-test passes.
#
# It NEVER connects to anything but the container it starts on 127.0.0.1,
# and refuses to run if the database URL it built is not local.
# Run from the repo root:  bash scripts/schema-baseline/schema_check.sh
# Needs: docker, node (with backend/node_modules installed), python 3.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep /tmp paths for docker exec

PG_IMAGE="${PG_IMAGE:-postgres:17}"        # production is Postgres 17
PORT="${SCHEMA_CHECK_PORT:-55433}"
NAME="flash-schema-check-$$"
HERE="scripts/schema-baseline"
NORM="$HERE/normalize_schema.py"
BASELINE="${SCHEMA_CHECK_BASELINE:-$HERE/production_schema_baseline.sql}"   # override only to test the check itself
WORK="$HERE/.schema-check-tmp"   # relative + git-ignored: works for Windows-native docker/python too

fail() { echo "SCHEMA CHECK FAILED: $*" >&2; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
rm -rf "$WORK"; mkdir -p "$WORK"
trap cleanup EXIT

[ -f "$BASELINE" ] || fail "baseline $BASELINE not found (run from the repo root)"
[ -f backend/src/db/migrate.js ] || fail "run from the repo root"
[ ! -e backend/.env ] || fail "backend/.env exists; refusing (dotenv could load it). Move it aside first."

python -I "$NORM" --self-test >/dev/null || fail "normalize_schema.py self-test failed"

PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
docker run -d --rm --name "$NAME" --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_PASSWORD="$PW" -p "127.0.0.1:$PORT:5432" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -q && break; sleep 1; done
docker exec "$NAME" psql -U postgres -q -c "CREATE DATABASE schema_check"

URL="postgresql://postgres:$PW@127.0.0.1:$PORT/schema_check"
HOST="$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(u.hostname)' "$URL")"
case "$HOST" in 127.0.0.1|localhost) ;; *) fail "refusing non-local host: $HOST" ;; esac
echo "target: host=$HOST port=$PORT db=schema_check ($PG_IMAGE, throwaway container $NAME)"

( cd backend && env -u DOTENV_CONFIG_PATH DATABASE_URL="$URL" node src/db/migrate.js ) > "$WORK/migrate.out" 2>&1 \
  || { cat "$WORK/migrate.out"; fail "migrate.js exited non-zero"; }
if grep -E "v41:|SKIP" "$WORK/migrate.out"; then fail "v41 reported a skip (see above)"; fi
grep -q "migration v41 completed: schema baseline" "$WORK/migrate.out" || fail "v41 did not report completion"
grep -q "migration v42 completed: schema_migrations_ledger" "$WORK/migrate.out" || fail "v42 did not report completion"
grep -q "migration v43 completed: rls_public_lockdown" "$WORK/migrate.out" || fail "v43 did not report completion"

docker exec "$NAME" pg_dump -U postgres -d schema_check --schema-only --no-owner --no-privileges \
  --no-publications --no-subscriptions --schema=public --lock-wait-timeout=10s \
  --restrict-key=flashschemacheck -f /tmp/fresh.sql
docker cp "$NAME:/tmp/fresh.sql" "$WORK/fresh.sql" >/dev/null

read -r FB FT < <(python -I "$NORM" --stats "$WORK/fresh.sql"   | sed -E 's/bytes=([0-9]+) create_tables=([0-9]+)/\1 \2/')
read -r BB BT < <(python -I "$NORM" --stats "$BASELINE"         | sed -E 's/bytes=([0-9]+) create_tables=([0-9]+)/\1 \2/')
ACCEPTED_PROD_ONLY_TABLES=3   # settlement_config, store_settlements, store_settlement_line_items
echo "fresh dump: bytes=$FB create_tables=$FT | baseline: bytes=$BB create_tables=$BT"
[ "$FB" -gt 10000 ] && [ "$BB" -gt 10000 ] || fail "a dump is (near-)empty"
[ "$BT" -gt 0 ] || fail "baseline has no tables"
[ "$FT" -eq $((BT - ACCEPTED_PROD_ONLY_TABLES)) ] || fail "fresh has $FT tables, expected $((BT - ACCEPTED_PROD_ONLY_TABLES))"

python -I "$NORM" --compare "$WORK/fresh.sql" "$BASELINE" || fail "schema differs from the production baseline"
echo "SCHEMA CHECK PASSED"
