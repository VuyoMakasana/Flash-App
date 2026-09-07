# Production-Readiness Audit — Section 2.8 Follow-up: Driver Cash-Commission-Debt Mechanism

**Date:** 2026-09-08. **Scope:** the trusted-driver commission-debt system for
cash orders — a driver collects the customer's cash in full, and owes Flash
its per-delivery commission afterward rather than it being deducted from the
payment itself. Requested as a follow-up before closing Section 2.8, given
this is real money owed to Flash by real drivers. Every claim below is read
directly from the current source or proven live against the Docker sandbox
(synthetic driver/user/order rows only, created and fully deleted by the
verification script — no live production data touched).

---

## 1. Where is the debt recorded, and is it tamper-proof?

Recorded in two places, written inside one server-side transaction that a
client cannot skip or influence:

- `driver_commission_debts` — one row per cash delivery, `UNIQUE(order_id)`.
- `driver_wallets.cash_commission_debt` / `unpaid_cash_deliveries` — the
  running totals actually checked for blocking.

The write path is `paymentController.confirmCashReceived` →
`driverCommissionService.recordCashCommission(client, order.driver_id,
orderId)`, called **unconditionally** for every cash order, using
`order.driver_id` — a value read from the locked `orders` row inside the
same transaction (`SELECT ... FOR UPDATE`), never taken from the request
body. There is no code path into `completed` status for a cash order that
skips this: `orderStateMachineService.js`'s `completed` transition throws
unless `payment_status === 'paid'` already, and `payment_status` only
becomes `'paid'` for cash orders inside this same block, immediately before
`recordCashCommission` runs.

**Correction — found a real bug in the original version of this report.**
The first pass of this audit described the commission amount as "a
hardcoded server constant" and treated that as reassuring (not
client-controlled). Vuyo caught the actual problem: Flash's commission
model is percentage-of-delivery-fee (the same `flashCommission = max(10,
25% of delivery_fee)` formula computed for every card order at creation
time in `Order.create`, `backend/src/models/Order.js`), not a flat amount
— and `recordCashCommission` was **genuinely hardcoding `COMMISSION_AMOUNT
= 20.00` for every cash delivery regardless of that order's actual delivery
fee**. Confirmed by reading the constant declaration and every one of its
four use sites in `driverCommissionService.js` — not a coincidence of the
specific order tested; a R500 delivery fee and a R50 one would have
recorded the identical R20 debt.

**Why this was a real problem, not just a cosmetic one:** a cash driver on
a large order (high delivery fee, so a large real `flashCommission`) was
underpaying Flash every single time, silently — the shortfall was neither
logged nor visible anywhere, since the system had no record of what the
*correct* amount should have been. A driver skewing toward larger cash
orders would have owed Flash steadily less than they actually should, with
no code path that would ever have surfaced the gap.

**Fix:** `recordCashCommission` now looks up the order's own `delivery_fee`
(a column that is never mutated after order creation — confirmed by
grepping the whole backend for any `UPDATE ... SET delivery_fee`, zero
matches) and computes the commission via the **same shared helper** already
implementing the correct formula, `computeCommission()`
(`backend/src/utils/helpers.js`) — previously written but never actually
called from anywhere, so this also closes a small pre-existing dead-code/
duplication gap rather than adding a third copy of the formula.
`COMMISSION_AMOUNT` was removed entirely (including from the module's
exports — confirmed nothing outside this file imported it).
`recordCashCommission` now returns the amount it actually recorded, and
`paymentController.confirmCashReceived`'s JSON response (which also
separately hardcoded `amount: 20.00`) now reports that real value instead.

**Verified live** (post-fix, against the Docker sandbox, three synthetic
cash orders with different delivery fees, all cleaned up afterward):

| Delivery fee | Expected commission (25%, R10 floor) | Actually recorded |
|---|---|---|
| R80  | R20 | R20 |
| R240 | R60 | R60 |
| R12  | R10 (floor) | R10 |

