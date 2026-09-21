# Test Coverage Remediation Report

Branch: `test/close-coverage-gaps` (based on `feature/storefront-port`). Not merged into `admin-platform` or `main` — this branch's own status is unchanged by this work.

This report documents a six-phase effort to close the real test-coverage gaps identified in an earlier full-journey audit of this codebase (customer journey, driver journey, admin-panel data reflection, store-portal data reflection). That audit's own finding was blunt: several flows *looked* covered because a route existed, but nothing actually proved they worked — and in a few cases, nothing had ever really exercised the code at all. This document covers what was actually built in response, what was found broken along the way, and — just as importantly — what is still not covered, so nothing here is mistaken for "100% tested."

Every phase below follows the same discipline: real tests exercise the real function/controller/route (no test that asserts hardcoded literals without calling the code under test — the exact anti-pattern the original audit found and this effort was created to stop repeating), real database-dependent behavior (locking, transactions, aggregate queries) is proven against the real isolated test database rather than a mocked pool, and every bug found while writing a test was reported and confirmed before being fixed — never patched silently.

---

## 1. Bugs found and fixed

Five things were found and fixed while writing these tests: four real defects in application code, and one stale test fixture (not an application bug, included here because it affected the accuracy of tests in this same effort). Each one below follows the same shape: what was broken, why, the exact fix, and the proof that it's actually fixed — not just "the test suite is green," but a concrete demonstration of the specific thing that was broken now working.

### 1.1 Order creation crashed instead of cleanly rejecting a productId-less item

**File:** `backend/src/models/Order.js`

**What was broken:** `order_items.product_id` is declared `NOT NULL` (`backend/src/db/migrate.js`). `Order.create`'s external/partner-item branch — for an item with no `productId` at all, just a client-supplied `price`/`name` — passed its own price validation (any price > 0) and then reached the `INSERT INTO order_items` with a `null` `product_id`, violating that constraint. The result was an unhandled Postgres error (`null value in column "product_id" ... violates not-null constraint`) instead of the clean, intentional 400 every other validation failure in that same function produces.

**Why:** there is no real external/partner-item catalogue behind this branch — it validates a price for a case the schema was never actually built to persist.

