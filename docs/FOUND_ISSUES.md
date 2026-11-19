# Flash — Found Issues Register

**The single list of problems found and NOT yet fixed.** An issue is recorded here the moment it is found, then fixed separately, with founder approval, on its own branch. Nothing here has been changed in code unless its Status says so.

- **Created:** 2026-11-19 (foundation Phase 2), from: `docs/PROJECT_STATE.md` (Phase 1 + Part A verification), `docs/SCHEMA_BASELINE.md` §8a, the founder's Phase 1 condition 5 list, and the founder's Render findings.
- **Severity:** Critical / High / Medium / Low / Info.
- **Status:** `Open` (not fixed), `Decision` (needs a founder call first), `Latent` (real but not reachable until something else ships), `Mitigated` (partly handled), `Fixed` (with PR).
- **Source:** where it was found and how confident we are. "Founder-reported" means taken from the founder's own dashboard check and **not independently verified** by Claude Code.
- **IDs are stable.** Never renumber. When fixed, set Status to `Fixed (PR #N)` and keep the row.
- The `PROJECT_STATE.md` IDs (C-, H-, N-, P-, M-) are kept as the second column so the two documents cross-reference.

---

## A. Environment and safety hazards (founder's Phase 1 condition 5)

| ID | Ref | Sev | Issue | Evidence | Status |
|---|---|---|---|---|---|
| FI-001 | cond.5 | **High** | `.vscode/mcp.json` configures a Supabase MCP server (`supabase`) that points at **production**. Any MCP-capable tool opened in this repo can read or alter production. This is the route by which unreviewed production DDL, including a `DROP`, has already happened (FI-061). | `.vscode/mcp.json` (server `supabase`); SCHEMA_BASELINE.md §2 | **Decision**: remove or disable it, or repoint to staging (SCHEMA_BASELINE.md §8) |
| FI-002 | cond.5 | High | Both mobile apps, and **every** `eas.json` profile, default to the **production** API. A dev or preview build talks to production unless `EXPO_PUBLIC_API_BASE_URL` is set. | `flash-user-app/services/api.js`, `flash-driver-app/services/api.js`, both `eas.json` | Open |
| FI-003 | cond.5 | High | Three worktree env files point at an **unidentified remote database**. | `.claude/worktrees/*` env files (paths only; never read) | Open |
| FI-004 | cond.5 | Medium | `backend/tests/integration/adminCoverage.test.js:23` opens `new Pool({ connectionString: DATABASE_URL })` with **no local-host guard**. Run with a production URL in the shell, it connects to production. | `adminCoverage.test.js:23` | Open (Phase 4 local-host guard) |
| FI-005 | cond.5 | **High** | `backend/src/db/migrate.js` has **no production guard**; it runs against whatever `DATABASE_URL` is set (`migrate.js:17`). Combined with FI-060 this is the most dangerous script in the repo. | `migrate.js:17`; SCHEMA_BASELINE.md §6 | Open (rule in force: never run it on production) |
| FI-006 | P1 | Info | Hazards that must never be run: `backend/test-db.js` (hard-codes the production DB host, `rejectUnauthorized: false`) and `scripts/final-verification.sh` (prints `.env` secrets). Both are denied in `.claude/settings.json`. | PROJECT_STATE.md §4 | Open (delete or quarantine: founder decision) |

## B. Earlier audit findings, re-verified on `main` (PROJECT_STATE.md §5, §10)

