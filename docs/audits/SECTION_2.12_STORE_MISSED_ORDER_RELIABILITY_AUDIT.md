# Production-Readiness Audit — Section 2.12: Store Missed-Order Reliability

**Date:** 2026-09-09. **Scope:** what happens when the store misses a new
order — no acceptance, no preparation follow-through — and whether that's
detected/recoverable or silent. Every claim below is read directly from
the current source or proven live against the Docker sandbox (synthetic
user/admin/order rows only, created and fully deleted by each verification
script — no production data touched, and one real email genuinely
delivered via Resend to prove the pipeline end-to-end, using Resend's own
documented test address, not a real inbox).

---

## The central finding: a new order got zero proactive signal to the store

Checked every `io.to('admin').emit(...)` call site in the backend. SOS
alerts, driver applications ready for review, refund failures,
stuck-at-delivered, and driver-connection-lost all get a real-time admin
broadcast. **A brand-new order reaching `pending_store_acceptance` did
not** — no socket emit existed for this transition anywhere.

Checked the email fallback layer next, since this codebase has already
solved this exact class of problem twice: `sendSosAlertEmail` and
`sendReturnAwaitingReviewEmail` both exist specifically because — quoting
the SOS one's own comment — "before this, an alert only ever reached a
live Socket.io connection to the 'admin' room — missed entirely if nobody
had the panel open at that exact moment." **No equivalent existed for a
new pending order.** The only thing that happened: the *customer* got a
push notification ("we've received your order, the store is reviewing
it") — the store got nothing telling them there was anything to review.
The admin dashboard's `activeOrdersByStatus` breakdown was the one partial
mitigation — real, but purely pull-based, no urgency indicator, and only
useful if the founder happened to open the panel within the 15-minute
window.

**Compounding gap**: when the 15-minute store-acceptance-timeout cron
fired — a real order genuinely missed, the customer refunded, a sale
lost — it produced **only a `console.log`**. No admin alert, no email,
nothing visible anywhere in the panel beyond digging into
`order_cancellations.reason`. This broke the "admin must be able to
reconstruct what happened" principle already enforced everywhere else in
this audit (§2.4, §2.13). The founder had no way to know they were losing
sales to missed acceptances unless they stumbled onto a cancelled order
and investigated why.

**Same shape of gap, one stage later**: `preparing` orders (store
accepted, but never hit "Mark Ready for Pickup") had the identical
problem against the §2.10 30-minute timeout — no reminder before, no
notification after.

---

## The fix (founder-confirmed: 5-minute escalation threshold)

Three-tier design, matching this codebase's own proven notification
pattern (live socket + durable email fallback):

1. **Immediate socket alert** on arrival at `pending_store_acceptance` —
   `notifyAdminNewOrderPendingAcceptance(order, io)`, a new
   `io.to('admin').emit('fleet_alert', { type:
   'new_order_pending_acceptance', ... })`, the same shape every other
   real admin alert in this codebase already uses. Wired into **all four**
   real places an order can arrive at this state:
   - `webhookController.handleChargeSuccess` (card payment, webhook)
   - `paymentReconciliationJob.reconcilePendingPayments` (card, webhook-missed
     fallback)
   - `paymentController`'s cash-order flow
   - `recoverStuckPaidOrders` (§2.10's own stuck-at-paid recovery — a
     recovered order really is a new arrival needing the same attention)
2. **A one-time escalation email** if an order is *still* unhandled 5
   minutes later (`pending_store_acceptance`) or 20 minutes later
   (`preparing` — the same 10-minute-buffer ratio as the confirmed
   5-of-15 for acceptance, applied to preparing's 30-minute window, not a
   separately re-litigated threshold). Not fired on every order — that
   would just become noise to ignore at real volume — only once one is
   genuinely at risk. New idempotent flag columns
   (`acceptance_escalated_at`/`preparation_escalated_at`, same shape as
   `stuck_delivery_flagged_at`) guarantee this never re-sends for the same
   order. A new 5-minute cron
   (`escalateStuckPendingAcceptanceOrders`/`escalateStuckPreparingOrders`)
   checks both — 5-minute cadence, not the timeout crons' 15, specifically
   so an order crossing the escalation threshold gets a real chance to be
   caught before the actual cutoff, not just once right at the edge.
3. **A distinct "you just missed this order" email** the moment the
   timeout cron actually auto-cancels one — added to `rejectPendingAcceptance`
   (gated on `cancelledByRole === 'system'`, never fired for a real,
   deliberate store reject — the store obviously already knows about
   that one) and unconditionally to `cancelStalePreparingOrders` (only
   ever reached via the system timeout cron in the first place).

New email templates, `sendOrderEscalationEmail`/`sendOrderMissedEmail` in
`emailService.js`, following the exact `sendSosAlertEmail`/
`sendReturnAwaitingReviewEmail` pattern — `getAdminEmails()` + `sendEmail`,
nothing novel invented.

---

## Files changed

- `backend/src/db/migrate.js` — migration v39:
  `orders.acceptance_escalated_at`/`preparation_escalated_at` +
  supporting partial indexes.
- `backend/src/services/emailService.js` — new
  `sendOrderEscalationEmail`/`sendOrderMissedEmail`.
- `backend/src/services/orderStateMachineService.js` — new
  `notifyAdminNewOrderPendingAcceptance`,
  `escalateStuckPendingAcceptanceOrders`, `escalateStuckPreparingOrders`;
  `rejectPendingAcceptance` and `cancelStalePreparingOrders` (§2.10) now
  send the missed-order email; `recoverStuckPaidOrders` (§2.10) now
  raises the admin alert too.
- `backend/src/controllers/webhookController.js`,
  `backend/src/services/paymentReconciliationJob.js`,
  `backend/src/controllers/paymentController.js` — each of the three real
  `paid → pending_store_acceptance` call sites now raises the admin alert
  on success.
- `backend/src/server.js` — new 5-minute escalation cron.
- `backend/tests/unit/storeMissedOrderNotifications.test.js` — new, 10
  tests. `backend/tests/unit/stuckOrderRecovery.test.js` — 2 new
  assertions added to existing §2.10 tests.

## Verification

- **Unit** (12 new/extended tests): the socket alert fires with the
  correct payload and safely no-ops with no `io`; both escalation
  functions send the right email, flag the right column, use the
  confirmed default thresholds (5 / 20 minutes), and don't stop a batch on
  one failure; `rejectPendingAcceptance` sends the missed-order email only
  for `cancelledByRole === 'system'`, never for a real store reject;
  `cancelStalePreparingOrders` sends it unconditionally;
  `recoverStuckPaidOrders` raises the admin alert on a successful
  recovery. Full backend unit suite: **276 passed, 276 total** — up from
  264, zero regressions.
- **Live, against the Docker sandbox** (image rebuilt from the fixed
  source, migration v39 applied): real rows for every path —
  `escalateStuckPendingAcceptanceOrders`/`escalateStuckPreparingOrders`
  correctly matched, flagged, and (confirmed idempotent — a second run
  against the same order matched nothing) real backdated orders;
  `rejectPendingAcceptance` correctly attempted the missed-order email
  only for the system-timeout case, confirmed by its absence for the
  real-reject case; `cancelStalePreparingOrders` attempted it
  unconditionally. With zero admin rows seeded, every email call
  correctly short-circuited with `"No admin accounts found"` rather than
  crashing — proving the guard clause. **With one real admin row seeded**
  (email set to Resend's own documented test address, not a real inbox),
  `escalateStuckPendingAcceptanceOrders` triggered a genuine, successful
  Resend API delivery (`messageId: <dea356fd-...@resend.dev>`) — the
  entire pipeline verified end-to-end through a real external provider
  call, not just asserted in a mock.
- All synthetic data (users, admins, orders, cancellations) deleted after
  each run; confirmed zero leftover rows.

## Outcome

The core finding — a genuinely serious, previously-invisible reliability
gap where the founder could lose real orders with zero signal, before or
after the fact — is closed with the same proven notification pattern this
codebase already trusts for SOS and returns, not a new mechanism. All four
real arrival points are covered, not just the common case. **Section 2.12
is complete.**
