# Production-Readiness Audit — Section 2.9: Refund Lifecycle

**Date:** 2026-09-08 (concurrency fix and live verification), 2026-09-09
(remainder). **Scope, as given:** Paystack refunds via `refundService.js`,
their interaction with the order state machine, driver compensation on
cancellation, and idempotency. Every claim below is either read directly
from the current source or proven live against the Docker sandbox
(synthetic user/driver/order rows only, created and fully deleted by each
verification script — no production data touched in this section).

---

## How the four scoped areas actually work

**Paystack refunds (`refundService.js`).** `refundOrderPayment` commits a
`payment_refunds` row (`status='processing'`) and locks the order row
*before* ever calling Paystack, then calls Paystack outside that
transaction. Paystack refunds are asynchronous — a live test call in an
earlier section of this audit came back `pending`, days out — so the order
sits at `payment_status='refund_pending'` until a `refund.processed`/
`refund.failed` webhook (or the polling fallback below) calls
`finalizeRefund`, the single place that ever sets the terminal
`refunded`/`refund_failed` state.

**Order state machine interaction.** `cancelled` is correctly terminal
(`ALLOWED_TRANSITIONS.cancelled = []`), and `updateOrderStatus` itself is
properly guarded: it takes `SELECT ... FOR UPDATE` first, and if the order
is *already* in the target state it returns early — before running
`Order.restockItems` or any other side effect. The state transition and the
inventory restock were already genuinely idempotent against re-entry,
confirmed by tracing the exact line order, not assumed.

**Driver compensation on cancellation.** `computeCancellationSplit`
(10%/5% pre-pickup, 0%/8% after store-arrival) is shared between the real
cancel path and its preview endpoint, so the two can never drift apart on
the math. Compensation is a direct wallet credit
(`DriverWallet.creditAvailable`/`reversePending`), recorded in
`order_cancellations` in the same DB transaction as the status change.

**Idempotency.** This is where the real findings were.

---

## Findings and fixes

### 1. HIGH — `cancelOrder` credited driver compensation from an unlocked read, before the order was ever locked

**Root cause.** The order used to decide `refundMode`/`split` and to credit
the driver's wallet was read via a plain `db.query` *before* `BEGIN`/
`FOR UPDATE`. `updateOrderStatus` itself was already correctly locked and
idempotent on re-entry — but the wallet credit happened *before* that call
was ever reached, using the stale, unlocked snapshot. Two concurrent
`cancelOrder` requests for the same order — not just a same-device
double-tap (the mobile app already debounces that with a `submitting`
flag) but a client retry after its own 20-second `REQUEST_TIMEOUT_MS`
fires while the original request is still running server-side (this
handler's own duration includes a live Paystack refund submission — the
same reachable shape as the §2.8 `initializePayment` race), or simply two
sessions — could both read `driver_assigned` and both credit the driver's
cancellation compensation, even though the order's own `status` still only
ever became `cancelled` once. `cancelOrder` had zero test coverage before
this audit, consistent with this never being caught.

**Fix.** `backend/src/controllers/orderController.js` — the order lookup
that feeds `refundMode`/`split`/the cancellable-stage guard now happens via
`SELECT ... FOR UPDATE` as the *first* statement inside the transaction,
and every decision (including the driver-wallet credit) is made from that
fresh, locked read, not the earlier unlocked one (which no longer exists —
removed rather than kept as a redundant pre-check, to avoid two sources of
truth). The cancellable-stage guard now also explicitly includes
`cancelled` itself, so a second concurrent call sees the order already
cancelled and is rejected with a distinct `409 "Order has already been
cancelled"` before touching the wallet at all — a genuine, deliberate
behavior change from the old accidental "second call silently no-op
succeeds" outcome, which was never a designed idempotent-success case, just
an artifact of the race. The outer error handler now maps `"Order not
found"` → 404 and both cancellable-stage messages → 409, preserving the
original status codes for the still-valid cases.

**Verified — unit** (`tests/unit/orderCancellation.test.js`, new, 7 tests):
404 on a missing/unowned order; 409 with the original message for an
already-picked-up order; 409 with the new distinct message for an
already-cancelled order (and no wallet call in either 409 case);
`full_refund` mode credits nothing and refunds the full payment;
`pre_pickup_split` correctly computes and credits the driver's 5% and
refunds only the customer's share; `store_arrival_split` correctly applies
the harsher 0%/8% tier; and a dedicated concurrency test modeling exactly
the race described above (a second client's locked read returns the
already-`cancelled` row, simulating the first transaction having already
committed) asserts `DriverWallet.creditAvailable` is called **exactly
once** across both calls, not once per call.

**Verified — live, against the Docker sandbox, with two genuinely
concurrent HTTP requests** (not simulated): created a real `driver_assigned`
card order (subtotal R100, delivery fee R30, driver payout R25 pending),
then fired `Promise.all([cancel(), cancel()])` — two real `POST
/api/orders/:id/cancel` calls hitting the rebuilt backend container at the
same time. Result, all 8 checks passing:
- exactly one request returned `200`, the other `409 "Order has already
  been cancelled"`;
