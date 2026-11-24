# Flash — Work Log

Newest first. One entry per merged or open piece of work: date, branch/PR, what changed, how it was verified, and anything left open. Code history is in git; this log records the **why** and the **evidence**.

---

## 2026-11-24 — PR A: real-money blockers (#94, `launch/real-money-blockers`)
- **Founder decisions (2026-11-24, after the read-only real-money audit):**
  - **Partner stores will be paid by Paystack split payments** (design A), because Flash must never hold store money. **Store payments stay off until Paystack confirms how refunds on split transactions work** (the founder is asking). Checklist L-17, FI-093.
  - **Sunday 2026-11-29's real-money test is Flash Closet only, card only, cash off.** Checklist L-16.
  - **The returns policy and terms are being drafted separately.** Don't change return windows or fees yet. Checklist L-18, FI-102.
- **C3 (FI-026, Critical): a client price is never trusted.**
  - `Order.create` refuses any item that isn't a real, active product of an active, approved store, with 400 "… is no longer available". That includes items with no `productId`, unknown or inactive ids, and non-UUID ids (which used to give a 500).
  - The price **and the name** stored on the order come from the server row. `validateExternalItemPrice` and the "external/partner item" path are deleted.
- **H4 (FI-097): products from suspended, rejected, pending or inactive stores** are hidden from `Inventory.getProducts`/`getProduct` and refused by `Order.create`. The rule is `stores.is_active = true AND status = 'approved'`, the same one `Store.listActive` already uses.
- **H1 (FI-016, the known launch blocker): the no-driver timeout now cancels cash orders too.**
  - It moved from `server.js` to `orderStateMachineService.cancelNoDriverOrders`; the cron is a thin wrapper.
  - Cash orders get no refund (never charged), a "You have not been charged." message, and a restock.
  - The customer message is still a founder decision.
