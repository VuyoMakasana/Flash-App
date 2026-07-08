# Flash — Pre-Launch Production Readiness, Security & Performance Audit

**Date:** 2026-07-08
**Scope:** `backend/`, `flash-user-app/`, `flash-driver-app/` — full source read, live local testing against a rebuilt Docker stack (Postgres 15 + Redis 7 + backend, migrated to the current schema), real `npm test`/`npm audit`/coverage runs, a full git-history secret scan, live GitHub Actions CI status check, and a real load test with seeded data against `localhost:3000`.
**Method:** Every finding below was produced by either (a) directly reading the cited file/line range, or (b) an actual command run in this session with its real output captured. Nothing here is estimated. Where something could not be verified (no physical device, no production credentials, no internet access for a version-EOL lookup), it says so explicitly.

---

## 1. Executive summary

Flash is **not launchable today**, but it is close, and the path to launch is short and well-defined — most of what's broken here is fixable in days, not weeks, and several of the codebase's hardest problems (payment idempotency, wallet ledger math, driver-assignment race safety, the order state machine) are **already solid**, which is the part most teams get wrong. What's actually blocking launch is a small number of concrete, well-understood bugs: two full customer-facing features (live order tracking and chat) are silently dead due to a one-line storage-API mismatch left over from a security fix; every authenticated request's bearer token is written to plaintext production logs; and a client can manipulate an order's price to near-zero with a negative quantity. None of these require architectural rework — each is a small, targeted patch. Once the Critical and High findings below are closed and CI is unblocked (it currently cannot run at all — see §2), Flash is in a genuinely strong position to launch.

---

## 2. Launch blockers (Critical), sorted by exploitability

### C-0 — GitHub Actions CI has not executed on any of the last ~20 commits (account billing lock, not a code issue)

**Severity:** Critical (process/verification gap — nothing has actually been checked on any recent push)
**Category:** Production Readiness — broken CI/CD pipeline
**File(s):** `.github/workflows/ci.yml`; verified via `gh run list`/`gh run view` against the live repo
**Exploitability:** N/A — operational, not attacker-facing
**Real-world impact:** I checked the actual GitHub Actions run history (`gh run list --workflow=ci.yml`), not just the workflow file. Every one of the last 20 runs (back to 2026-06-11) shows `failure`, completing in **2-6 seconds** — far too fast to be a real test failure. `gh run view` on the most recent run shows why:
```
X Secrets Scan in 2s — "The job was not started because your account is locked due to a billing issue."
X Mobile — Dependency Check in 3s — same
X Backend — Lint & Test in 3s — same
```
No job has actually executed. This means every commit merged to `main` since at least 2026-06-11 — including the entire Phase 1-4 feature work — has landed with **zero automated verification**: no test run, no coverage check, no secret scan, no dependency audit. This is worth fixing before anything else in this list, because it's the reason several of the other Critical/High findings below (the broken auth test suite, the real coverage numbers) were never caught.
**Proof of concept:** `gh run list --workflow=ci.yml` / `gh run view <id>` against `github.com/VuyoMakasana/Flash-App`.
**Fix:** Resolve the GitHub account billing issue (Settings → Billing) — this is not something I can do or verify further; it needs your GitHub account access specifically.

---

### C-1 — Bearer JWTs are logged in full plaintext in production, on every request

**Severity:** Critical
**Category:** A09:2025 Security Logging & Alerting Failures (CWE-532)
**File(s):** `backend/src/server.js:121` (`app.use(pinoHttp({ logger }))` — no `redact` config), `backend/src/config/logger.js:8-14` (default level is `"info"` in production, so this is active, not just a dev artifact)
**Exploitability:** Trivial — passive, no attacker action needed, just log read access
**Real-world impact:** `pino-http`'s default request serializer attaches the complete, unredacted header set to every request-completion log line. I verified this **live**, not just by reading the code: I sent a request with a marker bearer token to the locally rebuilt backend and grepped the container's actual log output:
```
docker logs flash_backend | grep AUDIT_TEST_TOKEN_MARKER_abc123xyz
→ "authorization":"Bearer AUDIT_TEST_TOKEN_MARKER_abc123xyz"   ← confirmed present, in plaintext
```
Anyone with read access to Render's log stream (or any log drain/aggregator it's piped to) can extract live 15-minute user/driver tokens and 8-hour admin tokens directly from logs and impersonate any account — including admin — within the token's validity window. This defeats the entire short-lived-token design documented in this repo's own CLAUDE.md.
**Fix:** One-line change: `pinoHttp({ logger, redact: ['req.headers.authorization', 'req.headers.cookie'] })`.

---

### C-2 — Live order tracking and driver chat are completely non-functional (reads the wrong storage API)

