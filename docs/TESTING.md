# Flash — Testing (local and CI)

**Rule:** tests only ever use a **local** database and Paystack **TEST** keys. Every jest run enforces this before any test executes (`backend/tests/setup/testEnv.js`, wired via `jest.config.js` `setupFiles`). Production is never touched by tests.

## One-time setup (backend)
1. Copy `backend/.env.test.example` to **`backend/.env.test`**. It is git-ignored; never commit it.
2. In `backend/.env.test`, set **`PAYSTACK_SECRET_KEY`** to your Paystack **test** secret key (`sk_test_…`). Optionally set `PAYSTACK_PUBLIC_KEY` (`pk_test_…`). Everything else in the example is a test-only placeholder.

## Run
From `backend/`:

```bash
npm run test:db:up        # throwaway Postgres 17 on 127.0.0.1:55432 (tmpfs, starts empty)
npm run test:db:migrate   # migrate.js v1–v42 against that LOCAL db only (refuses anything else)
npm test -- --testPathPattern=tests/unit          # unit tests (database mocked)
npm test -- --testPathPattern=tests/integration   # integration tests (local db)
npm run test:db:down      # remove the container (data is discarded)
```

## What the guard refuses
- **The whole run is refused** if `DATABASE_URL` is set and its host is not `localhost`, `127.0.0.1` or `::1`. That includes Supabase hosts and look-alikes such as `localhost.example.com`. It also refuses a URL that can't be parsed, or one that matches a known production marker.
- It refuses if `PAYSTACK_SECRET_KEY` or `PAYSTACK_PUBLIC_KEY` is a **live** key (`sk_live_` / `pk_live_`).
- Error messages name only the offending **host**, never the password or key.
- Precedence: variables already set in your shell or in CI win over `backend/.env.test`. `backend/.env` (the app's env file) is never loaded by tests.

## CI
`.github/workflows/ci.yml` runs Postgres in a service container on `localhost:5432` with placeholder secrets (`PAYSTACK_SECRET_KEY: sk_test_placeholder`), which the guard accepts. CI still uses `postgres:15`; moving it to 17 to match production is Phase 6 (FI-068). Locally, `docker-compose.test.yml` already uses 17.

## Schema check and migrations
New schema changes are standalone files in `backend/src/db/migrations/` (from v42). How to write one and how it reaches production: `docs/PROD_MIGRATIONS.md`. `tests/integration/migrationLedger.test.js` needs `psql` on PATH in CI; locally it skips the psql cases when `psql` is absent.

`bash scripts/schema-baseline/schema_check.sh` builds a fresh database from `migrate.js` in its own throwaway local container and compares it with the committed production baseline (`docs/SCHEMA_BASELINE.md` §10).