**The fix:** `Order.create` now throws its own clean validation error (`"Invalid item for ...: a productId is required..."`) for this case, placed *after* the existing price check (so a request that's also missing a valid price still gets that message first, unchanged). `'a productId is required'` was added to `orderController.js`'s `CLIENT_ERROR_FRAGMENTS` so it maps to a 400, the same as every other rejection in this function.

**Proof:** `tests/integration/orderCreation.test.js` is a real, unmocked test against the isolated test database. Before the fix, it asserted the raw Postgres crash message; after the fix, it asserts the clean `"a productId is required"` rejection and that no order row was left behind — re-run against the real database, passing. `tests/unit/orderCreationController.test.js` separately confirms the controller maps this to a 400 response, not the generic 500 an unrecognized error would produce.

**Reachability:** confirmed not reachable from the real, shipped user app today — every cart item in `flash-user-app/context/FlashContext.js` always carries a real `flash_inventory` id — but it's real code, and this closes a real defect in it.

### 1.2 Driver ratings silently truncated fractional values instead of rejecting them

**File:** `backend/src/models/Rating.js`

**What was broken:** `Rating.submitRating` validated the rating with `parseInt(rating, 10)`, which *truncates* rather than rejects — `parseInt(3.5, 10)` is `3`, a valid in-range integer. A client sending `{"rating": 3.5}` was silently recorded as a 3-star rating instead of rejected, despite the function's own error message (`"Rating must be an integer between 1 and 5"`) promising otherwise.

**Why:** `parseInt` was the wrong tool for "is this actually an integer" — it coerces instead of validating.

**The fix:** `Number(rating)` (which does not truncate) combined with `Number.isInteger()` on the result. This still accepts a numeric string (`"5"`) — `req.body.rating` isn't guaranteed to be a JS number by any validator upstream of this call — while correctly rejecting any real fractional value.

**Proof:** `tests/integration/rating.test.js`, real database. A dedicated test asserts `Rating.submitRating(..., 3.5, ...)` now rejects with the real message; a second, explicitly added regression test proves the fix didn't break the legitimate numeric-string case (`'4'` is still accepted and stored as `4`).

### 1.3 Order history crashed on a non-numeric page/limit query parameter

**File:** `backend/src/controllers/orderController.js`

**What was broken:** `parseInt('abc')` is `NaN`, and — critically — `Math.max`/`Math.min` involving `NaN` always return `NaN` too. `const page = Math.max(1, parseInt(req.query.page || '1'))` reads as if it falls back to `1`, but for a non-numeric `page` value it silently became `NaN` instead. That `NaN` reached `Order.getUserOrders`'s real `LIMIT`/`OFFSET` bind parameters and crashed with an unhandled Postgres error (`invalid input syntax for type bigint: "NaN"`), confirmed live against the real database before the fix.

**Why:** the `|| '1'` / `|| '20'` fallbacks only ever catch a missing value, never a present-but-garbage one.

**The fix:** parse `page`/`limit` first, then explicitly check `Number.isNaN` and substitute the real default before clamping.

**Proof:** reproduced the crash live against the real database first (not assumed from reading the code). `tests/unit/orderHistoryController.test.js`'s test now asserts `Order.getUserOrders` is called with the real default `(userId, 1, 20)` for a garbage `page`/`limit`, instead of `(userId, NaN, NaN)`.

### 1.4 Store product-image upload was completely non-functional

**File:** `backend/src/services/s3Service.js`, consumed by `backend/src/controllers/storeInventoryController.js`

**What was broken:** `storeInventoryController.js`'s `addProduct` and `updateImage` have always called `s3Service.uploadPublicFile(...)` — a method that did not exist anywhere on the real `S3Service` class (confirmed by reading the entire file: only `uploadFile`, `getSignedUrl`, and `deleteFile` existed). Every real attempt by a store to upload a product photo crashed unconditionally with `TypeError: s3Service.uploadPublicFile is not a function`. This is the most severe of the four application bugs found in this effort — not a rough edge on unusual input, but a feature that could not work at all, for anyone, ever.

**Why:** the existing `uploadFile` method is deliberately private — Cloudinary `type: 'authenticated'`, returns only `{ publicId, resourceType }`, needs `getSignedUrl()` to ever be viewed — correct for driver KYC documents and delivery-proof photos, but wrong for a product photo, which `flash_inventory.image_url` stores and serves directly, unauthenticated, to customers on the public storefront. The method the controller needed had simply never been written.

**The fix:** a genuinely separate `uploadPublicFile` method on `S3Service`, mirroring `uploadFile`'s own structure but with `type: 'upload'` (Cloudinary's public-access mode) and returning the real, permanent `result.secure_url`. The controller's call sites already expected exactly this name and return shape — no controller changes were needed once the method existed.

**Proof — this is the one the original brief specifically asked to highlight:** `tests/integration/storeInventoryImageUpload.test.js` is a dedicated test that mocks nothing. It uploads a real 1×1 JPEG through the real controller to real Cloudinary (using this environment's real, already-configured credentials), then makes a genuine, unauthenticated `fetch()` of the URL that comes back and asserts a real `200` response with an `image/*` content-type — proving a customer's phone could actually load it, not just that the function call didn't throw. It cleans up the real Cloudinary asset afterward, and skips itself cleanly (rather than failing for an unrelated reason) if Cloudinary credentials aren't present in a given environment.

### 1.5 Not an application bug: a stale test fixture in `auth.test.js` itself

**File:** `backend/tests/unit/auth.test.js`

**What was broken:** this test file's own `REGISTER_VALIDATORS` constant — meant to mirror the real `POST /user/register` route's express-validator chain, since calling the controller directly in a unit test skips the route's own validators entirely — was missing `dateOfBirthValidator`, the real server-side 18+ age gate `authRoutes.js` has always applied to registration. Every `registerUser` test in this file, including this same effort's own newly-added success-path test, was therefore validated against an incomplete mirror of the real route.

**This is explicitly not an application bug** — the real route (`authRoutes.js`) has always enforced the age gate correctly regardless of this test file. Only the test file's own copy of it was stale.

**The fix:** replicated the real validator in the test file, gave every test in that describe block a real, valid `date_of_birth` by default, and added the matching `DRIVER_REGISTER_VALIDATORS` (five real validators, including the phone requirement) for the new `registerDriver` tests added in the same phase.

**Proof:** every existing and new test in that describe block still passes with the corrected, complete validator set.

---

## 2. The `driverAutoSuspensionService.js` extraction

**Why this needed doing first:** the driver auto-suspension/reassignment logic — "a driver accepted an order and then went unavailable for 45+ minutes" — lived entirely inline inside a `cron.schedule(...)` callback in `backend/src/server.js` (~130 lines). There was no way to call it, and therefore no way to test it, without a running server and a live cron tick.

**The extraction:** `backend/src/services/driverAutoSuspensionService.js` now exports `reassignStuckDriverOrders({ io })`, matching the exact pattern already established for `paymentReconciliationJob.js`'s functions and `orderStateMachineService.cancelAbandonedPaymentPendingOrders` (both extracted from inline cron callbacks for the same reason, earlier in this codebase's history). `server.js`'s cron callback is now a thin `require` + call wrapper, identical in shape to those other jobs'.