All three produced different, correctly-computed `driver_commission_debts`
rows (`[20, 60, 10]`, not `[20, 20, 20]`) — proving this is a genuine
per-order computation now, not a coincidence of whichever order happened to
be tested first.

The write itself remains just as tamper-proof as before this fix: the
*amount* is now computed from `orders.delivery_fee` (a server-authoritative,
immutable-after-creation column, read inside the same transaction, never
supplied by the client) instead of a constant — the client still has no way
to influence it, skip it, or substitute a value of its own.

**Conclusion: tamper-proof, and — after this fix — now records the
mathematically correct amount for the order's actual size, not a flat
placeholder.**

---

## 2. Is there an enforced cap, or can debt grow unbounded?

Enforced, at two independent real gates — confirmed by tracing both, not
assuming from the constant names:

- `driverController.setOnlineStatus` — before flipping a driver online,
  calls `checkCommissionBlock(req.userId)`; if blocked, returns
  `403 { code: 'COMMISSION_DEBT_BLOCKED' }` and the driver never goes
  online.
- `driverController.acceptOrder` — same check, run *before* `assignDriver`,
  so a blocked driver cannot pick up new work even if already online when
  the block was triggered mid-shift.

The block itself triggers automatically inside `recordCashCommission` the
moment either threshold is crossed — `DEBT_THRESHOLD = R200` or
`COUNT_THRESHOLD = 10` unpaid deliveries, whichever comes first — via the
private `_blockDriver` helper, which also force-sets `is_online = false`
server-side (not just a flag the client is expected to respect).

**Verified live**: pushed a synthetic driver's outstanding debt past R200
(9 cash deliveries with zero wallet balance to auto-deduct from). Result:
`driver_wallets.cash_commission_debt >= 200`, `drivers.commission_blocked =
true`, `drivers.is_online = false` — all server-set, no client involved.
Then confirmed both gates for real: `POST /api/drivers/online` with
`{online:true}` → `403 COMMISSION_DEBT_BLOCKED`; `POST
/api/drivers/orders/:id/accept` on a freshly created order → same `403`.

**Conclusion: real, enforced, cannot grow unbounded** — a driver is cut off
from new work automatically once either threshold is crossed.

---

## 3. Does weekly settlement correctly net outstanding debt against payout?

Yes, with no bypass path. `DriverWallet.createPayoutRequest(driverId,
amount)` is the **only** code path in the codebase that inserts into
`driver_payout_requests` (confirmed by grepping the whole backend for that
INSERT — one match). It always calls
`deductDebtBeforePayout(client, driverId, requestedAmount)` first, inside
the same `SELECT ... FOR UPDATE`-locked transaction, and stores only the
**net** amount. If the debt fully absorbs the requested payout, it throws
rather than silently paying out R0 unexplained.

**Verified live**: gave a synthetic driver R500 of payable wallet balance
while still carrying an outstanding debt from step 2 above; the resulting
payout request's `amount` was exactly `500 − debtBeforePayout`, the debt
column dropped to `0`, and — as a direct consequence of the debt clearing —
`commission_blocked` flipped back to `false` automatically (`_maybeUnblockDriver`,
called from within the same debt-clearing path).

**The one scenario this does not — and structurally cannot — solve in
software**: a driver who owes debt but never requests a payout and never
logs in again (e.g. abandons the platform entirely with outstanding debt
and no wallet balance to net it against). That's an unavoidable bad-debt /
collections situation, not a missing enforcement mechanism — there is no
payout event to net against if the driver never initiates one. The debt
itself is not lost or hidden in that case: it remains visible in
`driver_commission_debts` / `driver_wallets`, both already-registered
AdminJS resources (confirmed present in `adminCoverage.js` from an earlier
round of this audit), so it's available for manual collections follow-up
rather than silently written off. This is the same class of item as the
COD-collusion caveat already logged in §2.8's main report — a real,
named limitation of the model, not a code defect.

**Conclusion: settlement correctly nets debt with no bypass; the only
unrecoverable case is a driver who never triggers a payout at all, which no
netting-at-payout-time design can address.**

---

## 4. Could a driver reach "trusted" status without their debt history being checked?