- the order ended up `cancelled` exactly once;
- exactly **one** `order_cancellations` row was created, with the correct
  R5 driver share (not two rows, not R10);
- exactly **one** `driver_wallet_ledger` entry exists for the
  `pre_pickup_cancellation_compensation` note — the actual race being
  tested;
- the driver's `wallet_balance` was credited exactly once (R5, not R10) and
  `pending_balance` reversed exactly once (R25 → R0, not driven negative by
  a double reversal).

This is a direct, live reproduction of the exact concurrency mechanism —
fired against the real endpoint, real DB, real row locks — not just a
mocked assertion.

### 2. MEDIUM — the missing-refund reconciliation job always retried at the *full* payment amount, ignoring split cancellations

**Root cause.** `paymentReconciliationJob.reconcileMissingRefunds` finds
any `cancelled` + `payment_status='paid'` card order and retries
`refundOrderPayment` with no override amount. For a
`driver_assigned`/`driver_arrived_store` cancellation, the *correct* refund
is `split.totalCustomerRefund` — deliberately less than the full payment,
since the store's and driver's shares are meant to stay withheld. If the
original split-refund attempt failed for any transient reason (a network
blip, Paystack downtime — precisely the scenario this job exists to catch),
the very next reconciliation pass "fixed" it by refunding the customer the
**full** amount, silently overpaying them by exactly the withheld
store+driver shares. The job never consulted `order_cancellations`, which
already stores everything needed to do this correctly (written in the same
transaction as the cancellation itself, by every real cancellation path in
this codebase).

