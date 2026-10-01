# Flash — Launch Readiness Audit (October 2026)

**Target assessed:** a real, non-pilot public launch at **1 store / ~20
customers / 5 drivers.**

**Method.** Read-only. No code, config, or production state was changed.
Every claim is either a code citation at `main` = `582465f`, a result from a
live probe run earlier in this engagement, or explicitly marked
**unverifiable from here**. Nothing inferred is presented as confirmed.

**Classification used throughout, never blended:**

| | Meaning |
|---|---|
| **(a) WORKING** | Functional in production today |
| **(b) BLOCKED** | Built, but non-functional — blocker named |
| **(c) NOT BUILT** | Does not exist |

---

## §0 — What already exists (read first, to avoid duplication)

This audit **references** rather than re-litigates the following. Where a
prior finding has since changed, that is called out explicitly.

| Document | Covers | Status for this audit |
|---|---|---|
| `SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` | §2.1–2.14 + 8 pre-launch gates | **Primary prior art.** Gates re-checked in §7 below — **one has changed** |
| `SUBSCRIPTION_LIFECYCLE_AUDIT.md` | Driver/premium subscription lifecycle, deletion interaction | Still accurate, **one point now stale** (see §8) |
| `SECTION_2.8_COMMISSION_DEBT_AUDIT.md` | Cash-commission debt mechanics | Referenced in §2, not re-audited |
| `SECTION_2.8_PAYMENTS_AUDIT.md` / `SECTION_2.9_REFUND_LIFECYCLE_AUDIT.md` | Payments, refunds | Referenced |
| `PAYMENT_MODEL_AND_PORTAL_AUDIT.md` | Target payment model + portal gaps A1–A6, B1–B5 | A1/A2 now shipped (§3); **A3–A6 still open** |
| `OPEN_FOLLOWUPS.md` | 22 numbered deferred items | #21 resolved, #22 added |
| `PRODUCTION_SECRETS_CHECKLIST.md` | Secret-value verification | Still unresolved (§7) |
| `ACCESS_SECURITY_AUDIT.md` | Access control | Referenced; new endpoints assessed §7 |
| `PHASE2_STORE_PAYOUTS_PLAN.md`, `PHASE2A/2B` records | Store payout destination + commission | Current (§3) |
| `CLAUDE.md` | Architecture + commands | **Stale in one respect** (§5) |

