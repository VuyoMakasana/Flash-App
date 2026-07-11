# Flash — Returns, Saved Cards, Saved Addresses & Legal/Compliance Audit

**Date:** 2026-07-09
**Scope:** Read-only investigation only — no fixes applied in this session. Every finding below was produced by reading the actual file, running the actual command, or hitting the live backend (rebuilt fresh from current committed HEAD, `0438e6a`, before any testing began). Real curl/SQL output is quoted where relevant; anything not directly verifiable says so explicitly.

---

## 1. Plain-language summary

The returns feature is much further along than a first glance suggests, but it has one live, unconditional bug and one severe, unmitigated financial-trust gap. The bug: **the admin "approve return" action fails every single time, for every real admin, with no exception** — reproduced with the exact production admin-token shape, not a testing artifact — because the code tries to store the literal string `"admin"` in a database column that only accepts UUIDs. The trust gap: **store credit is issued the instant a driver taps "picked up," with no physical inspection, no photo, no admin sign-off, and — separately — no way for a customer to ever spend that credit anywhere in the app once they have it.** The driver-side half of the feature (a screen for drivers to find and claim return pickups) doesn't exist at all — the backend endpoint that issues credit has no discoverable UI on either app. Saved cards, by contrast, are fully functional, properly tokenized through Paystack, and free of the IDOR gaps found elsewhere in this codebase — a genuine bright spot. Saved addresses are the opposite story: a fully-built, polished "Home/Work/Other" screen exists in the user app with zero backend behind it — every action 404s. On legal/compliance, the in-app Privacy Policy and Terms are hardcoded text baked into the app binary (not linked to the real, live flashdelivery.co.za site), they disagree with each other and with the live site on how account deletion actually works, one in-app Settings link points at a domain (`flash.co.za`) that isn't Flash's real domain at all, and the app enforces none of the three separate "must be 18+" claims found across the live site's own pages. None of this is fixed in this session — it's the accurate baseline for the fix/build work to follow.

---

## 2. Returns system — findings

### 2.1 History (git-verified)

`git log --follow` on `Return.js`/`returnController.js`/`returnRoutes.js` shows this was built as a real feature in two passes, then patched three times very recently:

| Commit | Date | What |
|---|---|---|
| `5cd35fa` | 2026-03-21 | Original build, "MVC migration backend" — Return.js/returnController.js/returnRoutes.js created whole-cloth (206 lines) |
| `ae81e42` | 2026-04-01 | "production-ready order state machine, payment escrow, OTP cash confirmation" — substantial rework |
| `c7198bc` | 2026-07-05 | "close 3 data-isolation gaps" — added the missing `requireApprovedDriver` gate to `/:returnId/pickup` |
| `5ad2fef` | 2026-07-05 | "generalize validateId" — added `validateId` to the ID-param routes |
| `5d712e4` | 2026-07-05 | "return-pickup race (H3)" — added `FOR UPDATE OF rr` to `pickupReturn`'s SELECT, closing a double-credit race |

Not a stub or placeholder — built with real intent, and already patched once for a real race-condition bug. The two fixes flagged as possibly-still-outstanding in the build prompt's own framing (the missing `requireApprovedDriver` gate, the pickup race) are **both already fixed**, confirmed both by reading current source and by live testing below — the inline code comments describing them as "was missing" are historical/explanatory, not a sign they're still broken.

### 2.2 What actually happens today, end to end

