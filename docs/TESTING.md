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
`tests/integration/rlsBackendRole.test.js` (v43): every other integration test connects as a superuser, which ignores RLS. This one creates a production-shaped role (not superuser, BYPASSRLS, owner of every table), runs the real backend read and write paths and the cron functions as that role, and restores everything afterwards. `bash scripts/schema-baseline/v43_grant_rehearsal.sh` rehearses v43 against production's real grant state, and `bash scripts/schema-baseline/v44_rehearsal.sh` rehearses v44 against production's post-v43 state, and `bash scripts/schema-baseline/v45_rehearsal.sh` rehearses v45 against production's post-v44 state (all local Docker only).

New schema changes are standalone files in `backend/src/db/migrations/` (from v42). How to write one and how it reaches production: `docs/PROD_MIGRATIONS.md`. `tests/integration/migrationLedger.test.js` needs `psql` on PATH in CI; locally it skips the psql cases when `psql` is absent.

`bash scripts/schema-baseline/schema_check.sh` builds a fresh database from `migrate.js` in its own throwaway local container and compares it with the committed production baseline (`docs/SCHEMA_BASELINE.md` §10).

## Publishing to iPhone testers (Expo Go, EAS Update)
Neither app has an iOS build yet. iPhone testers open each app in **Expo Go**, from a published update (FI-117). A JS-only change ships by publishing an update; a change that adds a native module needs a build instead.

**What to publish for #102 (Step 1):** the **driver app** only (plans hidden, FI-127). The user app has no #102 change, so PR D's update is still current.

**Before publishing:**
- the backend change it needs must be **merged and deployed** first;
- check on your iPhone that the **current** tester link still opens in Expo Go (FI-117: SDK 54 support in the store's Expo Go);
- publish from an up-to-date `main`, never from a branch.

From the app's folder (`flash-driver-app/` or `flash-user-app/`), in PowerShell:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL = "https://api.flashdelivery.co.za"   # REQUIRED (FI-118), or the update points at localhost
npx eas-cli update --branch preview --platform ios --message "Driver plans are free; Buy Plan hidden (#102)"
Remove-Item Env:EXPO_PUBLIC_API_BASE_URL
```

- **The link:** use the **https** link it prints (`https://u.expo.dev/update/<id>`), **never `exp://`**. A new update means a new link to send testers.
- **The branch:** any EAS branch name works, because testers open a per-update link. `preview` is a suggestion, not a convention found in the repo.
- **Who can open it:** testers must be invited to the `vuyomakasana` Expo organization (Viewer), or Expo Go answers 403.
- **Check on the device:**
  - **driver app:** log in; no "Buy Plan", plan banner or "My Plan" anywhere; **Go online** works inside Gqeberha;
  - **user app:** log in; the products load (so it's not the localhost/demo fallback); the payment screen shows **Card only**.