- **H6 (FI-099):** `recoverPaidOrdersStuckAtPaymentPending`, run by the `recover-stuck-paid` cron, finishes paid orders left at `payment_pending` exactly as the webhook would (`paid`, then `scheduled_for_morning` when closed, otherwise `pending_store_acceptance` with the admin alert). A failure goes to Sentry.
- **M8 (FI-107):** the webhook **and** the reconciliation job mark an order paid only if Paystack's amount equals the order total in cents and the currency is ZAR (`paystackService.amountMatchesOrder`). A mismatch is left unpaid and logged as CRITICAL. `verifyPayment` now returns `providerAmount`/`providerCurrency`.
- **M4 (FI-041):** transfer recipients use `type: "basa"` (South Africa), per Paystack's Transfer Recipient API. Not yet exercised against Paystack.
- **Sizes and stock (FI-113, second commit, founder request on PR #95):**
  - A product with sizes needs the item's size to be one of `flash_inventory.sizes`, and the stock check and decrement always run. Before, a missing size skipped both (an unknown size was refused, but as "out of stock").
  - A product with no sizes is capped at **10 per order** across all its lines, and a client size for it is ignored.
  - Tests: a missing size, an unknown size, and over-stock with a size and without one (the cap), in the unit tests and against real Postgres. The new integration check failed on the first commit's code.
  - Also found: FI-114 (the app always asks for a size, so it can't sell a sizeless product).
- **The audit:** every finding C1–L2 is recorded in `FOUND_ISSUES.md` §G (FI-092–FI-112). C3, H1 and M4 update FI-026, FI-016 and FI-041 in place; FI-065 is updated too.
- **Tests (written first):**
  - `orderClientPriceTrust.test.js` (C3), `realMoneyRecovery.test.js` (H1, H6) and `paymentAmountCheck.test.js` (M8, M4) failed 26 of 29 before the fix. The 3 that passed describe behaviour that was already correct.
  - The **integration** test `storeProductVisibility.test.js` (H4 + C3 against real Postgres) failed 8 of 9 against the old code.
  - `orderStoreAttribution.test.js` now uses real UUIDs, and its two "external item" cases became refusals. The `productPriceValidation.test.js` drift guard now asserts there's no client-price path.
- **Verified:** unit 844/844 (55 suites); integration 28/28 (5 suites) on a fresh local Postgres 17 test DB (after the sizes commit).
- **No migration, no new dependency.**
- **Founder action before merging:** checklist L-15 (Flash Closet's store must be approved and active, or its catalogue disappears).

## 2026-11-24 — v45 applied to production; MFA code moved to next week (`docs/v45-applied`)
- **v45 was applied by the founder on 2026-11-24 at 01:35 SAST**, outside the 06:45–19:45 awake window by founder decision (no traffic; it locks `admins` only). Verified at 01:39 SAST.
  - The step E record: https://github.com/VuyoMakasana/Flash-App/pull/92#issuecomment-7117592795. The second review: https://github.com/VuyoMakasana/Flash-App/pull/92#issuecomment-7116188335.
  - File sha `5b341cf5…`; BEFORE `83a42d48…`; AFTER `aefbc6af…` (79,132 bytes, 69 tables).
  - Backup `flash_public_20261124_012130_pre-v45.dump` (sha `dc36276a…`), verified by step C.
- **Readiness:** 69/69/0, verdict OK. **Advisor (01:57 SAST):** no ERRORs or WARNs; INFO `rls_enabled_no_policy` on 69 tables (+1 is `admin_mfa_recovery_codes`, expected).
- **Founder decisions:**
  - Flash Closet and partner stores must both receive orders and payments at launch, as separate orders, with no existing flow broken.
  - The MFA code (PR 3) moves to next week.
  - Kill switches (L0.5b) still come before any real money.
  - The real-money test is on Sunday 2026-11-29 (small amounts, refunded afterwards).
- **Updated:** `PROD_MIGRATIONS.md` §9 (the v45 row and details), `SCHEMA_BASELINE.md`, `PROJECT_STATE.md`, `LAUNCH_INFRA_CHECKLIST.md` (L-13: steps 1–2 done, steps 3–4 next week).

## 2026-11-23 — `DRIVER_TEST_MODE` switched off in production (docs only, on PR #92)
- **The founder set `DRIVER_TEST_MODE=false` in Render at 22:53 SAST.** The restart was verified in the Render logs (server running, admin panel mounted). New driver registrations start at `pending_documents` again (`models/Driver.js`). **FI-091 is fixed.**
- **Follow-up, new checklist L-14:** drivers who registered while it was on stay auto-approved, with placeholder documents (`file_name = 'test-mode-placeholder'`, shown in the panel as "Verified" with no file) and a `TEST_MODE_GRANT` subscription. The founder reviews them in the admin panel and rejects or suspends anyone who isn't a known tester.
- **Updated:** `FOUND_ISSUES` (FI-091 and the decisions summary), `SECRETS_INVENTORY`, `LAUNCH_INFRA_CHECKLIST` (L-6, new L-14), `PROJECT_STATE`.
- **Not touched:** the v45 SQL, its rollback and `SHA256SUMS` (their hashes are unchanged).

## 2026-11-23 — v45 admin TOTP schema, written and proven; NOT applied. MFA design and lost-phone runbook (#91, `launch/v45-admin-totp`)
- **v45 (`v45_admin_totp.sql`)** follows the v42–v44 pattern: BEFORE/AFTER header, `lock_timeout` 5 s / `statement_timeout` 60 s, `flash.file_sha`, a ledger row with the sha-mismatch refusal, one transaction, idempotent.
  - **`admins`** gains `totp_secret_enc` text (AES-256-GCM ciphertext `v<n>:iv:tag:ct`), `totp_enrolled_at` timestamptz and `totp_last_step` bigint, plus `admins_totp_check`: the secret and enrolment time are set together; a step exists only once enrolled, and is ≥ 0; the secret has the versioned format.
  - **`admin_mfa_recovery_codes`:** uuid PK; `admin_id` → `admins` ON DELETE CASCADE; `code_hash`, a hex-sha256 CHECK; `created_at`; `used_at`; `UNIQUE (admin_id, code_hash)`.
  - **Rule 9:** RLS on the new table, no policies, nothing granted.
  - **Guards check the schema only:** v42 (the ledger table), v43 (RLS on the ledger), v44 (the `feature_switches` table), and that `admins` has a uuid PK. Any partial or unexpected shape raises.
  - **Locks:** one ALTER takes ACCESS EXCLUSIVE on `admins` **first** (so the FK's lock never has to upgrade), held until COMMIT. No other existing table is touched. A re-run takes no lock.
  - **The rollback** drops the table, the CHECK and the three columns, and removes the ledger row. It warns that after PR 3, the MFA code must be reverted first.
- **Fingerprints:** BEFORE `83a42d48…` → AFTER `aefbc6affe4dc1b2041aaa318721620f4abf5289810b945dae11d013ce91ccd9` (79,132 bytes, 69 tables). The change: `admins` re-spelled with 3 columns and the CHECK; the new table plus its PK, FK, UNIQUE and RLS (−1 / +6 statements). File sha `5b341cf5…ac841d04`; rollback `d3bcd4b2…88e422e5`.
- **Proofs (all local, throwaway containers):**
  - **The founder-path rehearsal** (`rehearse.sh` on a restored baseline): apply; re-apply changes nothing; a wrong sha is refused with no change; the rollback returns exactly to the start; AFTER computed with `schema_delta.py apply`.
  - **`v45_rehearsal.sh`, 29/29:**
    - the fixture is production's post-v44 state, and its baseline hashes to BEFORE;
    - readiness 69/69/0 with verdict OK, and `anon` is denied;
    - every CHECK, FK and UNIQUE rule;
    - the replay-guard UPDATE and the single-use code UPDATE work exactly once;
    - a re-apply with MFA data present is byte-identical;
    - the wrong sha, the cascade, the rollback, a second rollback, and four guards;
    - **locks:** it applies while orders, users, drivers, stores, admin_actions and feature_switches are exclusively locked; the file takes **90 ms** inside its transaction; while `admins` is in use it gives up after `lock_timeout` and changes nothing.
  - **`schema_check.sh`:** a fresh `migrate.js` (now including v45) equals the new baseline.
- **Also:** `migrateV45` (`pool.end()` moved to it); `adminCoverage.js` excludes `admin_mfa_recovery_codes`; `SHA256SUMS`; `schema_check.sh`; `.gitignore`; `PROD_MIGRATIONS.md` (tools, the v45 check after step E, the §9 row), `SCHEMA_BASELINE.md`, `TESTING.md`.
- **The design** (`docs/ADMIN_MFA_DESIGN.md`, also in the PR description, for review before PR 3):
  - RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step);
  - AES-256-GCM under the new `ADMIN_TOTP_ENCRYPTION_KEY`;
  - 10 recovery codes of 80 bits each, hashed, shown once;
  - the AdminJS gate and the enrolment page;
  - the API's password → challenge → code flow, with no token before the code;
  - every failure counts toward the lockout, and only a full login resets it;
  - the lost-phone runbook A/B/C.
- **Recorded from the founder (2026-11-23):**
  - PR #90 deployed at 21:50 SAST;
  - in Render: `NODE_ENV=production` and `APP_URL` exist, and **`DRIVER_TEST_MODE=true`** (new FI-091, High; checklist L-6);
  - **L-12 decided:** the morning cold start is accepted during TestFlight, and Render Starter comes before public launch (FI-090). New checklist **L-13** (the MFA rollout order).
- **Verified:** see the PR (unit and integration results on this head).
- **Founder actions:** the second review of v45, merge, then A–E plus the v45 check (`PROD_MIGRATIONS.md` §5). Review the MFA design. `ADMIN_TOTP_ENCRYPTION_KEY` waits for PR 3 (add it before merging PR 3).

## 2026-11-23 — Auth limiter once, unused admin limiter deleted, secrets inventory, keep-awake finding (#89, `launch/fixes-and-secrets-inventory`)
- **PR #88 deployed and verified (founder, 2026-11-23):**
  - `ADMIN_SESSION_SECRET` was added in Render before the merge;
  - the deploy went live at 20:46 SAST, with `[AdminPanel] Mounted at /admin-panel` logged at 20:46:17;
  - the founder logged in and navigated without being logged out, which confirms the Secure cookie works behind Render's TLS.

  FI-088 is fixed and verified; checklist L-11 is done.
- **FI-087, fixed:** removed `router.use(authLimiter)` from `routes/authRoutes.js`. `server.js`'s `app.use("/api/auth/", authLimiter)` is now the only mount, so a customer gets 10 attempts per 15 minutes, not 5. `tests/unit/clientIp.test.js` now expects a step of 1 per request (it was 2).
- **FI-089, fixed (founder decision: delete):** removed `adminAccountLoginLimiter` and its export from `middleware/rateLimiter.js`. `normalizeAdminEmailKey` is kept, because `adminPasswordResetLimiter` uses it. Comments in `rateLimiter.js` and `services/adminLoginLockout.js` are reworded.
- **New test, `tests/unit/authLimiterOnce.test.js`** (written first, failing 6/6 before the fix). It checks:
  - exactly 10 attempts (remaining 9 … 0), and the 11th gets 429 with the standard message;
  - two auth routes share one counter at a step of 1;
  - another client is unaffected;
  - there's exactly one mount;
  - the deleted limiter isn't exported, and nothing in `backend/src` mentions it.
- **`docs/SECRETS_INVENTORY.md` (new):** every variable the backend reads, names only. For each: what it protects, where it's set, when it was added (where known), what happens without it in production, and how to rotate it. Code checks while writing it found that:
  - `APP_URL` is required for card payments in production;
  - `DRIVER_TEST_MODE=true` auto-approves new drivers;
  - `PAYMENT_METHOD_ENCRYPTION_KEY` can't be rotated without a re-encryption migration.

  It flags the **pending database password rotation**, with the safe order.
- **FI-090 (new, High, founder-reported):** Render answers the pinger with 429 while the free service is asleep, and the service doesn't start (2026-11-22, 06:05 and 06:15 SAST). Once awake, the pinger keeps it awake (2026-11-21, 14:09–20:10). The decision is new checklist item **L-12**: Render Starter (about US$7/month) before public launch, or accept the morning cold start during TestFlight. `CRON_JOBS.md` no longer claims the 06:05 ping wakes the server.
- **Verified:** unit 800/800, integration 18/18 on `bdbb203`; CI green. **Merged as PR #90 and deployed (founder): live 2026-11-23 21:50 SAST, admin panel mounted.**
- **Founder actions:** decide L-12; confirm `NODE_ENV=production` and `DRIVER_TEST_MODE` in Render (SECRETS_INVENTORY "Check these first"); rotate the database password.

## 2026-11-21 — Admin hardening: real client IP for rate limits, session cookie and secret, role, lockout, dummy hash (#87, `launch/admin-hardening`)
- **A0 / FI-088 (High), fixed:** with `trust proxy 1` and production's 3-entry `X-Forwarded-For`, `req.ip` was the right-most entry, a Render-internal proxy. Every per-IP limiter keyed on it. `middleware/clientIp.js` (mounted first) now sets `req.ip` from `CF-Connecting-IP`, on Render only and only if it's a valid IP; `X-Forwarded-For` is never used for the key. Tests use the real header shape: separate clients, the same client across edges, and spoofing via `X-Forwarded-For` and `True-Client-IP`.
- **A2:** the cookie is `flash_admin_session`, httpOnly, Secure in production, SameSite=Strict, 8 h, and the session id is regenerated at login.
- **A3:** `ADMIN_SESSION_SECRET` (32+ characters, not `ADMIN_JWT_SECRET`) is required in production. Without it the panel doesn't mount (404) and the API is unaffected.
- **A4:** `role = 'admin'` only, and create, delete and bulk delete are off on `drivers`.
- **A1b:** a per-account lockout (5 failures in 15 min, express-rate-limit's `MemoryStore`) shared by both admin logins.
- **A7:** a dummy-hash comparison for unknown emails. Both logins share `services/adminCredentials.js`.
- **Stamp-file test** added (held from #86).
- **Found:** FI-087 (`authLimiter` applied twice; open), FI-089 (the per-account limiter was never wired; superseded).
- **Verified:** unit 794/794, integration 18/18; a live production-mode run (no secret: panel 404, API 200; with it: cookie flags, a new session id over a planted one, the shared lockout returning 429).
- **Founder action:** add `ADMIN_SESSION_SECRET` in Render **before** merging (checklist L-11).

## 2026-11-21 — v44 applied to production; readiness evidence kept per run (`docs/v44-applied`)
- **v44 applied by the founder on 2026-11-21 at 14:17 SAST.**
  - Steps A–E passed; verified at 14:19 SAST.
  - The step E record is on PR #85: https://github.com/VuyoMakasana/Flash-App/pull/85#issuecomment-7063019801.
  - File sha `332926f4…`; BEFORE `689f03b4…`; AFTER `83a42d48…`.
  - Backup `flash_public_20261121_140851_pre-v44.dump` (sha `94563bd5…`), verified by step C.
- **Readiness:** 68/68/0, `postgres` defaults = `postgres` + `service_role`, verdict OK.
- **Advisor (15:04 SAST):** no ERRORs or WARNs; INFO `rls_enabled_no_policy` on 68 tables (expected).
- **Fix:** `R-RlsReadiness.ps1` saved to a fixed file name, so the post-v44 run overwrote the pre-v43 readiness file. It now saves to `rls_readiness_<yyyyMMdd_HHmmss>.txt` (or `rls_post_v43_<…>.txt`) through the new `Get-FlashStampedFileName`, so every run is kept.
  - It's verified under PowerShell 5.1: exact format, distinct names a second apart, and refused path-like names.
  - Scripts only, nothing under `backend/`: the jest test for it is held for the next backend PR, because this PR may not touch `backend/`.
- **Updated** `PROD_MIGRATIONS.md` §9, `SCHEMA_BASELINE.md`, `PROJECT_STATE.md` and the older WORKLOG heading, so that none says v44 is pending.

## 2026-11-21 — L0.5a: v44 `feature_switches` written and proven locally; NOT applied by that PR (#84, PR #85, merged; **applied by the founder 2026-11-21 14:17 SAST**, see the entry above)
- **v44** creates `public.feature_switches`:
  - `key` text, the primary key, with a CHECK limited to the 8 known keys;
  - `enabled`, `updated_at` and `updated_by`. `updated_by` has no foreign key, so v44 locks no existing table; the audit trail goes in `admin_actions` in L0.5b.
  - There is no message column; messages live in code.
  - RLS on, no policies, no grants (rule 9).
  - Seed: on for `card_payments`, `new_orders`, `cash_orders`, `store_portal_writes` and `signups`; off for `driver_payouts`, `premium` and `boosts`. The seed uses `ON CONFLICT DO NOTHING`, so a re-run never resets a flipped switch.
  - Rollback drops the table and the ledger row.
- **BEFORE `689f03b4…` → AFTER `83a42d48…`.** The change is 3 statements: the table with its CHECK, the PK, and RLS. File sha `332926f4…`.
- **Found while writing:** a guard on ledger *rows* would make step D's schema-only rehearsal always fail. v44 checks a schema fact instead, and the rule is now in `PROD_MIGRATIONS.md` §4.
- **Proofs:**
  - the founder-path rehearsal;
  - `v44_rehearsal.sh` on production's post-v43 state: seeds; readiness 68/68/0; a flipped switch survives a re-apply; wrong sha refused; rollback; guards; applied while `orders`, `users` and `admins` were exclusively locked;
  - unit, integration and the schema check.

  `adminCoverage.js` records the table as intentionally not a default AdminJS resource.
- **Not applied.** Next: the founder's second review, then A–E. L0.5b only after that.

## 2026-11-21 — L0.4: cheap /health, protected /health/db, driver withdrawals closed, rule-11 CI check (#82, `launch/l0-4-health-payouts`)
- **`GET /health`** is now liveness only: `200 {"status":"ok"}`, no-store, no database, no version, no Redis status; mounted before the request logger. It used to run `SELECT 1` through the pool on every call, with no rate limit.
- **`GET /health/db`** (new):
  - the `X-Health-Token` header is compared in constant time against `HEALTH_CHECK_TOKEN`;
  - a wrong or missing token, or no token configured, gets the normal 404;
  - the result is cached for 15 s, and concurrent requests share one query;
  - it returns only `{database, latencyMs}`, with 503 on error;
  - it's never logged, and the logger also redacts `x-health-token`.
- **FI-086 fixed:** `POST /api/drivers/wallet/payout-request` started a live Paystack transfer. It now refuses (`403 WITHDRAWALS_DISABLED`) behind `requireApprovedDriver`, before any database write or Paystack call; the old handler is removed and `PayoutService` kept for L3. The driver app has no withdraw button.
- **Rule 11 CI check** (FI-085), plus a fix to the rule-9 regex, where `public.` matched any character.
- **Docs:** the pinger setup and free-hours maths (`CRON_JOBS.md`, `LAUNCH_INFRA_CHECKLIST.md` L-10, L-3 note).
- **Founder action:** add `HEALTH_CHECK_TOKEN` in Render, then set up the two cron-job.org jobs.

## 2026-11-21 — v43 applied to production; FI-081 fixed (`docs/v43-applied`)
- **v43 applied by the founder on 2026-11-21 at 11:09 SAST.**
  - Steps A–E and `R-RlsReadiness.ps1 -PostV43` all passed; verified at 11:12 SAST.
  - The step E record is on PR #80: https://github.com/VuyoMakasana/Flash-App/pull/80#issuecomment-7060545953.
  - File sha `4c26cb10…`; BEFORE `4355621a…`; AFTER `689f03b4…`.
  - Backup `flash_public_20261121_105627_pre-v43.dump` (sha `eeba7469…`), verified by step C.
- **Post-check:** `rls_enabled=67`, `tables_with_anon_or_auth_privs=0`, `postgres` defaults = `postgres` + `service_role` only, verdict OK.
- **Advisor:** no ERRORs; both `pg_graphql` WARNs 67 → 0; INFO `rls_enabled_no_policy` on 67 tables (expected).
- **Live check:** `/api/inventory` 200; jobs ran with no permission or RLS errors.
- **FI-081 → Fixed.** The remaining accepted gap is `supabase_admin`'s default ACLs.
- **New FI-085 (Low):** `PUBLIC` `EXECUTE` on new functions; none exist today.
- **New rule 11** (`PROD_MIGRATIONS.md` §1): every migration that creates a function revokes `EXECUTE … FROM PUBLIC` and grants nothing to `anon`/`authenticated`.
- **Updated** `PROD_MIGRATIONS.md` §9, `SCHEMA_BASELINE.md` §10, `PROJECT_STATE.md` and older `WORKLOG.md` lines, so that none says v43 is pending.
- Docs only.

## 2026-11-21 — v43 RLS lockdown written and proven locally; NOT applied by that PR (#73, PR #80, merged; **applied by the founder 2026-11-21 11:09 SAST**, see the entry above)
- **Repo search before writing:** nothing in the backend, either app, the store portal or the scripts uses supabase-js, an anon or publishable key, Storage, Realtime, auth, or REST/GraphQL. The only Supabase hits are the Postgres connection string, a dashboard link, the never-run `test-db.js`, a test fixture, the pooler-host check, and the read-only Supabase MCP dev tool.
- **Non-table objects in `public`** (baseline and `migrate.js`): 0 sequences, 0 functions or procedures, 0 views, 0 triggers; 1 enum type (`order_status_enum`, not touched).
- **v43:**
  - RLS on all 67 tables, with no FORCE and no policies;
  - revoke `anon`/`authenticated` on tables, sequences and functions;
  - revoke them from `postgres`'s default privileges in `public`;
  - guards: an exact table set by name (67 on production; 64 = the 67 minus the 3 settlement orphans on fresh/CI), and the applying role keeping access;
  - an in-transaction proof, then the ledger row.

  The rollback disables RLS and removes the ledger row; it never re-grants. AFTER is `689f03b4…`; the change is exactly 67 `ENABLE ROW LEVEL SECURITY` statements.
- **Proofs:**
  - the grant rehearsal on production's real grant state passed;
  - the backend-role integration test passed;
  - rule 9 and the post-v43 evaluator are unit-tested.

  `R-RlsReadiness.ps1 -PostV43` is the check after step E.
- **Not applied.** Next: the founder's second review of the SQL, then A–E.

## 2026-11-21 — v42 applied to production; records updated (`docs/v42-applied`)
- **v42 applied by the founder on 2026-11-21 at 07:55 SAST.**
  - Steps A–E all passed; verified at 09:38 SAST.
  - The step E record is on PR #72: https://github.com/VuyoMakasana/Flash-App/pull/72#issuecomment-7059420526.
  - File sha `b4dd4c84…`; BEFORE `697134af…`; AFTER `4355621a…`.
  - Backup `flash_public_20261121_074206_pre-v42.dump` (sha `f8d8b5a3…`), verified by step C.
- **Security advisor:** no ERRORs. The two `pg_graphql_*_table_exposed` WARNs went from 66 to 67, because `schema_migrations_ledger` inherited `postgres`'s default grants. v42 predates rule 9; accepted, not rolled back. FI-081 is noted: v43 must cover all 67 tables.
- **Recorded:** the Supabase free plan has no backups (`LAUNCH_INFRA_CHECKLIST.md` L-9; `PROD_MIGRATIONS.md` §6). Step B is the only backup.
- **`.gitignore`:** `flash-store-portal/.env` can no longer be committed.
- **Updated** `PROD_MIGRATIONS.md` §9, `SCHEMA_BASELINE.md` §10 and `PROJECT_STATE.md`, so that none says v42 is unapplied.
- Docs and `.gitignore` only.

## 2026-11-21 — v43 decisions and standing rules recorded (#73, `launch/v43-decisions`)
- **Founder decisions for v43:**
  - the rollback disables RLS only and never re-grants `anon`/`authenticated`;
  - `service_role` stays as is, and its key must never be in the apps, the website or the repo;
  - default privileges owned by roles we can't alter (e.g. `supabase_admin`) are an accepted, recorded gap. They only apply to objects that role creates.
- **Standing rules** (`PROD_MIGRATIONS.md` §1, rules 9–10; `WORKFLOW.md` §1):
  - every migration that creates a table enables RLS on it and grants nothing to `anon`/`authenticated`;
  - every step E records the Supabase security advisor's result.

  `E-Verify.ps1` now prints that reminder.
- **v43 is still not written.** It waits for the readiness check (OK) and v42's A–E. (v42's A–E passed on 2026-11-21. v43 was then written in PR #80 and **applied on 2026-11-21 at 11:09 SAST**.)

## 2026-11-21 — Launch plan L0.3: cron audit, FI-014, logging, awake window (#75, `launch/l0-3-cron-window`)
- **FI-014 root cause confirmed:** Render runs the root `server.js`, which requires `src/server.js`. There, `require.main === module ? startServer() : createApp()` ran `createApp()` at require time, registering all 16 crons; then `startServer()` registered all 16 again.
  - Also found: the first set captured an `io` that never listened, so its socket emits reached no one.
  - Also found: graceful shutdown closed that non-listening server, not the live one.
- **Fix:**
  - `src/jobs/cronRunner.js`: register once per process; start/finish/fail logs; no overlap; SAST daily slots inside 06:45–19:45; startup catch-up for daily jobs.
  - `createApp({ withCronJobs })`, so only `startServer()` asks for crons.
  - Lazy exports.
  - The escalation claim UPDATE.
  - The 4 out-of-window daily jobs moved to 06:50–06:56 SAST; the morning release stays at 07:00 (explicit SAST).
  - Audit: `docs/CRON_JOBS.md`.
- **Found:** FI-073 lead. Startup blocks the event loop for about 54–69 s locally on `main` too, longer than the 5 s DB connect timeout. Recorded; to fix in L1.
- **Verification:** see PR.

## 2026-11-20 — FI-081 raised to Critical; v43 readiness check (#73, `launch/v43-rls-readiness`)
- **Founder-reported (2026-11-20):**
  - The Supabase advisor confirmed `rls_disabled_in_public` (ERROR) on all 66 tables.
  - The founder disabled the Data API; the waitlist still works, and that warning cleared.
  - `pg_graphql_anon_table_exposed` and `pg_graphql_authenticated_table_exposed` remain, on 66 tables each.
  - No app uses supabase-js, the anon key, or REST/GraphQL.
- **FI-081 → Critical**, mitigated by the Data API being off. The fix is v43: RLS on every `public` table, revoke from `anon`/`authenticated`, default privileges. It is a **proposal under review, not written**.
- **New:** `scripts/prod-migrations/R-RlsReadiness.ps1` + `rls_readiness.sh`, a read-only check that the backend role stays exempt from RLS on every table. Verified locally only, on a prod-shaped DB with Supabase-like roles; see PR.
- **New FI-083 (High):** Supabase is in Frankfurt and Render in Oregon, so every query crosses the Atlantic. Added `LAUNCH_INFRA_CHECKLIST.md` **L-8** (move `Flash-App` to Render Frankfurt).
- **PR #72 merged and deployed** (`09bf0d3`). The founder posted the second-review comment on it. **v42 was not yet applied at that point**; the founder ran A–E next. (**Applied 2026-11-21 07:55 SAST**, see the 2026-11-21 v42 entry.)

## 2026-11-20 — Launch plan L0.2: production migration process (#71, PR #72, merged)
- **Process approved by the founder** with six changes. All six are implemented, and the process is documented in **`docs/PROD_MIGRATIONS.md`**:
  - BEFORE/AFTER header fingerprints;
  - the ledger hash passed as `-v file_sha`;
  - step D's git and PR-hash pre-checks;
  - PowerShell-only steps A–E through `docker run`;
  - backup location, retention and encryption;
  - a second review before step D.
- **v42 (approved):** `schema_migrations_ledger (version text PK, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`, as a standalone file. `migrateV42` only runs that file. There is a guarded rollback file.
  - Baseline: `697134af…` (66 tables) → `4355621a…` (67 tables). The change is exactly the new table and its PK.
- **v42 was not applied to production by that PR.** The founder applied it with steps A–E on **2026-11-21 at 07:55 SAST** (see the 2026-11-21 v42 entry).
- **Found while building it:** a restored copy of production re-spells 2 CHECK constraints (FI-082). That's why steps C and D compare like with like, or compare deltas. Also recorded FI-081 (no RLS on `public`; Supabase Data API exposure unverified; founder check).
- **WORKFLOW.md:** the launch plan, the founder decisions, the per-fix process and the deferred list are recorded; rule 3 now requires a second review.
- **Verification:** local throwaway containers only; production was never contacted. See PR #72.

## 2026-11-20 — Launch plan L0.1: local/test isolation (#69, PR #70, merged)
- **Added:**
  - A jest `setupFiles` bootstrap that refuses any run whose `DATABASE_URL` host isn't `localhost`, `127.0.0.1` or `::1` (or that matches a production marker), or that holds a **live** Paystack key.
  - `backend/.env.test.example` (`backend/.env.test` is now git-ignored; it wasn't before).
  - `docker-compose.test.yml`: Postgres 17, `127.0.0.1:55432`, tmpfs.
  - npm scripts `test:db:up` / `test:db:migrate` / `test:db:down` (the migrate helper is guarded the same way).
  - `docs/TESTING.md`.
- **Test-first:** `tests/unit/testEnvGuard.test.js` failed before the fix (`Cannot find module`) and passes after (14 tests, including jest wiring and child-process runs of the bootstrap).
- **Verified locally against Postgres 17.12 only:** migrate v1–v41 with no v41 skips; unit 637/637 (44 suites); integration 7/7 (2 suites). A full run with a remote URL, and a full run with a live key, were each refused before any test executed.
- **FI-004:** mitigated.
- **No runtime change.**

## 2026-11-20 — Phase 3: cleanup (`foundation/cleanup`)
- **Deploy diagnosis** (founder, from Render): the backend (`rootDir=backend`) auto-deploys only for `main` commits that touch `backend/` and pass CI.
  - `4de9d57` (CI only) and `abcfa49` (docs/settings only) were skipped by design.
  - `9b20249` was blocked by the old Secrets Scan failure.
  - The store portal deployed all three.
  - **My earlier top hypothesis (Render waiting on queued, zero-run check suites) was wrong**, and the founder's evidence replaced it.
  - Recorded in WORKFLOW §3 and LAUNCH L-2a.
  - New issues: FI-079 (a stuck check-run record) and FI-080 (unused GitHub apps).
- **Local branches** (List A): `git branch -d` deleted 37 of the 38 approved merged branches.
  - It refused `multi-tester-readiness`: it has 4 commits its remote lacks, all 4 already in `main`. Needs `-D`, which is a founder call.
- **Worktrees:** removed `ci-secrets-scan` and `main-adminjs-fix`, without `--force`, both clean; deleted the `status-check` branch.
  - `agent-acb9bacfac06dd01a` is waiting for the founder to move its pentest-report copy out.
  - `agent-a6598502319f8f63f` and `feature-storefront-port` are kept untouched.
- **Kept all 33 unmerged branches** (List D).
- **Docs** (List E): added `docs/audits/INDEX.md` and historical-log banners on `README.md` and `HOW_TO_RUN.md`; **no files moved**.
- **GitHub:** 8 labels to be created; 27 issues drafted for founder approval (List F).
- **Remote merged branches** (List B) are left for the founder to delete in the GitHub UI.
- **Follow-up (2026-11-20, founder-approved):**
  - The founder moved **both** pentest-report copies out of the repo. `.gitignore` now blocks `SECURITY_SELF_PENTEST_REPORT*.md`, and INDEX.md and PROJECT_STATE.md note that the report is kept outside the repo.
  - Worktree `agent-acb9bacfac06dd01a` and its branch removed, without `--force`, clean.
  - `multi-tester-readiness` deleted with `-D` after `git cherry` showed 0 outstanding commits.
- **Context recorded:**
  - A live Paystack key exists (Render env only); card payments stay OFF in the apps. FI-041 and FI-062 now read "latent until card payments are switched on in the app".
  - iOS-only launch: FI-019's Android `FOREGROUND_SERVICE` part is out of scope for launch, and FI-033's iOS external-checkout item is flagged as launch-relevant.
- **GitHub:**
  - Milestone **iOS launch** (#1) created, with no issues assigned.
  - **29 issues created (#40–#68)** with labels, verified against GitHub (29 open, 0 on a milestone, labels match exactly).
  - Issue numbers added to `FOUND_ISSUES.md`.

## 2026-11-19 — Phase 2: guardrails (`foundation/guardrails`)
- **Added:**
  - `docs/WORKFLOW.md`, `docs/FOUND_ISSUES.md` (69 items: condition-5 hazards, re-verified audit findings, N-1–N-21, schema-baseline items, founder-reported Render findings), `docs/APP_STATES.md` (money/order app-state standard, with today's backend and client error behaviour documented first), `docs/WORKLOG.md`;
  - PR and issue templates;
  - `.claude/settings.json` deny/ask rules;
  - a "Read first" pointer in `CLAUDE.md`.
- **Plan change:** Phase 5A (app state inventory, read-only) added after Phase 5.
- **Found while writing APP_STATES.md:** FI-059 (`validate()` uses `err.param`, undefined on express-validator 7.3.2).
- **Found checking why Render did not deploy PR #36:** FI-077. The CI Secrets Scan failed on **every push to `main`** (TruffleHog base == head); 8 of 8 recent `main` runs failed on that job alone. **Fixed separately in PR #37** (approved, merged first); verified on `main` push run #128 (`4de9d57`): all 4 jobs passed, Secrets Scan `commits_scanned: 2`, 0 secrets.
- **Added FI-078** (Medium): the scan's `--only-verified` lets unverifiable leaked credentials pass CI; revisit in Phase 8.
- **Started `docs/LAUNCH_INFRA_CHECKLIST.md`** (L-1 branch protection on `main`, L-2 fix the Secrets Scan, …).
- **Verification:** documentation and config only, so no runtime change.
  - Deny rules tested live, with harmless `--help` forms only: `gh pr merge`, `git rebase`, `git reset --hard`, `git clean`, `rm -rf`, `rm -r`, `supabase`, `npx supabase` and `render` were all denied.
  - The Supabase and Render MCP tools became unavailable in-session once the file was saved.
  - Ask rules not exercised.
  - **Confirmed via `/permissions` on 2026-11-19** (run and reviewed by the founder) for the rules that existed then: 43 deny, 8 ask (commit `5b39eab`). The founder also removed the local allow `Bash(git stash *)` from `.claude/settings.local.json`.
  - **Also confirmed via `/permissions` on 2026-11-19** (second check, run by the founder after the session reloaded them): the additions in `7c6c223` (every `git push` → ask; deny `git reset --hard`, `git clean`, `rm -r`/`-rf`, `supabase`, `npx supabase`, `render`; ask `git branch -D`, `git restore`, `git checkout --`, `psql`, `pg_dump`, `pg_restore`) and the `PowerShell` tool deny (`22d2acc`). Final totals: 52 deny, 16 ask.
  - **`PowerShell` tool denied entirely** (`/permissions` lists rules, not tools; the AI session confirmed it has a PowerShell tool). All shell commands now go through Bash, where the Bash rules apply.

## 2026-11-19 — Schema baseline, fix N-18 (PR #36, merged)
- Production schema baseline committed (normalized, secret-scanned).
- Migration v41 brings fresh DBs to production's definition, proven a zero-DDL no-op on production's schema.
- `scripts/schema-baseline/schema_check.sh` added.
- **v41 has NOT been run on production.**
- **Verification:** 8 local proofs plus an independent review (`docs/SCHEMA_BASELINE.md` §11); CI green on Postgres 15.
- **Open:** `migrate.js` is unsafe on production (FI-060); Supabase-tooling DDL outside review (FI-061); Phase 6 items FI-068 and FI-069.

## 2026-11-19 — Phase 1 Part A: independent verification (PR #35, merged)
- A fresh subagent re-checked 25 claims: 18 confirmed, 4 with wrong lines or timing, 3 partially correct.
- `PROJECT_STATE.md` corrected and checked against the confirmed payment model.

## 2026-11-18 — Phase 1: `PROJECT_STATE.md` (PR #34, merged) + docs PRs #16, #25 merged
- Read-only re-audit of `main`.
- PRs #16 (squatted-email proposal) and #25 (payment-model audit) merged as documents only.