**Proof this is a real extraction and not a rewrite — required, not optional, since a silent behavior change here would be a production incident waiting to happen:**

1. **The diff is mechanical only.** Every query, every condition, every comment explaining a real production decision (the shared requeue-and-wallet-reversal transaction, the exact 5-cancellation threshold, the best-effort penalty-row insert that must never block the customer notification) is preserved verbatim. The only functional change: the Socket.IO instance is now a real `io` parameter instead of closing over `server.js`'s module-scope `_io` variable — required to make the function callable with no server running at all.
2. **A real, unmocked integration suite proves the extracted function still does exactly what the original inline code was documented to do**, against the real isolated test database:
   - `tests/integration/driverAutoSuspension.test.js` — "reassigns a real stuck order: requeued, driver penalised once, wallet reversed" (proves the shared transaction really is atomic and produces the right end state, not just that the right SQL strings were called)
   - "auto-suspends a driver whose cancel_count reaches 5, with a real, admin-visible penalty record"
   - "does not touch an order that has not been stuck long enough yet (under 45 minutes)" — the real time-window filter
   - "does not touch an order already past the pre-pickup stage (in_transit), even if old" — the real pre-pickup-only scope
   - "processes multiple real stuck orders for different drivers in one run"

   All 5 passed on the first real run against the actual database.
3. `node --check` confirmed both files still parse cleanly, and a full `require()` of `server.js` (module load only) resolved the entire require graph — including the new module — with no import-time error.

---

## 3. Store-isolation security tests

Both store-portal backend controllers' own header comments name store-scoped isolation as the single most security-relevant property of the whole subsystem — in `storeOrderController.js`'s own words: *"a compromised Store A account should not even learn that a given order id belongs to a real (just not their) store."* Every write and read endpoint in both controllers now has a dedicated test proving this holds, using two real stores with real, live `req.storeId` values — not a single store with an assumed boundary.

Each of these tests asserts **two things together**, not just one: the correct `404` response (never `403` — a `403` would itself leak that the record exists), *and* a direct re-query of the database proving the other store's real record was left completely untouched. A test that only checked the HTTP response could pass even if the write silently succeeded against the wrong store's data; these don't allow that.

**`tests/integration/storeOrderController.test.js`:**
- `listOrders` — *"a store only ever sees its own orders, never another store's"*
- `getOrder` — *"a cross-store detail request returns 404, not the other store's real data"*
- `accept` — *"a cross-store accept attempt is rejected and the real order is left untouched"*
- `reject` — *"a cross-store reject attempt is rejected and the real order is left untouched"*
- `markReady` — *"a cross-store mark-ready attempt is rejected and the real order is left untouched"*
- `getAnalytics` — a real revenue-leak check: Store B's own (much larger) order total must never appear in Store A's computed revenue

