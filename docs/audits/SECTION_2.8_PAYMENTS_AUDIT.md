# Production-Readiness Audit — Section 2.8: Payments (Double Charges, Cards, Cash on Delivery)

**Date:** 2026-09-07. **Scope:** card payments (Paystack hosted checkout +
saved-card charges), Cash on Delivery, and whether either trusts anything
client-side that should be server-verified. Real money, 19 live production
orders — every claim below is either read directly from the current source
or proven live against the Docker sandbox (including real calls to
Paystack's own test API, never production).

---

## 1. Do card payments and Cash on Delivery share one state machine, or diverge?

They share **one `orders.status` state machine** — both flow through the
same `paid → pending_store_acceptance → ... → completed` sequence
(`orderStateMachineService.js`'s `ALLOWED_TRANSITIONS`). They diverge on
the **separate `payment_status`/financial-truth columns**, which are what
actually answer "has real money moved":

| | `payment_status` at checkout | `payment_status` at delivery |
|---|---|---|
| Card | `pending` → `paid` the moment Paystack confirms a real charge (webhook or reconciliation) | already `paid` |
| Cash | `pending` → `pending_cash` (no money has moved yet) | → `paid` only via the OTP-verified `confirmCashReceived` |

**Worth naming plainly**: `orders.status = 'paid'` does **not** mean money
changed hands for a cash order — it means "the payment-method step is
resolved, proceed to fulfillment." The real financial truth always lives
in `payment_status`/`cash_to_collect`, never in `status` alone. This is
genuinely enforced, not just a naming convention:
`orderStateMachineService.js`'s `completed` transition explicitly throws
(`'Cash orders require payment confirmation before completion'`) unless
`payment_status === 'paid'` already — a cash order cannot be completed by
a client-side action alone.

---

## 2. The double-charge walkthrough

### Paystack webhook retry — already fully protected, verified by reading the code

`webhookController.handleChargeSuccess` has three independent layers:
1. `webhook_events.paystack_event_id` — a real `UNIQUE` DB constraint,
   checked inside a transaction. A retried webhook (same `event.id`) hits
   the constraint violation and rolls back before touching anything.
2. `SELECT ... FOR UPDATE` on the order row, plus an application-level
   `payment_status === 'paid'` guard — closes the race between two
   near-simultaneous deliveries of the same or a related event.
3. `payments` table insert uses `ON CONFLICT (provider_transaction_id) DO
   NOTHING` — a third layer at the ledger-row level.

A webhook retry cannot cause Flash to double-credit or double-process an
order. This part was already solid.

### User double-tapping Pay / a slow network — **found a real, reachable gap, now fixed**

**Root cause:** `paystackService.initializePayment` did a plain `SELECT`
(no lock), then — only after a potentially slow external call to
Paystack's `/transaction/initialize` — an `UPDATE`. Nothing spanned that
sequence with a lock.

**Why this was concretely reachable, not just theoretical:** the mobile
app's own request timeout is **20 seconds**
(`REQUEST_TIMEOUT_MS`, `flash-user-app/services/api.js`). This service's
own outbound timeout to Paystack is **30 seconds**
(`paystackService.js`'s `request()`). That 10-second gap is itself
evidence that Paystack can genuinely take that long sometimes. If it
does: the app times out at 20s, shows an error, and re-enables "Pay" —
while the backend is *still waiting* on Paystack, having not yet reached
its own `UPDATE`. A customer retry at that point runs a second
`initializePayment`, whose `SELECT` sees the exact same pre-update state
the first call saw, and independently calls Paystack too.

**The actual danger wasn't just "two references exist"** — `orders.
paystack_reference` is a single, overwritable column. Whichever `UPDATE`
lands last silently wins. If the customer completes checkout on the
reference that then gets overwritten, that charge's real webhook arrives
with `WHERE ... AND paystack_reference = $2`, matches zero rows, and
silently no-ops — a customer genuinely charged by Paystack, with an order
that never gets marked paid. The existing reconciliation cron doesn't
catch this either: it re-verifies whatever reference is *currently*
stored, not the one that was actually completed.

**The fix already existed in this exact codebase**, just not applied
consistently: `chargeSavedCard` (`paymentController.js`) already does
this correctly — `SELECT ... FOR UPDATE` inside a transaction, commits
`paystack_reference`/`payment_status='pending'` *before* the external
call, so a concurrent second attempt blocks on the lock and then
correctly sees the committed reference. `initializePayment` now does the
same:
1. Resolve `APP_URL`/`callbackUrl` *before* opening the transaction — a
   missing `APP_URL` in production must fail with zero DB side effects,
   exactly as before this fix.
2. `SELECT ... FOR UPDATE`, check ownership/already-paid, generate our
   own reference, commit it, **then** call Paystack.
3. If the external call then fails (network error or `status:false`),
   revert `payment_status`/`paystack_reference`, scoped to the exact
   reference just set (`WHERE id=$1 AND paystack_reference=$2`) so a
   concurrent successful attempt's reference is never clobbered.

**A second, narrower edge case, found live (not in the original design) and also fixed:**
running a real concurrency test against the Docker sandbox (two
`initializePayment` calls fired simultaneously) surfaced that if the
*first* caller's own Paystack call subsequently fails and reverts, a
*second* caller who already received that reference via the
short-circuit path is left holding a reference that will now never
resolve — stuck "awaiting confirmation" forever, since no real Paystack
transaction was ever created for it. Fixed with a staleness check on the
short-circuit path: a `pending` reference older than **2 minutes**
(matching `paymentReconciliationJob.js`'s own threshold, for
consistency — legitimate init calls complete well within that window)
is not trusted; a fresh reference safely supersedes it instead.

---

## 3. Cash on Delivery — does anything trust client-side confirmation?

Looked specifically for this and did not find a gap.
`orderStateMachineService.js` refuses `completed` for any cash order
unless `payment_status` is already `'paid'`, and that can only happen
through `confirmCashReceived` — an OTP sent to the *customer's* phone,
entered by the driver, verified server-side, inside a transaction with
`SELECT ... FOR UPDATE` and an ownership check (already reviewed in
§2.4's driver-fraud audit). A driver cannot mark a cash delivery complete
by tapping a button; the server-side state machine itself blocks it.

**Worth naming honestly, not as a new gap**: the OTP proves the customer
*attests* to having settled up — the same trust model as a signature or
paper receipt in any COD system. It does not cryptographically prove
cash physically changed hands, and a colluding driver+customer pair
could still fake it. That's a standard, accepted limitation of COD
generally, and it's the same collusion angle already tracked as a
pre-existing open item (no minimum-transit-time/order-velocity check,
`PRODUCTION_READINESS_AUDIT.md` §8.3) — not a new finding, and not
something to re-fix here.

---

## 4. Files changed

- `backend/src/services/paystackService.js` — `initializePayment`
  rewritten: lock-then-commit-before-external-call, `APP_URL` resolved
  before any DB writes, failure-revert scoped to the exact reference set,
  and the 2-minute staleness check on the short-circuit path.
- `backend/tests/unit/paystackInitializePayment.test.js` — new, 10 tests.

## 5. Verification

- **Unit** (10 new tests, `paystackInitializePayment.test.js`): the row
  lock is actually acquired (`FOR UPDATE`); the DB commit genuinely
  happens *before* Paystack is called (asserted via call ordering, not
  just the final state); a second call while a fresh reference is
  pending never reaches Paystack; a *stale* pending reference is
  correctly superseded while a *recent* one still short-circuits;
  `Order not found`/`Not your order`/`Order already paid` all still
  reject before ever calling Paystack; both explicit-failure and
  thrown-exception paths correctly revert, scoped to the right reference.
- **Full suite**: green except the two known pre-existing failures
  (`OPEN_FOLLOWUPS.md` #3), unrelated to this change.
- **Live, against the Docker sandbox, with real calls to Paystack's own
  test API (not mocked, not production)**: fired two `initializePayment`
  calls concurrently for the same order. Result: exactly one genuine
  Paystack checkout session was created (`https://checkout.paystack.com/
  ...`, a real reference); the second call blocked on the row lock and
  correctly returned the *same* reference via the short-circuit path,
  never making its own Paystack call; the order's stored
  `paystack_reference` matched exactly the one reference that actually
  reached Paystack.

  **Caveat, stated plainly**: the race in the *original* code was
  identified by reading the implementation and the two timeout constants
  (20s client / 30s Paystack-call), not by empirically reproducing a
  double-Paystack-transaction against the unpatched version first — doing
  that reliably would need injecting an artificial delay into the
  Paystack call to force the exact interleaving, which wasn't done here.
  The mechanism itself is straightforward to verify by inspection (with
  the lock removed, two concurrent calls unconditionally both pass the
  pre-update `SELECT` and both proceed to call `/transaction/initialize`)
  and isn't in doubt, but it was not independently reproduced pre-fix.
