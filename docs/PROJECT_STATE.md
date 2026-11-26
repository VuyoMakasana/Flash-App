# Flash — Project State (re-audit of `main`)

**As of:** 2026-11-18, `main` @ `e8f15c9` (PR #33 merged).
**Method:** read-only. Only `git` and file reads were used. No npm, node, tests, migrations, docker, databases or dashboards.
**Scope:**
- Re-checked every Critical, High and Medium finding from the earlier read-only audit, which was run against branch `docs/project-state-and-launch-readiness` @ `03ad623`, 44 commits behind `main`.
- Re-checked the four production-log findings.
- Read the new store-portal code and every backend file changed since `03ad623`.
- Completion pass (same branch, PR #34): read `adminPanel.js`, migrations v34–v40, `HANDOFF_OCT_2026.md` and `OPEN_FOLLOWUPS.md` in full. Added §3.1, §3.2, §6.1 and findings N-14 to N-19.

> This document describes what the code **does**. Where something could not be
> verified from the source (runtime env values, device behaviour, production
> data), it says so explicitly.

> **Status update, 2026-11-26 (admin panel, #96).**
> - **PR #95 (PR A) is merged.**
> - **#96:** saving the Flash Closet store, and editing or adding any product with sizes, failed in the admin panel: jsonb fields were posted flattened (FI-115). Also, the edit forms re-posted hidden lifecycle fields, which could undo a suspension (FI-116). Both are fixed with admin-panel before-hooks.
> - **Next:** PR B, the L0.5b kill switches.

> **Status update, 2026-11-24, later (PR A, real-money blockers, #94).**
> - **Founder decisions:**
>   - Partner stores will be paid by **Paystack split payments**; store payments stay off until Paystack confirms how split refunds work (FI-093, L-17).
>   - **Sunday 2026-11-29 is Flash Closet only, card only, cash off** (L-16).
>   - The returns policy is being drafted; don't change return windows or fees (FI-102, L-18).
> - **PR A fixes:**
>   - client prices are never trusted (C3, FI-026);
>   - non-approved stores' products are hidden and refused (H4, FI-097);
>   - the no-driver timeout covers cash (H1, FI-016);
>   - paid orders stuck at `payment_pending` are recovered (H6, FI-099);
>   - payment amount and currency are checked (M8, FI-107);
>   - transfer recipients use `basa` (M4, FI-041).
> - **Every real-money audit finding is recorded** in `FOUND_ISSUES.md` §G.
> - **Still needed before Sunday:** the L0.5b kill switches (FI-095) and the user-app change that shows card (FI-096).

> **Status update, 2026-11-24 (v45 applied; plan for the real-money test).**
> - **v45 (admin TOTP) was applied to production on 2026-11-24 at 01:35 SAST and verified at 01:39.** Production == the committed baseline `aefbc6af…` (69 tables); readiness 69/69/0, OK (`PROD_MIGRATIONS.md` §9). **No code uses the new columns or table yet.**
> - **Founder decisions:**
>   - Both Flash Closet and partner stores must receive orders and payments at launch: separate orders, nothing shared, and no existing flow may break.
>   - **The MFA code (PR 3) moves to next week.**
>   - Kill switches (L0.5b) still come before any real money.
>   - **Target: a real-money test on Sunday 2026-11-29** (small amounts, refunded afterwards).

> **Status update, 2026-11-23, later (MFA schema; Render checked).**
> - **PR #90 (#89)** is merged and deployed (live 21:50 SAST, admin panel mounted).
> - **Founder's Render check:** `NODE_ENV=production` ✅; `APP_URL` set ✅; `DRIVER_TEST_MODE` was `true` (**FI-091**, High), so new drivers skipped document review. **The founder set it to `false` on 2026-11-23 at 22:53 SAST; FI-091 is fixed.** Drivers auto-approved before then are to be reviewed (checklist L-14).
> - **L-12 decided:** the morning cold start is accepted during TestFlight; Render Starter before public launch (FI-090).
> - **v45 (admin TOTP, #91)** is written and proven locally, **not applied**. It adds `admins.totp_secret_enc`, `totp_enrolled_at` and `totp_last_step` (+ `admins_totp_check`) and `admin_mfa_recovery_codes` (RLS on). The baseline is now v45's AFTER `aefbc6af…` (69 tables). Production was still at v44 (`83a42d48…`, 68 tables) at the time. **(Applied 2026-11-24, see above.)** No code reads the new columns yet.
> - **The MFA design and lost-phone runbook** are in `docs/ADMIN_MFA_DESIGN.md`; the code is PR 3.

> **Status update, 2026-11-23 (security and operations).**
> - **Admin hardening (#87, PR #88)** is deployed and verified on production (live 20:46 SAST; `ADMIN_SESSION_SECRET` added before the merge). Rate limits now key on the real client IP (FI-088 fixed).
> - **#89:** `authLimiter` applies once per `/api/auth/*` request, so customers and drivers get 10 attempts per 15 minutes, not 5 (FI-087 fixed). The unused `adminAccountLoginLimiter` is deleted (FI-089 fixed).
> - **`docs/SECRETS_INVENTORY.md`** lists every variable the backend reads (names only), with rotation steps. **The database password rotation is still pending.**
> - **The keep-awake pinger doesn't wake a sleeping free service (FI-090).** The Render Starter decision is checklist L-12.
> - **Next:** admin MFA (TOTP): v45 schema, then the code; then L0.5b (feature switches).

> **Status update, 2026-11-21 (migrations).** This audit predates the production migration process.
> - **`migrate.js` is never run against production.** Schema changes reach production only through `docs/PROD_MIGRATIONS.md` steps A–E.
> - **v41 (PR #36):** merged; not applied to production and not needed (a proven no-op there).
> - **v42 (`schema_migrations_ledger`, PR #72):** **applied to production on 2026-11-21 at 07:55 SAST**. Step E verified production == the committed baseline (`PROD_MIGRATIONS.md` §9).
> - **v43 (RLS lockdown of `public`, PR #80):** **applied to production on 2026-11-21 at 11:09 SAST**. Steps A–E and the `-PostV43` check passed; FI-081 is fixed (`PROD_MIGRATIONS.md` §9).
> - **v44 (`feature_switches`, PR #85):** **applied to production on 2026-11-21 at 14:17 SAST**. Steps A–E and the readiness check passed (68 tables, all RLS, none granted to `anon`/`authenticated`). No code reads it yet; that's L0.5b (`PROD_MIGRATIONS.md` §9).
>
> Item 5 in §3 and N-18 below describe the state before this.

---

## 1. Summary

Flash is a same-day clothing delivery marketplace in Nelson Mandela Bay. Today it runs with **one store**, a handful of drivers, and **cash on delivery as the only working payment path**. Card payment (Paystack) is built, but production holds a `sk_test_` key and the card option is hidden in the app.

Since the earlier audit, `main` has gained a **multi-tenant store layer**:
- a Vite/React store portal (`flash-store-portal/`);
- store onboarding with admin approval;
- store staff roles;
- store suspension;
- per-store inventory;
- store commission stamped at order completion;
- an (unverified) store payout destination;
- product price integrity checks (migration v40);
- email bounce visibility through a Svix-signed Resend webhook.

The migration chain is at **v40**.

**State in one paragraph:**
- The new store-layer code is generally careful. Tenant scoping on `store_id` is consistent, and suspension is re-checked live on every request.
- **Every Critical money and auth bug from the earlier audit is still present**, because the files involved (`DriverWallet`, `payoutService`, `driverCommissionService`, `authController`) are byte-identical to the audited branch.
- The launch-blocking cash-order hang is still present.
- The re-audit found **one new High issue in the store portal**: real-time order updates never reach the portal, because the socket server rejects store tokens. A store has 15 minutes to accept an order before it is auto-rejected, and the portal has no polling fallback.

---

## 2. Architecture

| Part | Stack | Entry | Notes |
|---|---|---|---|
| `backend/` | Node/Express, `pg` (no ORM), Socket.IO, AdminJS (`@adminjs/sql`, patched by `scripts/patch-adminjs-sql.js` at postinstall), node-cron | `backend/server.js` → `src/server.js` | One process on Render's free tier (single instance). DB is Supabase Postgres. |
| `flash-user-app/` | Expo SDK 54 / RN 0.81.5, React Navigation | `App.js` | Customer app. Unchanged since `03ad623`. |
| `flash-driver-app/` | Expo SDK 54, expo-router | `app/_layout.js` | Driver app. Unchanged since `03ad623`. |
| `flash-store-portal/` | Vite 5, React 18, react-router 6, socket.io-client, vitest | `src/main.jsx` → `src/App.jsx` | Store staff portal. Built in CI (PR #15). Deployment target per `emailService` default: `https://flash-store-portal.onrender.com`. |

> CLAUDE.md says "Expo SDK 56 / RN 0.85". `package.json` on `main` says SDK 54 / RN 0.81.5. CLAUDE.md is stale on this point, and on the cron count and `moduleNameMapper` (see `docs/audits/HANDOFF_OCT_2026.md`).

### Backend layout
`routes/` → `controllers/` → `models/` / `services/`, plus `middleware/`, `socket/`, `db/migrate.js` (a monolith, v1–v40, guarded by `require.main` since PR #31).

### Auth domains (four separate JWT families)

| Principal | Secret | Lifetime | Refresh | Revocation |
|---|---|---|---|---|
| Customer / driver | `JWT_SECRET` | 15 min | Rotating refresh tokens (`refresh_tokens`) | `revoked_tokens` by `jti` |
| Admin (API) | `ADMIN_JWT_SECRET` | — | — | — |
| AdminJS session | cookie signed with `ADMIN_JWT_SECRET` (`adminPanel.js:2361`) | session | — | — |
| Store user | `STORE_JWT_SECRET` | 8 h | none | `password_changed_at` vs `iat`, live `is_active` + store `status` check in `authenticateStore` |

Store middleware chain: `authenticateStore` → `requireOwnStore` → `requireStorePasswordCurrent` (forced reset) → `requireStoreRole(...)`.

Store roles:
- `owner`
- `store_manager`
- `inventory_staff`
- `sales_staff`
- `finance`
- `marketing`, which has no login yet: login rejects it.

### Order state machine (`services/orderStateMachineService.js`)

```
created → payment_pending → paid → (scheduled_for_morning →) pending_store_acceptance → preparing
        → waiting_for_driver → driver_assigned → driver_arrived_store → picked_up → in_transit
        → delivered → completed            (pre-pickup states → cancelled)
```

- `pending_store_acceptance` and `preparing` are the store-facing stages.
- The store accepts, rejects or marks ready from the portal or from AdminJS actions.
- Timeouts: 15 minutes for acceptance, 30 minutes for preparation, each with an escalation email.

### Cron jobs
`src/server.js` has 17 `cron.schedule` calls. One is commented out (`server.js:355`), which leaves **16 active**.

---

## 3. Connections (what talks to what)

```
user app ──HTTP+Socket(JWT_SECRET)──┐
driver app ─HTTP+Socket(JWT_SECRET)─┤
store portal ─HTTP(STORE_JWT)───────┼──> backend (Render) ──> Supabase Postgres
store portal ─Socket(STORE_JWT)──X  │        ├──> Paystack REST (sk_test_ in prod)
AdminJS (browser, cookie) ──────────┘        ├──> Cloudinary (s3Service.js)
                                             ├──> Resend API (email)  <── Resend webhook (Svix-signed)
                                             ├──> Expo push
                                             └──> Sentry (backend only reporting)
```

`X` = the connection is rejected; see N-1.

| Integration | Where | State |
|---|---|---|
| Paystack | `services/paystackService.js` (raw REST) | `sk_test_` key in prod (per HANDOFF; unverifiable from here). `/bank/resolve` does not support ZAR. The transfer recipient type is `nuban` (Nigeria); see N-2. |
| Resend | `services/emailService.js` | Preferred when `RESEND_API_KEY` is set or `SMTP_HOST` is resend.com. Webhook in `webhookController.handleResend`: Svix HMAC, 300 s tolerance, `email_events` deduplicated on `svix_id`. |
| Cloudinary | `services/s3Service.js` | `uploadPublicFile` added for product images. |
| Webhooks | `routes/webhookRoutes.js`, mounted before `express.json()` | Paystack (HMAC-SHA512), Payflex, Resend. |

### 3.1 How AdminJS connects to the order state machine and the store portal

AdminJS is mounted inside the same Express process at `/admin-panel` (`adminPanel.js:2100-2416`). It talks to Postgres in two ways:
- through its own `@adminjs/sql` adapter, using `DATABASE_URL` with `schema: 'public'` (`:2212`);
- through the app's `pg` pool, for virtual fields and custom actions.

**Three paths can change an order's store stage.** All three converge on the same three state-machine functions.

| Caller | Accept | Reject | Mark ready | Passes `io`? | Audit trail |
|---|---|---|---|---|---|
| Store portal (`storeOrderController.js:112-146`) | `acceptOrder` | `rejectPendingAcceptance` (reason "Rejected by store via Store Admin Portal") | `markReadyForPickup` | **yes** | `store_actions` |
| AdminJS `orders` actions (`adminPanel.js:1146-1194`) | `acceptOrder` | `rejectPendingAcceptance` (reason "Rejected by store via admin panel") | `markReadyForPickup` | **no** (N-14) | `admin_actions` |
| Crons (`orderStateMachineService.js:766`, `:824`, `:897`) | — | timeout → `rejectPendingAcceptance`, `cancelledByRole: 'system'` | — | yes | console + escalation email |

**What the three functions do:**
- `acceptOrder` moves the order `pending_store_acceptance → preparing` (`orderStateMachineService.js:655`).
- `rejectPendingAcceptance` (`:555`) locks the order, cancels it, and inserts an `order_cancellations` row with a `full_refund` split. Only a **card-paid** order then gets a Paystack refund (`:618`). It defaults `cancelledByRole` to `'store'` (`:565`), so an **admin** rejection is recorded as a store rejection.
- `markReadyForPickup` (`:676`) moves the order `preparing → waiting_for_driver`. Then:
  - if it has `io`, it emits `order_update` to the customer and `new_order_available` to the preferred driver or `driver_pool`;
  - it always calls `autoAssignNearestDriver` and push-notifies drivers.

**The actions' button visibility** (`isAccessible`) reads `record.param('status')`. The real guard is the state machine's own `FOR UPDATE` plus `ALLOWED_TRANSITIONS` check.

**What reaches the store portal: nothing, whichever path acted.** No path emits to a store room (N-1), so the portal sees a change only when it refetches.

**What AdminJS can mutate** (every other resource is read-only):

| Resource | Writes | Via |
|---|---|---|
| `drivers` | approve / reject | `Admin.updateDriverStatus`. Generic new/edit also enabled; `status` is hidden from the edit form (`:984`). |
| `orders` | accept / reject / mark ready | State-machine functions above. Generic edit, new and delete are disabled. |
| `return_requests` | approve / reject / finalize refund | `Return.approveReturn` / `rejectReturn` / `finalizeRefund`. Finalize issues a real Paystack refund. |
| `sos_alerts`, `chat_reports` | acknowledge / resolve | `SosAlert.acknowledge`, `ChatReport.resolve` |
| `flash_inventory` | **generic new/edit** + deactivate | Hooks run `nullifyEmptyNonTextFields` → `validateInventoryPrices` → `clearInventoryCacheAfter`. `store_id` is an editable plain-text field (its reference is suppressed, `:1760`). `stock_by_size` is unvalidated (N-15). |
| `stores` | approve / reject / suspend / reactivate, plus generic edit of details | `StoreOnboardingService.approve` (7-day invite token + welcome email), `.reject`, `Store.suspend`, `Store.reactivate`, gated by `STORE_STATUS_TRANSITIONS`. Status and review columns are hidden from edit. |
| `marketing_*` (3 tables) | **generic delete left enabled** | N-16 |

**Not registered at all** (confirms audit item A5):
- `store_users`, so an admin cannot fix an owner's email, unlock an account or release a squatted address;
- `store_transfer_recipients`;
- `store_password_tokens`;
- `users` (it collides with Supabase's `auth.users`, `:106-120`);
- `admins`.

`commission_rates` and `email_events` are registered but **read-only**. A rate change requires SQL (A4).

**Cross-cutting AdminJS mechanics:**
- `stripSensitive` removes `password_hash`, `cash_otp_hash` and `cash_otp_plain` from every response, including populated references (`:83-104`).
- `suppressReferencesToUnregisteredTables` (`:910`) suppresses every foreign key that points at an unregistered table.
- A runtime prototype patch on `@adminjs/sql` `Resource.filterQuery` (`:2132`) fixes date-range filters.
- CSP is removed for `/admin-panel` only (`:2389`).
- `adminLimiter` sits in front of `POST /login` (`:2411`).
- The session uses default MemoryStore, no explicit cookie `secure`/`sameSite`, and reuses `ADMIN_JWT_SECRET` as both cookie password and session secret (`:2358-2371`).

### 3.2 Schema facts from migrations v34–v40 (`db/migrate.js:2182-2746`)

Each migration runs in its own transaction on its own client (`migrate.js:1076-1147`), and `pool.end()` must stay on the last one. **Migrations are applied manually on Render.** The service auto-deploys `main` and does **not** run migrations (`OPEN_FOLLOWUPS` #16), so a merge can deploy code ahead of the schema it needs.

| Ver | Objects | Facts that matter |
|---|---|---|
| v34 | `stores`, `store_users`, `store_actions` (CREATE IF NOT EXISTS); `flash_inventory.store_id UUID` + FK → `stores` (nullable); `store_users.force_password_reset`, `password_changed_at`; `store_password_tokens` | Written to **mirror production's existing shape**: these tables first reached prod from another branch. `store_users.email` is `UNIQUE` and **case-sensitive** (N-7). `role` CHECK has six roles. `store_password_tokens.token VARCHAR(128) UNIQUE` is stored **plaintext** (N-6). In a **fresh** DB, `store_users`/`store_actions` cascade-delete from `stores`. **Production differs:** `store_users_store_id_fkey` there has **no** `ON DELETE CASCADE`, per the live-schema read in `STORE_EMAIL_SQUATTING_PROPOSAL.md` §1 (see N-18). |
| v35 | `idx_orders_store_id_created_at` | Named to avoid the `IF NOT EXISTS` name-only trap (an older `idx_orders_store_id` exists). The redundant old index is left in place. |
| v36 | `stores.status` (NOT NULL, default `pending`, CHECK of 5 states), `reviewed_by` → `admins`, `reviewed_at`, `rejection_reason`, `idx_stores_status_created` | Existing stores backfilled to `approved` via `WHERE status IS NULL` (idempotent). |
| v37 | `email_events` (`svix_id UNIQUE`), `store_users.{welcome,reset}_email_status[_at]` | Covers every recipient; dedupe on `svix_id`. |
| v38 | `store_transfer_recipients` | **No account number stored.** Only `recipient_code`, `bank_code`, `bank_name`, `account_last4`, `account_name`. A partial unique index enforces **one active destination per store**. The driver table (`transfer_recipients`) has neither property (`OPEN_FOLLOWUPS` #17). |
| v39 | `commission_rates` (created here only for fresh DBs; production's came from an unmerged "v31"); seeds a global `0.1000` where none is active; `orders.store_commission NUMERIC(10,2)`, `commission_rate_applied NUMERIC(5,4)`, `commission_rate_id` → `commission_rates`; partial index `(store_id, delivered_at) WHERE store_commission IS NOT NULL` | CHECKs: scope ∈ {global, store, promotional}; `0 ≤ rate ≤ 1`; a global rate has no store and the other scopes need one; a promotional rate needs a window. Unique partial index: one active global. **No historical backfill**: the two older completed orders stay NULL. |
| v40 | `flash_inventory_price_positive CHECK (price > 0)`, `flash_inventory_cost_price_non_negative` | Guarded `DO $$` blocks. Plain `ADD CONSTRAINT` (an ACCESS EXCLUSIVE scan) was judged fine at about 16 rows. The ≤ 100,000 ceiling stays in application code. |

**Schema drift: a fresh database is not identical to production** (N-18). The code comments themselves record objects in production that `migrate.js` never created:
- the `orders.store_id → stores` FK (`adminPanel.js:1073-1078`);
- `flash_inventory.store_id` existing before v34 (`:1755-1758`);
- `commission_rates` from an unmerged v31;
- `stores.onboarding_verified_by` in one environment but not another (`:896-898`);
- **a different definition:** `store_users_store_id_fkey` is `ON DELETE CASCADE` in `migrate.js:2249` but has no `ON DELETE` clause in production (`STORE_EMAIL_SQUATTING_PROPOSAL.md` §1). Deleting a store therefore behaves differently in tests than in production.

`orders.store_id` itself became UUID in v26/v27 (`migrate.js:1822-1840`).

### 3.3 Store portal → backend endpoints
All calls go through `flash-store-portal/src/services/api.js`.

| Area | Endpoints |
|---|---|
| Auth | `/api/store-auth/{login,logout,account,change-password,forgot-password,reset-password}` |
| Orders | `/api/store-orders[/:id[/accept\|reject\|mark-ready]]` |
| Inventory | `/api/store-inventory[/:id[/stock\|image\|deactivate\|reactivate]]` |
| Staff | `/api/store-staff[/:id/(de\|re)activate]` |
| Analytics | `/api/store-analytics` |
| Onboarding | `/api/store-onboarding/apply` |

`/api/store-banking` exists on the backend, but the portal deliberately has no route to it (`utils/roleNav.js` comment).

---

## 4. Danger zones

Change these only with characterization tests in place.

1. **`orderStateMachineService.updateOrderStatus` / `assignDriver`.** Every flow depends on them: crons, cancellations, photo/OTP checks, webhooks, AdminJS actions, the store accept/reject flow, and the commission stamp.
2. **Crons in `src/server.js`.** They are registered **twice** in production (C-5). They are timing-sensitive and they move money and stock.
3. **`DriverWallet` + `payoutService` + `driverCommissionService`.** These three are mutually inconsistent today (C-1, C-2, C-3).
4. **`authController` + `middleware/auth.js`.** All four principals depend on them.
5. **`db/migrate.js`.** A monolith of 2,748 lines. It is applied **manually** while Render auto-deploys `main` (`OPEN_FOLLOWUPS` #16), and a fresh database differs from production (N-18). `CREATE … IF NOT EXISTS` matches on name only: a past drift broke v34, as documented in the file. It has **no production-URL guard** (`migrate.js:17`). Its `pool.end()` placement is load-bearing (v40 comment).
6. **`adminPanel.js`.** It monkey-patches `@adminjs/sql` internals, and the postinstall patch script also rewrites the adapter. An adapter upgrade will break it.
7. **`Order.create`.** It owns pricing, stock decrement, `store_id` derivation and the mixed-store rejection.
8. **Both mobile apps' `services/api.js` `request()`.** It handles token refresh with no single-flight (H-7).
9. **Environment hazards. Do not run any of these:**
   - `backend/test-db.js`, which hardcodes the production DB host with `rejectUnauthorized: false`.
   - `final-verification.sh`, which prints `.env` secrets.
   - `backend/tests/integration/adminCoverage.test.js:23`, which opens `new Pool(DATABASE_URL)` with no local guard.
   - `migrate.js`, which has no production guard.
   - `.vscode/mcp.json`, which points at production.
   - Both apps' and every `eas.json` profile's defaults, which point at the production API.
   - Three worktree env files, which point at an unidentified remote database.

---

## 5. Bug table — earlier findings re-checked on `main`

**Legend:**
- **Present** means the defect is still in the code.
- **Fixed** means the code changed and the defect is gone.
- **Changed** means the code changed but the defect remains in another form.

**How "unchanged" was established:** `git diff 03ad623...e8f15c9` is empty for these files:
- `DriverWallet.js`
- `payoutService.js`
- `driverCommissionService.js`
- `authController.js`
- `paymentController.js`
- `Payment.js`
- `paystackService.js`
- `refundService.js`
- `Return.js`
- `User.js`
- `Tracking.js`
- `Driver.js`
- `driverController.js`
- `socketServer.js`
- `fleetIntelligenceService.js`
- all of `flash-user-app/` and `flash-driver-app/`

For those files the *code* is unchanged. **Correction (verification pass):** that does not make the earlier audit's line references exact. Some were wrong in the original audit (C-2, H-8, H-10, H-16, H-17). The rows below carry the corrected, independently verified lines; see §10.

### Production-log findings

| # | Finding | Status on `main` | Evidence |
|---|---|---|---|
| P-1 | Every cron runs twice | **Present** | `src/server.js:1002`: `require.main === module ? startServer() : createApp()`. Under `backend/server.js`, `require.main` is not this module, so `createApp()` runs at require time and then again inside `startServer()`. |
| P-2 | Cash order with no driver hangs forever | **Present** | `src/server.js:652` cron filters `AND o.payment_status = 'paid'`; `Payment.cashOnDelivery` sets `pending_cash`. No cron references `pending_cash`. No admin alert for `waiting_for_driver`. Stock never restocked. |
| P-3 | `CASH_OTP_SECRET` fallback | **Guarded** | `services/cashOtpService.js:16-29` throws in production when unset. Residual risk: a weak value, or `NODE_ENV` not set to `production`. **I could not verify** the Render value. |
| P-4 | DB "failed to verify connection" at startup | **Code path known, root cause unverified** | `config/database.js:82-94` runs a non-blocking `SELECT 1` with `connectionTimeoutMillis: 5000`. Hypothesis, not verified: a cold-start TLS handshake to Supabase exceeds 5 s. |

### Critical

| # | Finding | Status | Location |
|---|---|---|---|
| C-1 | Driver payout debits the wallet twice, or loses the money | **Present** | `DriverWallet.js:129-134`, `payoutService.js:16,37`, `:186-191`. The failure path (`:165-172`) never re-credits. **Worse than stated:** on an instant Paystack success, finalize hits C-3's 31-char insert, rolls back, and the request is marked `failed` although the money was sent. |
| C-2 | Commission debt forgiven on partial payouts; misleading rollback | **Present** | `driverCommissionService.js:187-248` (the file is 340 lines; the earlier `:512`/`:540` were wrong). Partial path `:229-247`; misleading message `:224`. |
| C-3 | `'payout_debit_reconcile_required'` (31 chars) into `VARCHAR(30)` | **Present** | `migrate.js:402`, `payoutService.js:207` |
| C-4 | OAuth account takeover (no `email_verified`; Apple trusts client `email`) | **Present** | `authController.js:322`, `:384`, `:614`, `:672` |
| C-5 | Crons twice (= P-1). Duplicate escalation emails. | **Changed** | Escalation now selects `… IS NULL` (`orderStateMachineService.js:965`, `:994`), but the UPDATE at `:973` / `:1002` has no `IS NULL` guard. Two cron copies can both select before either updates. Root cause (P-1) present. |
| C-6 | Email/password users locked out (verification unreachable) | **Present (likely)** | `authController.js:110`. Email links point to `APP_URL/verify-email` (`emailService.js:188`), with no backend route and no registered `flash://` scheme. Depends on what `APP_URL` serves; **I could not verify** that. |

### High

| # | Finding | Status | Location |
|---|---|---|---|
| H-7 | Token refresh race → reuse detection revokes all sessions | **Present** | `flash-user-app/services/api.js:93`, `flash-driver-app/services/api.js:89` |
| H-8 | Driver location broken in real conditions | **Partially correct, corrected** (device behaviour not verified) | `flash-driver-app/tasks/backgroundLocationTask.js:85-114` (the file is 240 lines). The task re-reads `FLASH_DRIVER_TOKEN` from SecureStore on each ping, so a foreground refresh **does** reach it. "Never refreshed" was overstated: the task cannot refresh by itself, so its POSTs 401 silently after about 15 min of background-only use. No foreground reporting: `driverApi.updateLocation` is never called. `app.config.js:81-90` lacks FOREGROUND_SERVICE. |
| H-9 | Driver can cancel a paid order with no refund or penalty | **Present** | `orderController.js:291` area (driver path unchanged in the diff); `orderStateMachineService.js:59–61` allow `→ cancelled` pre-pickup |
| H-10 | `markCashFailed` repeatable → abuse flag in two calls | **Present** | `paymentController.js:523-575` (the file is 584 lines; `:676` was wrong). The only precondition is `status === 'delivered'` (`:550`); the flag is set at 2 or more (`:557-567`). |
| H-11 | Driver dashboard socket never reconnects after `auth_expired` | **Present** (timing corrected) | `flash-driver-app/app/driver/dashboard.js:151-182`; the context token is only set at `DriverContext.js:81,165,211,221`. The server checks every 14 min (`socketServer.js:139-155`), and a 15-min token is still valid at the first check, so the disconnect comes at about **28 min**, not about 14. |
| H-12 | User TrackingScreen leaks a 10 s poller per `connect_error` | **Present** | `flash-user-app/screens/TrackingScreen.js:252` |
| H-13 | OrderStatusScreen crashes with only `orderId` | **Present** | `OrderStatusScreen.js:131` |
| H-14 | Pending drivers can't log back in to finish onboarding | **Present** | `authController.js:575`, `flash-driver-app/app/auth/login.js:74` |
| H-15 | Fabricated line items: non-inventory UUID accepts a client price; the no-`productId` path always 500s | **Present** | `Order.js:196-213` (partner/external paths use `validateExternalItemPrice(item.price)`, a bound, not a server price); `order_items.product_id VARCHAR(100) NOT NULL` (`migrate.js:220`) |
| H-16 | Cash returns can never be refunded | **Partially correct, corrected** | Cash part present: `refundService.js:59` (the file is 267 lines) throws for anything but card; `Return.finalizeRefund` (`Return.js:295`) calls it. **The duplicate-inflation half was wrong:** `return_request_items` has `UNIQUE (return_id, order_item_id)` (`migrate.js:1438`), so a duplicate insert rolls back the whole request. **Production has it too** (`return_request_items_return_id_order_item_id_key`, SCHEMA_BASELINE.md §4.5), so the duplicate half is disproven there as well. |
| H-17 | Customers can see the driver's live location and phone on **their own** historical orders, at any status | **Present** (scope corrected) | `Order.js:385-390` (`getByIdWithDetails`), `:438-441` (`getUserOrders`), `User.js:~147-150`, `Tracking.js:6-7` (the file is 26 lines; `:537` was wrong). The phone is nulled for a blocked pair only in `getByIdWithDetails` (`Order.js:430-432`); the other three queries don't. |
| H-18 | Real-time admin alerts reach no one (admin tokens ≠ `JWT_SECRET`) | **Present** | `socketServer.js:108` verifies only `JWT_SECRET`. The `admin` room join exists, but an admin token never authenticates. |

### Medium

| Finding | Status | Location / note |
|---|---|---|
| `rate-limit-redis` not installed → limits per-instance memory | **Present** | `rateLimiter.js:21-35`. Single instance today, so impact is low until scale-out. New email-keyed account limiters added for admin/store. |
| Cash orders leave `pending_balance` inflated; blocks driver deletion | **Present** | `DriverWallet.js` unchanged; `Driver.js:159` |
| Wallet commission deductions write no ledger row | **Present** | `driverCommissionService.js:404` |
| Plan delivery limits never enforced (`deliveries_used` never incremented) | **Present** | unchanged files |
| `assignDriver` doesn't check subscription | **Present** | `orderStateMachineService.js` (assignDriver unchanged in diff) |
| OAuth drivers can't save a bank account (password step-up) | **Present** | `driverController.js:612` |
| Checkout silently changes login email | **Present** | `flash-user-app/screens/CheckoutScreen.js:198`, `User.js:55` |
| Unauthenticated logout with an unsigned JWT can force a driver offline | **Present** | `authController.js:508` |
| Cash-on-delivery has no status check; notifies `driver_pool` early | **Present** | `Payment.js:603` |
| Payment can be initialised for a cancelled order | **Present** | `paystackService.js:124` (refund cron mitigates) |
| AdminJS session: MemoryStore, cookie flags, secret reuse | **Present** | `adminPanel.js:2361-2369` (moved from `:1906`). `cookiePassword` = `ADMIN_JWT_SECRET`. |
| Email "DEV MODE" logs reset/verify tokens when no transport | **Present** (line moved) | `emailService.js:122-127` logs the full body, including links with tokens. Only reached when neither Resend nor SMTP is configured. |
| Trend/revenue endpoints open to any authenticated user | **Present** | unchanged |
| No account lockout; no phone uniqueness | **Changed** | Email-keyed login limiters added for **admin and store** accounts only. Customers and drivers are unchanged. |
| No chargeback handling | **Present** | — |
| OAuth age-gate bypass | **Present** | `authController.js` unchanged |
| iOS external Paystack subscription checkout (App Store risk) | **Present** | mobile apps unchanged |
| `final-verification.sh` prints secrets | **Present** | hazard; do not run |
| Commission stamp inside the completion transaction with no SAVEPOINT | **Present (likely)** | `orderStateMachineService.js:266-287`. A SQL error inside `computeStoreCommission(client, …)` is caught, but Postgres has already aborted the transaction. The following status UPDATE then fails with `25P02`, so the completion **does** fail, contradicting the comment. |

Low items from the earlier audit were not re-checked line-by-line. All of them sit in files unchanged since `03ad623` except the commented cron (now `server.js:355`).

---

## 6. New findings (not in the earlier audit)

| # | Sev | Finding | Evidence | Confidence |
|---|---|---|---|---|
| N-1 | **High** | **Store portal never receives real-time order updates.** See the detail below. | `socketServer.js:100-125`, `flash-store-portal/src/hooks/useStoreSocket.js`, `OrdersPage.jsx:17,41` | Confirmed by reading; runtime not observed |
| N-2 | High (latent) | **Transfer recipients use `type: "nuban"`** with `currency: "ZAR"`. Paystack's NUBAN is Nigerian, and South Africa uses `basa` (Paystack API knowledge, not shown in the repo). Affects **both store and driver** bank registration: `storeBankingController.js:126` **and** `driverController.js:617`. Latent until a live key exists. | `paystackService.js:368-376` | Code confirmed; Paystack behaviour not tested |
| N-3 | Medium | **Store `updateStock` doesn't validate values.** Only "is an object" is checked, so negative, fractional, string or `NaN`-producing values are stored. `Order.create` treats a non-numeric count as unlimited stock. The portal sends `Number(e.target.value)`, which can be negative or fractional, and the API is callable directly. | `storeInventoryController.js:169-190` | Confirmed (code) |
| N-4 | Medium | **Admin-added inventory has `store_id = NULL` — in fresh/test DBs only.** In **production** `flash_inventory.store_id` is `NOT NULL DEFAULT <first store>` (SCHEMA_BASELINE.md §4.3), so N-4 does not occur there; instead every store-less product is silently assigned to the first store once a second store exists (Medium). Fresh DBs get production's definition via v41 S1. `Inventory.addProduct` (the legacy admin REST path) never sets `store_id`; the AdminJS form leaves it as optional free text (N-15). Orders for such products get `store_id NULL`: invisible in the portal, never commission-stamped (`if (order.store_id …)`), and unattributed for settlement. | `models/Inventory.js:39-52`; `orderStateMachineService.js:266` | Confirmed (code); production data not checked |
| N-5 | Low (downgraded) | **`/api/store-auth/reset-password` has no route-level limiter** (`forgot-password` has `storePasswordResetLimiter`). It **is** covered by the global `app.use("/api/", limiter)` (100 requests per 15 min per IP, `server.js:188`), so "no rate limiter" was overstated. `OPEN_FOLLOWUPS` #13. | `routes/storeAuthRoutes.js:27-37` | Confirmed |
| N-6 | Low | **Store reset token is double-spendable.** The token is looked up without a row lock, and the consume UPDATE has no `used_at IS NULL` guard, so two concurrent requests with one token both succeed. Tokens are stored **plaintext**, so a DB read leak yields usable tokens. | `storeAuthController.js:231-247`, `:207` | Confirmed (code) |
| N-7 | Low | **Store email case.** `StoreUser.findByEmail` is case-sensitive and `createStaff` doesn't normalize email, so `Bob@x` and `bob@x` can be two accounts, or a login can fail on case. | `models/StoreUser.js:14`, `storeStaffController` | Confirmed (code) |
| N-8 | Low | `reactivateStaff` can reactivate an anonymized (deleted) store account. | `storeStaffController` | Confirmed (code) |
| N-9 | Low | Storefront `GET /api/stores/:storeId` exempts `storeId` from UUID validation, so a malformed id reaches Postgres as a `uuid` cast error and returns a 500, not a 400. | `middleware/validation.js:26`, `routes/storefrontRoutes.js:14` | Likely |
| N-10 | Low (policy) | Store staff of every role that can see orders get customer **and** driver phone numbers. | `storeOrderController` | Confirmed; may be intended |
| N-11 | Low | The portal stock input fires a PATCH on every keystroke (`onChange` → `updateStock`), so typing "12" sends 1 then 12. Each request is full-replace, so out-of-order responses can persist a stale value. | `InventoryPage.jsx:59-63,236` | Confirmed (code) |
| N-12 | Low | The store JWT (8 h, no refresh) lives in `localStorage`, so any XSS in the portal yields a full 8 h session. Common trade-off, noted for the record. | `StoreAuthContext.jsx`, `services/api.js` | — |
| N-13 | Info | `Store.getDefaultStoreId` appears unused on `main`. | `models/Store.js` | Not exhaustively verified |
| N-14 | Medium | **AdminJS store-order actions send no socket events.** See the detail below. | `adminPanel.js:1153,1172,1189`; `orderStateMachineService.js:94-95,565,655-701` | Confirmed (code) |
| N-15 | Low | **AdminJS `flash_inventory` new/edit has gaps.** `stock_by_size` is written through the generic key-value editor with no validation, the same class as N-3. `store_id` is a free-text field, so a product can be created with no store or with a mistyped UUID; an FK violation surfaces as a raw error. New/edit is **not** logged to `admin_actions`; only `deactivateProduct` is. | `adminPanel.js:1760-1811` | Confirmed (code); key-value value types not verified at runtime |
| N-16 | Low | The three `marketing_*` resources disable new/edit but leave AdminJS's generic **delete / bulkDelete** enabled, which is a hard `DELETE`. Every other resource disables delete. | `adminPanel.js:1814-1941` | Confirmed (code) |
| N-17 | Info | Stale comment: it says `'suspended'` "is reachable only by a direct database change today", but the `suspendStore` action exists. | `adminPanel.js:172-175` vs `:2041` | Confirmed |
| N-18 | Medium (process) → **fixed for fresh DBs by v41 (PR #36, merged)** | **A fresh-DB schema is not production's schema.** Fully enumerated in `docs/SCHEMA_BASELINE.md` §4: IN MIGRATE ONLY 0; IN PROD ONLY 5 FKs + 1 index + 3 settlement tables (accepted orphans); 6 real DIFFERENT DEFINITION items; 16 cosmetic CHECK spellings + 2 column orders (accepted). Migration v41 brings a fresh DB to production's definition and is proven a zero-DDL no-op on production's schema (SCHEMA_BASELINE.md §11). **v41 has NOT been run on production.** `scripts/schema-baseline/schema_check.sh` now detects any new drift. | `docs/SCHEMA_BASELINE.md` | Confirmed against production's own schema dump (founder-run, read-only) |
| N-19 | Info | `orders.cash_otp_plain VARCHAR(6)` holds the cash OTP in plaintext alongside its hash. It is time-boxed and nulled on verification, deliberately so the customer can re-view it. That makes it readable by anyone with DB access during the window. | `migrate.js:626`, `cashOtpService.js:50-57,154` | Confirmed (code); design choice, not necessarily a bug |
| N-20 | High (latent until card payments go live) | **`Boost.activateBoost` inserts `store_id = 'flash_closet'` into a `uuid` column** in production (`store_boosts.store_id` is `uuid NOT NULL` + FK there), so a paid boost fails to activate **after Paystack has charged**. After v41, fresh DBs fail the same way. | `models/Boost.js:4,105-107`; SCHEMA_BASELINE.md §4.3 | Confirmed (code + prod schema) |
| N-21 | Medium (latent) | `brand_size_mappings.store_id` is `uuid` in production, so `GET /api/sizing/recommend/:storeId/:category` with a non-UUID `storeId` returns a 500. | `models/Sizing.js:152`; SCHEMA_BASELINE.md §4.3 | Confirmed (code + prod schema) |

**N-1 in detail:**
- `useStoreSocket` connects with the `STORE_JWT_SECRET`-signed token.
- `socketServer.js:108` verifies only `JWT_SECRET`, so the handshake fails with "Invalid token".
- No code joins a `store:<id>` room, and nothing emits to one: `grep "store:"` in `socketServer.js` and every `.emit` site finds nothing.
- The hook's own comment says the server auto-joins `store:<storeId>`, which is untrue.
- `OrdersPage` loads once and otherwise relies on the socket. There's no polling.
- With a **15-minute acceptance timeout** that auto-rejects, a store watching the portal can miss new orders unless it refreshes manually.
- The admin escalation email is the only safety net.

**N-14 in detail:**
- Accept, reject and mark-ready are called without `io`, and `emitOrderUpdate` returns early when `io` is missing.
- When an admin acts, the customer gets no `order_update` socket event, and drivers get no `new_order_available` socket broadcast.
- Push notifications and auto-assignment still run, so nothing is lost; the customer and driver apps simply don't update in real time.
- An admin rejection is recorded as `cancelled_by_role = 'store'`, which is wrong attribution.

### 6.0 Findings checked against the confirmed payment model

The source is `docs/audits/PAYMENT_MODEL_AND_PORTAL_AUDIT.md` (PR #25, merged and read in full). It defines the confirmed target model:
1. The **item price is always paid by card**.
2. The **delivery fee** is the customer's choice: card, or cash to the driver.
3. **Stores receive only item earnings**, never delivery money or anything a driver collected.

Production today is the opposite: cash-only, 19 of 19 orders, no card payment ever processed. The audit says the target model cannot ship before a live Paystack key, because with `sk_test_` no order could be placed at all (its B2).

| Finding here | Effect of the target model | Changed? |
|---|---|---|
| P-2 cash order with no driver hangs | Still true and still launch-blocking **today**, because today every order is cash. Under the target model every order's item is card-paid, so the cron's `payment_status = 'paid'` filter may match once item-paid is recorded that way. **The fix must not hard-code today's cash-means-whole-order assumption.** | Recommendation refined; severity unchanged |
| C-1 / C-2 / C-3 driver payout and commission debt | Unaffected. The audit confirms driver earnings already derive only from `delivery_fee` (`utils/helpers.js:43`). | No |
| H-10 `markCashFailed` repeatable | Still present. Under the target model, cash covers only the delivery fee, so the money at stake per abuse is smaller; the customer-flagging harm is unchanged. | Description refined |
| H-16 cash returns can never be refunded | Still true today. Under the target model the item is always card-paid, so returns use the card refund path and the cash half becomes moot. (The duplicate-inflation half was found incorrect in §10.) | Description refined; severity unchanged until the model ships |
| Medium: cash orders inflate `pending_balance` | Unaffected (driver-side accounting). | No |
| M-2 commission stamp without SAVEPOINT | Unaffected. Commission is a share of item value under either model. | No |
| N-2 `nuban` for SA recipients | Unaffected and still latent. Store payouts are unblocked only by a live key, and become **more** important under the target model, because Flash then holds all item money and must settle it. | Importance up once the key exists |
| N-4 admin-added products have no store | Unaffected, but more consequential: under the target model, settlement aggregates stamped `store_commission`, and NULL-store orders would be silently excluded. | Consequence sharpened |
| §7 "Store settlement (2c) blocked on key **and** #20" | The audit (§4) says the target model **dissolves** #20's settlement question: Flash always receives item money, so 2c needs no payment-method branch. #20 should be **re-scoped, not closed**: driver cash custody is untracked until `cash_to_collect` becomes `delivery_fee` (B4). | Yes, see §7 |
| `computeCancellationSplit` (not previously a finding here) | **Becomes wrong under the target model** (B5). Its `isCash` branch assumes no item money was collected. It must change **with** the model change, not before (HANDOFF §5). | New, latent |

**Payment-model gaps from the audit, all still open** and all gated on a live Paystack key (B2):
- **B1:** the app offers only cash.
- **B3:** `delivery_payment_method` only ever says `'cash'`, in lockstep with `payment_method`.
- **B4:** `cash_to_collect = order.total`; it should be `delivery_fee`.
- **B5:** see the table above.
- **B6:** `delivery_payment_status` is a driver-payout lifecycle despite its name.

### 6.1 Overlap with `OPEN_FOLLOWUPS.md` (read in full)

**Status of the 22 items:**
- **Resolved:** #3, #21, #22.
- **Open:** all the rest.
- **Deliberately not pre-launch gates:** #4–#12.

**Items that bear directly on this document:**

| Item | Relation |
|---|---|
| #13 reset-password unthrottled | **= N-5**, still present |
| #14 no per-account store session revocation | still present; `authenticateStore` re-checks `is_active` live, so deactivation is the only lever |
| #15 suspension notifies nobody; pending orders then time out as "store didn't respond" | still present (`Store.suspend` unchanged) |
| #16 Render auto-deploys ahead of manual migrations | still present; see §3.2 |
| #17 driver `transfer_recipients.account_number` plaintext | still present (`driverController.js:640`, file unchanged) |
| #18 `orders.store_paid` means "card captured" | still present; a trap for settlement work |
| #19 `order_cancellation_store_shares` never paid | still present |
| #20 cash orders: store item value unrecorded | still present; **blocks Phase 2c** |
| #1, #2 mobile Sentry symbolication | still present (mobile apps unchanged) |

**From `HANDOFF_OCT_2026.md` (read in full)**, recorded there and not re-verified here because they are runtime or dashboard facts:
- `DRIVER_TEST_MODE` is still `true` in production, so every driver signup is auto-approved and auto-subscribed (§3.1).
- Operational rate limiters are keyed on IP. `otpLimiter` (3/60 s) sits on the only working checkout path, behind carrier CGNAT (§3.4).
- There is no pre-expiry driver subscription warning, and the subscription is enforced only on `getAvailableOrders`, not on going online (§3.5).
- RLS is disabled on all 66 tables (§3.6; judged acceptable at current scale).
- R10 has not been verified through a real AdminJS submission (§3.8).
- On Render's free tier, crons don't run while the service sleeps and fire late on wake (§6).

---

## 7. Built / partial / not started

| Area | State | Notes |
|---|---|---|
| Customer ordering, cash on delivery | **Built** | Only working payment path. |
| Card payments (Paystack) | **Partial** | Code built; prod key is `sk_test_`; card option hidden in app. |
| Driver dispatch, auto-match, OTP/photo proof | **Built** | H-8 location issues affect matching. |
| Driver payouts | **Partial / broken** | C-1/C-2/C-3; no payout button in app; `/bank/resolve` unsupported for ZAR. |
| Store onboarding + admin approval (v36) | **Built** | Email-squat release is PR #16 (open, founder decision). |
| Store portal: orders, inventory, staff, analytics, account | **Built** | N-1 (no real-time); Settings is owner-only; Finance sees Analytics only. |
| Store suspension (per-request) | **Built** | Notifies nobody (`OPEN_FOLLOWUPS` #15). |
| Store commission stamping (v39) | **Built** | No-SAVEPOINT risk; null `store_id` orders skipped (N-4); rate changes need SQL (A4). |
| Store payout destination (v38) | **Partial, hidden** | Unverified registration; `nuban` (N-2); no portal route. |
| Store settlement (Phase 2c) | **Not started (paused)** | Blocked on a live Paystack key. Under the confirmed target model, `OPEN_FOLLOWUPS` #20's settlement question dissolves (§6.0). #20 is re-scoped to the untracked driver cash custody. |
| Target payment model: item always card, delivery card or cash | **Not started (paused)** | Gaps B1, B3–B6 (§6.0); blocked on a live key (B2). `computeCancellationSplit` must change with it. |
| Store portal finish line (`PAYMENT_MODEL_AND_PORTAL_AUDIT.md` §5.A) | **Partial** | **Shipped:** A1 product edit and A2 reactivate (PR #26). **Open:** **A3** a store cannot edit its own profile (name, address, logo, banner, description; admin-only workaround); **A4** a commission-rate change needs SQL; **A5** `store_users` has no admin surface (see §8 for PR #16's proposal); **A6** bounce visibility has no alerting. |
| Product price integrity (v40) | **Built** | All four write paths and a DB CHECK. |
| Email (Resend) + bounce visibility (v37) | **Built** | — |
| Customer email verification | **Not reachable** | C-6. |
| Masked calling | **Not started** | Founder decision. |
| Mobile crash reporting | **Partial / absent** | User app: source maps disabled. Driver app: no Sentry plugin. |
| Staging environment, health check path, feature flags/kill switches | **Not started** | `OPEN_FOLLOWUPS` #8, #10; HANDOFF §3.9. |
| Supabase RLS | **Not enabled** | 66 tables (HANDOFF §3.6); backend uses a privileged connection. |
| Multi-store cart semantics | **Not specified** | Mixed-store carts are rejected in `Order.create`. |

---

## 8. Open questions

**For the founder (business calls, not technical):**
1. **Cash-order hang (P-2).** What should the customer be told: "no driver available" or "cancelled"? Should an admin be alerted rather than the order auto-cancelling?
2. **Store real-time (N-1).** Is a manual-refresh portal acceptable for launch with one store, or must live updates work first? A polling fallback is the smaller change; store-token socket auth is the proper one.
3. **ZAR bank verification for drivers and stores.** Adopt Paystack `/bank/validate`, or ship unverified for drivers too? Confirm the recipient type (`basa`) once a live key exists.
4. **Store settlement at one store.** Settle manually for launch, or block on Phase 2c? (`OPEN_FOLLOWUPS` #20.)
5. **Should store staff see customer/driver phone numbers** (N-10)?
5a. **Squatted store-owner emails** (`STORE_EMAIL_SQUATTING_PROPOSAL.md`, PR #16, merged as a document; **nothing is built**).
   - **The problem:** `/apply` creates real `stores` and `store_users` rows, and `store_users.email` is globally unique. Anyone can therefore permanently block a business's email, and only hand-written SQL against production can undo it.
   - **Your decision:**
     - **Option C (recommended by the proposal):** separate `store_applications` from accounts. Cheapest now, at 1 store and 0 pending applications.
     - **Option A (stopgap):** an admin "release email" tombstone action.
     - **Option B:** status-scoped uniqueness. The proposal rejects it.
   - **Also open:** whether applicants get an acknowledgement email, which would need a per-address throttle.
   - **Related:** PROJECT_STATE A5 and N-7.
6. **The other open decisions** in `docs/audits/HANDOFF_OCT_2026.md` §4: premium tier, masked calling, admin sub-roles, subscription enforcement, refund notification, `store_boosts`, commission-rate UI.

**For the engineering setup (needed before Phase 4):**

7. **Docker status: answered.** Docker is running, but it is not to be used before Phase 4. In Phase 4 the first step is to show evidence that `docker compose` and every test command use only the local Postgres and receive no real third-party keys, and to get approval before running anything.
   - Note: `HANDOFF_OCT_2026.md` §8 says Docker Desktop would not start on this machine as of 2026-10-01. That is now superseded by the founder.
   - Also: the founder moved `backend/.env` out of the repo, so it must not be recreated until Phase 4, and only pointing at local Postgres.
8. **Render values I cannot read.** `NODE_ENV`, `DRIVER_TEST_MODE`, the Paystack key mode, `CASH_OTP_SECRET` strength, `APP_URL`. These stay manual dashboard checks.
9. **Production data I cannot check.** How many `flash_inventory` rows and orders have `store_id IS NULL` (N-4)? How many orders are stuck in `waiting_for_driver` with `pending_cash` (P-2)?

---

## 9. What this re-audit did and did not read

**Read in full:**
- All `flash-store-portal/src` source files except page bodies' styling markup. That covers `App.jsx`, `ProtectedRoute`, `StoreAuthContext`, `useStoreSocket`, `services/api.js`, `utils/roleNav.js`, `utils/orderStatus.js`, `package.json`, `vite.config.js`, `.env.example`, plus targeted reads of every page's data-loading and mutation code.
- Every backend store controller, model and route.
- `commissionService`.
- The `auth.js`, `rateLimiter.js`, `cors.js` and `helpers.js` diffs.
- The `s3Service`, `webhookController` (Resend) and `emailService` diffs.
- The commission and store-stage parts of `orderStateMachineService`.
- The `Order.js` diff.
- The `socketServer.js` auth handshake.

**Read in full in the Phase 1 completion pass** (requested on PR #34):
- `backend/src/adminPanel.js`: all 2,425 lines. AdminJS lives in this single file; there is no `src/admin/` directory. Results are in §3.1, N-14 to N-17, and the AdminJS session row in §5.
- `backend/src/db/migrate.js` v34–v40: the `migrateV34`–`migrateV40` bodies and their comments (`:2182-2746`), plus the runner block that invokes them (`:1060-1179`). Results are in §3.2 and N-18.
- `docs/audits/HANDOFF_OCT_2026.md`: all 470 lines.
- `docs/audits/OPEN_FOLLOWUPS.md`: all 935 lines. Results are in §6.1.
- Supporting reads: `orderStateMachineService.js:90-105`, `:548-721` (store-stage functions, `emitOrderUpdate`) and `storeOrderController.js` imports and dispatch (`:3-146`).

**Read in full in the verification pass** (`foundation/verify-phase1`, after PRs #16 and #25 merged):
- `docs/audits/PAYMENT_MODEL_AND_PORTAL_AUDIT.md`: all 416 lines. Results are in §6.0 and §7.
- `docs/audits/STORE_EMAIL_SQUATTING_PROPOSAL.md`: all 262 lines. Results are in §8 item 5a and the N-18 FK difference.

**Docs not read in full:** the other ~38 files in `docs/audits/`. They are referenced only where HANDOFF or OPEN_FOLLOWUPS cites them.

**AdminJS facts that are not verified at runtime:** no AdminJS session was opened, because there are no credentials and none should be guessed. Everything in §3.1 comes from the source.

**Not done (by rule):** no tests run, no app started, no database or dashboard contacted. Untracked files `docs/audits/SECURITY_SELF_PENTEST_REPORT.md` and `flash-store-portal/.env` were left untouched; only the variable name was read from the latter. *(2026-11-20: the founder has since moved every copy of the pentest report outside the repo; `.gitignore` now blocks `SECURITY_SELF_PENTEST_REPORT*.md`.)*

---

## 10. Verification (independent re-check, 2026-11-19)

**How it was done:**
- A fresh subagent with no access to this document or the session that wrote it was given only a one-line claim with `file:line` for each Critical, production and High finding (C-1–C-6, P-2, H-7–H-18), the two new Highs (N-1, N-2) and five Medium spot-checks (M-1–M-5).
- It checked each claim read-only against `main` @ `8ceaa5a`. It opened nothing under `docs/` and no `.env` files.
- Every disagreement with this document was then re-checked by hand with `grep`/`wc`/`sed` on the same tree, and the corrected rows above carry the verified lines.

**Results** (25 claims: 18 confirmed as written, 4 confirmed with wrong lines or timing, 3 partially correct):

| Claim | Subagent verdict | Re-check | Evidence / correction |
|---|---|---|---|
| C-1 payout double-debit | CONFIRMED | agree | `DriverWallet.js:129-134`, `payoutService.js:16,37,186-191`; no re-credit on failure. Plus a compounding case with C-3 (row updated). |
| C-2 debt forgiven | CONFIRMED, wrong lines | agree, **lines fixed** | `driverCommissionService.js:187-248` (340-line file) |
| C-3 31-char into VARCHAR(30) | CONFIRMED | agree | `migrate.js:402`, `payoutService.js:207` |
| C-4 OAuth takeover | CONFIRMED | agree | `authController.js:322-329,384-392,614,672`; `emailVerified` is used only for new users (`googleAuthService.js:46`) |
| C-5 crons twice | CONFIRMED | agree | `src/server.js:979,1002`; escalation `orderStateMachineService.js:965/973,994/1002` |
| C-6 verification unreachable | CONFIRMED | agree | only `POST /api/auth/user/verify-email` exists (`authRoutes.js:48`); the email button uses an unregistered `flash://` link; the user app never calls verify. What `APP_URL` serves is still unverifiable. |
| P-2 cash no-driver hang | CONFIRMED | agree | `server.js:652-662` vs `Payment.js:194` `pending_cash` |
| H-7 refresh race | CONFIRMED | agree | `flash-user-app/services/api.js:92-118`, `flash-driver-app/services/api.js:88-114`, `authController.js:450-470` |
| H-8 driver location | PARTIALLY CORRECT | agree, **row corrected** | the task re-reads the token per ping; it cannot refresh by itself (`backgroundLocationTask.js:85-114`, 240-line file) |
| H-9 driver cancels paid order | CONFIRMED | agree | `orderController.js:283-334`; `orderStateMachineService.js:60-61,196,211-221` |
| H-10 markCashFailed | CONFIRMED, wrong lines | agree, **lines fixed** | `paymentController.js:523-575` |
| H-11 socket after auth_expired | CONFIRMED, timing differs | agree, **timing fixed** | about 28 min, not about 14 |
| H-12 poller leak | CONFIRMED | agree | `TrackingScreen.js:252-292` |
| H-13 OrderStatusScreen crash | CONFIRMED | agree | `OrderStatusScreen.js:57-60,131`; `PaymentScreen.js:86` navigates with `{ orderId }` only |
| H-14 pending driver login | CONFIRMED | agree | `authController.js:575-586`, `login.js:72-75`, `driverRoutes.js:62-67`. Caveat: a stale SecureStore token on the same device might still allow onboarding (not verified). |
| H-15 client-priced items | CONFIRMED | agree | `Order.js:196-213,319-323`; `migrate.js:220` |
| H-16 cash returns / duplicates | PARTIALLY CORRECT | agree, **row corrected** | the cash half holds (`refundService.js:59`); the duplicate half is wrong because of `UNIQUE (return_id, order_item_id)` (`migrate.js:1438`), pending a production-schema check |
| H-17 driver phone/location | CONFIRMED, lines off | agree, **row corrected** | scope is the customer's own orders; `Tracking.js` is 26 lines |
| H-18 admin sockets | CONFIRMED | agree | `socketServer.js:100,108` vs `adminController.js:35` |
| N-1 store portal no live updates | CONFIRMED | agree | `useStoreSocket.js`, `storeAuthController.js:68-76`, `OrdersPage.jsx:35,41` |
| N-2 `nuban` | CONFIRMED (code) | agree, **scope widened** | also used for **driver** recipients (`driverController.js:617`). The SA `basa` rule is external Paystack knowledge. |
| M-1 rate-limit-redis | CONFIRMED | agree | not in `backend/package.json` |
| M-2 commission without SAVEPOINT | CONFIRMED | agree | no `SAVEPOINT` anywhere in `backend/src` |
| M-3 store updateStock | CONFIRMED | agree | `storeInventoryController.js:170-193`; arrays pass too |
| M-4 AdminJS session | CONFIRMED | agree | `adminPanel.js:2358-2371` |
| M-5 reset-password limiter | PARTIALLY CORRECT | agree, **N-5 downgraded to Low** | the global `/api/` limiter covers it (`server.js:188`) |

**Still not verifiable from the repo:**
- device behaviour (H-8, H-12, H-13);
- the generated Android manifest;
- whether `STORE_JWT_SECRET` or `ADMIN_JWT_SECRET` happen to equal `JWT_SECRET` in production (that would change N-1 and H-18);
- `REDIS_URL`;
- what `APP_URL` serves;
- Paystack's real response to `nuban`/ZAR;
- whether production has the `return_request_items` UNIQUE constraint.

**Not re-verified in this pass:** the Low items and the Medium items beyond M-1 to M-5.