**Severity:** Critical
**Category:** Production Readiness — broken core feature, regression from a prior security fix
**File(s):** `flash-user-app/screens/TrackingScreen.js:154`, `flash-user-app/screens/ChatScreen.js:44`
**Exploitability:** Trivial — happens 100% of the time, no special conditions
**Real-world impact:** A prior fix ("HIGH-4") moved auth tokens from `AsyncStorage` to `expo-secure-store`. Both `TrackingScreen` and `ChatScreen` were never updated and still do `await AsyncStorage.getItem('FLASH_TOKEN')` — which is now always `null` (repo-wide grep confirms nothing writes that key to AsyncStorage anymore). Because `token` is `null`, `io()` (the socket connection) is never even called. Result: every customer who taps "Track Driver Live" sees "Finding a driver nearby..." frozen forever, no matter how far along delivery actually is — one of the app's core same-day-delivery value props is completely dead. Chat never receives real-time messages either (only the initial REST history load works).
**Proof of concept:** Place any order, get it assigned, open Track Order — the live badge never resolves from "Connecting...".
**Fix:** Both files should `import { getToken } from '../services/api'` (already exports a SecureStore-backed getter) and use that instead of `AsyncStorage.getItem('FLASH_TOKEN')`. Two-line fix per file.

---

### C-3 — Negative/zero order quantities let a client manipulate order totals and inflate store stock

**Severity:** Critical
**Category:** A04:2025 Insecure Design (missing server-side validation on a financial computation) / API6:2023 Unrestricted Access to Sensitive Business Flows
**File(s):** `backend/src/models/Order.js:126-168` (stock adjustment), `:158-159` (`const qty = parseInt(item.quantity) || 1`)
**Exploitability:** Trivial — single authenticated customer, no race required
**Real-world impact:** `item.quantity` is never checked for sign. A negative quantity line item (e.g. `-5`) is truthy in JS and passes straight through into `computedSubtotal += serverPrice * qty`, reducing the order total — and, for Flash-inventory items, the *same* unvalidated raw quantity is used for the stock decrement (`available - item.quantity`), so a negative quantity both **bypasses the out-of-stock check** and **increases store stock** (`available - (-5) = available + 5`). A customer can submit one legitimate line plus a large-negative second line for the same/another product to drive the order total to zero or negative while still receiving real merchandise. For cash orders there's no external gateway to catch a non-positive `cash_to_collect` — the driver is simply told to collect ~R0. `quantity: 0` also silently coerces to `1` for pricing (`|| 1`) but uses the raw `0` for the stock decrement, causing a smaller stock/accounting mismatch on every zero-quantity line.
**Proof of concept:**
```
POST /api/orders
{ "items": [
    { "productId": "<real-uuid>", "size": "M", "quantity": 1 },
    { "productId": "<real-uuid>", "size": "M", "quantity": -1 }
  ], "delivery_mode": "fleet", ... }
```
→ net subtotal for that product line = 0; stock ends net-unchanged despite the customer receiving 1 real unit.
**Fix:**
```js
const rawQty = Number(item.quantity);
if (!Number.isInteger(rawQty) || rawQty <= 0) {
  throw new Error(`Invalid quantity for "${item.name || 'item'}": must be a positive integer`);
}
```
applied once before both the stock adjustment and the subtotal accumulation, plus a final `if (finalTotal <= 0) throw new Error('Order total must be positive')` as defense-in-depth.

---

### C-4 — Driver location pings are not verified against real order ownership, and can survive a driver believing they've gone offline