**Shipped since the last consolidated report** (PRs #26–#29, 2026-09-30):
store product editing + reactivation, product price integrity + migration
v40, `OPEN_FOLLOWUPS` #22 logged, Add Product field errors. All merged, all
CI-green, v40 applied and verified in production.

---

## §1 — Customer app (`flash-user-app`)

### 1.1 Flow status

| Stage | Status | Evidence |
|---|---|---|
| Signup / login / email verification | **(a) WORKING** | `authRoutes.js`; `sendEmailVerificationEmail` |
| Password reset | **(a) WORKING** | `sendPasswordResetEmail` |
| Browsing / storefront | **(a) WORKING** | `storefrontRoutes.js`, `GET /api/inventory` (60s cache) |
| Cart | **(a) WORKING** | `FlashContext.js`; falls back to demo products if API unreachable |
| Checkout — **cash** | **(a) WORKING** | `POST /api/payments/cash-on-delivery` + OTP |
| Checkout — **card** | **(b) BLOCKED** | See 1.2 |
| Order tracking | **(a) WORKING** | Socket.io `order:<id>` / `user:<id>` rooms |
| Driver calling | **(c) NOT BUILT** (masked) | Gate 3 — dials the real number |
| Post-order / returns | **(a) WORKING** | `returnRoutes.js`, 48h window |

**Multi-store cart:** there is no multi-vendor "malls" concept. `Order.js`
documents pickup as always the one fixed store location, and the
`inventoryStoreIds` set exists to detect when an order spans stores. At 1
store this is not exercised. **Flagged for §9** — behaviour at 2+ stores is
not specified anywhere.

### 1.2 Cards and payment — the full chain

**Can a user add and save a card today? No.** Not a judgement call — a
verifiable chain:

1. **There is no "add card" endpoint.** `paymentRoutes.js` exposes
   `GET /cards`, `DELETE /cards/:cardId`, `PATCH /cards/:cardId/default`,
   `POST /charge-saved-card` — **no `POST /cards`**.
2. **A card is saved only as a by-product of a completed card charge.**
   `Payment.saveCard` has exactly one caller:
   `webhookController.js:129`, after a successful Paystack webhook, as
   `.catch(() => {})` — failures silently swallowed.
3. **The app says so honestly.** `SavedCardsScreen.js`'s "Add New Card"
   button opens an explanation, not a form: *"Cards are saved automatically
   after your first Paystack payment."*
4. **Card payment cannot complete.** `paystackService.js:25` throws when the
   key is absent **or** starts with `sk_test_`. A live probe earlier in this
   engagement confirmed production's key **is** `sk_test_`.
5. **The app hides card entirely anyway.** `PaymentScreen.js:26`:
   `ALL_PAYMENT_METHODS.filter(m => m.id === 'cash')`, under a
   `// TEMPORARY TEST-MODE — remove before real launch` comment (line 11).

**Net: cash is the only payment path that works. No card has ever been
saved, and none can be, until a live key exists.** In Paystack *test* mode
with a `sk_test_` key and `NODE_ENV` not production, the card flow would
exercise end-to-end against Paystack's sandbox; in production it throws
before any network call.

### 1.3 Premium subscription — unreachable, not merely decorative

`SUBSCRIPTION_LIFECYCLE_AUDIT.md` established the R99 premium confers **no
benefit** (no pricing, matching, or fee effect). This audit adds that it is
also **unpurchasable**:

`PremiumScreen.js` requires a selected saved card — the button is
`disabled={purchasing || !selectedCardId}` and calls
`purchasePremiumWithCard(selectedCardId)`. Since no card can be saved (1.2),
`selectedCardId` can never be set. The screen's own prompt, *"Add a saved
card to subscribe"*, links to a screen that cannot add one.

**This supersedes a now-stale point in the prior audit**, which recorded
premium purchase as using Paystack hosted checkout. Both paths exist in the
backend — `Subscription.purchasePremium` (hosted checkout, `Subscription.js:96`)
and `purchasePremiumWithSavedCard` (`:203`) — but **the app only wires the
saved-card one**. Status: **(b) BLOCKED**, doubly.

### 1.4 Customer notifications

**Implemented — push (`notificationService.js`):**

| Notification | Trigger |
|---|---|
| Order status × 10 states | `notifyUserOrderUpdate` — `pending_store_acceptance`, `preparing`, `waiting_for_driver`, `driver_assigned`, `driver_arrived_store`, `picked_up`, `in_transit`, `delivered`, `completed`, `cancelled`, plus a generic fallback |
| New chat message | `notifyNewMessage` |

**Implemented — email (`emailService.js`):** password reset, email
verification. (The other eight senders are admin/store/ops-facing.)

**NOT BUILT — customer-facing:**

- **Any SMS.** Zero integration exists — no Twilio/Clickatell/SMSPortal
  dependency or `sendSms` anywhere. Acknowledged in code:
  `driverController.saveBankAccount` uses password step-up explicitly
  because *"there's no reliable SMS/OTP delivery infrastructure wired up
  yet."*
- Payment-failure notification.
- Refund-issued notification (refund happens; the customer is not told).
- Order-confirmation **email** (push only — nothing survives app uninstall).
- Subscription expiry/renewal notice (see §8).
- Return-window-closing reminder.

---

## §2 — Driver app (`flash-driver-app`)

### 2.1 Flow status

| Stage | Status | Notes |
|---|---|---|
| Signup + document upload | **(a) WORKING** | `requireApprovedDriver` gates on `pending_documents` / `documents_submitted` / `under_review` / `rejected` / `suspended` |
| Admin approval | **(a) WORKING** | AdminJS drivers resource (new/edit enabled) |
| Going online | **(a) WORKING** | `POST /api/drivers/online` — checks commission debt + geofence |
| Seeing / accepting jobs | **(a) WORKING** | `assignDriver` uses `SELECT … FOR UPDATE`, so two drivers cannot take one order |
| Delivery flow + photo proof | **(a) WORKING** | See `HOTFIX_ORDER_PHOTO_BYPASS.md` |
| Earnings / wallet | **(a) WORKING** | `DriverWallet` — pending on assignment, released on completion |
| Bank account registration | **(a) WORKING** (unverified) | 2.3 |
| Bank account **verification** | **(b) BLOCKED** | 2.3 — wrong Paystack endpoint for South Africa |
| Payout | **(b) BLOCKED** | 2.3 |

### 2.2 How drivers earn and are charged

Mechanics are documented in `SECTION_2.8_COMMISSION_DEBT_AUDIT.md` and
`FINANCIAL_DOMAIN_SPECIFICATION.md`; not re-audited. In summary:
`computeCommission` (`helpers.js`) gives Flash `max(R10, 25% of delivery
fee)` and the driver the remainder. On **cash** orders the driver collects at
the door and therefore owes Flash its commission —
`driver_commission_debts`, enforced at go-online. **`OPEN_FOLLOWUPS` #20
remains open and is a 2c blocker:** on a cash order nothing records that the
*store* is owed its item value, which is physically with the driver.

**Subscriptions: (b) BLOCKED / partly (c).** See §8 — there is **no
recurring charge of any kind**, and the gate is enforced only on
`getAvailableOrders`, not on going online.

### 2.3 Can a driver receive a real payout today? No — two blockers

**Built:** `/bank/supported-banks`, `/bank/verify`, `/bank/save`,
`/bank/account`, `/wallet/payout-request`, and `payoutService.js`, which
performs a real `paystackService.initiateTransfer` with a pre-transfer
`getBalance()` check.

**Blocker 1 — the live key.** Every Paystack call throws in production under
`sk_test_`, so `getBalance` and `initiateTransfer` both fail.

**Blocker 2 — and this one survives a live key.**
`driverController.verifyBankAccount` → `paystackService.verifyBankAccount` →
**`/bank/resolve`** (`paystackService.js:384`). A live probe against the real
production Paystack key earlier in this engagement returned:

> `Please supply one of the following valid currencies: NGN, USD, GHS, KES`

`/bank/resolve` **does not support South Africa.** This is the same trap the
store Phase 2a work hit — it was resolved there by shipping *unverified*
registration and shelving `/bank/validate` (ZAR 3/call, requires ID number).
**The driver path was never given the same treatment and still calls the
unsupported endpoint.** This is a **new finding** of this audit.

Mitigating: `saveBankAccount` does **not** depend on verification succeeding
— it requires password step-up only — so drivers can register a payout
destination unverified, exactly as stores now do. Also note
`OPEN_FOLLOWUPS` #17: **driver bank account numbers are stored in
plaintext.**

### 2.4 Driver notifications

**Implemented:** new-order-available push (`notifyDriversNewOrder`); new
chat message (`notifyNewMessage`).

**NOT BUILT:**

- Document approved / rejected (a driver learns by trying to go online).
- Order reassigned away from them (the 10-min cron reassigns and increments
  `cancel_count`, silently).
- Auto-suspension at `cancel_count` = 5 (account stops working, no notice).
- Commission-debt threshold warning before go-online is blocked.
- Subscription expiry warning (§8).
- Payout completed / failed.

---

## §3 — Store portal (`flash-store-portal`)

Verified in depth on 2026-09-30 (PRs #26–#29) — **not re-audited here.**

| Capability | Status |
|---|---|
| Application → approval → owner password set | **(a) WORKING** |
| Login, RBAC (6 roles), staff management | **(a) WORKING** |
| Inventory: add, stock, image, **edit details**, deactivate, **reactivate** | **(a) WORKING** — PR #26 |
| Price integrity (all 4 write paths + v40 constraints) | **(a) WORKING** — PR #27, v40 verified live |
| Add Product field errors | **(a) WORKING** — PR #29 |
| Order accept / reject / mark-ready | **(a) WORKING** |
| Analytics | **(a) WORKING** — uses `SUM(subtotal)` |
| Suspension kill switch | **(a) WORKING** |
| Payout destination registration | **(b) BLOCKED** — `GET /api/store-banking/banks` 502s on the test key; the screen is deliberately hidden (`roleNav.js`) |
| Commission computation | **(a) WORKING** — stamped at completion (v39) |
| **Settlement — actually paying a store** | **(c) NOT BUILT** — Phase 2c, blocked on #20 |

**Not covered by tonight's work — `PAYMENT_MODEL_AND_PORTAL_AUDIT.md` A3–A6,
all still open:** store profile self-edit (A3), commission-rate admin UI
(A4), `store_users` admin surface (A5), bounce alerting (A6).

**Launch consequence:** a store can trade and its earnings are computed and
auditable, but **nothing can pay it.** At 1 store, settling manually is
viable; this does not scale and is correctly tracked as 2c.

---

## §4 — Flash Admin Portal (AdminJS)

**(a) WORKING.** **27 tables** registered (`adminPanel.js`). Deliberately
read-only except **drivers** and **flash_inventory**, the two resources an
admin is genuinely expected to edit.

Capabilities include driver approval/rejection, order inspection, SOS
acknowledgement, chat-report resolution, refund visibility, finance
dashboards, fleet clustering, user lookup, and the email-bounce log.
`adminCoverage.js` is a registry forcing an explicit decision for every
table — including documented **dead** tables (`saved_cards`,
`driver_payouts`, `store_credits`).

**Missing:** `store_users` has **no admin surface** (A5) — an admin cannot
correct an owner's email, re-issue access, or release a squatted address.
Commission rates are read-only by design (A4), so changing one requires SQL.

---

## §5 — Backend architecture

Layout and entry points are documented in `CLAUDE.md`; accurate. Order
lifecycle is owned by `orderStateMachineService.js` (the single source of
truth; `updateOrderStatus` and `assignDriver` both use `SELECT … FOR UPDATE`).

**`CLAUDE.md` is stale on cron jobs:** it documents **7**; `server.js`
registers **16 active** `cron.schedule` calls (17 occurrences, one commented out at `server.js:355`).
Not a defect — a documentation gap worth closing.

### External integrations — actual current status

| Integration | Purpose | Status |
|---|---|---|
| **Paystack** | Payments, payouts, transfers | **(b) BLOCKED** — production key is `sk_test_` (live probe) |
| **Resend** | Transactional email | **(a) WORKING** — API path preferred when `RESEND_API_KEY` is set, SMTP fallback; delivery-event webhook live with real Svix verification |
| **Cloudinary** | Image/document storage | **(a) WORKING** — note: implemented in `services/s3Service.js`, a **misleading filename**; there is no AWS S3 |
| **Sentry** | Crash reporting | **(b) BLOCKED (degraded)** — §7 |
| **PostHog** | Product analytics | **(a) WORKING** in **both** mobile apps (`services/analytics.js`); **not** in the backend |
| **Google Maps** | Geocoding, maps | **(a) WORKING** on Android; iOS pending (§7) |
| **SMS** | — | **(c) NOT BUILT** — no provider at all |
| **Redis** | Socket.io adapter, cache | Optional; `/health` reports `redis: not_configured` |

---

## §6 — Database

Postgres on Supabase. Migration chain is at **v40**, applied to production.
**Verified by Vuyo directly, not by this audit:** both `flash_inventory`
CHECK constraints confirmed present with the expected definitions, and a real
`price = -1` write rejected with `23514 check_violation` leaving the row
untouched. CI additionally executes the full chain including v40 against
`postgres:15` on every run (log line: `Flash database migration v40
completed`), though against an empty `flash_inventory`.

**RLS: nothing in the repository enables it.** `migrate.js` contains **zero**
`ROW LEVEL SECURITY` and **zero** `CREATE POLICY` statements. The prior audit
found RLS disabled on all tables; nothing has changed it since. **I could not
query Supabase to re-confirm the live state** — but no code path would have
turned it on.

**Why this is lower-risk than it sounds, and where it still bites:** all
access is mediated by the backend, which enforces tenant scoping in SQL
(`AND store_id = $n`) and was adversarially tested for it. RLS would be
defence-in-depth against a leaked database credential or a direct-connection
mistake — not the primary control. It matters more as the number of
direct-DB consumers grows (AdminJS already connects directly).

**Integrity gaps beyond those already fixed:**

- `OPEN_FOLLOWUPS` #17 — driver bank account numbers in plaintext.
- #18 — `orders.store_paid` means "customer paid by card", not "store was
  paid"; intended-but-unexercised.
- #19 — `order_cancellation_store_shares` is write-only; nothing pays it.
- #20 — cash orders don't record that the store is owed its item value.
- #22 — `migrate.js` executes every migration merely by being `require`d
  (`migrate.js:1152`, no `require.main` guard), which is also why migrations
  can only be tested by reading their source.

---

## §7 — Security: drift re-check

Referencing `ACCESS_SECURITY_AUDIT.md` and the 8 gates in
`SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` §2 rather than redoing them.
Only time-sensitive items were re-checked.

| Gate | Prior state | Now |
|---|---|---|
| 1. Paystack live key | Broken | **UNCHANGED — still `sk_test_`** |
| 2. GitHub Actions CI billing lock | "Completely non-functional since 2026-06-11" | **✅ RESOLVED.** Six full runs succeeded on 2026-09-30 (`36349384465`, `36770027079`, `36771780618`, `36776133898`, `36777402042`, `36778717634`) — migration + unit + integration + portal + secrets scan |
| 3. Masked calling | Not built | **UNCHANGED — (c)** |
| 4. Google Maps key rotation | Android live, iOS pending, old keys still active | **Unverifiable from here** — needs Google Cloud Console + EAS |
| 5. Crash reporting | Broken both apps | **Refined, still degraded.** User app: `@sentry/react-native` **is** registered (`app.config.js:76`) but `SENTRY_DISABLE_AUTO_UPLOAD: "true"` persists in `eas.json` → **minified stacks**. Driver app: dependency installed and `Sentry.init` **is** called (`app/_layout.js`), but the only `app.config.js` mention is a **comment** — no Expo plugin → JS errors likely arrive, **native crashes and symbolication do not** |
| 6. Dead `pk_test_` publishable key | Present | **UNCHANGED** — `pk_test_9db77a6…` still in **both** `eas.json` files |
| 7. Render health check / auto-migrate | Not applied | **Unverifiable from here** (no `render.yaml`/`Procfile` in repo — dashboard-only) |
| 8. Secret values unconfirmed | Unconfirmed | **UNCHANGED** — `CASH_OTP_SECRET`, `ADMIN_PASSWORD_HASH`, `ADMIN_EMAIL`, `SMTP_*` still unverified |

**`DRIVER_TEST_MODE`:** code reads `process.env.DRIVER_TEST_MODE === "true"`
(`Driver.js:44`) — defaults **false**, grants a real subscription row and
auto-generated documents when true. **Its live value on Render is
unverifiable from here, and it must be confirmed `false` before launch** —
if true, any signup becomes an approved driver with a free subscription.

**New endpoints since the last security pass** — the store portal tree
(`store-onboarding`, `store-auth`, `store-inventory`, `store-orders`,
`store-staff`, `store-banking`, `store-analytics`). All sit behind
`authenticateStore` + `requireOwnStore` + `requireStorePasswordCurrent` +
`requireStoreRole(...)`, answer **404 not 403** cross-tenant, and were
adversarially tested (tenant isolation, field whitelisting, 13 mutations on
the price path). `authenticateStore` re-checks `is_active` and store status
live on every request. **Assessed as covered.**

---

## §8 — Subscriptions and recurring charges

**The direct question: does either app deduct money on a recurring basis
today? No. Nothing recurring exists anywhere in this system.**

Verified, not assumed:

- **Zero cron jobs touch subscriptions.** `grep -c` for
  `driver_subscriptions|premium_subscriptions` in `server.js` → **0**, across
  all 16 active jobs.
- **No auto-renewal flag, no stored mandate, no retry.** Every driver
  renewal is a fresh, fully manual Paystack purchase
  (`Subscription.purchaseDriverPlan` → `initializeGenericCharge`).
- **Expiry is lazy.** `expires_at > NOW()` is evaluated per request; the
  `status` column is never swept. A row reads `'active'` forever after expiry
  and is still correctly treated as expired.

**Is there a mechanism warning 5 days before a charge, on either app? No —
it does not exist at all.** A repository-wide search for any
5-day/renewal-reminder/expiring-soon mechanism returns **zero matches**. This
is **(c) NOT BUILT**, not built-but-broken.

**The honest framing:** because nothing auto-charges, there is **no risk of a
surprise deduction** — which is the more serious failure mode, and it is
absent. What *is* missing is the opposite: **no warning that access is about
to stop.** A driver's subscription lapses silently and they simply stop
seeing new orders mid-shift, with no notice before or at the moment it
happens. Per `SUBSCRIPTION_LIFECYCLE_AUDIT.md` there is also no grace period
and the gate is enforced only on `getAvailableOrders`, **not** on going
online — so a driver can go online, appear available, and receive nothing.

**Premium (customer):** **(b) BLOCKED** and confers no benefit — see §1.3.

**If recurring billing is ever introduced, a pre-charge warning becomes
mandatory, not optional** — South African consumer-protection expectations
and card-scheme rules both point that way. Flagged in §9; it is a legal
question, not a technical one.

---

## §9 — Open questions for Vuyo (not guessed at)

1. **Masked calling** — build a proxy (real dependency, real cost) or launch
   with real numbers exchanged and accept that as the model? *(Gate 3, open
   since the last audit.)*
2. **Driver bank verification in South Africa** — adopt `/bank/validate`
   (ZAR 3/call, needs ID number) for drivers as was approved for stores, or
   ship unverified registration for drivers too? **Today it calls an endpoint
   that cannot work for ZAR.**
3. **Premium subscription** — is the R99 tier launching at all? It currently
   confers nothing and cannot be purchased. Give it a real perk, remove it
   from the UI, or leave it visibly disabled?
4. **Driver subscription enforcement** — should an expired subscription also
   block *going online*, not just new-order visibility? And should there be a
   grace period?
5. **Expiry warning** — do you want a pre-expiry notice for drivers (the
   "5 days" mechanism does not exist)? If recurring billing is ever added,
   this stops being optional.
6. **Store settlement at 1 store** — settle manually for launch, or block
   launch on Phase 2c? #20 must be answered either way.
7. **Multi-store behaviour is unspecified.** No document defines what happens
   when a cart spans two stores — one order or several, one delivery fee or
   several, how commission splits. Not urgent at 1 store; it is the first
   thing to break at 2.
8. **Customer order-confirmation email** — push-only today, so an uninstall
   loses all order history. Add email?
9. **Refund notification** — a refund is issued and the customer is never
   told. Intended?
10. **`store_boosts` / promotions** — still unresolved from earlier sessions.

---

## §10 — Punch list for 1 store / 20 customers / 5 drivers

### Genuinely blocking a real public launch

| # | Item | Why it blocks | Owner |
|---|---|---|---|
| **B1** | **Live Paystack key** (`sk_live_…`) on Render | The single highest-impact item. Blocks: card checkout, saved cards, premium, driver payouts, store payout registration. Everything money-related except cash | Founder |
| **B2** | **Confirm `DRIVER_TEST_MODE=false`** in production | If true, any signup becomes an approved driver with a free subscription | Founder (dashboard) |
| **B3** | **Confirm the *values* of 4 secrets** (`CASH_OTP_SECRET`, `ADMIN_PASSWORD_HASH`, `ADMIN_EMAIL`, `SMTP_*`) | Precisely: `cashOtpService.otpSecret()` **throws** in production when `CASH_OTP_SECRET` is unset, so it is certainly *set* — cash OTP works. What is unverifiable is whether it is a **strong random value** or a weak/placeholder one (the dev fallback is the hardcoded string `flash-cash-otp-dev-only-fallback`). A guessable secret forges cash-delivery OTPs on the **only** working payment path | Founder (dashboard) |
| **B4** | **Decide masked calling** (gate 3) | Customers and drivers exchange real phone numbers today. A launch decision, not a bug | Founder |
| **B5** | **Driver payout path must actually work** | Drivers cannot be paid. Needs B1 **and** the `/bank/resolve` → ZAR decision (§9.2) | Founder + eng |
| **B6** | **Store settlement decision** (#20) | The store cannot be paid. Manual at 1 store is acceptable *if explicitly chosen* | Founder |
| **B7** | **Mobile crash reporting is absent, not merely degraded** — `SENTRY_AUTH_TOKEN` + remove `SENTRY_DISABLE_AUTO_UPLOAD`; register the Sentry Expo plugin in the driver app | **Upgraded in severity (§11).** The apps' Sentry project shows **zero issues in 90 days** — two apps in real use producing no events at all is not plausible, so this is very likely total absence rather than unreadable stacks. Launching blind to mobile crashes | Founder + eng |
| **B8** | **Rotate out the leaked Google Maps keys**; finish iOS builds | Known exposure left deliberately open | Founder |

### Strongly recommended before launch (not strictly blocking)

| # | Item |
|---|---|
| R1 | Driver expiry/lapse notice — a driver going silently dark mid-shift is a support incident at 5 drivers (§8) |
| R2 | Enforce the subscription check on **go-online**, not just order visibility |
| R3 | Notify drivers on document approval/rejection, reassignment, and auto-suspension |
| R4 | Customer order-confirmation **email** |
| R5 | Replace the dead `pk_test_` key in both `eas.json` files (gate 6) |
| R6 | Wire Render's health check to `/health` (gate 7) |
| R7 | `migrate.js` `require.main` guard (#22) — makes every future migration testable |
| R8 | Refund-issued notification to the customer |
| R9 | Close the `CLAUDE.md` cron-count drift (7 documented vs 16 real) |
| R10 | **Validate `price`/`cost_price` in AdminJS's `before` hooks** (§11) — the last uncovered write path. v40 guards the range but not the *type*; a non-numeric value still raises `22P02`. Reuse `validateProductPrice` beside `nullifyEmptyNonTextFields` |
| R11 | **Investigate the recurring backend CORS rejection** in Sentry (§11) — 1 of 5 unresolved issues; a persistent CORS failure usually means a real client is being refused |

### Deliberately deferred — do not do before launch

A3–A6 (store profile self-edit, commission-rate UI, `store_users` admin
surface, bounce alerting); RLS (defence-in-depth, not the primary control);
multi-store cart semantics (§9.7); the card-only checkout rewrite and the
bundled `computeCancellationSplit` fix (both correctly blocked on B1);
premium perks; `store_boosts`; horizontal scaling and staging (#7, #8) —
genuine spend, correctly deferred until scale demands them.

### Built for scale already — no rework needed at 10 stores

Worth stating, since the brief asked not to build anything needing redoing:
multi-tenancy is real (`store_id` scoping in SQL, 404-not-403, per-store RBAC);
commission uses a precedence-ordered rate table so a per-store override is an
`INSERT`, not a code change; the order state machine is centralised with row
locking; payouts are staged through a wallet rather than paid inline. **None
of the launch blockers above require architectural change — they are
credentials, decisions, and notifications.**

---

## §11 — Verification status

### Closed since this audit was first written

Verified by Vuyo with direct Render / Supabase / Sentry access on
2026-10-01. Recorded here as confirmed fact, attributed — not as this
audit's own finding.

| Previously unknown | Now confirmed |
|---|---|
| Supabase RLS live state | **RLS is disabled on all 66 tables.** Matches the repo (zero `ROW LEVEL SECURITY` / `CREATE POLICY` statements) — now confirmed live, not inferred |
| Render build / start commands | **`npm install` / `node server.js`, with no `migrate.js` reference anywhere.** Migrations are therefore entirely manual, confirming #16's premise — and **unblocking #22's `require.main` guard**, since no deploy path imports that module |
| Render health check | **No health-check path is configured on the service.** Gate 7 confirmed outstanding: a bad deploy cannot be caught before it takes traffic |
| Is Sentry receiving events? | **Backend: yes** — 5 unresolved issues, including a **recurring CORS rejection** worth its own investigation. **Mobile: no** — the apps' Sentry project has **zero issues in 90 days**, which corroborates gate 5 from the other direction: crash reporting is very likely not working on either app |

**The mobile Sentry silence is the significant one.** §7 reasoned from
configuration that the user app would produce unreadable (minified) stacks
and the driver app would miss native crashes. Zero issues in 90 days across
both is stronger evidence than the config analysis: it suggests **nothing is
arriving at all**, not merely arriving degraded. Two apps in real use for
90 days producing zero events is not plausible as a true absence of errors.
**Gate B7 should be treated as "crash reporting is absent," not "degraded."**

### Still unverified

- **Live values of every Render environment variable** — including whether
  the Paystack key has since been replaced, and `DRIVER_TEST_MODE`'s actual
  value. The `sk_test_` finding comes from a live API probe earlier in this
  engagement, not from reading the dashboard. **B2 and B3 remain open.**
- **Google Maps key status** in Google Cloud Console; iOS build state.
- **Any production row counts or data distribution.**
- **Nothing in §1–§4 was exercised through a deployed UI** — this audit is
  read-only code analysis plus prior live results, as scoped.

### Correction to this audit: the AdminJS path is only partly covered

§3 and §4 describe `flash_inventory`'s AdminJS write path as "covered by
v40's CHECK constraint." **That is true for the range invariant and false
for the type one**, and the distinction is load-bearing:

- `CHECK (price > 0)` rejects a **valid number** that is non-positive →
  `23514 check_violation`.
- A **non-numeric** value (`'abc'`, or — far more likely in South Africa —
  `'12,50'` with a comma decimal separator) fails during **type coercion**,
  raising `22P02 invalid input syntax for type numeric` **before any CHECK
  constraint is evaluated**. v40 does nothing for this.

`flash_inventory` has exactly two numeric columns, `price DECIMAL(10,2) NOT
NULL` and `cost_price DECIMAL(10,2)`. The three application write paths now
reject non-numeric input via `validateProductPrice` (`Number.isFinite`), so
they cannot produce `22P02`. **AdminJS's generic form still can**, because it
writes columns directly. `nullifyEmptyNonTextFields`
(`adminPanel.js:773`, added 2026-09-22 in `e0d4386`) converts `''` → `NULL`
for non-text fields and closes the empty-string case only — a non-empty,
non-numeric value passes straight through.

**Recommended fix (not built):** add a price/`cost_price` check to the same
`before` hooks that already run `nullifyEmptyNonTextFields` on
`flash_inventory`'s `new` and `edit` (`adminPanel.js:1695-1696`), reusing
`validateProductPrice` / `validateProductCostPrice` from `utils/helpers.js`.
That would make all four write paths consistent and is the only remaining
gap in #21's coverage. Tracked as a follow-up, not folded into any open PR.