**Fix.** `backend/src/services/paymentReconciliationJob.js` —
`reconcileMissingRefunds` now `LEFT JOIN LATERAL`s each order to its most
recent `order_cancellations` row. For `pre_pickup_split`/
`store_arrival_split`, it retries with `customer_item_refund +
delivery_fee_refunded` as the override amount instead of the full payment.
A split whose customer share is genuinely zero (e.g. a zero delivery fee)
is skipped entirely, matching `cancelOrder`'s own `split.totalCustomerRefund
> 0` guard — nothing was ever meant to be refunded for that order. A
missing `order_cancellations` row (shouldn't happen in practice, but
defensively handled) falls back to a full refund, the pre-existing safe
default.

**Verified — unit** (`tests/unit/paymentReconciliationJob.test.js`, new):
`full_refund` mode still retries with no override; `pre_pickup_split` and
`store_arrival_split` both retry with the correct stored partial amount
(R115 and R122 respectively in the test fixtures, not the full R130); a
split with a zero customer share is skipped without calling
`refundOrderPayment` at all; a missing cancellation record falls back to a
full refund; one order failing doesn't stop the rest of the batch from
being retried.

**Verified — live, against the Docker sandbox**: created a real cancelled
card order (R130 total) with a real `order_cancellations` row recording
`pre_pickup_split` (`customer_item_refund=85`, `delivery_fee_refunded=30`),
`payment_status` still `paid` (simulating a refund that never actually
went out). Ran the real `reconcileMissingRefunds()` directly. The resulting
`payment_refunds` row was created with `amount = 115.00` — the correct
split amount — not R130. (The Paystack call itself failed in the sandbox,
`PAYSTACK_SECRET_KEY` not being configured there, but that's irrelevant to
what's under test: the row is committed with the correct amount *before*
Paystack is ever called, exactly like the rest of this audit's refund
work.)

### 3. MEDIUM-LOW — a refund orphaned mid-crash had no reconciliation path at all

**Root cause.** If the backend process dies (a Render redeploy, an OOM
kill) after `payment_refunds` commits at `status='processing'` but before
the Paystack HTTP call ever returns, the row is left with
`refund_reference = NULL` forever — that column is only ever set from
Paystack's own response. `reconcileStuckRefunds` only polls rows that
already have a reference (needed to ask Paystack for status), and
`reconcileMissingRefunds`'s retry just finds this same `'processing'` row
via `refundOrderPayment`'s own idempotency short-circuit and returns it
unchanged. Before this fix, such a row — and the customer's money — was
invisible to every reconciliation path forever, requiring an admin to
notice and manually intervene. Same class of gap as the stale-reference fix
already made to `initializePayment` in §2.8.

**Fix.** `backend/src/services/paymentReconciliationJob.js` — new
`reconcileOrphanedProcessingRefunds`, called first thing inside
`reconcileStuckRefunds` on every cron tick. It marks
`status='processing' AND refund_reference IS NULL` rows older than 5
minutes as `'failed'` (tagging `provider_response` with `{"orphaned":
true}` for anyone reading the row later). paystackService's own outbound
Paystack timeout is 30 seconds, so 5 minutes is comfortably past any
legitimately in-flight call — this can't misfire against a call that's
merely slow. Marking the row `'failed'` (rather than trying to directly
resurrect it) is deliberate: `'failed'` is exactly the status
`refundOrderPayment`'s own existing-refund check excludes, so
`reconcileMissingRefunds` picks the underlying order back up fresh on its
very next pass and genuinely retries it — reusing the retry path that
already exists rather than building a second one.

**Verified — unit** (`tests/unit/paymentReconciliationJob.test.js`):
marks a stale orphaned row failed; no-ops cleanly when nothing is
orphaned; `reconcileStuckRefunds` runs the orphan sweep before polling
Paystack for referenced rows.

**Verified — live, against the Docker sandbox**: inserted a real
`payment_refunds` row at `status='processing'`, `refund_reference=NULL`,
backdated 10 minutes. Running the real `reconcileOrphanedProcessingRefunds()`
flipped it to `'failed'`, confirmed by reading the row back. A second,
*freshly*-inserted row in the same state (no backdating) was correctly left
untouched — confirming the 5-minute staleness gate isn't accidentally
catching genuinely in-flight refunds.

### 4. LOW — vestigial Payflex branch and an unguarded audit-row insert in the no-driver-timeout cron

**Root cause.** `server.js`'s 30-minute no-driver-available auto-cancel cron
checked `payment_method IN ('card', 'payflex')` before refunding, but
Payflex was fully removed as a payment method earlier in this audit
(`paymentController.js`'s CRITICAL-3 fix) — `refundOrderPayment` itself
immediately rejects any `payment_method !== 'card'`, so this implied a
capability that no longer exists (dead code, not a live bug: cash orders
never reach this branch either, since `payment_status` is never `'paid'`
pre-delivery for cash). Separately, this cron's `order_cancellations`
INSERT ran outside any transaction, before the locked state transition — a
narrower version of finding #1's ordering issue, though with no financial
side effect at stake on this particular path (no driver compensation
here), so the worst case was a harmless orphaned audit row in an unlikely
race window.

**Fix.** `backend/src/server.js` — dropped the dead `'payflex'` branch
(now just `order.payment_method === 'card'`). Wrapped the
`order_cancellations` INSERT and the `updateOrderStatus` call in one
transaction (`pool2.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`, `client`
passed to `updateOrderStatus` as `externalClient`), matching every other
real cancellation path in this codebase — a crash or an illegal-transition
throw between the two statements now rolls back the audit row too, instead
of leaving it committed for a cancellation that never actually happened.

**Verified**: syntax-checked (`node --check`); this is cron-registration
code with no dedicated test harness in this codebase (matching the
existing pattern for the other crons in `server.js`, none of which have
unit tests either) — covered by direct code review and the fact that the
transaction-wrapping pattern is identical, statement-for-statement, to the
already-tested pattern in `orderStateMachineService.rejectPendingAcceptance`.
No live verification run for this specific cron (dead-code removal plus a
mechanical transaction wrap with no behavior change in the only reachable
case), consistent with the founder's own framing of this as the lowest
priority of the four.

---

## Files changed

- `backend/src/controllers/orderController.js` — `cancelOrder` locks the
  order first and computes every decision from that locked read; the
  cancellable-stage guard now explicitly rejects an already-`cancelled`
  order; the outer catch maps the new error messages to 404/409.
- `backend/src/services/paymentReconciliationJob.js` —
  `reconcileMissingRefunds` now joins `order_cancellations` and retries
  split cancellations at their correct partial amount; new
  `reconcileOrphanedProcessingRefunds`, called from `reconcileStuckRefunds`.
- `backend/src/server.js` — no-driver-timeout cron: dropped the dead
  Payflex branch, wrapped the cancellation INSERT + transition in one
  transaction.
- `backend/tests/unit/orderCancellation.test.js` — new, 7 tests (zero
  coverage existed for `cancelOrder` before this).
- `backend/tests/unit/paymentReconciliationJob.test.js` — new, 9 tests
  (zero coverage existed for this whole file before this).

## Verification summary

- **Unit**: 16 new tests across the two new files, all passing. Full
  backend unit suite: **253 passed, 253 total** — up from 237 before this
  section, zero regressions, zero known failures (the two pre-existing
  failures this audit carried earlier were both independently resolved in
  §2.8's commission-debt work).
- **Live**, against the Docker sandbox (image rebuilt from the fixed
  source — this backend service has no bind mount, confirmed earlier in
  this audit), covering three of the four fixes with real HTTP calls and
  real function calls against real rows: the two-concurrent-request race
  test for finding #1 (8/8 checks), the split-amount retry for finding #2
  (1/1), and the orphan-recovery sweep for finding #3 (2/2, including the
  negative case). All synthetic data created by each script was deleted at
  the end of the run; a final sweep confirmed zero leftover rows.

## Outcome

All four approved fixes are implemented, tested, and — for the three where
it was meaningful — verified live against a real running instance of the
fixed code, not just mocked assertions. The headline finding (#1) is the
same shape of concurrency bug this audit has now found and fixed multiple
times across different subsystems (§2.8's `initializePayment`, this
section's `cancelOrder`) — reachable through a client timeout retry, not
just a theoretical double-tap, and now closed with the same lock-before-
side-effect pattern used everywhere else in this codebase. **Section 2.9 is
complete.**