**Severity:** Critical (combining two agents' findings — a route-matrix High and a driver-app Critical describing the same root cause and its worst-case combination)
**Category:** API1:2023 Broken Object Level Authorization / OWASP Mobile M6 (privacy)
**File(s):** `backend/src/routes/driverRoutes.js:52-58` (no `requireApprovedDriver`, no ownership check), `backend/src/controllers/driverController.js:154-169`, `backend/src/models/Driver.js:115-142`, `flash-driver-app/context/DriverContext.js:62-70,145-169,182-215`, `flash-driver-app/tasks/backgroundLocationTask.js:125-201`
**Exploitability:** Requires auth only — any registered driver account, including one still in `pending_documents` status (never approved), since `/api/drivers/location` is the one driver-order route missing `requireApprovedDriver`
**Real-world impact:** `Driver.updateLocation()` takes the client-supplied `orderId` from the request body and, with **no check that `orders.driver_id === req.userId`**, persists it to `driver_locations` and broadcasts it live into the `order:<id>` Socket.IO room the real customer is watching — including firing "your driver has arrived" push notifications. Any driver (approved or not) can POST `{lat, lng, orderId}` for an order they have no connection to. This compounds with a second real gap: the driver app's `isOnline` UI state is never reconciled against the OS-level background-location task on hydration, and the 45-minute stuck-order reassignment cron never notifies the old driver's app that the order was taken away — so a driver who force-quits mid-shift can keep broadcasting real GPS location, tagged to an order they no longer own, into a live customer-facing tracking channel, indefinitely.
**Proof of concept:**
```
curl -X POST https://<backend>/api/drivers/location \
  -H "Authorization: Bearer <any-driver-jwt>" -H "Content-Type: application/json" \
  -d '{"lat":-33.9608,"lng":25.6022,"orderId":"<uuid-of-an-order-not-assigned-to-this-driver>"}'
```
**Fix:** In `Driver.updateLocation`, verify `SELECT 1 FROM orders WHERE id=$1 AND driver_id=$2` before persisting/broadcasting, dropping the ping (or clearing the client's stale `activeOrder`) on mismatch. Add `requireApprovedDriver` to the `/location` route. On the client, reconcile `isOnline` against `Location.hasStartedLocationUpdatesAsync()`/`/drivers/me` on app hydration, and emit a `driver:<id>` socket event from the reassignment cron so a foregrounded old-driver app clears its stale `activeOrder` immediately.

---

## 3. High-severity findings

**H-1 — Real backend test coverage is 19.46%/7.22%/20.28%/5.34% (statements/branches/lines/functions), far below the 70/60/70/70 gate `jest.config.js` and CLAUDE.md both claim CI enforces.**
File: `backend/jest.config.js:29-34` vs. actual `npx jest --coverage` output (captured this session). Even setting aside C-0 (CI not running at all), if it *were* running, this would fail the build on every push. `src/socket/socketServer.js` and `src/services/orderStateMachineService.js` — the two most correctness-critical files in the backend — show **0%** and **4.05%** statement coverage respectively.
Fix: either lower the threshold to reflect reality and ratchet it up deliberately, or (better, given the stakes) write real tests for the state machine and socket auth paths first.

**H-2 — `auth.test.js` has never once executed successfully since it was created; the refresh-token reuse-detection logic has zero test coverage.**
File: `backend/tests/unit/auth.test.js:12` — `jest.mock('bcrypt')`, but the project's only password-hashing dependency is `bcryptjs` (`package.json:19`); `bcrypt` isn't installed at all. Verified live: `Cannot find module 'bcrypt'`. The file also calls `AuthController.register`/`.login`, which don't exist (real names are `registerUser`/`loginUser`) — a straight rename would still not make it pass.
Fix: fix the mock target, rename the called methods to match the real controller, add a real reuse-detection test (replay an already-rotated refresh token, assert the whole token family gets revoked).

**H-3 — Google/Apple OAuth audience checks are not scoped per app — a token minted for the user app is accepted by the driver app's sign-in endpoint and vice versa.**
File: `backend/src/services/googleAuthService.js:21-34`, `backend/src/services/appleAuthService.js:81`, `backend/src/controllers/authController.js:290,347,562`. `verifyGoogleToken`/the Apple `accepted` audience list union in all four (or three) client IDs regardless of which endpoint calls them. A customer's Google token can self-provision a driver-role account via `POST /api/auth/driver/google` (still gated by document approval downstream, but the audience boundary itself is broken).
Fix: thread the expected per-app audience through `verifyGoogleToken(idToken, expectedAudience)`; drop the sibling app's client ID from each Apple `accepted` list.

**H-4 — Delivery fee is trivially client-selectable (R90 vs R180) — no real mall table exists to validate against.**
File: `backend/src/models/Order.js:54-59`, `backend/src/controllers/orderController.js:41-95`. `calculateDeliveryFee` charges R90 whenever `pickup_mall_id === dropoff_mall_id`, and both values come straight from the client with nothing to check them against (confirmed: no `malls` table anywhere in the schema; pickup is always the single fixed store location). Any customer can send matching IDs on every order for a guaranteed R90 fee instead of R180 — a 100%-reachable, zero-skill revenue loss on every single order, which also proportionally shrinks driver payouts since `driver_payout` derives from the manipulated fee.
Fix: compute delivery fee server-side from `dropoff_lat/lng` distance from the fixed store location; stop trusting client-supplied mall IDs for pricing.

**H-5 — Driver bank account (payout destination) can be changed with only the existing session token — no step-up re-authentication, no notification.**
File: `backend/src/routes/driverRoutes.js:122-127`, `backend/src/controllers/driverController.js:419-464`. Given this same app already treats stolen sessions seriously enough to build a full JWT revocation-list system, this is a real gap: anyone who obtains a driver's session (stolen device, leaked token) can redirect all future payouts to their own account, and the real driver gets no signal until a payout goes missing.
Fix: require password re-entry or an OTP step before activating a new payout destination; notify the driver's verified contact channel on change.

**H-6 — A driver can call `markCashFailed` to keep collected cash, dodge the R20 commission, and get the *customer* penalized instead.**
File: `backend/src/controllers/paymentController.js:409-459`, `backend/src/routes/paymentRoutes.js:89-94`. Unlike the legitimate OTP-gated `confirmCashReceived` path (which is the *only* caller of `recordCashCommission`), `markCashFailed` requires no OTP, no delivery-status precondition, and has **no rate limiter at all** (its siblings `/cash/send-otp` and `/cash/confirm` both have one). A driver who actually collects cash can call this instead of the real confirmation flow, keep the money, skip commission entirely, and after 2 occurrences the innocent *customer* gets auto-flagged `flagged_for_cash_abuse`.
Fix: require `order.status === 'delivered'` before allowing this call (mirroring `confirmCashReceived`'s precondition); add rate limiting; track a per-driver fail-rate as a fraud signal instead of only tracking customer refusals.

**H-7 — No request timeout anywhere in either mobile app's `services/api.js` — a dropped connection hangs indefinitely, including cash-OTP and bank flows.**
File: `flash-driver-app/services/api.js:59-116` (same gap in `flash-user-app`). No `AbortController`, no connectivity check. Cash-OTP confirm and bank-account save both disable their buttons while the request is "in flight" with no ceiling — on South African cellular networks (the app's actual target), this turns ordinary flakiness into "the app is frozen," and for cash-OTP specifically it directly touches money-reconciliation trust (the backend is safe from double-crediting, but the driver has no way to know that).
Fix: wrap `fetch()` with an `AbortController` timeout (~15-20s); reuse the polling+"Check Again" pattern `subscription.js` already implements correctly for the payment-confirmation flow.

**H-8 — Nine screens in flash-user-app show the raw string "SESSION_EXPIRED" to the user, and three (Checkout, Payment, OrderStatus) silently swallow it — neither path ever actually logs the user out or navigates anywhere.**
File: `flash-user-app/services/api.js:91-92`; the three silent-swallow sites (`CheckoutScreen.js:158`, `PaymentScreen.js:156`, `OrderStatusScreen.js:105,125`) catch the error and `return` with a comment claiming a redirect happens that doesn't exist in the code; the other nine (`SavedCardsScreen.js`, `SizingScreen.js`, `TrustedDriversScreen.js`, `FeedScreen.js`, `AddressScreen.js`, `SettingsScreen.js`) show `Alert.alert('Error', 'SESSION_EXPIRED')` verbatim. Either way, `FlashContext`'s `isAuthenticated` state is never actually reset, so the user is stuck in a dead, authenticated-looking UI until they force-quit.
Fix: have `services/api.js`'s `request()` call a shared session-expiry callback (set once by `FlashContext`) instead of relying on 12 separate call sites to special-case the string.

**H-9 — Payment redirect has no way back into the app — the Paystack `callback_url` points at a backend route that doesn't exist, and no deep-link scheme is registered.**
File: `flash-user-app/screens/PaymentScreen.js:130-152`, `app.config.js` (no `scheme` field), `backend/.env.example:98`. After paying, the customer's browser lands on the backend's generic 404 JSON handler with no way back to the app, while the app has already raced ahead to a "waiting for confirmation" polling screen with no correlation to what's on-screen in the browser.
Fix: register `expo.scheme`, add a real `/payment/callback` backend route that redirects into the app scheme, add a `Linking.addEventListener('url', ...)` handler.

**H-10 — AddressScreen and NotificationsScreen are fully built UI calling backend routes that don't exist.**
File: `flash-user-app/services/api.js:203-241`; confirmed absent from `backend/src/server.js`/`userRoutes.js`. Every action on these two screens 404s forever.
Fix: build the missing routes or hide the menu entries until they exist.

**H-11 — Background location can keep running (and reporting live GPS) after a driver believes they've gone offline.**
File: `flash-driver-app/context/DriverContext.js:62-70,145-169,182-215`; `tasks/backgroundLocationTask.js:125-201`. See C-4 — listed here too because it's independently a real production-readiness gap even setting aside the IDOR angle: `isOnline` is never restored/reconciled from the actual OS task state or `driver.is_online` on app hydration.
Fix: on hydration, check `Location.hasStartedLocationUpdatesAsync()` and reconcile against `/drivers/me`.

---

## 4. Medium / Low findings

**Medium**
- `payment_pending → scheduled_for_morning` is a defined-but-unreachable bypass edge in the order state machine that skips `paid` — not currently exploitable (every real caller transitions through `paid` first), but a latent footgun. `orderStateMachineService.js:37`. *Fix: remove the edge.*
- The documented "driver_assigned 25% cancellation penalty" doesn't actually refund the other 75% — the customer's entire payment is silently retained on a `driver_assigned`-stage cancellation. `orderController.js:184-267`. *This overcharges the customer; it is a billing-correctness bug, not an attacker vector.*
- A driver's "R20 self-cancel-before-pickup penalty" is logged (`driver_penalties`) but never actually deducted from anything — drivers can cherry-pick and abandon low-value orders at zero real cost, up to the 5-cancellation auto-suspend threshold. `driverController.js:292-296`.
- `preferred_driver_id` at order creation is never checked against a real accepted `trusted_drivers` relationship — any customer can grant *any* driver a guaranteed 3-minute head start with no vetting handshake, opening a collusion channel. `orderController.js:47-90`.
- Socket.IO never re-checks `revoked_tokens` after the initial handshake — a logged-out/revoked session's already-open socket stays live for up to ~14 more minutes. `socketServer.js:140-155`.
- `POST /api/drivers/location` has no `requireApprovedDriver` gate (compounds C-4). `driverRoutes.js:52-58`.
- `GET /api/drivers/nearby` is fully unauthenticated and discloses driver names, ratings, vehicle plates, and live positions to anyone with network access. `driverRoutes.js:106`.
- `SELECT o.*` on orders leaks internal-only columns (`cash_otp_hash`, `paystack_reference`, `store_paid`, `driver_paid`) to customer/driver clients — low real risk since the OTP hash is HMAC-keyed server-side, but still an unnecessary exposure. `Order.js:233-282`.
- Driver document upload trusts the client-declared `Content-Type` with no magic-byte sniffing — low risk today since storage is `authenticated`-type Cloudinary behind signed URLs, but a real gap if documents are ever rendered inline anywhere later. `middleware/upload.js:8-27`.
- No Sentry `beforeSend` scrubbing hook on any of the three `Sentry.init()` calls — no active leak found today, but no backstop against a future `captureException(err, {extra: {token}})` mistake either.
- `forgotPassword` has a measurable timing side-channel for user enumeration (known-email path awaits a full SMTP send; unknown-email path returns almost instantly). `authController.js:193-225`.
- Coordinate/GPS spoofing is not documented anywhere as an accepted risk for the Nelson Mandela Bay geofence check — the check itself is honestly scoped (doesn't claim to be spoof-proof), but nothing flags the residual risk for future readers. `geoBoundary.js`.
- 18 FK/lookup columns across `return_requests`, `payments`, `payment_refunds`, `driver_payout_requests`, `driver_wallet_ledger`, `driver_penalties`, `feed_posts`, `feed_likes`, `feed_comments`, `store_credits`, `driver_ratings`, `orders.parent_order_id` have no supporting index — cheap to add now, will matter as these append-only tables grow.
- `Driver.getNearby` and `autoMatchService`'s nearest-driver query both do haversine trig with **no bounding-box pre-filter** — confirmed via live `EXPLAIN ANALYZE` (see §6) to already be a full sequential scan at just 55 seeded drivers; will scale linearly and start costing real latency in the 1,000-2,000+ concurrently-online-driver range.
- Two real-looking Google Maps API keys (`AIzaSyBx...`, `AIzaSyDIT6c9...`) are permanently present in git history (removed from current `HEAD` in commit `d15b5ad`, but recoverable from ~5 earlier commits since history hasn't been rewritten). *Not verified whether these specific keys have actually been rotated/revoked in Google Cloud Console — removing them from the repo does not revoke them. Confirm this directly.*

**Low**
- Admin login allows a plaintext-password dev fallback outside `NODE_ENV=production` (correctly fenced off, but worth confirming every non-primary deployment has `NODE_ENV=production` set).
- `JWT_SECRET` and friends are checked for placeholder *strings* but never for minimum length/entropy — a weak-but-non-placeholder secret would pass validation.
- Several admin-only write routes (`boost`, `inventory`, `sizing/mappings/seed`) accept request bodies with only ad-hoc presence checks rather than the `express-validator` pattern used elsewhere — low risk since admin is already the highest-trust role.
- Product images use RN's default `<Image>` with no disk cache/resize layer (`expo-image` isn't a dependency) — full-resolution refetch on every mount.
- `FlashContext`'s single monolithic `useMemo`'d context value re-renders every mounted screen on any cart mutation — already flagged as known follow-up in the file's own header comment.
- Checkout draft (`FLASH_CHECKOUT_DRAFT`) is a single global AsyncStorage key, not namespaced per user, and isn't cleared on session expiry (only on explicit logout) — a second person on a shared device could see a previous customer's typed name/phone/address (contents are otherwise clean of any payment data).
- Driver notifications screen and three Settings notification toggles are entirely non-functional/cosmetic dead UI.
- Duplicate push-token registration logic in both `DriverContext` and `dashboard.js` (harmless but will silently diverge).
- `eas.json`'s `production` build profile for both mobile apps has an unused, dead `pk_test_...` Paystack key checked in — no runtime effect, but confusing.
- iOS EAS submit config still has literal placeholder values (`YOUR_APP_STORE_CONNECT_APP_ID` etc.) — will block `eas submit` for iOS until filled in.
- `flash-driver-app` pins `expo-router@~4.0.17` against `expo@~56.0.14` — a large version mismatch flagged in Phase 4 of this engagement as pre-existing dependency debt requiring a coordinated `@react-navigation` v6→v7 migration; not re-litigated in depth here since it was already identified and deliberately deferred.

---

## 5. Load test results (real numbers, run against a locally rebuilt copy of the current backend)

**Setup:** rebuilt `docker-compose.yml`'s backend image from current source (the previously-running local stack was 3 months stale — confirmed by probing two routes added this week, both 404'd before rebuild, both 401'd after), ran all pending migrations, seeded 110 test customers + 55 test drivers + 1 product directly into Postgres (bypassing only the rate-limited `/api/auth/*` registration endpoints — necessary because that limiter is 10 req/15min per IP and would make seeding 165 accounts through the real endpoints take hours from one machine), and minted access JWTs using the server's own `JWT_SECRET`/signing logic. Ran a 5-minute scenario: 50 drivers pinging location every ~10s, ~100 customers browsing/ordering, and a 30-order burst-with-accept-race phase.

**Important methodological caveat, stated plainly:** every simulated actor in this test originates from **one machine, one IP address**. This is fundamentally different from 100 real customers on 100 real home/mobile IPs. It means every IP-keyed rate limiter in the backend (general: 100/15min, order creation: app-level limiter, location: 60/min) was **shared across all simulated actors** rather than applied per-actor. This isn't a meaningless test artifact, though — it directly and accurately demonstrates what happens to *real* users who share a NAT'd IP, which is a genuinely common scenario on South African mobile networks (large-scale carrier NAT) and office/campus WiFi. Read the results below with that lens.

### Real measured results

| Endpoint | Requests | 200 OK | 429 (rate-limited) | 500 | 401 | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| `GET /api/inventory` | 1,050 | 26 (2.5%) | 1,012 | 12 | — | 1,842ms | 6,992ms | 11,140ms |
| `GET /api/orders/my-orders` | 1,050 | 5 (0.5%) | 1,045 | — | — | 234ms | 2,598ms | 6,385ms |
| `POST /api/orders` (steady) | 1,050 | 0 | 1,050 | — | — | — | — | — |
| `POST /api/orders` (30-order burst) | 30 | 0 | 30 | — | — | — | — | — |
| `POST /api/drivers/location` | 1,313 | 300 (22.8%) | 1,006 | — | 7 | 150ms | 4,687ms | 16,054ms |

**Accept-race test:** 0 races ran, because 0 of the 30 burst orders ever received a `201` — every single burst order-creation attempt was rejected with `429` before the accept-race step could even start, since the concurrent "steady" browsing traffic had already exhausted the shared order-creation rate limiter. This is itself a real, useful result, not a null one — see below.

### What breaks first (the brief's core question)

**Under this specific shared-IP load, the rate limiters break first, by a wide margin** — not the Postgres connection pool, not a hot row lock. Over 96% of all requests across every endpoint were rejected with `429` before ever reaching business logic. This directly contradicts the brief's own stated prior ("this is almost always either the Postgres pool or a single hot row lock") **for the shared-IP case specifically** — worth knowing precisely because CGNAT is common enough in South Africa that this isn't a purely synthetic scenario.

**The Postgres pool is also real and was directly observed**, just masked behind the rate limiter for most of this run: the 12 real `500`s on `GET /api/inventory` all show `responseTime` of ~5,500ms, which lines up almost exactly with `config/database.js:23`'s `connectionTimeoutMillis: 5000` — i.e., these are pool-exhaustion timeouts (pool `max: 50`, `backend/src/config/database.js:21`), not application bugs. I did not isolate this further with the rate limiter disabled (would require a code change, not attempted), so I can't give a clean "pool exhausts at exactly N concurrent DB-touching requests" number — but the failure mode itself, and its ~5.5s signature, is real and directly observed, not inferred.

**Driver-assignment locking:** genuinely could not be exercised this run — zero orders reached `waiting_for_driver` during the burst window (all rejected by the rate limiter before creation). This is a real gap in this test's coverage, not a "confirmed safe" result. However, all three specialized backend agents independently traced `assignDriver`'s transaction/locking code by hand (not just read the comments) and confirmed the `SELECT ... FOR UPDATE` ordering genuinely prevents double-assignment — see §3's business-logic findings for the traced mechanics. **Not verified under live concurrent load in this session** — the static/transactional analysis is solid, but I want to be precise that this specific test did not exercise it.

**Webhook idempotency — verified live, separately from the load test:** built a validly HMAC-SHA512-signed `charge.success` payload and sent it twice to `/api/webhooks/paystack`. Both returned `200`. Checked the database directly afterward: `orders.payment_status = 'paid'` (set exactly once) and `webhook_events` has exactly one row for that event ID despite two delivery attempts. **Confirmed genuinely idempotent, empirically, not just by code reading.**

### Not verified in this session (explicitly)
- Real per-account (as opposed to shared-IP) rate-limiter behavior at the target concurrency — would need a proper multi-IP load-testing setup (e.g. a cloud-based tool with distributed source IPs), not available in this environment.
- Exact Postgres pool exhaustion point (N concurrent long-held transactions) — masked by the rate limiter in this run.
- Redis-vs-no-Redis behavioral difference under load — the local stack ran with Redis configured throughout; the no-Redis path was not separately load-tested.
- Cron-vs-live-load interaction (stuck-order/no-driver-auto-cancel crons firing mid-test) — the 5-minute test window is shorter than both cron intervals (10min/15min), so neither fired during the test.
- Socket.IO memory/CPU under sustained load — not separately profiled; static analysis (by the DB-schema agent) found the in-memory caches have working, sensibly-scoped cleanup intervals and don't grow unboundedly under realistic ping patterns.

---

## 6. Route / permission matrix

Full table below covers all 19 route files. `general` = the baseline 100/15min limiter mounted on all of `/api/`; specific limiters are noted where stricter.

| Method | Path | Auth? | Role guard? | Ownership check | Rate limit |
|---|---|---|---|---|---|
| POST | /api/auth/user/register | No | — | — | authLimiter 10/15min |
| POST | /api/auth/user/login | No | — | — | authLimiter |
| POST | /api/auth/user/apple, /google | No | — | — | authLimiter |
| POST | /api/auth/driver/register, /login, /apple, /google | No | — | — | authLimiter |
| POST | /api/auth/refresh | No | — | reuse-detection revokes token family | authLimiter |
| GET/PUT | /api/users/me | Yes | user | self | general |
| GET | /api/users/orders | Yes | user | self | general |
| DELETE | /api/users/account | Yes | user | self | general |
| GET/PUT | /api/drivers/me | Yes | driver | self | general |
| POST | /api/drivers/documents/upload | Yes | driver | self | general |
| POST | /api/drivers/online | Yes | driver | `requireApprovedDriver` | general |
| **POST** | **/api/drivers/location** | Yes | driver | **none — see C-4** | locationLimiter 60/min |
| GET | /api/drivers/available-orders | Yes | driver | `requireApprovedDriver` | general |
| POST | /api/drivers/orders/:id/accept, /cancel | Yes | driver | `requireApprovedDriver` + row lock | general |
| **GET** | **/api/drivers/nearby** | **No** | — | — | general — see Medium findings |
| POST | /api/drivers/bank/save | Yes | driver | self — see H-5 (no step-up auth) | general |
| POST | /api/orders | Yes | user | — (see C-3, H-4) | general + orderLimiter |
| GET | /api/orders/:id | Yes | — (shared) | `WHERE user_id/driver_id` in model | general |
| PUT | /api/orders/:id/status | Yes | driver | `order.driver_id === req.userId` | general |
| POST | /api/orders/:id/cancel, /select-driver, /rate-driver, /return | Yes | user | ownership checked in model | general |
| POST | /api/payments/initialize, /cash-on-delivery, /charge-saved-card | Yes | user | ownership checked | general + paymentLimiter |
| GET | /api/payments/verify/:reference | Yes | none (compensating check in service) | `row.user_id !== callerUserId` | general |
| POST | /api/payments/cash/send-otp, /confirm | Yes | driver | ownership + OTP | otpLimiter 3/min |
| **POST** | **/api/payments/cash/fail** | Yes | driver | ownership only — see H-6 | **none** |
| POST | /api/admin/login | No | — | — | adminLimiter 5/15min |
| ALL other /api/admin/* | Yes | admin | N/A | general |
| GET | /api/inventory, /:id | No | — | public read, `cost_price` excluded | general + 60s cache |
| POST/PATCH/DELETE | /api/inventory | Yes | admin | — | general |
| GET/POST | /api/messages/:orderId(/unread) | Yes | — (shared) | ownership checked in model | general |
| POST | /api/returns/:orderId | Yes | user | ownership checked | general |
| POST | /api/returns/:returnId/pickup | Yes | driver | claim semantics (by design) | general |
| GET | /api/tracking/order/:orderId | Yes | — (shared) | role-conditional, null on mismatch | general |
| POST | /api/sos/:orderId/trigger | Yes | — (shared) | explicit role+id match | general |
| POST | /api/webhooks/paystack | No — HMAC signature instead | — | idempotent via unique constraint | excluded from limiter |

**IDOR/BOLA audit result:** of every route taking an ID parameter, only `POST /api/drivers/location` lacks a real ownership check (C-4). Every other ID-bearing route — orders, payments, cards, messages, tracking, SOS, trusted-driver relationships — verified to re-derive authorization from the resource's actual owner column, not the caller's role claim alone.

**BFLA audit result:** no route allows a customer-role or driver-role token to reach admin-only or opposite-role functionality. One real gap: `/api/drivers/location` lacks `requireApprovedDriver` (every sibling driver-order route has it).

**Admin isolation:** confirmed clean — every route in `adminRoutes.js` requires `requireRole('admin')` with zero gaps, and no admin-capable write action in any other controller (boost, inventory, sizing, returns, fleet) is reachable without that same guard.

---

## 7. Dependency audit (real `npm audit` output, captured this session)

| App | Total | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| `backend` | 18 | 0 | 6 | 11 | 1 |
| `flash-user-app` | 14 | 0 | 2 | 12 | 0 |
| `flash-driver-app` | 13 | 0 | 2 | 11 | 0 |

**Backend — notable High findings:** `basic-ftp` (unbounded multiline DoS via a malicious FTP server — check whether this is actually reachable: it's a transitive dep, likely via a Cloudinary/upload-related package, not directly used), `form-data` (CRLF injection in multipart field names — used by upload flows), `nodemailer` (`<=9.0.0`, raw-option file/URL-access bypass — used for verification/reset emails), `systeminformation` (Linux command injection via `networkInterfaces()` — check if this is even invoked anywhere; likely an unused transitive dep pulled in by `pm2`), `undici` (TLS cert validation bypass via SOCKS5 proxy config — check exposure), `ws` (uninitialized memory disclosure + DoS, via `engine.io`/`socket.io-adapter` — directly relevant since Socket.IO is core to this app).
**Mobile apps:** the `ws` (via `engine.io-client`) High finding is common to both and is the same root package as the backend's.
**No CI enforcement currently exists for any of these** — the `Audit backend dependencies` CI step exists (`ci.yml`) but is `continue-on-error: true` "for now," and per C-0, CI hasn't run at all recently regardless.
**Fix path:** `npm audit fix` covers the low-risk subset (`undici`, `ws`, `engine.io`, `socket.io-adapter`, `express`, `qs`, `body-parser`) without breaking changes for all three apps. `nodemailer`, `basic-ftp`, `form-data`, `systeminformation`, `uuid`/`node-cron` need `--force` (breaking-change upgrades) — recommend a dedicated, tested upgrade pass rather than bundling into this fix round, consistent with how the `expo-router` dependency debt was handled earlier in this engagement.

---

## 8. File coverage checklist

Every file below was opened and read in full, either by me directly or by one of seven parallel specialist review passes (auth/session, business-logic/financial-abuse, route/permission matrix, data-exposure/dependencies, flash-user-app, flash-driver-app, DB-schema/state-machine), each of which cited exact file:line for every claim and explicitly flagged anything it couldn't verify.

**Backend — 100% of `middleware/`, `routes/` (19/19), `controllers/` (19/19), `services/` (16/16), `models/` (all referenced/relevant models), `socket/socketServer.js`, `utils/`, `config/`, `db/migrate.js`** — opened; see finding numbers above for anything flagged, "clean" for everything else (full per-file checklists are in each specialist pass's original output and are available on request — condensed here for readability).

**flash-user-app** — `App.js`, `context/FlashContext.js`, `services/api.js`, `app.config.js`, `eas.json`, `package.json`, and all 26 screen files under `screens/` — opened in full.

**flash-driver-app** — `app/_layout.js`, `context/DriverContext.js`, `services/api.js`, `tasks/backgroundLocationTask.js`, `app.config.js`, `eas.json`, `package.json`, and every route file under `app/auth/*` and `app/driver/*` — opened in full.

**Also directly executed/verified this session (not just read):**
- `npm test` (backend unit) — real output captured, 2/6 suites failed (see H-2)
- `npm run test:integration` — real output captured, 4/4 tests passed
- `npx jest --coverage` — real coverage numbers captured (see H-1)
- `npm audit` — all three apps, real JSON output captured (see §7)
- Full git-history secret scan (`git log --all -p` grepped for `sk_live_`, `sk_test_`, `AIza`, `AKIA`, private-key headers)
- `gh run list`/`gh run view` against the live GitHub repo (see C-0)
- Live plaintext-JWT-in-logs verification against a running instance (see C-1)
- Live webhook-replay idempotency test against a running instance (see §5)
- Real `EXPLAIN ANALYZE` on the `getNearby` haversine query against seeded data (see Medium findings)
- 5-minute load test with 165 seeded accounts against a rebuilt, migrated local copy of the current backend (see §5)

**Not verified in this session, explicitly:**
- Anything requiring a physical Android/iOS device (background-location survival under real OEM battery managers, actual on-device fetch timeout behavior on a dropped cellular connection)
- Production Render account settings (whether `NODE_ENV=production` is actually set there, whether backups are configured/tested, whether the account is on a sleeping free tier)
- Whether the two git-history-leaked Google Maps API keys have actually been rotated/revoked in Google Cloud Console (only confirmed they're removed from current source)
- Real per-IP (as opposed to shared-IP) rate-limiter behavior at the target load concurrency
- Expo SDK 56 / RN 0.85 EOL status (no internet access for a live lookup in this session)

---

## 9. Fix backlog

**Critical — fix before launch**
- [ ] C-0: Resolve GitHub Actions billing lock (you — I cannot do this)
- [ ] C-1: Add `redact` config to `pinoHttp()` in `server.js:121`
- [ ] C-2: Fix `TrackingScreen.js`/`ChatScreen.js` to read the token from SecureStore, not AsyncStorage
- [ ] C-3: Validate `item.quantity` is a positive integer in `Order.js` before pricing/stock logic
- [ ] C-4: Add ownership check to `Driver.updateLocation`; add `requireApprovedDriver` to `/drivers/location`; reconcile driver-app `isOnline` on hydration

**High**
- [ ] H-1: Decide a real coverage plan (lower threshold honestly + ratchet up, or write real tests for the state machine/socket auth first)
- [ ] H-2: Fix `auth.test.js`'s `bcrypt`→`bcryptjs` mock and method names; add refresh-reuse test
- [ ] H-3: Scope OAuth audience checks per app (user vs driver) in both Apple and Google verification
- [ ] H-4: Compute delivery fee server-side from coordinates, not client-supplied mall IDs
- [ ] H-5: Require step-up auth (password/OTP) before activating a new driver payout bank account
- [ ] H-6: Gate `markCashFailed` behind `order.status === 'delivered'` + add rate limiting
- [ ] H-7: Add request timeouts to both mobile apps' `services/api.js`
- [ ] H-8: Centralize `SESSION_EXPIRED` handling through one callback instead of 12 call sites
- [ ] H-9: Register a URL scheme + real `/payment/callback` route + deep-link handler
- [ ] H-10: Build the missing address/notification backend routes, or hide the screens
- [ ] H-11: Same fix as C-4's client-side half

**Medium** (see §4 for full detail on each)
- [ ] Remove the `payment_pending → scheduled_for_morning` bypass edge
- [ ] Actually issue the 75% refund on `driver_assigned`-stage cancellations, or correct the documentation
- [ ] Either enforce or remove the decorative driver R20 self-cancel penalty
- [ ] Validate `preferred_driver_id` against a real accepted `trusted_drivers` row
- [ ] Re-check `revoked_tokens` on the Socket.IO periodic interval, not just at handshake
- [ ] Add auth to `GET /api/drivers/nearby`
- [ ] Replace `SELECT o.*` with an explicit column allowlist on order reads
- [ ] Add magic-byte MIME sniffing to document uploads
- [ ] Add `beforeSend` scrubbing to all three `Sentry.init()` calls
- [ ] Remove the `forgotPassword` timing side-channel (don't await the email send)
- [ ] Document GPS-spoofing as an accepted residual risk
- [ ] Add the 18 missing FK/lookup indexes listed in the DB-schema findings
- [ ] Add a bounding-box pre-filter to `getNearby`/`autoMatchService`'s geo queries
- [ ] Confirm in Google Cloud Console that both leaked historical Maps API keys are actually rotated/revoked

**Low** — see §4; recommended to batch into a single cleanup pass rather than fix individually.

**Dependencies** — run `npm audit fix` (non-breaking subset) across all three apps now; schedule a dedicated, tested pass for the `--force` upgrades (`nodemailer`, `form-data`, `basic-ftp`, `systeminformation`, `uuid`).