| ID | Ref | Sev | Issue | Evidence | Status |
|---|---|---|---|---|---|
| FI-010 | C-1 | **Critical** | **Driver payout double-debits or loses money.** The request deducts from the wallet, processing checks the already-reduced balance, and finalize deducts again. **Compounding:** on an instant Paystack success, finalize hits FI-012's insert, rolls back, and the request is marked `failed` although the money was sent. | `DriverWallet.js:129-134`; `payoutService.js:16,37,165-172,186-191` | Open (reachable via API only; no payout button) |
| FI-011 | C-2 | **Critical** | Commission debt is forgiven on partial payouts. On full absorb it throws and rolls back while telling the driver the debt was reduced. | `driverCommissionService.js:187-248` (message `:224`) | Open |
| FI-012 | C-3 | **Critical** | `'payout_debit_reconcile_required'` (31 chars) is written into `VARCHAR(30)`, so the "safety" path itself throws. | `migrate.js:402`; `payoutService.js:207` | Open |
| FI-013 | C-4 | **Critical** | OAuth account takeover: Google/Apple link to an existing account by email without `email_verified`, and Apple falls back to a **client-supplied** email. | `authController.js:322-329,384-392,614,672` | Open |
| FI-014 | C-5 / P-1 | **Critical** | **Every cron runs twice in production** (`createApp()` runs at require time and again in `startServer()`). Escalation crons can double-send, because the UPDATE has no `IS NULL` guard. | `src/server.js:979,1002`; `orderStateMachineService.js:965/973,994/1002` | Open |
| FI-015 | C-6 | **Critical** (likely) | Email/password customers are blocked until email is verified, but verification is unreachable: no GET route, an unregistered `flash://` scheme, and the app never calls verify. | `authController.js:110`; `emailService.js:188-189`; `authRoutes.js:48` | Open (what `APP_URL` serves is unverified) |
| FI-016 | P-2 | **Critical** (launch blocker) | **A cash order with no driver hangs forever.** The no-driver cron filters `payment_status='paid'`, but cash is `pending_cash`. No cancel, no refund, no restock, no alert. | `src/server.js:652-662`; `Payment.js:194` | **Decision** (customer message) + Open |
| FI-017 | P-3 | Medium | `CASH_OTP_SECRET` is guarded in production, but a **weak value** cannot be ruled out. | `cashOtpService.js:16-29` | Open (founder dashboard check) |
| FI-018 | H-7 | High | Token-refresh race: both apps refresh with no single-flight, so concurrent 401s trigger reuse detection, which revokes every session. | `flash-user-app/services/api.js:92-118`; `flash-driver-app/services/api.js:88-114`; `authController.js:450-470` | Open |
| FI-019 | H-8 | High | Driver location is unreliable. The background task re-reads the token, but **cannot refresh** it, so it 401s silently after about 15 min backgrounded. There is no foreground reporting and no `FOREGROUND_SERVICE` permission. *(Part A: "never refreshed" was overstated.)* | `flash-driver-app/tasks/backgroundLocationTask.js:85-114`; `app.config.js:81-90` | Open (device behaviour unverified) |
| FI-020 | H-9 | High | A driver can cancel a paid order with no refund, no `order_cancellations` row and no wallet reversal. | `orderController.js:283-334`; `orderStateMachineService.js:60-61,196,211-221` | Open |
| FI-021 | H-10 | High | `markCashFailed` is repeatable, so one driver can flag a customer in two calls, and the order is stranded at `delivered`. | `paymentController.js:523-575` | Open |
| FI-022 | H-11 | High | The driver dashboard socket never reconnects after `auth_expired` (about **28 min**, not 14: Part A correction). | `flash-driver-app/app/driver/dashboard.js:151-182`; `DriverContext.js:81,165,211,221` | Open |
| FI-023 | H-12 | High | User `TrackingScreen` leaks a 10 s poller on every `connect_error`, never cleared. | `flash-user-app/screens/TrackingScreen.js:252-292` | Open |
| FI-024 | H-13 | High | `OrderStatusScreen` crashes when opened with only `orderId` (the `PaymentScreen` path). | `OrderStatusScreen.js:57-60,131`; `PaymentScreen.js:86` | Open |
| FI-025 | H-14 | High | Pending drivers can't log back in to finish onboarding. | `authController.js:575-586`; `flash-driver-app/app/auth/login.js:72-75` | Open |
| FI-026 | H-15 | High | Non-inventory `productId` items take a client price (bounded only), and the no-`productId` path always 500s. | `Order.js:196-213,319-323`; `migrate.js:220` | Open |
| FI-027 | H-16 | High | Cash returns can never be refunded. *(Part A: the duplicate-refund half is **disproven**; production also has the UNIQUE constraint.)* | `refundService.js:59`; `Return.js:295` | Open |
| FI-028 | H-17 | High | Customers see the driver's live location and phone on **their own** historical orders at any status. Only a blocked pair is masked, and only in one query. | `Order.js:385-390,430-432,438-441`; `User.js:~147-150`; `Tracking.js:6-7` | Open |
| FI-029 | H-18 | High | Real-time admin alerts (SOS, refund-failed, connection-lost) reach no one: sockets verify only `JWT_SECRET`, and admin tokens use `ADMIN_JWT_SECRET`. | `socketServer.js:100,108`; `adminController.js:35` | Open |
| FI-030 | M-1 | Medium | `rate-limit-redis` is not installed, so limits are per process (matters at more than one instance). | `rateLimiter.js:19-36` | Open |
| FI-031 | M-2 | Medium | The commission stamp runs inside the completion transaction without a SAVEPOINT. A SQL error there aborts completion. | `orderStateMachineService.js:266-287` | Open |
| FI-032 | M-4 | Medium | AdminJS session: default **MemoryStore**, no `secure`/`sameSite` cookie flags, and `ADMIN_JWT_SECRET` reused as cookie password and session secret. Also founder-reported in the Render findings (FI-074). | `adminPanel.js:2358-2371` | Open |
| FI-033 | — | Medium | Other carried Mediums: cash orders inflate `pending_balance`; commission deductions write no ledger row; plan delivery limits are never enforced; `assignDriver` ignores subscription; OAuth drivers can't save a bank account; checkout silently changes the login email; an unsigned-JWT logout can force a driver offline; cash-on-delivery has no status check; a payment can be initialised for a cancelled order; trend/revenue endpoints are open to any user; no account lockout; no phone uniqueness; no chargeback handling; OAuth age-gate bypass; iOS external Paystack subscription checkout. | PROJECT_STATE.md §5 (Medium table) | Open (split into individual issues on triage) |