**Found a real gap here — fixed.** Two systems exist and were previously
uncoordinated:

- **Driver subscriptions** (`Subscription.js` / `subscriptionService.
  checkDriverSubscriptionAllowed`) — gates purely on active-plan +
  delivery-limit. Confirmed by reading it fully: no debt or "trust tier"
  concept exists here at all, so there's nothing to fix on this side.
- **Trusted-driver relationships** (`TrustedDriver.js`) — a
  *customer*-initiated relationship (a customer marks a driver as trusted
  for priority/exclusivity on their future orders). This is a different
  mechanism from subscriptions, but it's the one Vuyo's question was
  actually pointing at: **`TrustedDriver.respondToRequest` had no
  commission-debt check at all before accepting**, even though
  `driverController.acceptOrder` already correctly blocked the same driver
  from accepting *orders* while debt-blocked.

**Why this mattered, concretely**: a commission-debt-blocked driver could
still accept a customer's trust request, so the customer would see "trusted
driver" status for someone who — at that exact moment — cannot go online or
accept any order at all. Not a financial bypass (order acceptance stays
independently and correctly gated regardless of trust status), but a real
UX-consistency gap that misrepresents a blocked driver's actual
availability to a customer.

### Fix

`TrustedDriver.respondToRequest(requestId, driverId, action, io)`
(`backend/src/models/TrustedDriver.js`) now checks
`checkCommissionBlock(driverId)` before honoring `action === 'accept'`,
throwing a descriptive error if blocked. **Declining stays unconditionally
allowed** — there's no reason to force a blocked driver to hold onto a
pending request they can't act on.
`trustedDriverController.respondToRequest`'s catch block maps that error to
`403 { code: 'COMMISSION_DEBT_BLOCKED' }`, matching the exact shape already
used by `driverController.js`'s `acceptOrder`/`setOnlineStatus`, so mobile
clients handle it identically regardless of which endpoint returned it.

---

## Files changed