**`tests/integration/storeInventoryController.test.js`:**
- `listProducts` — *"a store only ever sees its own products, never another store's"*
- `getProduct` — *"a cross-store detail request returns 404, not the other store's real product"*
- `addProduct` — *"creates a real product attributed to req.storeId, ignoring any store_id a client might send"* — a request body containing a spoofed `store_id` for a different real store is simply ignored; the server never trusts it
- `updateStock` — *"a cross-store stock update is rejected as 404, and the real product is left completely untouched"*
- `deactivateProduct` — *"a cross-store deactivate attempt is rejected, and the real product stays active"*
- `updateImage` — *"a cross-store image update is rejected as 404, product left untouched"*

---

## 4. Full test coverage map

### 4.1 Backend (`backend/tests/`)

**Real, unmocked integration tests** (against the isolated Supabase test project — never production; `src/config/database` is not mocked in these files):

| File | Added | What it proves |
|---|---|---|
| `tests/integration/orderCreation.test.js` | this effort | `Order.create` end to end: real store_id attribution, server-side price override, real stock decrement, oversell rejection, malformed-quantity rejection, and a real two-connection concurrency race proving the `FOR UPDATE` lock actually serializes checkouts (exactly one winner, stock lands at exactly 0) |
| `tests/integration/rating.test.js` | this effort | `Rating.submitRating` end to end: real aggregate-average recomputation across two real deliveries, IDOR protection, wrong/missing driver, pre-completion rejection, duplicate-rating rejection |
| `tests/integration/driverAutoSuspension.test.js` | this effort | the extracted auto-suspension/reassignment service (see §2) |
| `tests/integration/driverCancelAssignedOrder.test.js` | this effort | `DriverController.cancelAssignedOrder`'s own hand-rolled transaction: requeue + wallet reversal + fixed R20 penalty, IDOR, past-pickup rejection |
| `tests/integration/storeOrderController.test.js` | this effort | the entire Store Admin Portal orders backend (see §3) |
| `tests/integration/storeInventoryController.test.js` | this effort | the entire Store Admin Portal inventory-write backend (see §3); S3 mocked here, proven for real below |
| `tests/integration/storeInventoryImageUpload.test.js` | this effort | real Cloudinary upload + real unauthenticated `fetch()` (see §1.4) |
| `tests/integration/adminCoverage.test.js` | pre-existing | every real table has a recorded admin-visibility decision |
| `tests/integration/productionStateMachine.test.js` | pre-existing | order-state-machine wiring at the route level |

**Mocked unit tests, new or materially changed in this effort:**

| File | Added | What it proves |
|---|---|---|
| `tests/unit/orderCreationController.test.js` | this effort | `OrderController.createOrder`'s own request validation and error→status mapping |
| `tests/unit/orders.test.js` | modified | fake hardcoded-literal block removed; real coverage now lives in `orderCreation.test.js` |
| `tests/unit/inventoryGetProduct.test.js` | this effort | `Inventory.getProduct`/`InventoryController.getProduct` ("view a single product") |
| `tests/unit/orderHistoryController.test.js` | this effort | `OrderController.getUserOrders` ("view order history") pagination and error mapping |
| `tests/unit/auth.test.js` | extended | added: `registerUser` real success path, `registerDriver` (all paths), `googleSignInUser`/`appleSignInUser` (all three real account states each can land in — existing-by-provider-id, link-by-email, brand-new account — plus 401/500 distinction) |
| `tests/unit/requireApprovedDriverGate.test.js` | this effort | the driver approval gate itself: fast path, fresh DB check for every real non-approved status, 404, DB-error handling |
| `tests/unit/driverControllerCore.test.js` | this effort | `setOnlineStatus` (all three online gates), `acceptOrder`, `getWallet`/`getEarnings`/`requestPayout` |
| `tests/unit/driverProofPhotoController.test.js` | this effort | `submitPickupPhoto`/`submitDropoffPhoto` real success paths (previously only the bypass-rejection was tested) |

Plus 20 pre-existing unit test files, unchanged, still passing (auth token revocation/refresh, order state machine, order cancellation splits, refund service, payment reconciliation, webhooks, driver commission, chat/block/report, phone redaction, socket auth, store account lockout, store auth middleware, admin auth/lockout/chronological sort, notification service, messages, storefront controller, store model).

