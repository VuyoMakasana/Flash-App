# Flash — Handoff / Continuity Document

**Written 2026-10-01. Repo state at `main` = `a8707c0`.**

**Read this first if you have no memory of prior work on Flash.** It is written
to be self-sufficient: a fresh session (AI or human) should be able to read it
top to bottom and resume without any chat history. Nothing important about
Flash's current state lives only in a conversation.

**Nothing in here is a task to start.** Fixes are greenlit separately by the
founder (Vuyo). This document records state, not a work order.

---

## 0. Orientation — where the authoritative information lives

| Need | Read |
|---|---|
| Architecture, commands, conventions | `CLAUDE.md` (repo root) |
| Full launch-readiness picture | `docs/audits/LAUNCH_READINESS_AUDIT_OCT_2026.md` |
| Numbered deferred items (1–22) | `docs/audits/OPEN_FOLLOWUPS.md` |
| Target payment model + portal gaps A1–A6 / B1–B5 | `docs/audits/PAYMENT_MODEL_AND_PORTAL_AUDIT.md` (PR #25, **still open**) |
| Prior 15-section audit + 8 pre-launch gates | `docs/audits/SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` |
| Subscription lifecycle truth | `docs/audits/SUBSCRIPTION_LIFECYCLE_AUDIT.md` |
| Per-feature records | `PRODUCT_PRICE_INTEGRITY_RECORD.md`, `STORE_PRODUCT_EDIT_AND_REACTIVATE_RECORD.md`, `PHASE2A/2B` records |

**Two known stale points in `CLAUDE.md`**, worth fixing when convenient:

1. It documents **7** cron jobs; `src/server.js` registers **16 active**
   (17 `cron.schedule` calls, one commented out at ~line 355).
2. It describes unit tests auto-mocking `src/config/database` via a
   `moduleNameMapper` → `tests/__mocks__/database.js`. **Neither exists.**
   Tests use explicit `jest.mock(...)` calls. `jest.config.js` also explicitly
   **excludes** `src/db/migrate.js` from coverage — worth revisiting now that
   the module is importable (see PR #31).

---

## 1. What is live and merged

Migration chain is at **v40**, applied and verified in production. Backend unit
tests: **623 passing, 43 suites.** Store portal: **55 passing, 6 files.**

> ⚠️ **Numbering collision — read this before interpreting any "#N".**
> GitHub PR numbers and `OPEN_FOLLOWUPS.md` item numbers are separate sequences
> that overlap. They are **not** the same thing:
>
> | Ambiguous | PR means | Follow-up means |
> |---|---|---|
> | **#21** | store analytics revenue fix | **product price integrity** (closed by PR #27) |
> | **#22** | Phase 2 payout plan | **`migrate.js` runs on require** (closed by PR #31) |
> | **#16** | squatted-email proposal (open) | Render auto-deploys ahead of migrations |
> | **#20** | bounce-visibility verification | **cash orders: store's item value unrecorded** (open, blocks Phase 2c) |
>
> This document writes "PR #N" or "`OPEN_FOLLOWUPS` #N" explicitly wherever the
> two could be confused. Older documents are not always so careful.

| PR | Merge | What it actually did |
|---|---|---|
| #12 | `bb011c8` | Self-service store onboarding with admin approval (migration v36) |
| #13 | `a5e340d` | Fixed `@adminjs/sql` cross-schema table lookup — Supabase's `auth`/`realtime` schemas collided with `public`, causing pg `21000` errors |
| #14 | `695b70c` | Store-owner signup + first-password pages in the portal |
| #15 | `aaf2516` | CI job for the store portal's tests and build |
| #17 | `6ad0816` | Store suspension kill switch, re-checked per request in `authenticateStore` (403 `STORE_SUSPENDED`) |
| #18 | `7a0be1e` | Logged follow-ups 13–16 |
| #19 | `083ebf1` | Email bounce visibility via a real Svix-verified Resend webhook (migration v37) |
| #20 | `429ea74` | Recorded live verification of bounce visibility |
| #21 | `983dcd4` | **Bug fix:** store analytics reported the delivery fee as store revenue (`SUM(total)` → `SUM(subtotal)`) |
| #22 | `86b02b1` | Phase 2 payout plan, two audit corrections, follow-ups 17–19 |
| #23 | `d60d268` | Phase 2a store payout destination — **unverified** bank registration, no account number stored (migration v38) |
| #24 | `70ec930` | Phase 2b — compute and stamp store commission at completion (migration v39) |
| #26 | `21c1fca` | Product editing + reactivation (audit A1/A2): `PATCH /api/store-inventory/:id`, product and staff reactivate, portal UI |
| #27 | `3485280` | Product price integrity across all four write paths + **migration v40** (`CHECK (price > 0)`, `CHECK (cost_price IS NULL OR cost_price >= 0)`) |
| #28 | `8c609fd` | Logged `OPEN_FOLLOWUPS` #22 |
| #29 | `582465f` | Portal: Add Product form now surfaces backend field errors |
| #30 | `d7e14b0` | **Launch-readiness audit** (604 lines) — the primary reference |
| #31 | `b044466` | `require.main === module` guard on `migrate.js` (#22). Makes migrations importable and therefore behaviourally testable |
| #32 | `a8707c0` | AdminJS inventory form now validates `price`/`cost_price` (R10) — the fourth write path |

### Still open, not merged

- **PR #16** — proposal for releasing a squatted store-owner email. Needs a
  founder decision, not code review.
- **PR #25** — the payment-model and portal audit (A1–A6, B1–B5). **A1, A2 are
  now shipped (#26); A3–A6 remain open.** The document is still the reference
  for the target payment model, so it matters even though unmerged.

---

## 2. 🔴 The one unfixed bug that blocks launch

**A cash order with no available driver hangs silently forever.**
**Not yet fixed. Found 2026-10-01, after the audit in PR #30 was written.**

### Mechanism

1. A cron (`src/server.js`, the `*/15 * * * *` job at ~line 652) auto-cancels
   and refunds orders stuck in `waiting_for_driver` for >30 minutes. Its
   predicate includes **`AND o.payment_status = 'paid'`**.
2. `Payment.cashOnDelivery` (`src/models/Payment.js`, ~line 18) sets
   **`payment_status = 'pending_cash'`** — never `'paid'`.
3. Therefore **cash orders can never match that cron.** Confirmed: `grep -c
   pending_cash src/server.js` → **0**. No cron anywhere references it.

### Why it matters specifically at 1 store / 5 drivers

- **Cash is the only working payment path** (card is blocked — see §3), so this
  is the default case, not an edge case.
- With only 5 drivers, "all busy or offline" is an ordinary Tuesday.
- The customer's app shows *"Your order is ready — looking for a nearby
  driver."* **indefinitely.** No timeout, no cancellation, no notification.
- **No admin alert either.** The escalation crons cover
  `pending_store_acceptance` and `preparing` only — not `waiting_for_driver`.
- **Stock is never returned.** `Order.restockItems` is correct and runs on *any*
  transition to `cancelled` — but a hung order never reaches `cancelled`. At one
  store, a few abandoned orders make items read as out of stock when they are
  not.

### Evidence it is an oversight, not a design choice

The sibling store-acceptance timeout cron (~line 751) queries
`status = 'pending_store_acceptance'` with **no payment filter**, so it handles
cash correctly — and its own comment claims parity with *"an unmatched
`waiting_for_driver` order ... above"*, parity that does not exist for cash.

### Shape of the fix (not built, not approved)

Drop the `payment_status = 'paid'` filter and branch the refund instead: a cash
order has taken no money, so it needs cancellation + restock + customer
notification but **no refund call**. Must also decide whether to notify an admin
rather than cancel silently. **Founder decision on the customer-facing message
is required** — "no driver was available" is a different promise from "cancelled".

---

## 3. Launch readiness — everything outstanding

### Priority order (my recommendation)

1. **The cash-order hang** (§2). The only new code blocker; breaks the default
   path at exactly this driver count.
2. **Three dashboard/credential items, all founder-only:**
   - `DRIVER_TEST_MODE` → `false`
   - `CASH_OTP_SECRET` → confirm strong
   - `PAYSTACK_SECRET_KEY` → a real `sk_live_` key
3. **IP-keyed rate limiters** — specifically `otpLimiter`, which sits on the
   only working checkout path.

### 3.1 `DRIVER_TEST_MODE` — still `true` in production

**Not independently verifiable by an AI session: Render's API exposes only a
*write* for environment variables, no read.** That asymmetry is almost
certainly deliberate — a read endpoint would make any integration token a
secrets-exfiltration route. **This is a manual dashboard check, permanently.**

While `true`, `Driver.create()` (`src/models/Driver.js`, ~line 44) gives a
brand-new signup **auto-generated document rows** *and* a real
`driver_subscriptions` row. **At a public launch, every signup becomes an
approved, subscribed driver with zero review.**

**What changes when it is `false`:** a driver starts at `pending_documents`,
must upload real documents, moves through `documents_submitted` →
`under_review`, and **an admin must approve them** in AdminJS. They must also
purchase a plan before `getAvailableOrders` returns anything.
**Sequence this before launch day, not on it** — five drivers each need upload +
approval + purchase.

### 3.2 Live Paystack key — still `sk_test_`

`paystackService.request()` (~line 25) throws in production when the key is
absent **or** starts with `sk_test_`. Last confirmed `sk_test_` by a live API
probe. **Nothing money-related can go live until a real key exists.** Blocked
by it:

- Card checkout (the user app additionally filters card out client-side —
  `PaymentScreen.js` ~line 26, under a `// TEMPORARY TEST-MODE` comment)
- Saved cards (a card can only be saved as a by-product of a completed card
  charge — `Payment.saveCard`'s sole caller is `webhookController.js` ~line 129)
- Premium subscriptions (**doubly blocked** — `PremiumScreen` requires a saved
  card that can never exist)
- Driver payouts and store payout-destination registration

### 3.3 The four unread Render secrets (B3)

Cannot be read programmatically. **All require a dashboard check:**

| Variable | Risk if wrong |
|---|---|
| `CASH_OTP_SECRET` | **Highest.** It is certainly *set* (production throws without it), so the risk is a **weak value** — the dev fallback is the literal string `flash-cash-otp-dev-only-fallback`. A guessable secret forges cash-delivery OTPs on the **only working payment path.** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` | Admin panel access |
| `SMTP_HOST` / `PORT` / `USER` / `PASS` | Email fallback (Resend API is the preferred path) |

Also worth confirming while in there: `JWT_SECRET` and
`PAYMENT_METHOD_ENCRYPTION_KEY` are real and **distinct from each other** (by
design, so rotating one does not break the other).

### 3.4 Rate limiters key on IP, not user

Only the admin/store **email** limiters use a `keyGenerator`
(`src/middleware/rateLimiter.js`). Every operational limiter uses
express-rate-limit's default, which is per-IP. South African mobile carriers use
CGNAT heavily, so **multiple users or drivers can share one public IP:**

| Limiter | Limit | Risk at this scale |
|---|---|---|
| `otpLimiter` | **3 / 60s** | **Worst.** On the cash OTP path — the only working checkout. Two customers behind one NAT can block each other. |
| `locationLimiter` | 60 / 60s | Drivers ping continuously; 3+ drivers on one carrier NAT could lose location updates |
| `orderLimiter` | 5 / 60s | Shared across everyone on that IP |

Not certain to bite at 20 users, but plausible, and the OTP one fails on the
critical path. The fix is a `keyGenerator` keyed on the authenticated user id
with an IP fallback for unauthenticated routes.

### 3.5 No 5-day pre-charge subscription warning

**Does not exist at all** — repo-wide search returns zero matches. But the
honest framing matters:

**Nothing auto-charges anywhere.** Zero crons touch `driver_subscriptions` or
`premium_subscriptions`; there is no stored mandate, no auto-renewal flag, no
retry. Every renewal is a fresh manual Paystack purchase. **So there is no
surprise-deduction risk** — the more serious failure mode is simply absent.

The real gap is the inverse: **no warning before access stops.** A driver's
subscription lapses silently mid-shift and they just stop seeing new orders.
There is also no grace period, and the check is enforced only on
`getAvailableOrders`, **not** on going online — so a driver can go online,
appear available, and receive nothing.

Buildable pre-launch (a cron plus one push). A pre-*charge* warning is
meaningless until recurring billing exists — and if recurring billing is ever
added, a pre-charge warning becomes **mandatory**, not optional.

### 3.6 RLS disabled on all 66 Supabase tables

Confirmed live by the founder. Also confirmed in-repo: `migrate.js` contains
**zero** `ROW LEVEL SECURITY` and **zero** `CREATE POLICY` statements, so
nothing would have enabled it.

**Recommendation: acceptable at this scale. Do not block launch on it.** All
access is mediated by the backend, which enforces tenant scoping in SQL
(`AND store_id = $n`) and was adversarially tested. RLS is defence-in-depth
against a **leaked database credential**, not the primary control, and going
public does not change that exposure — customers never touch Postgres directly.
The realistic attack path is credential leakage (AdminJS connects directly, and
`DATABASE_URL` lives in Render env). **Revisit when a second direct-DB consumer
is added.**

### 3.7 R11 — not built

The CORS-rejection Sentry severity downgrade. **Investigated and closed as
not-a-defect:** Sentry issue NODE-D showed origin `https://evil.example.com`
via `curl`, 74 occurrences in tight bursts — security testing, and the CORS
middleware working correctly.

It is **noise reduction, not a fix**: 74 benign events in a 5-issue list is most
of the list, and an error channel that is mostly noise is one a real issue hides
in. The extension point already exists — `beforeSend` in `src/server.js` (~line
28), which currently only scrubs `authorization`/`cookie`. CORS rejections reach
Sentry via `Sentry.captureException` in `src/middleware/errorHandler.js`.
**Deciding where to filter (source vs `beforeSend`) is the open question.**

### 3.8 R10 — one unverified gap

PR #32 closed the AdminJS write path, but **nobody has tested it through a real
authenticated AdminJS submission.** The remaining uncertainty is narrow and
specific: `AdminValidationError = AdminJSModule.ValidationError` is captured at
mount and asserted only by **source text**, because `buildResources()` needs a
live `DATABASE_URL`. If AdminJS ever moves that export, the hook falls back to a
shaped error — still correct behaviour, but AdminJS may not render it against
the field.

**To verify:** log into the AdminJS panel, edit a `flash_inventory` product, and
type `12,50` into the price field. Expect a field-level validation message, not
a 500. An AI session cannot do this (no admin credentials, and it should not
guess them).

### 3.9 Carried forward from the earlier audit, still open

From `SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` §2. **Gate 2 (GitHub Actions
billing lock) is RESOLVED** — CI has run reliably since 2026-09-30. Still open:

- **Masked calling is not built.** `TrackingScreen.js` dials the driver's real
  number. Needs a founder decision: build a proxy, or launch with real numbers
  exchanged.
- **Mobile crash reporting is absent, not merely degraded.** The apps' Sentry
  project shows **zero issues in 90 days** — two apps in real use producing no
  events is not plausible. User app: plugin registered but
  `SENTRY_DISABLE_AUTO_UPLOAD: "true"` persists in `eas.json` (minified
  stacks). Driver app: dependency installed and `Sentry.init` called in
  `app/_layout.js`, but **no Expo plugin registration** — only a comment in
  `app.config.js` — so native crashes and symbolication are unconfigured.
  Backend Sentry *is* working (5 unresolved issues).
- **Google Maps key rotation incomplete.** New Android keys live; **iOS builds
  pending**, and the two previously-leaked keys are **still active** in Google
  Cloud Console.
- **Dead `pk_test_` publishable key** still in both apps' `eas.json`
  (`pk_test_9db77a6ebc076fa07d4b3b434bb403ad0851aea9`). No functional risk —
  unreferenced in source — but replace it with the live key.
- **No Render health-check path configured** (confirmed). A bad deploy cannot be
  caught before it takes traffic.
- **No SMS provider exists at all.** Acknowledged in code as the reason driver
  payout changes use password step-up rather than OTP.

---

## 4. Open founder decisions — waiting on Vuyo

None of these should be decided by an AI session.

1. **Premium subscriptions — launching or not?** The R99 tier confers **no
   benefit** (no pricing, matching, or fee effect — verified) *and* is
   **unpurchasable** (needs a saved card that cannot exist). Give it a real
   perk, remove it from the UI, or ship it visibly disabled.
2. **ZAR bank verification approach.** `/bank/resolve` — which the driver path
   still calls (`paystackService.js` ~line 384) — supports **NGN/USD/GHS/KES
   only, not ZAR**, proven by live probe. It would fail for every South African
   account *even with a live key*. Stores were resolved by shipping unverified
   registration and shelving `/bank/validate` (ZAR 3/call, needs an ID number).
   **Drivers never got the same treatment.** Adopt `/bank/validate` for drivers,
   or ship unverified for them too?
3. **Masked calling** — build a calling proxy (real dependency, real cost) or
   launch with real numbers exchanged and accept that as the model?
4. **Store settlement at 1 store** — settle manually for launch, or block on
   Phase 2c? `OPEN_FOLLOWUPS` #20 must be answered either way.
5. **Admin sub-roles.** Admin access is currently all-or-nothing; there is no
   sub-role model. `store_users` also has **no admin surface** (A5), so an admin
   cannot correct an owner's email or release a squatted address — which is what
   **PR #16** proposes.
6. **Driver subscription enforcement** — should an expired subscription also
   block *going online*, not just new-order visibility? And should there be a
   grace period?
7. **Pre-expiry driver warning** — build it? (§3.5)
8. **The cash-order-hang customer message** (§2) — "no driver available" vs
   "cancelled" is a promise, not a string.
9. **Multi-store cart semantics are specified nowhere.** No document defines
   what happens when a cart spans two stores — one order or several, one
   delivery fee or several, how commission splits. Irrelevant at 1 store; the
   first thing to break at 2.
10. **Customer order-confirmation email** — push-only today, so an uninstall
    loses all order history. Add email?
11. **Refund notification** — a refund is issued and the customer is never told.
12. **`store_boosts` / promotions** — unresolved from earlier sessions.
13. **Commission rate changes require SQL** (A4) — `commission_rates` is
    read-only in AdminJS by design (a rate change is a new row, never an edit).
    Build an "add rate" admin action?

---

## 5. Deliberately paused, and why

**Do not start these. Both are blocked on the same thing.**

| Paused | Blocked on | Note |
|---|---|---|
| **Card-only checkout rewrite** | A live Paystack key | The confirmed target model is: item price **always** card, delivery fee the customer's choice (online or cash), stores receive **only** item earnings — never delivery money, never anything a driver collected. Writing it now risks it sitting correct-but-unusable, which the payout-destination and driver-banking work already hit twice. |
| **`computeCancellationSplit` fix** | Bundled with the above | Its `isCash` branch assumes no item money was collected. **Not wrong under today's model, only under the target one.** Must ship *with* the rewrite, not before. |
| **Phase 2c store settlement** | A live Paystack key **and** `OPEN_FOLLOWUPS` #20 | #20: on a cash order nothing records that the **store** is owed its item value, which is physically with the driver. Every completed order in production history is cash, so a settlement run built on the card assumption would either pay stores money Flash does not hold, or skip every order that exists. |
| **A3–A6** (store profile self-edit, commission-rate UI, `store_users` admin surface, bounce alerting) | Founder prioritisation | Explicitly held behind A1/A2. |

---

## 6. Render free tier — expected behaviour, not a bug

**The `Flash-App` backend service is on Render's free tier.** It **spins down
after roughly 15 minutes of inactivity**, and the next request has to wake it,
which can take **tens of seconds** (a cold start, occasionally appearing as a
timeout on the very first request).

**The admin panel is affected too**, because AdminJS is mounted inside that same
Express service — it is not a separate deployment.

This is **documented Render behaviour for the free tier, not a defect in
Flash.** Do not investigate it as a performance bug, and do not add retry
hacks or keep-alive pingers to work around it.

**The only real fix is upgrading that one service to Render's paid Starter
plan.** That is a billing decision for the founder — **an AI session must not
change the plan.**

**The store portal is unaffected** — it is a static site
(`srv-dapr7e3bc2fs73bp0nj0`) and does not spin down.

One practical consequence worth knowing: a cold start means the **16 cron jobs
do not run while the service is asleep**. They resume on wake, and every
timeout cron is interval-based (`updated_at < NOW() - INTERVAL ...`) rather than
tick-counting, so nothing is permanently skipped — it just fires late.

---

## 7. How this engagement has operated

A fresh session should match this bar; it is why the work has held up.

- **Verify, do not assume.** Every production claim was checked directly —
  live API probes, `pg_constraint` queries, reading source rather than trusting
  comments or docs. `CLAUDE.md` and `README` are known to drift.
- **Separate "working" from "built but blocked" from "not built."** Never blend
  them. The audit uses this classification throughout.
- **Say what was not verified.** Every record ends with a "Not verified"
  section. This is load-bearing, not politeness.
- **Mutation-test anything that matters**, and **check the unmutated baseline
  is green first.** A mutation that fails to apply, or a suite that was already
  red, makes a mutation run meaningless.
- **Hold every PR for review**, and confirm CI green on the **run's own
  `headSha`** — not the PR's check list, where a stale commit reference can
  hide.
- **Present founder decisions; do not make them.** The cancellation split, the
  commission rate, the premium perk, the ZAR verification approach — all were
  escalated, not assumed.

### Verification traps that actually occurred

Recorded because each produced a **green, confident, wrong** result:

1. **A vacuous mock** — mocked `src/config/database`, but `migrate.js` builds
   its own pool from `pg`. The assertion could never fail; 8/8 passed with the
   guard deleted.
2. **`.toThrow()` catching the wrong exception** — `require('adminjs')` throws
   `SyntaxError` under jest, satisfying five "rejects invalid input" tests that
   validated nothing.
3. **Tests blind to their own wiring** — 15 tests called a hook directly, so
   removing it from the `before` array left them all green.
4. **A collapsed regex escape** — `\s` inside a template literal becomes a
   literal `s`; two tests failed on *clean* source and made a mutation run
   report a false "8/8 caught".
5. **A measurement taken on a stale tree** — a healthy-looking `615/42` test
   count reconciled to the wrong branch. Caught only by the arithmetic not
   adding up.
6. **Shell command substitution eating a commit message** — backticks inside a
   double-quoted `git commit -m` are expanded. Use `-F <file>`.

The pattern: **the production code was almost always right; the instrument
measuring it was wrong.** Check the instrument before trusting the measurement.

---

## 8. Things an AI session structurally cannot do here

State these plainly rather than appearing to have checked them:

- **Read any Render environment variable.** The API is write-only for env vars.
  `DRIVER_TEST_MODE`, the Paystack key, and all B3 secrets are **permanently**
  manual dashboard checks.
- **Read Render's build/start commands or deploy ids** unless the MCP
  integration is connected (it was unavailable for much of this work). Confirmed
  by the founder: build/start are `npm install` / `node server.js`, with **no
  `migrate.js` reference** — migrations are applied manually.
- **Read or resolve Sentry issues** without that integration connected.
- **Log into the AdminJS panel** (no credentials, and it must not guess them).
- **Query production Postgres directly**, absent a connected integration.
- **Run the backend integration test suite locally** on this machine — Docker
  Desktop will not start, so there is no local Postgres. CI covers it on every
  run against `postgres:15`.

---

## 9. Immediate next steps, in order

1. **Founder:** dashboard check — `DRIVER_TEST_MODE` → `false`,
   `CASH_OTP_SECRET` strength, live Paystack key, remaining B3 secrets.
2. **Founder:** resolve Sentry issue **NODE-N** — it is genuinely closed. It was
   the empty-string case, fixed by `nullifyEmptyNonTextFields` on 2026-09-22,
   4m43s after that issue's last occurrence, with no recurrence since. **It is
   not** what R10/v40 addressed, and R10 must not be credited with closing it.
3. **On greenlight:** fix the cash-order hang (§2).
4. **On greenlight:** `keyGenerator` on the operational rate limiters (§3.4).
5. **On greenlight:** R11 noise reduction (§3.7).
6. **Verify R10 live** through a real AdminJS submission (§3.8).
7. **Decide** the items in §4.