- `backend/src/services/driverCommissionService.js` — `recordCashCommission`
  now computes the commission from the order's own `delivery_fee` via the
  shared `computeCommission()` helper instead of a hardcoded `R20`
  constant (removed, including from the module's exports); the function now
  returns the amount it actually recorded.
- `backend/src/controllers/paymentController.js` — `confirmCashReceived`'s
  response now reports the real recorded amount (`commissionAmount`,
  captured from `recordCashCommission`'s return value) instead of a
  separately hardcoded `amount: 20.00`.
- `backend/tests/unit/driverCommission.test.js` — updated every
  `recordCashCommission` test for the new leading order-lookup query; added
  two new tests proving the commission scales with delivery fee and that
  the R10 floor still applies; fixed a genuine pre-existing test bug found
  while doing this (whitespace-sensitive `.includes()` assertion — see
  `docs/audits/OPEN_FOLLOWUPS.md` #3, now resolved).
- `backend/tests/unit/payments.test.js` — updated the cash-confirmation
  test to assert the response reports back whatever
  `recordCashCommission` actually returned, not a hardcoded value.
- `backend/src/models/TrustedDriver.js` — `respondToRequest` now checks
  `checkCommissionBlock` before accepting (not before declining).
- `backend/src/controllers/trustedDriverController.js` —
  `respondToRequest`'s catch block maps the new error to
  `403 COMMISSION_DEBT_BLOCKED`.
- `backend/tests/unit/trustedDriverCommissionBlock.test.js` — new, 4 tests.

## Verification

- **Unit**: `driverCommission.test.js` — 19 tests (2 new: commission scales
  with delivery fee, R10 floor applies to a small delivery fee), all
  passing, including the now-fixed pre-existing failure. 4 new tests in
  `trustedDriverCommissionBlock.test.js`: accepting while blocked rejects
  before ever reaching the DB (`pool.query` never called); declining while
  blocked never even calls `checkCommissionBlock`; accepting while not
  blocked still works; the pre-existing "Request not found" behavior is
  unregressed. **Full unit suite: 237 passed, 0 known failures** — this is
  a genuine improvement over every prior report in this audit, which had
  carried 2 known pre-existing failures throughout; one is fixed for real
  (`OPEN_FOLLOWUPS.md` #3) and the other (`adminCoverage.test.js`) is a
  host-vs-Docker-network artifact that only reproduces when run outside the
  container, already independently confirmed passing inside Docker.
- **Live, end-to-end, against the Docker sandbox** (synthetic driver/user/
  orders, fully cleaned up after): a full real cycle —
  1. A real cash delivery via the actual OTP-gated HTTP endpoint produced a
     genuine `driver_commission_debts` row and wallet debt increment.
  2. A second cash delivery with sufficient wallet balance correctly
     auto-deducted from `wallet_balance` rather than adding to debt, while
     leaving the *first* (unpaid-at-the-time) debt still outstanding.
  3. Nine more deliveries pushed debt past the R200 threshold; the driver
     was auto-blocked and auto-forced offline, server-side.
  4. Both `POST /api/drivers/online` and `POST
     /api/drivers/orders/:id/accept` correctly rejected with
     `403 COMMISSION_DEBT_BLOCKED` while blocked.
  5. `PATCH /api/trusted-drivers/:id/respond` with `action: 'accept'`
     correctly rejected with the same `403 COMMISSION_DEBT_BLOCKED` while
     blocked (the new fix); `action: 'decline'` on the same request still
     succeeded.
  6. Running the debt-blocked driver's outstanding debt through
     `DriverWallet.createPayoutRequest` produced a payout netted exactly by
     the outstanding debt, cleared the debt to zero, and automatically
     unblocked the driver — all server-side, no separate manual step.

  All 18 checks in this live run passed. All synthetic data (users,
  drivers, orders, wallets, debts, payout requests, trust rows) was deleted
  at the end of the run; a second cleanup pass confirmed zero leftover rows
  after a transient rate-limiter collision between two consecutive script
  runs against the same container IP left one synthetic driver+user pair
  behind (`otpLimiter` is 3 req/min per IP on the real HTTP OTP-confirm
  endpoint — expected behavior, not a bug, and not a concern for real
  traffic since real drivers don't fire cash-confirms back-to-back from the
  same IP within a minute).
- **Live, post-fix, against the Docker sandbox** (rebuilt the backend image
  so the running container actually reflects the code change — this
  backend service has no bind mount, confirmed earlier in this audit):
  three synthetic cash orders with delivery fees of R80/R240/R12 produced
  `driver_commission_debts` rows of R20/R60/R10 respectively — three
  different, correctly-computed amounts, not a flat R20 three times over.
  All synthetic data cleaned up afterward; confirmed zero leftover rows.

## Answering Vuyo's four questions directly

1. **Tamper-proof?** Yes — server-locked `driver_id`, welded into the same
   transaction required to reach `completed`/get paid at all. **But the
   amount itself was wrong**: the original version of this report
   incorrectly treated a hardcoded flat R20 as reassuring rather than
   catching that it should have been percentage-of-delivery-fee like every
   card order's commission. Fixed to compute the real per-order amount via
   the same formula/helper already used for card orders, verified live
   across three different order sizes.
2. **Enforced cap?** Yes — R200 debt or 10 unpaid deliveries, whichever
   first, auto-blocks both going online and accepting orders. Unaffected by
   the amount-computation fix; the thresholds themselves were always
   correct, only what accumulated toward them was wrong before.
3. **Nets correctly at settlement?** Yes, with no bypass path — the sole
   payout-request code path always deducts debt first. The only
   unrecoverable case (a driver who never requests payout at all) is an
   inherent bad-debt/collections risk, not a software gap, and the debt
   stays visible in AdminJS for manual follow-up.
4. **Could a driver get "trusted" status without a debt check?** Found yes
   (trust-request acceptance had no gate) — now fixed, tested, and
   verified live end-to-end.

**Section 2.8 is now fully closed** — including the commission-amount
correction Vuyo caught before sign-off, which was real and has been fixed,
tested, and verified live at three different order sizes.
