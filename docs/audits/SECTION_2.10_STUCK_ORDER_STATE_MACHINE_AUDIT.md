# Production-Readiness Audit — Section 2.10: Stuck-Order State Machine

**Date:** 2026-09-09. **Scope, as given:** walk through what happens when an
order gets stuck at each stage of its lifecycle, and be explicit about
which already have a timeout/recovery mechanism versus which could leave
an order — and a customer's money — stuck with no automated way out. Every
claim below is either read directly from the current source or proven live
against the Docker sandbox (synthetic user/product/order rows only,
created and fully deleted by the verification script — no production data
touched).

---

## State-by-state coverage (before this section's fixes)

| State | What could get it stuck | Automated recovery? |
|---|---|---|
| `created` | — | N/A — never actually used; `Order.create` always inserts `payment_pending` directly |
| `payment_pending`, no `paystack_reference` | Customer abandons checkout before ever attempting payment | **None** |
| `payment_pending`, `paystack_reference` set | Payment attempted, webhook missed | ✅ `reconcilePendingPayments` (5 min), re-verifies with Paystack after 2 min |
| `paid` | The `paid → pending_store_acceptance` transition throws and is silently swallowed | **None** |
| `scheduled_for_morning` | — | ✅ Released daily at 07:00 SAST |
| `pending_store_acceptance` | Store never accepts/rejects | ✅ 15-min timeout, auto-cancel + refund |
| `preparing` | Store accepts but never marks ready | **None** |
| `waiting_for_driver` | No driver accepts | ✅ 30-min timeout, auto-cancel + refund |
| `driver_assigned` / `driver_arrived_store` | Driver goes offline/silent | ✅ 45-min reassignment (requeue, penalize, auto-suspend at 5, fleet re-match) |
| `picked_up` / `in_transit` | Driver goes silent with the goods | ⚠️ Detected only (25-min flag) — and structurally cannot be cancelled from here at all |
| `delivered` | Customer never confirms OTP | ⚠️ Detected only (2-hour flag) |
| `completed` / `cancelled` | — | N/A — terminal |

Confirmed the driver-side chain is genuinely airtight, not just "probably
fine": `requeueOrderForDriverSearch` (called by the 45-min reassignment
cron) resets both `driver_id = NULL` and `updated_at = NOW()`, so a
repeatedly-reassigned-then-abandoned order always re-enters a fresh 30-
minute `waiting_for_driver` countdown rather than ever falling through a
gap between the two crons.

---

## Findings and fixes

### A. HIGH — an abandoned `payment_pending` order held real inventory hostage indefinitely

**Root cause.** `Order.create` decrements `flash_inventory.stock_by_size`
at order-creation time — before any payment is ever attempted. A customer
who closes the app during checkout without ever calling `initializePayment`
left that order (and the stock it reserved) sitting at `payment_pending`
forever. `paymentReconciliationJob.reconcilePendingPayments` exists for a
*different* case (a payment that WAS attempted but whose webhook was
missed) and explicitly excludes this one via its own `paystack_reference
IS NOT NULL` guard — nothing else was ever going to catch it. The customer
*could* self-cancel manually (`cancelOrder`'s full-refund states include
`payment_pending`, correctly restocking), but nothing proactive ever did
this. Unlike the concurrency races found elsewhere in this audit, this
needs zero bad luck to reach — cart abandonment is routine, everyday user
behavior, not a rare failure mode.

**Fix.** New `orderStateMachineService.cancelAbandonedPaymentPendingOrders`,
called from a new 15-minute cron in `server.js`. Finds orders `status =
'payment_pending' AND paystack_reference IS NULL` older than **60 minutes**
(founder-confirmed threshold — generous for a slow connection or a
distracted customer, while still bounding how long real stock sits
reserved for nothing), and cancels each through the existing state machine
(`updateOrderStatus → 'cancelled'`, which already correctly triggers
`Order.restockItems`), recording a real `order_cancellations` row
(`reason: 'payment_never_initiated_timeout'`). No refund is attempted —
`payment_status` never reached `'paid'` here, so there is genuinely
nothing to refund.

### B. LOW — `paid` could get silently stuck if the next transition ever throws

**Root cause.** The `paid → pending_store_acceptance` transition fires
automatically right after payment confirms, in both real call sites
(`webhookController.handleChargeSuccess` and `paymentReconciliationJob.
reconcilePendingPayments`) — but both wrap it in a swallow-all `catch`.
Nothing anywhere else ever scanned for an order stuck at `status = 'paid'`.
In practice this transition is a bare `UPDATE` with no side effects to
fail on (confirmed by reading `updateOrderStatus`'s full body — only
`driver_assigned`, `picked_up`/`in_transit`/`delivered`, and `completed`
have special-cased side effects; `pending_store_acceptance` has none), so
this should be rare — but real money would already be attached to an order
that never starts fulfillment, with only the customer's own manual cancel
as a way out.