1. **Customer requests a return** (`POST /api/returns/:orderId`, aliased at `POST /api/orders/:orderId/return` — both routes call the exact same `Return.requestReturn()` model function, confirmed by reading both controllers; this is route duplication, not a bug). Requires the order to belong to the caller and be in `delivered`/`completed` status. Creates one `return_requests` row, `status='requested'`. **Whole-order only** — there is no line-item/partial-return concept anywhere in the schema or code.
2. **A driver claims the pickup** (`POST /api/returns/:returnId/pickup`, any approved driver — not necessarily the one who delivered the original order, confirmed by reading the code: no relationship check between the claiming driver and the original `orders.driver_id`). This single call **instantly issues store credit** — no admin step required, no physical verification of any kind, no photo, no condition check. Sets `return_requests.status='picked_up'`, `credit_issued=true`.
3. **Separately, an admin can call** `POST /api/returns/:returnId/approve`. This does **not** gate or precede step 2 in any way that's actually enforced — both `pickupReturn` and `approveReturn` independently require `status='requested'`, so whichever fires first wins and the other is rejected. `approveReturn`'s real effect: it creates a **second, separate delivery order** (`is_return_order=true`, `parent_order_id` set) for a driver to physically collect the item and bring it to the store — a reverse-logistics leg. **It has no connection to `store_credits` at all** — confirmed by grepping every reference to `store_credits` in the backend: the only write is inside `pickupReturn`.
4. **No fee is charged anywhere in this flow.**
5. **Refund type: store credit only**, `store_credits.balance`, valid 90 days, equal to the original order's `subtotal` (not including the delivery fee).

### 2.3 Findings, by severity

---

**CRITICAL — `approveReturn` is completely broken for every real admin, unconditionally**
**Category:** A05:2025 Security Misconfiguration / broken core function — CWE-1284 (Improper Validation of Specified Quantity in Input)
**File:** `backend/src/models/Return.js:158-166` (the `approved_by` column write), `backend/src/db/migrate.js:600` (`approved_by UUID`)
**Exploitability:** N/A — not an attacker path, an unconditional functional failure
**Real-world impact:** The production admin identity is a single hardcoded JWT payload `{ id: "admin", role: "admin", jti: uuidv4() }` (`backend/src/controllers/adminController.js:77-81`), and `middleware/auth.js:29` sets `req.userId = decoded.id` directly — meaning **every real admin session's `req.userId` is the literal string `"admin"`**, never a UUID. `Return.approveReturn(returnId, adminId)` passes that string straight into `UPDATE return_requests SET ... approved_by = $2 ...`, and `return_requests.approved_by` is typed `UUID`. This throws a Postgres type error on every single call, with no exception.
**Proof (live, reproduced twice — once via the real HTTP route, once by invoking the model directly to capture the raw error):**
```
$ curl -X POST http://localhost:3000/api/returns/<id>/approve -H "Authorization: Bearer <real-shaped admin JWT>"
{"error":"Failed to approve return"}   http_status=500

$ docker exec flash_backend node -e "require('/app/src/models/Return').approveReturn('<id>', 'admin').catch(e => console.log(e.message))"
invalid input syntax for type uuid: "admin"
    at /app/node_modules/pg/lib/client.js:652:17
    at async /app/src/models/Return.js:158:7
```
The admin token used was minted inside the container with the server's own `JWT_SECRET`, using the **exact real payload shape** `adminController.js` itself produces on a successful login — this is not a malformed test token, it is what every real admin session actually looks like. There is no real admin credential configured in this environment (`ADMIN_PASSWORD_HASH` in `.env` is the literal placeholder string, not a real bcrypt hash), so the real `/api/admin/login` path itself could not be exercised — but the token shape it produces is fully documented in `adminController.js` and was reproduced exactly.
**Secondary bug in the same code path:** `returnController.js`'s `approveReturn` catch block (lines 67-74) only recognizes two specific error messages ("Return not found", "Return request is not awaiting approval") — the actual UUID error falls through to a generic `res.status(500)`, and there is **no `console.error` call anywhere in this catch block**, so the real cause is invisible in application logs (only visible via the raw pino HTTP access log, which doesn't include the error message or stack — confirmed by checking `docker logs` output, which showed only the HTTP-level "request errored" line with no application-level detail).

---

