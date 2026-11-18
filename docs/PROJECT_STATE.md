# Flash — Project State (re-audit of `main`)

**As of:** 2026-11-18, `main` @ `e8f15c9` (PR #33 merged).
**Method:** read-only. Only `git` and file reads were used. No npm, node, tests, migrations, docker, databases or dashboards.
**Scope:**
- Re-checked every Critical, High and Medium finding from the earlier read-only audit, which was run against branch `docs/project-state-and-launch-readiness` @ `03ad623`, 44 commits behind `main`.
- Re-checked the four production-log findings.
- Read the new store-portal code and every backend file changed since `03ad623`.

> This document describes what the code **does**. Where something could not be
> verified from the source (runtime env values, device behaviour, production
> data), it says so explicitly.

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
| Paystack | `services/paystackService.js` (raw REST) | `sk_test_` key in prod (per HANDOFF; unverifiable from here). `/bank/resolve` does not support ZAR. The transfer recipient type is `nuban` (Nigeria); see N-3. |
| Resend | `services/emailService.js` | Preferred when `RESEND_API_KEY` is set or `SMTP_HOST` is resend.com. Webhook in `webhookController.handleResend`: Svix HMAC, 300 s tolerance, `email_events` deduplicated on `svix_id`. |
| Cloudinary | `services/s3Service.js` | `uploadPublicFile` added for product images. |
| Webhooks | `routes/webhookRoutes.js`, mounted before `express.json()` | Paystack (HMAC-SHA512), Payflex, Resend. |

### Store portal → backend endpoints
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
5. **`db/migrate.js`.** A monolith of more than 2,000 lines. `CREATE … IF NOT EXISTS` matches on name only: a past drift broke v34, as documented in the file. It has **no production-URL guard** (`migrate.js:17`). Its `pool.end()` placement is load-bearing (v40 comment).
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

For those files, the earlier audit's line references are still exact.

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
| C-1 | Driver payout debits the wallet twice, or loses the money | **Present** | `DriverWallet.js:129`, `payoutService.js:37`, `:186` |
| C-2 | Commission debt forgiven on partial payouts; misleading rollback | **Present** | `driverCommissionService.js:540`, `:512` |
| C-3 | `'payout_debit_reconcile_required'` (31 chars) into `VARCHAR(30)` | **Present** | `migrate.js:402`, `payoutService.js:207` |
| C-4 | OAuth account takeover (no `email_verified`; Apple trusts client `email`) | **Present** | `authController.js:322`, `:384`, `:614`, `:672` |
| C-5 | Crons twice (= P-1). Duplicate escalation emails. | **Changed** | Escalation now selects `… IS NULL` (`orderStateMachineService.js:965`, `:994`), but the UPDATE at `:973` / `:1002` has no `IS NULL` guard. Two cron copies can both select before either updates. Root cause (P-1) present. |
| C-6 | Email/password users locked out (verification unreachable) | **Present (likely)** | `authController.js:110`. Email links point to `APP_URL/verify-email` (`emailService.js:188`), with no backend route and no registered `flash://` scheme. Depends on what `APP_URL` serves; **I could not verify** that. |

### High

| # | Finding | Status | Location |
|---|---|---|---|
| H-7 | Token refresh race → reuse detection revokes all sessions | **Present** | `flash-user-app/services/api.js:93`, `flash-driver-app/services/api.js:89` |
| H-8 | Driver location broken in real conditions (background token expiry, no foreground reporting, Android FGS permissions) | **Present** (code; device behaviour not verified) | `flash-driver-app/.../backgroundLocationTask.js:417` |
| H-9 | Driver can cancel a paid order with no refund or penalty | **Present** | `orderController.js:291` area (driver path unchanged in the diff); `orderStateMachineService.js:59–61` allow `→ cancelled` pre-pickup |
| H-10 | `markCashFailed` repeatable → abuse flag in two calls | **Present** | `paymentController.js:676` |
| H-11 | Driver dashboard socket never reconnects after `auth_expired` (~14 min) | **Present** | `flash-driver-app/app/driver/dashboard.js:159`, `socketServer.js` 14-min re-verify |
| H-12 | User TrackingScreen leaks a 10 s poller per `connect_error` | **Present** | `flash-user-app/screens/TrackingScreen.js:252` |
| H-13 | OrderStatusScreen crashes with only `orderId` | **Present** | `OrderStatusScreen.js:131` |
| H-14 | Pending drivers can't log back in to finish onboarding | **Present** | `authController.js:575`, `flash-driver-app/app/auth/login.js:74` |
| H-15 | Fabricated line items: non-inventory UUID accepts a client price; the no-`productId` path always 500s | **Present** | `Order.js:196-213` (partner/external paths use `validateExternalItemPrice(item.price)`, a bound, not a server price); `order_items.product_id VARCHAR(100) NOT NULL` (`migrate.js:220`) |
| H-16 | Cash returns can never be refunded; duplicate `order_item_id` inflates refunds | **Present** | `refundService.js:271`, `Return.js:76` |
| H-17 | Customers can see driver live location and phone on any historical order | **Present** (partly mitigated) | `Order.js:386-391`, `:439-442` still select `driver_phone` / `current_lat` with no status gate. `Order.js:430-432` now nulls the phone only for a **blocked** pair. `User.js:152`, `Tracking.js:537` unchanged. |
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
| N-2 | High (latent) | **Store transfer recipient uses `type: "nuban"`** (Nigerian NUBAN). South African accounts need `basa`, so creating a store recipient will likely fail even with a live key. The portal has no route to it today, which is why it's latent. | `paystackService.js:370`, `storeBankingController` | Likely; not tested against Paystack |
| N-3 | Medium | **Store `updateStock` doesn't validate values.** Only "is an object" is checked, so negative, fractional, string or `NaN`-producing values are stored. `Order.create` treats a non-numeric count as unlimited stock. The portal sends `Number(e.target.value)`, which can be negative or fractional, and the API is callable directly. | `storeInventoryController.js:169-190` | Confirmed (code) |
| N-4 | Medium | **Admin-added inventory has `store_id = NULL`.** `Inventory.addProduct` doesn't set `store_id`, so orders for such products get `store_id NULL`: invisible in the portal, never commission-stamped (`if (order.store_id …)`), and unattributed for settlement. | `models/Inventory.js:39-52`; `orderStateMachineService.js:266` | Confirmed (code); production data not checked |
| N-5 | Medium | **`/api/store-auth/reset-password` has no rate limiter** (`forgot-password` has one). Already logged as `OPEN_FOLLOWUPS` #13; still present. | `routes/storeAuthRoutes.js:32-36` | Confirmed |
| N-6 | Low | **Store reset token is double-spendable.** The token is looked up without a row lock, and the consume UPDATE has no `used_at IS NULL` guard, so two concurrent requests with one token both succeed. Tokens are stored **plaintext**, so a DB read leak yields usable tokens. | `storeAuthController.js:231-247`, `:207` | Confirmed (code) |
| N-7 | Low | **Store email case.** `StoreUser.findByEmail` is case-sensitive and `createStaff` doesn't normalize email, so `Bob@x` and `bob@x` can be two accounts, or a login can fail on case. | `models/StoreUser.js:14`, `storeStaffController` | Confirmed (code) |
| N-8 | Low | `reactivateStaff` can reactivate an anonymized (deleted) store account. | `storeStaffController` | Confirmed (code) |
| N-9 | Low | Storefront `GET /api/stores/:storeId` exempts `storeId` from UUID validation, so a malformed id reaches Postgres as a `uuid` cast error and returns a 500, not a 400. | `middleware/validation.js:26`, `routes/storefrontRoutes.js:14` | Likely |
| N-10 | Low (policy) | Store staff of every role that can see orders get customer **and** driver phone numbers. | `storeOrderController` | Confirmed; may be intended |
| N-11 | Low | The portal stock input fires a PATCH on every keystroke (`onChange` → `updateStock`), so typing "12" sends 1 then 12. Each request is full-replace, so out-of-order responses can persist a stale value. | `InventoryPage.jsx:59-63,236` | Confirmed (code) |
| N-12 | Low | The store JWT (8 h, no refresh) lives in `localStorage`, so any XSS in the portal yields a full 8 h session. Common trade-off, noted for the record. | `StoreAuthContext.jsx`, `services/api.js` | — |
| N-13 | Info | `Store.getDefaultStoreId` appears unused on `main`. | `models/Store.js` | Not exhaustively verified |

**N-1 in detail:**
- `useStoreSocket` connects with the `STORE_JWT_SECRET`-signed token.
- `socketServer.js:108` verifies only `JWT_SECRET`, so the handshake fails with "Invalid token".
- No code joins a `store:<id>` room, and nothing emits to one: `grep "store:"` in `socketServer.js` and every `.emit` site finds nothing.
- The hook's own comment says the server auto-joins `store:<storeId>`, which is untrue.
- `OrdersPage` loads once and otherwise relies on the socket. There's no polling.
- With a **15-minute acceptance timeout** that auto-rejects, a store watching the portal can miss new orders unless it refreshes manually.
- The admin escalation email is the only safety net.

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
| Store settlement (Phase 2c) | **Not started (paused)** | Blocked on a live Paystack key and `OPEN_FOLLOWUPS` #20 (cash item value owed to store is unrecorded). |
| Card-only checkout rewrite / cancellation split | **Not started (paused)** | Blocked on a live key. |
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
6. **The other open decisions** in `docs/audits/HANDOFF_OCT_2026.md` §4: premium tier, masked calling, admin sub-roles, subscription enforcement, refund notification, `store_boosts`, commission-rate UI.

**For the engineering setup (needed before Phase 4):**

7. **Docker status.** The approval message left this placeholder unfilled: "working" / "installing native PostgreSQL 15 instead" / "rely on CI only for now". I need the actual answer before any local DB work.
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

**Read by diff outline, not line-by-line:**
- `adminPanel.js` (+477 lines: store approve/reject/suspend actions, `commission_rates`, `email_events`, price validation).
- `migrate.js` v34–v40: table, column, index and constraint statements read, prose comments skimmed.

**Docs:**
- `HANDOFF_OCT_2026.md`: §1, §2, §3.9, §4 and §5 read in full; the rest by outline.
- `OPEN_FOLLOWUPS.md`: by outline and status lines.
- The other ~40 audit docs: **not read in full in this phase**. They are referenced here only where HANDOFF cites them.

**Not done (by rule):** no tests run, no app started, no database or dashboard contacted. Untracked files `docs/audits/SECURITY_SELF_PENTEST_REPORT.md` and `flash-store-portal/.env` were left untouched; only the variable name was read from the latter.