**Fix.** New `orderStateMachineService.recoverStuckPaidOrders`, called from
a new 15-minute cron. Finds orders `status = 'paid'` older than **10
minutes** (a purely technical threshold — comfortably past any realistic
processing time for a bare `UPDATE`, not a customer-facing wait, so picked
directly rather than asked as a business decision) and retries the same
transition. Safe to retry blindly: `updateOrderStatus`'s own
`canTransition` guard means it can never do anything wrong if the order
has genuinely already moved on, and the `WHERE` clause naturally stops
matching an order the moment the retry succeeds. If it keeps failing,
`Sentry.captureException` is called (matching the existing wallet-
reconciliation cron's own established pattern in this same file) instead
of silently swallowing forever.

### C. MEDIUM — `preparing` had no timeout if the store forgot to mark an order ready

**Root cause.** No cron covered this state at all — unlike
`pending_store_acceptance` (15-min timeout) and `waiting_for_driver`
(30-min timeout), nothing ever revisited a stuck `preparing` order.
`markReadyForPickup` is purely a manual action (admin panel / store
portal). Plausible in a small pilot where a human simply gets busy.
Customer could self-cancel, but nothing proactive did.

**Fix.** New `orderStateMachineService.cancelStalePreparingOrders`, called
from a new 15-minute cron. Finds orders `status = 'preparing'` older than
**30 minutes** (founder-confirmed — same order of magnitude as the
driver-side 45-minute stuck-timeout cron, generous for genuinely packing a
real order while still bounded) and cancels + refunds them the same way
the no-driver-timeout cron already does: an inline transaction (INSERT
`order_cancellations` + `updateOrderStatus`), then a refund attempt
*outside* that transaction for a card order that already paid (a cash
order, whose `payment_status` never reaches `'paid'` before delivery, has
nothing to refund). Deliberately not built by generalizing
`rejectPendingAcceptance` — that function is hardcoded to the
`pending_store_acceptance` stage specifically and means something
different there (a real store rejection, not a system timeout after the
store already accepted); mirroring the no-driver-timeout cron's own inline
shape instead avoids overloading an existing function with two different
meanings.

### D. A structural gap, named but explicitly not fixed in this section

**`picked_up` and `in_transit` have no `cancelled` transition at all** —
`ALLOWED_TRANSITIONS.picked_up = ['in_transit']`, `in_transit =
['delivered']`. This isn't a missing timeout; the state machine itself has
no path out of these two states except forward to `delivered`. If a driver
genuinely vanishes with the goods, the order is **permanently** stuck — the
existing 25-minute flag just marks it visible, forever, with no software
path to close it out. Compounding this: AdminJS's `orders` resource is
deliberately fully read-only (`edit: { isAccessible: false }`, confirmed
by reading `adminPanel.js` directly — no generic status editor, no "force
complete"/"force cancel" action anywhere), so there is no admin override
for this or for a stuck `delivered` order either. Resolution today is
100% outside the software.

**Deliberately not built in this section** — presented to Vuyo as a real
trust/policy decision (should an admin ever be able to force-complete or
force-cancel an order without the customer's OTP or the driver's
confirmation?), not a pure bug fix, and confirmed: leave as a follow-up
for a deliberate design pass later rather than build now. Logged in
`docs/audits/OPEN_FOLLOWUPS.md`.

---

## Files changed

- `backend/src/services/orderStateMachineService.js` — three new exported
  functions: `cancelAbandonedPaymentPendingOrders`,
  `cancelStalePreparingOrders`, `recoverStuckPaidOrders`. Each accepts an
  optional `thresholdMinutes` override (tests don't need to backdate rows
  by the full real window to exercise them) and returns `{ <verb>: N,
  total: M }` for logging/testability.
- `backend/src/server.js` — three new 15-minute crons, each a thin wrapper
  calling one of the functions above. Deliberately kept as thin wrappers
  (not inline logic, unlike some of this codebase's older crons) so the
  real behavior lives in a place that can be unit-tested, matching
  `paymentReconciliationJob.js`'s existing pattern.
- `backend/tests/unit/stuckOrderRecovery.test.js` — new, 11 tests.
- `docs/audits/OPEN_FOLLOWUPS.md` — new entry for the picked_up/in_transit/
  delivered admin-override decision (finding D).

## Verification

- **Unit** (11 new tests): each function cancels/recovers every matching
  candidate and returns an accurate count; the correct SQL threshold
  parameter is used (and the right default when none is given); a card+paid
  order triggers a real refund submission while a cash order does not; the
  correct `order_cancellations.reason` is recorded for each path; a single
  order's failure doesn't stop the rest of a batch from being processed;
  `recoverStuckPaidOrders` reports to Sentry (not silently) when its retry
  itself fails. Full backend unit suite: **264 passed, 264 total** — up
  from 253 before this section, zero regressions, zero known failures.
- **Live, against the Docker sandbox** (image rebuilt from the fixed
  source; synthetic user/product/order rows created and fully deleted by
  the script): all three functions run directly against real rows, 12/12
  checks passing —
  1. A real `flash_inventory` product with 2 units reserved by a real
     `order_items` row on a `payment_pending` order:
     `cancelAbandonedPaymentPendingOrders` cancelled the order and
     genuinely restocked the 2 units (`stock_by_size.M` back from 3 to 5).
  2. A real `preparing` card order (with a real `payments` row) and a real
     `preparing` cash order: `cancelStalePreparingOrders` cancelled both,
     submitted a real refund attempt only for the card order (a real
     `payment_refunds` row was created for the correct R290, before the
     Paystack call itself — the call failed only because
     `PAYSTACK_SECRET_KEY` isn't configured in the sandbox, irrelevant to
     what's under test here), and correctly triggered zero refund attempt
     for the cash order.
  3. A real `paid` order: `recoverStuckPaidOrders` correctly advanced it to
     `pending_store_acceptance`.
  4. Incidentally: the live run also found and correctly cancelled one
     genuinely pre-existing, forgotten `payment_pending` order left over
     from earlier work in this same Docker sandbox session — a real,
     organic confirmation the fix works on real stale data, not just a
     controlled fixture. Confirmed zero `payment_pending`/no-reference
     orders remained afterward.

## Outcome

Three real, confirmed gaps in the order-lifecycle's timeout coverage are
now closed, each verified both in isolation (mocked unit tests) and live
against a real running instance with real rows. One further, genuinely
structural gap (finding D) was surfaced and explicitly *not* auto-fixed —
it's a trust/policy decision, escalated rather than decided silently, and
tracked in `OPEN_FOLLOWUPS.md` for later. **Section 2.10 is complete.**