**HIGH — Store credit is issued with zero verification, and cannot currently be spent anywhere**
**Category:** A04:2025 Insecure Design — CWE-840 (Business Logic Errors)
**File:** `backend/src/models/Return.js:37-89` (`pickupReturn` — the only writer of `store_credits`)
**Exploitability:** Requires an approved driver account (any approved driver, not necessarily the one who delivered) willing to call the claim endpoint without the item ever changing hands, or a customer who colludes with (or controls) a driver account
**Real-world impact:** Two compounding issues:
1. **No verification before credit issuance.** `pickupReturn` issues real spendable-equivalent credit (`store_credits.balance`) the moment the API call succeeds — no photo, no store-side confirmation the item was received, no delay, no admin review. Traced exhaustively: `approveReturn` (the only admin-gated action) never touches `store_credits` at all (confirmed by grep — the only INSERT into `store_credits` in the entire backend is at `Return.js:65`). A customer who arranges for *any* approved driver (including one who never delivered the original order) to call this endpoint gets full-subtotal credit instantly, with the original merchandise never confirmed returned to anyone.
2. **Credit has no redemption path.** Exhaustive grep of `orderController.js`, `paymentController.js`, `Order.js`, `Payment.js` for `store_credit`/`storeCredit`/`creditBalance`/`applyCredit`: zero matches. Frontend check of `CheckoutScreen.js`, `PaymentScreen.js`, `CartScreen.js` for "credit": zero matches. `StoreCreditsScreen.js` is read-only — it displays a balance with no "Apply to order" action anywhere in its UI. Once issued, credit can be viewed forever but never spent, anywhere, by any current code path.
**Proof (live):** Requested and claimed a real return on a real R250 delivered order (`c94c3c75-858b-4d0b-8ca9-7be03e15afb6`) using two independently-registered test accounts (customer, driver — no prior relationship to the original order beyond the customer being its real owner):
```
{"success":true,"creditIssued":250,"message":"Return picked up. R250.00 instant credit issued to customer."}
```
followed by direct DB confirmation:
```
 amount | balance
--------+--------
 250.00 | 250.00
```
No admin action, no delay, no verification step occurred between request and credit.

---