## C. New findings from the Phase 1 re-audit (PROJECT_STATE.md §6)

| ID | Ref | Sev | Issue | Evidence | Status |
|---|---|---|---|---|---|
| FI-040 | N-1 | **High** | **The store portal never receives live order updates.** Store tokens are rejected by the socket server, no `store:<id>` room exists, and there's no polling. With a 15-min auto-reject, a store can miss orders. | `socketServer.js:108`; `flash-store-portal/src/hooks/useStoreSocket.js`; `OrdersPage.jsx:35,41` | Open |
| FI-041 | N-2 | High (latent) | Transfer recipients use Paystack `type: "nuban"` with ZAR; South Africa needs `basa`. Affects **both** store and driver bank registration (Part A widened the scope). | `paystackService.js:368-376`; `storeBankingController.js:126`; `driverController.js:617` | Latent (needs a live key) |
| FI-042 | N-3 | Medium | Store `updateStock` does not validate `stock_by_size` values (negative, non-numeric and arrays all pass). | `storeInventoryController.js:170-193` | Open |
| FI-043 | N-4 | Medium | Admin-added inventory gets `store_id = NULL` in **fresh/test DBs only**. In **production** the column is `NOT NULL DEFAULT <first store>` (see FI-066). Fresh DBs match production since v41 (PR #36). | `models/Inventory.js:39-52`; SCHEMA_BASELINE.md §4.3 | Mitigated (v41) |
| FI-044 | N-5 | Low | `/api/store-auth/reset-password` has no route-level limiter. *(Part A: downgraded, because the global `/api/` limiter covers it.)* | `storeAuthRoutes.js:27-37`; `server.js:188` | Open |
| FI-045 | N-6 | Low | The store reset token is double-spendable (no row lock, no `used_at IS NULL` guard) and stored in plaintext. | `storeAuthController.js:207,231-247` | Open |
| FI-046 | N-7 | Low | Store email is case-sensitive; `createStaff` doesn't normalize. | `StoreUser.js:14`; `storeStaffController` | Open |
| FI-047 | N-8 | Low | `reactivateStaff` can reactivate an anonymized (deleted) account. | `storeStaffController` | Open |
| FI-048 | N-9 | Low | Storefront `:storeId` is exempt from UUID validation, so a malformed id returns a 500. | `validation.js:26`; `storefrontRoutes.js:14` | Open |
| FI-049 | N-10 | Low | Store staff see customer and driver phone numbers. | `storeOrderController` | **Decision** (policy) |
| FI-050 | N-11 | Low | The portal stock input PATCHes on every keystroke (full replace), so out-of-order responses can persist a stale value. | `InventoryPage.jsx:59-63,236` | Open |
| FI-051 | N-12 | Low | The store JWT (8 h, no refresh) is kept in `localStorage`. | `StoreAuthContext.jsx`; `services/api.js` | Open |
| FI-052 | N-13 | Info | `Store.getDefaultStoreId` appears unused. | `models/Store.js` | Open |
| FI-053 | N-14 | Medium | AdminJS store-order actions pass no `io`, so admin-driven accept/reject/ready send no socket events, and admin rejections are recorded as `cancelled_by_role='store'`. | `adminPanel.js:1153,1172,1189`; `orderStateMachineService.js:94-95,565` | Open |
| FI-054 | N-15 | Low | The AdminJS `flash_inventory` form leaves `stock_by_size` unvalidated and `store_id` as free text, and new/edit actions are not logged to `admin_actions`. | `adminPanel.js:1760-1811` | Open |
| FI-055 | N-16 | Low | The three `marketing_*` AdminJS resources leave hard **delete** enabled. | `adminPanel.js:1814-1941` | Open |
| FI-056 | N-17 | Info | A stale comment says `suspended` is reachable only by DB change. | `adminPanel.js:172-175` | Open |
| FI-057 | N-18 | Medium (process) | A fresh-DB schema was not production's schema. | SCHEMA_BASELINE.md | **Fixed (PR #36)** for fresh DBs; `schema_check.sh` detects new drift; CI hook is Phase 6 |
| FI-058 | N-19 | Info | `orders.cash_otp_plain` holds the cash OTP in plaintext (time-boxed, by design). | `migrate.js:626`; `cashOtpService.js:50-57,154` | Open (design review) |
| FI-059 | — | Low | `validate()` reports `field: err.param`, which is undefined on express-validator 7.3.2 (it is `err.path`), so every field-level validation error has no field name. | `middleware/validation.js:13-16` | Open (found writing APP_STATES.md) |

## D. Schema baseline findings (SCHEMA_BASELINE.md §8a, PR #36)

| ID | Ref | Sev | Issue | Evidence | Status |
|---|---|---|---|---|---|
| FI-060 | §6 | **High** | **`migrate.js` is unsafe on production (confirmed with data).** It re-inserts deleted saved cards (`:645-658`); takes ACCESS EXCLUSIVE on `orders` three times per run and rebuilds its indexes and `orders_store_id_fkey` (v27 `:1852`, v28 `:1901-1903`); and re-seeds an active 10% commission rate when none is active (v39 `:2635-2641`). | SCHEMA_BASELINE.md §6, §11 | Open. **Rule: never run `migrate.js` against production** until fixed **and** a backup-first process is approved |
| FI-061 | §2 | **High** | Production schema was changed through **Supabase tooling outside git and review**, including a `DROP`, and each change was applied **before** its PR merged (rows 1–8: minutes to days ahead). | SCHEMA_BASELINE.md §2 | **Decision**: written rule "no production schema change except the approved backup-first process", covering the SQL editor, MCP and CLI (§8); see FI-001 |
| FI-062 | N-20 | **High** (latent until card payments go live) | `Boost.activateBoost` inserts `'flash_closet'` into a `uuid` column, so it fails in production **after Paystack has charged**. Fresh DBs now fail the same way (v41). | `models/Boost.js:4,105-107`; SCHEMA_BASELINE.md §4.3 | Latent |
| FI-063 | N-21 | Medium (latent) | `brand_size_mappings.store_id` is `uuid` in production, so `GET /api/sizing/recommend/:storeId/:category` with a non-UUID id returns a 500. | `models/Sizing.js:152` | Latent |
| FI-064 | §4.3 | Medium | **Should `store_users` / `store_actions` cascade-delete with their store?** Production says no, and fresh DBs follow since v41. | SCHEMA_BASELINE.md §4.3 | **Decision** (product) |
| FI-065 | §4.2 | Low | The settlement tables exist only in production (accepted orphans from an unmerged branch, superseded by the confirmed payment model). | SCHEMA_BASELINE.md §4.2 | **Decision** (remove later?) |
| FI-066 | §4.3 | Medium | `flash_inventory.store_id` defaults to the first store. Once a second store exists, products created without a store are silently assigned to it. | SCHEMA_BASELINE.md §4.3 | Open |
| FI-067 | §3 | Info | Whether Supabase migration row 10 (`drop_flash_site_marketing_tables`) removed real data. An optional read-only check exists. | `scripts/schema-baseline/prod_supabase_marketing_statements.sh` | Open (optional) |
| FI-068 | §10 | Medium | CI runs Postgres **15**; production is **17.6**. | `.github/workflows/ci.yml` | Open (Phase 6) |
| FI-069 | §10 | Medium | The schema check is not in CI yet, so drift could return unnoticed. | `scripts/schema-baseline/schema_check.sh` | Open (Phase 6) |

## E. Render / operations findings (founder-reported, 2026-11-19)

These come from the founder's Render dashboard check. **Claude Code cannot read Render** (dashboards and APIs are off-limits), so each is recorded as reported, with code evidence where the repo has some.

| ID | Ref | Sev | Issue | Evidence | Status |
|---|---|---|---|---|---|
| FI-070 | Render | **High** | `Flash-App` is on Render's **free plan** and **sleeps about 10–14 times a day**. While asleep, **crons miss their schedules**: escalation emails, the store-acceptance timeout, payment reconciliation and stuck-order recovery all fire late. The first request after sleep cold-starts (tens of seconds). | Founder-reported; HANDOFF §6; 16 crons in `src/server.js:315-915` | **Decision** (paid plan, cost) |
| FI-071 | Render | Medium | The service runs in **Oregon (US West)** while users are in **Gqeberha**, adding significant round-trip latency to every API call and socket message. | Founder-reported | **Decision** (region move) |
| FI-072 | Render | Medium | **No health-check path is configured**, so a bad deploy can take traffic. The app already has `GET /health`, which returns **503** when the DB check fails. | Founder-reported; `src/server.js:~240-265` | Open (set it to `/health`) |
| FI-073 | Render / P-4 | Medium | **The startup DB check fails on every boot** (`[Database] Failed to verify connection`). The code path is a non-blocking `SELECT 1` with `connectionTimeoutMillis: 5000`; a slow cold-start TLS connect is the leading hypothesis, **not yet verified**. | Founder-reported; `config/database.js:82-94` | Open (root cause unverified) |
| FI-074 | Render | Medium | **Bots scan `admin.flashdelivery.co.za`**. AdminJS is public-facing; its login has `adminLimiter` and AdminJS `maxRetries`, but both are per-IP and in memory (FI-030), and CSP is removed for the admin path. | Founder-reported; `adminPanel.js:2389-2411` | Open (consider IP allow-list or Cloudflare Access) |
| FI-075 | Render / M-4 | Medium | **AdminJS sessions are stored in memory**: every restart or sleep logs admins out, and sessions can't be shared across instances. Same root as FI-032. | Founder-reported; `adminPanel.js:2358-2371` | Open |
| FI-077 | CI | **High** | **The CI "Secrets Scan" fails on every push to `main`**, so with "deploy only after CI passes" (FI-076) **Render deploys nothing merged**. TruffleHog runs with `base: <default branch>` and `head: HEAD`. On a push to `main` those are the same commit, so it reports `BASE and HEAD commits are the same. TruffleHog won't scan anything.` and exits 1. It **found no secret; it scanned nothing.** This happened on all 8 recent `main` pushes (`a8707c0` 2026-10-01 through `9b20249` 2026-11-19), while Backend, Mobile and Store Portal passed each time. Pull-request runs are unaffected (different base). | `.github/workflows/ci.yml` (secrets-scan job: `base: ${{ github.event.repository.default_branch }}`, `head: HEAD`); run 44600237244 | **Fixed (PR #37)**: base/head from the event (`before..sha` on push, base/head SHA on PRs), TruffleHog pinned to v3.99.8. Verified on `main` push run #128 (`4de9d57`): every job passed, `commits_scanned: 2`, 0 secrets |
| FI-078 | CI | Medium | **The Secrets Scan uses `--only-verified`**, so a leaked credential TruffleHog cannot verify as live (revoked keys, test keys, providers without a verifier, private endpoints, or a verifier outage) **does not fail CI**. Only verified-live secrets fail the job. | `.github/workflows/ci.yml` secrets-scan `extra_args: --debug --only-verified` | Open (revisit in Phase 8 secrets hygiene: e.g. fail on unverified for high-risk detectors, or report unverified as a warning) |
| FI-076 | Render | Info | **Change (positive):** `Flash-App` now deploys only **after CI checks pass** (founder, 2026-11-19). It partly mitigates `OPEN_FOLLOWUPS` #16 (deploys still run ahead of **manual** migrations). | Founder-reported | Mitigated |

## F. Open founder decisions (summary)

FI-001, FI-016 (customer message), FI-049, FI-061, FI-064, FI-065, FI-070, FI-071. Also see `PROJECT_STATE.md` §8: the squatted-email proposal (PR #16), masked calling, premium tier, ZAR bank verification, settlement at one store, admin sub-roles, and others.