### 4.2 Admin panel (`backend/src/adminPanel.js`)

One change (§5 of the original 6-phase task): `store_id` added to the orders resource's `listProperties`. No test — this is a pure AdminJS resource-configuration change with no logic branch for a test to exercise. Verified by `node --check` (syntax) and a full backend suite re-run showing zero impact (451/451 unchanged).

**Known limitation, documented not fixed:** displays as a raw UUID, not a resolved store name. Unlike `driver_id`/`user_id`, `orders.store_id` has never had a real FK constraint to `stores` (it was converted from `VARCHAR` to `UUID` via a plain `ALTER COLUMN` in `migrate.js`'s v27, never given a real `REFERENCES stores(id)`), so AdminJS's SQL-adapter reference auto-resolution doesn't apply to it. A real fix needs either an actual FK constraint (a schema change) or a virtual resolved-name field (matching the existing `attachUserNames` pattern for `user_id`) — both real, separate pieces of work, out of this task's deliberately small scope for this one change.

### 4.3 Store portal (`flash-store-portal/`) — Vitest

Zero test infrastructure existed before this effort. Now: Vitest (matches this app's existing Vite tooling natively) + Testing Library, wired via `vite.config.js`'s own `test` block, `npm test` runs it.

| File | What it proves |
|---|---|
| `src/services/api.test.js` | `storeApi.updateStock` — real Bearer-token attachment, real endpoint/method/body shape, real thrown-Error-with-status on rejection |
| `src/context/StoreAuthContext.test.jsx` | the real login/logout flow every screen sits behind — token/user persistence including `forcePasswordReset`, a failed login never marking anyone in, logout clearing the session even when the server call itself fails |

### 4.4 `flash-user-app/` — jest-expo

Zero test infrastructure existed before this effort. Now: `jest-expo` + `@testing-library/react-native` + `react-test-renderer`, wired via `package.json`'s `"jest"` field (the standard Expo convention), `npm test` runs it.

| File | What it proves |
|---|---|
| `services/api.test.js` | `api.orders.create` — the full shared `request()` wrapper: real token attachment, real business-rule rejection, and a real 401 transparently refreshing the token and retrying the *same* order once, or clearing the session on a dead refresh token |
| `context/FlashContext.test.js` | `placeOrder` — the real cart-to-order data shape, through actual component rendering: the real cart array sent as `items` unmodified, every checkout field mapped to the backend's real snake_case names, dropoff-address fallback to the real saved profile, cart cleared only on real success, left untouched on real rejection |

### 4.5 `flash-driver-app/` — jest-expo

Zero test infrastructure existed before this effort. Same tooling as 4.4 (`jest` needed adding as an explicit devDependency here — it wasn't pulled in transitively the way it was for the user app).

| File | What it proves |
|---|---|
| `services/api.test.js` | `driverApi.orders.accept`/`cancelActive` — real endpoint/method/token, a losing-race rejection and a commission-debt block both surfacing as real, readable errors |
| `tasks/backgroundLocationTask.test.js` | the real background location task: the registered `TaskManager` handler POSTing a real ping with the real stored token (from SecureStore, not AsyncStorage — a real historical bug this file's own header documents) and the real active-order id, silently dropping pings when logged out, surviving OS errors/empty batches; and the real online-toggle flow (`startBackgroundLocation`/`stopBackgroundLocation`) requesting permissions in the right order, short-circuiting cleanly under Expo Go (another real historical bug this file's own header documents — this used to crash the whole app), never double-starting or stopping when nothing is running |

---

## 5. Known gaps — not covered by this effort

This was a targeted remediation of the gaps a prior audit found, not a push to 100% coverage. Listed here explicitly so none of it gets assumed covered by omission:

- **Driver OAuth variants** (`googleSignInDriver`/`appleSignInDriver`) — structurally identical to the now-tested user variants, but not covered; only `googleSignInUser`/`appleSignInUser` were in scope.
- **`Rating.getForOrder`** — untested; only `submitRating` (the write path) was in scope.
- **Driver document upload** (`DriverController.uploadDocument`) — untested.
- **AdminJS's own custom order actions** (`acceptOrder`/`rejectOrder`/`markReadyForPickup` buttons in `adminPanel.js`) — the underlying `orderStateMachineService` functions they call are thoroughly tested, but AdminJS's own wiring to them is not.
- **Most mobile-app screens and UI components** — Phase 6 was explicitly scoped as infrastructure-plus-one-critical-test-per-app, not full coverage. `flash-driver-app/app/driver/dashboard.js` (the actual accept-order screen) and `flash-user-app`'s checkout/product/cart screens are untested; only the underlying `services/api.js` and context layers are.
- **`flash-store-portal`'s remaining pages** (`InventoryPage`, `OrdersPage`, `AnalyticsPage`, staff management) — untested; only the API/auth-context layer.
- **`Order.getPaymentStatus`'s IDOR test** in `orders.test.js` — flagged during Phase 1 as a fragile pattern (its assertion is wrapped in `if (typeof Order.getPaymentStatus === 'function')`, a silent no-op if that method were ever renamed) but left as-is; out of this task's scope.
- **CI environment wiring for the new real-DB/real-Cloudinary tests** — every new integration test in this effort was run and verified locally with `DATABASE_URL` (and, for the image-upload test, `CLOUDINARY_*`) explicitly exported, since `npm test` does not load `.env` itself. Whether CI's existing environment already provides these the same way was not independently re-verified as part of this task — CLAUDE.md documents CI spinning up its own Postgres service container with `DATABASE_URL` set, which this effort relied on but did not re-confirm end-to-end in a live CI run.
- **The multi-store attribution limitation** (`Store.getDefaultStoreId()`, deliberately named "default, not only") — every order is still attributed to whichever store that query returns, not necessarily the store whose product was bought. Already documented in the code's own comments before this task; not something this task fixed, since it's an architecture/business decision (a real per-checkout store-selection step) rather than a bug.
- **One observed, non-reproducible test flake**: a single run of `flash-user-app`'s full suite showed one `FlashContext.test.js` failure immediately after two long, heavy, sequential test runs (a 241s backend run and a 73s store-portal run) on this resource-constrained machine. Four subsequent consecutive runs — both isolated and combined — passed cleanly. Consistent with transient resource contention rather than a deterministic bug, but noted here rather than silently discarded; worth watching if it recurs.

---

## 6. Final tallies

**Backend:** **451 passed / 0 failed / 451 total, 44/44 suites** (fresh run, `DATABASE_URL` and `CLOUDINARY_*` exported). Zero regressions at every step across all six phases.

**Frontend, first tests these apps have ever had:** **34 tests across 6 files in 3 apps** — `flash-store-portal` 6, `flash-user-app` 8, `flash-driver-app` 20 — all passing.

**Phase-by-phase backend before/after** (each verified with a real full-suite run, not assumed):

| Phase | Before | After | Net |
|---|---|---|---|
| Baseline (pre-existing, `DATABASE_URL` properly exported for the first time) | — | 311 / 0 / 311 (31 suites) | — |
| 1 — order creation | 311 | 329 / 0 / 329 | +18 (−3 fake, +9 integration, +12 controller) |
| 1 — bug fix (§1.1) | 329 | 329 / 0 / 329 | 0 (same tests, corrected assertions) |
| 2, part 1 — view-product & rating | 329 | 348 / 0 / 348 | +19 |
| 2, part 2 — order history & NaN fix (§1.3) | 348 | 358 / 0 / 358 | +10 |
| 2, part 3 — registration & OAuth | 358 | 371 / 0 / 371 | +13 |
| 3, part 1 — cron extraction (§2) | 371 | 376 / 0 / 376 | +5 |
| 3, part 2 — rest of driver journey | 376 | 420 / 0 / 420 | +44 |
| 4 — store portal + upload fix (§1.4) | 420 | 451 / 0 / 451 | +31 |
| 5 — admin panel visibility | 451 | 451 / 0 / 451 | 0 (UI-only) |
| 6 — frontend infrastructure | — | +34 (separate suites) | +34 |

Twelve commits total on `test/close-coverage-gaps`, each independently verified before the next began; every commit message carries its own before/after numbers and a full account of what changed and why.