**MEDIUM — `pickupReturn`'s controller swallows the real error on a lost race, returning a confusing generic 500**
**Category:** Error handling / API contract correctness
**File:** `backend/src/controllers/returnController.js:31-42`
**Real-world impact:** `Return.pickupReturn` throws a specific `"Return not found or already processed"` when a return has already been claimed (by another driver's concurrent request, or a retry) — but the controller's catch block does no `err.message` check at all (unlike `requestReturn`'s and `approveReturn`'s controllers, which both do), so this always surfaces as a generic `{"error":"Failed to process return pickup"}` / `500`, not a clean `409`. A driver whose app shows "failed, try again" for what is actually "someone else already got it" is a confusing but low-severity UX bug, not a security issue.
**Proof (live):** Fired two genuinely concurrent claims for the same return from two different approved drivers:
```
[Driver B] {"success":true,"creditIssued":250,...}   http_status=200
[Driver A] {"error":"Failed to process return pickup"}   http_status=500
```
DB confirms **exactly one** `store_credits` row was created (no double-credit — the H3 race fix genuinely works), but the losing driver's request should have surfaced as `409`, not `500`. Same generic-500 pattern independently confirmed on `requestReturn`'s uncaught `"Not your order"` case (§2.4 below).

---

**MEDIUM — `return_requests.user_id` has no supporting index**
**Category:** Performance / scalability (same class of finding as the original audit's DB-schema section)
**File:** `backend/src/db/migrate.js:216-230` (table definition — only an implicit unique index exists, from `UNIQUE(order_id)`); query at `Return.js:194-199` (`getUserReturns`)
**Real-world impact:** Trivial today (table has single-digit rows in this test environment) but will scale linearly as the table grows, same pattern already flagged for `Driver.getNearby` in the original audit.
**Proof (live, real `EXPLAIN ANALYZE`):**
```
Sort (actual time=3.915..3.922 rows=3 loops=1)
  ->  Nested Loop (actual time=0.112..0.127 rows=3 loops=1)
        ->  Seq Scan on return_requests rr (actual time=0.032..0.036 rows=3 loops=1)
              Filter: (user_id = '2fb69101-...'::uuid)
```
A genuine sequential scan, confirmed live — not a static-analysis inference. By contrast, `pickupReturn`'s SELECT (queried by primary key) correctly used `return_requests_pkey`, and `getCredits` correctly used `idx_store_credits_user` (both confirmed via the same live `EXPLAIN ANALYZE` pass).

---

**MEDIUM — Returned stock is never restored to `flash_inventory`**
**Category:** Data-integrity / inventory-accuracy gap
**File:** `backend/src/models/Return.js` (entire file) — confirmed by grep: zero references to `flash_inventory` or `stock_by_size` anywhere in `Return.js` or `returnController.js`
**Real-world impact:** The original order's `Order.create` decrements `flash_inventory.stock_by_size` at purchase time (per the earlier audit's C-3 work). Nothing in the return flow — request, pickup, or approve — ever adds that stock back. Every processed return permanently understates real physical inventory, compounding over time. Not a security issue; a real operational-accuracy bug the store side will feel directly.

---

**LOW — Requester-side ownership violation returns the wrong HTTP status**
**Category:** Error handling
**File:** `backend/src/controllers/returnController.js:17-27`
**Real-world impact:** `Return.requestReturn` correctly throws `"Not your order"` when a different user's token targets someone else's order (the ownership check itself works — confirmed live, see §2.4), but the controller's catch block doesn't recognize that message either, so it also surfaces as a generic `500` instead of a `403`/`409`. Purely a status-code/logging quality issue; the actual write is correctly blocked at the data layer.

---

**LOW — No return-specific rate limiting**
**Category:** Abuse-resistance completeness (minor)
**File:** `backend/src/routes/returnRoutes.js` (no route-level limiter on any of the four routes)
**Real-world impact:** The general `/api/` limiter (100 requests/15min, confirmed live via response headers — `RateLimit-Policy: 100;w=900`) does apply, so this is not "unlimited," but unlike the cash-OTP flows (which use a dedicated 3/min `otpLimiter`), return creation shares the app-wide budget with every other authenticated call from that IP. Low real risk given the ownership/status checks already gate each request meaningfully, but worth noting as an inconsistency with how other financially-adjacent flows in this codebase are treated.

### 2.4 Security tests — full results

| Test | Method | Result |
|---|---|---|
| **IDOR — request return on someone else's order** | Attacker's real token against victim's real order ID | **Blocked at the data layer** (`"Not your order"` thrown, no row created/modified — confirmed by DB check) but surfaced as `500` instead of `403`/`409` (see LOW finding above) |
| **Driver-claim race (two drivers, same return, concurrent)** | Two genuinely concurrent curl requests | **Correctly serialized** — exactly one credit issued, one driver wins with `200`, the other correctly rejected (though with the wrong status code, see MEDIUM finding above) |
| **`requireApprovedDriver` gate on pickup** | Freshly-registered, never-approved driver account | **Confirmed present and working**: clean `403 "Please upload your required documents."` — this audit-flagged gap from `c7198bc` (2026-07-05) is genuinely fixed |
| **Admin-approval bypass** | Attempted to reach the credit-issuing effect through any non-admin-gated path | **No bypass found** — `approveReturn` itself is correctly gated by `requireRole('admin')`, and it doesn't touch `store_credits` at all (so there is nothing to "bypass" for credit purposes — see HIGH finding above, credit issuance was never gated by approval in the first place) |
| **Cross-method race (`pickupReturn` vs `approveReturn` on the same return)** | Concurrent driver-pickup + admin-approve calls | Could not be cleanly isolated — the admin call fails unconditionally regardless of timing (see CRITICAL finding); the driver call in this specific test run was independently blocked by an unrelated auto-suspension from the stuck-order cron (confirmed genuine: `cancel_count=5` from earlier unrelated test orders, not a returns-system bug) |
| **Return on a never-delivered order** | Real order in `in_transit` status | **Blocked**, clean `400 "Can only return delivered orders"` |
| **SQL injection via `reason`** | `'; DROP TABLE return_requests; --<script>alert(document.cookie)</script>` as the reason text on a valid deliverable order | **Fully parameterized** — payload stored verbatim as inert text, table intact, row count as expected. Confirmed no admin web panel exists anywhere in this codebase to render this field as HTML (grepped for an admin frontend directory — none found), so the stored-XSS half of the payload has no current rendering surface to exploit — a dormant risk only, not live today |
| **Double-request / double-credit via retry** | Re-requested a return on an order that already had one (already picked up and credited) | **Blocked**, clean `409 "Return already requested"` — `UNIQUE(order_id)` constraint + explicit check both hold; confirmed still exactly one `store_credits` row afterward |
| **Rate limiting on return creation** | Live response headers | General `/api/` limiter applies (100/15min); no return-specific stricter limiter exists (see LOW finding above) |

### 2.5 Payments / saved-cards intersection

**Confirmed: zero intersection.** Grepped `Return.js` and `returnController.js` for `paystack`/`Paystack`/`saved_cards`/`payment_methods`/`paymentCrypto`: no matches. The return flow never calls Paystack, never touches the `payment_methods` table, never uses `paymentCrypto.js`. This is a real, useful finding for the upcoming build, not a null result: **there is no existing card-refund infrastructure to build on within the returns code itself.** `backend/src/services/refundService.js` does exist and is used elsewhere (order-cancellation refunds, per the earlier audit) — it is real, reusable infrastructure the returns-refund build could call into, but nothing in the current returns flow calls it today.

### 2.6 Store-side and driver-side experience

**No merchant/seller-facing surface exists at all.** `adminController.js` has no reference to `return_requests` or return `.reason` data anywhere — there is no dashboard view, notification, or any signal a store owner would see indicating an item is being returned to them.

**Driver-app UI: none.** Targeted grep for return-feature code (`requestReturn`, `returnRequest`, `pickupReturn`, `StoreCredit`, `/returns`) across the entire `flash-driver-app` codebase: **zero files matched.** `POST /:returnId/pickup` is a fully-implemented, working backend endpoint with **no corresponding screen, no way to discover pending returns, and no listing endpoint at all** — `returnRoutes.js` has no `GET` route that lists pending `return_requests` for a driver to browse. A real driver using the real app has no way to ever encounter this endpoint; it is only reachable by a direct API call.

**User-app UI: 3 files, functional for the request step, then a dead end.** `OrderStatusScreen.js` (request-return button, calls `requestReturn`), `ProfileScreen.js` (nav entry to Store Credits), `StoreCreditsScreen.js` (read-only balance viewer). The request step works end-to-end. Nothing past it does, because there's no driver UI to fulfill the claim.

### 2.7 Adversarial pass — see §2.4 (integrated above rather than repeated)

### 2.8 App Store / Play Store return-policy requirements

- **No dedicated in-app return-policy disclosure screen exists.** The only return-policy text anywhere in-app is inside the hardcoded `TermsAndConditionsScreen.js` (§4's terms text, item 4: "Return requests must be submitted within 24 hours of delivery. Items must be unused and in original packaging") — shown once, during forced onboarding, not re-accessible from Settings (see §5 below), and not shown at the point of purchase (Checkout/Cart screens have no return-policy text or link).
- **That disclosed policy is not enforced by any code.** Confirmed by reading `Return.requestReturn` in full: no timestamp comparison against delivery time anywhere, no "unused"/"original packaging" verification step of any kind (would require photo/inspection infrastructure that doesn't exist). A customer can request a return literally any time after delivery, indefinitely, as long as `order.status` is still `delivered`/`completed` (which never reverts on its own).
- **IAP vs. Paystack: confirmed correct.** Neither app's `package.json` lists `expo-in-app-purchases`/`react-native-iap` or any IAP dependency. All payment (existing order flow, and by extension whatever the returns-refund build adds) goes through Paystack as an external payment processor for physical goods — the correct, non-rejection-risk model for both stores.

---

## 3. Saved cards — functional verdict: **fully functional, well-built**

Traced the complete round trip:

1. **No raw card capture ever happens.** `SavedCardsScreen.js`'s "Add New Card" flow is purely informational — there is no PAN/CVV input field anywhere in this screen or file. Cards are saved automatically by the backend the first time a customer completes a real Paystack card payment.
2. **The real save trigger:** `webhookController.js:107-124`, inside the Paystack `charge.success` webhook handler. Only fires `Payment.saveCard()` when Paystack's own response marks the authorization `reusable: true` **and** `metadata.userId` is present — genuine server-to-server data, never client-supplied.
3. **What's actually stored** (`Payment.js:114-134`, `payment_methods` table): `authorization_code` **encrypted at rest** via `paymentCrypto.js`'s `encrypt()` (confirmed by reading the call site directly — not assumed), plus a separate HMAC-SHA256 fingerprint (`authCodeFingerprint`) used for uniqueness/dedup so the encrypted value never needs decrypting just to check for a duplicate. Alongside: `last4`, `brand`, `exp_month`, `exp_year` — all non-sensitive metadata. **No raw PAN or CVV is ever transmitted to or stored by Flash's backend at any point** — confirmed by reading every line of the save path; the only card data that ever reaches Flash's server is what Paystack's webhook payload contains (`data.authorization`), which per Paystack's own API never includes the full PAN or CVV.
4. **Reading cards back** (`getSavedCards`, `Payment.js:29-39`): explicitly excludes `authorization_code` from the SELECT — the encrypted token is **never sent to the client, even in encrypted form.**
5. **Deletion is real, not cosmetic** (`removeCard`, `Payment.js:136-155`): ownership-checked (`WHERE id=$1 AND user_id=$2`) then a genuine `DELETE FROM payment_methods` — the row is gone. Since the encrypted authorization code is never cached or held anywhere else in Flash's system, this is a complete, effective invalidation from Flash's side.
6. **IDOR — confirmed clean everywhere:** `getSavedCards`/`removeCard`/`setDefaultCard`/`chargeSavedCard` all use `req.userId` (server-derived from the JWT, never client-supplied) for every ownership check, at the SQL WHERE-clause level, not just app logic. `chargeSavedCard` additionally re-verifies order ownership (`WHERE id=$1 AND user_id=$2`) before charging. Traced the full `chargeSavedCard` function line by line: the decrypted `authorization_code` is used exactly once, passed directly to `paystackService.chargeAuthorization()` (an outbound server-to-server call) — it is never included in any `res.json()` response body anywhere in the function.

No bugs, no gaps found in this feature. This is the strongest-built surface encountered in this session's investigation.

---

## 4. Saved addresses — functional verdict: **frontend fully built, zero backend, confirmed still broken**

- **`AddressScreen.js` is a complete, polished CRUD UI** — list, add, edit, delete, set-default, with a `Home`/`Work`/`Other` label picker (`LABEL_OPTIONS`) and full address fields (street, apartment, suburb, city, gate code, landmark) — genuinely built to the exact "Takealot-style address book" shape the build prompt describes wanting.
- **No backend concept of multiple addresses exists at all.** Grepped `db/migrate.js` for any address-related table: none. Grepped `userRoutes.js` for any address route: none.
- **Confirmed live, not just by reading code:**
  ```
  $ curl -H "Authorization: Bearer <real token>" http://localhost:3000/api/users/addresses
  {"error":"Not found","message":"Cannot GET /api/users/addresses"}   http_status=404
  ```
  Every action on this screen (`api.user.getAddresses/addAddress/updateAddress/deleteAddress`, all targeting `/users/addresses...`) 404s. This is the exact gap the earlier full-app audit's H-10 finding described — **confirmed still true**, unchanged.
- **Checkout uses exactly one ad-hoc address, unconnected to the address-book screen.** `CheckoutScreen.js` has a single plain `TextInput` bound to `profile.address` (one field on the user's profile, not a list) with no picker, no "select from saved addresses" UI, and no call to `api.user.getAddresses()` anywhere in the file. `AddressScreen.js` and `CheckoutScreen.js` are two entirely disconnected pieces of code.
- **Smallest real gap, as a factual note (not a fix proposal):** a real `addresses` table (columns matching `AddressScreen.js`'s existing `EMPTY_FORM` shape exactly: `label`, `street`, `apartment`, `suburb`, `city`, `gate_code`, `landmark`, `is_default`) plus four CRUD routes (`GET/POST/PATCH/DELETE /users/addresses`) would make the *already-built* frontend fully functional with no UI changes required. Wiring a picker into `CheckoutScreen.js` is a separate, second piece of work.

---

## 5. Legal/compliance cross-check

Live site fetched directly: `https://flash-website.netlify.app/privacy` and `/terms`, both dated "Last Updated: 1 June 2025," canonical domain `www.flashdelivery.co.za`.

| Claim (source) | Actual app/backend behavior | Verdict |
|---|---|---|
| "We do not store card numbers" / "we do not store full card details" (Privacy) | Confirmed — only Paystack's `authorization_code` (encrypted), `last4`, `brand`, expiry ever stored. No PAN/CVV anywhere. | **Match** |
| "We share your delivery address and first name with the driver assigned to your order" (Privacy) | `Order.getByIdWithDetails` (the query behind every driver-facing order view) joins `drivers` for driver info but **never joins `users`** — the customer's name is not present anywhere in the returned object. `dropoff_address` **is** present and correctly shared. Driver-app dashboard screens display no customer name anywhere (grepped `dashboard.js`). | **Partial mismatch** — address confirmed shared; no code path was found that shares the customer's name with the driver |
| "You may request deletion of your account... by emailing privacy@flashdelivery.co.za" (Privacy, this session's build-prompt framing) vs. live Privacy Policy's actual current text: "response within 30 days, subject to legal retention requirements" vs. live Terms' text: "close your account... by contacting **hello@flashdelivery.co.za**... outstanding obligations survive" vs. in-app `PrivacyPolicyScreen.js` §6: "we anonymize your personal identifying information... you will no longer be able to log in" | **Three mutually different descriptions of the same process**, across the live Privacy page, the live Terms page (different contact email entirely), and the in-app hardcoded text (a materially different technical description — automatic anonymization vs. an email-initiated process). The earlier audit's separate finding that `user.deleteAccount()` has no backend route is a distinct, already-documented issue not re-litigated here. | **Mismatch (internally, site-vs-site and site-vs-app)** |
| Apple/Google in-app self-service account deletion requirement | Not present on either mobile app in any form (email-only process referenced in text, no in-app deletion flow found in either app's Settings screens) | **Store-compliance gap**, separate from whether the email process itself works |
| "The Flash Platform is not intended for use by persons under the age of 18" (live Privacy) / "You must be 18 years of age or older to create an account" (live Terms) | Grepped both apps' signup/registration screens and the backend's `registerUser`/`registerDriver` validators for any age/birthdate field: zero matches, on either app, anywhere. | **Mismatch** — claimed on the live site (both pages, in different wording), enforced nowhere |
| "Driver location is tracked in real time during active deliveries" (Privacy) | Confirmed elsewhere in this engagement (C-4/H-11 investigation): a driver's background location task starts when they go **online**, not scoped specifically to an active-delivery window — this describes the customer-visible tracking experience accurately, but is a looser technical claim than "only during active deliveries" if read as a statement about when the driver's GPS is sampled at all. Not re-tested live in this session; carried forward from already-verified prior work. | **Likely match for the customer-facing claim, imprecise if read as a technical claim about driver-side collection** — flagging the nuance rather than asserting a clean match |
| Homepage "Coming soon in Gqeberha/Port Elizabeth" vs. backend geofence | Backend's `NMB_BOUNDS` (Nelson Mandela Bay / Gqeberha urban area) has been live and enforced since before this engagement began (confirmed in the earlier full-app audit, unchanged since). | **Confirmed still mismatched** — the app already serves this city; the homepage still says "coming soon" |

---

## 6. In-app Privacy/Terms link inventory

| App | File:Line | Current behavior |
|---|---|---|
| user | `screens/ProfileScreen.js:109` | `navigation.navigate('PrivacyPolicy')` → internal `PrivacyPolicyScreen.js`, a hardcoded 9-section text block embedded in the app binary (not a link to the live site) |
| user | `screens/SettingsScreen.js:136-137` | `Linking.openURL('https://flash.co.za/privacy')` — **external link to `flash.co.za`, which is not Flash's real domain** (the real site is `flashdelivery.co.za` / `flash-website.netlify.app`). Almost certainly wrong/dead. |
| user | `screens/TermsAndConditionsScreen.js` (mounted in `App.js:153`) | Only reachable via the forced onboarding/terms-acceptance gate for a newly-registered or not-yet-accepted user — **no menu entry anywhere** (checked `SettingsScreen.js` and `ProfileScreen.js` in full: neither has a Terms link). Once accepted, a user has no in-app way to view Terms again. Hardcoded 8-section text block, embedded in the app binary. |
| user | `screens/SettingsScreen.js:45,145,153,175` | Same wrong-domain pattern throughout the whole Settings screen: `support@flash.co.za` (line 45, 145), App Store link `https://apps.apple.com/app/flash` (line 153, looks like a placeholder, not a real App Store ID), footer text "flash.co.za" (line 175) |
| driver | `app/driver/settings.js:125-126` | `Linking.openURL('https://flash.co.za/privacy')` — same wrong domain as the user app |
| driver | `app/driver/settings.js:134` | `Linking.openURL('mailto:support@flash.co.za')` — same wrong domain |
| driver | *(none)* | **No Terms & Conditions link, screen, or acceptance mechanism exists anywhere in the driver app** — grepped `app/auth/register.js` and `app/auth/onboarding.js` for any terms-related code: zero matches. A driver can register and start earning without ever being shown or accepting any Terms. |

---

## 7. Not verified in this session, explicitly

- Whether `flash.co.za` (the wrong domain found in both apps' Settings screens) is unregistered, parked, or belongs to a third party — no DNS/WHOIS lookup performed; flagged as "likely wrong," not confirmed to resolve to nothing.
- The exact current technical implementation of driver background-location start/stop timing relative to "active delivery" windows — carried forward from prior verified work in this engagement rather than re-tested live in this session.
- Real Apple/Google Play Store listing text/screenshots (no access to the actual store listings in this environment — only the in-app and live-website surfaces were checked).
- Whether the real `/api/admin/login` endpoint works end-to-end with genuine founder-configured credentials — `ADMIN_PASSWORD_HASH` in this environment's `.env` is a placeholder, not a real hash, so the actual login flow itself could not be exercised; only the token shape it *would* produce (documented directly in `adminController.js`) was reproduced and tested against.
- Whether any web-based admin panel exists **outside this repository** (e.g., a separately-deployed admin frontend not checked into this codebase) that might render the returns `reason` field as HTML, which would activate the currently-dormant stored-XSS risk noted in §2.4.
- Full legal accuracy/adequacy of either the live Privacy Policy or Terms & Conditions as documents — out of scope per the original prompt ("that's outside your competence and outside this task"); only cross-checked specific factual claims against observed app/backend behavior.
