# Hotfix — Proof-of-Delivery Photo Bypass on the Generic Order-Status Endpoint

**Date:** 2026-09-07. **Branch:** `hotfix/order-photo-bypass` (off `main`),
cherry-picked from `production-readiness-audit` commit `e143e1b`. **Status:**
deployed to production as a standalone hotfix, independent of the rest of
the in-progress production-readiness audit (which stays on
`production-readiness-audit`, not merged to `main`).

**Why this jumped the queue:** found during the audit's §2.4 section
(driver fraud/theft/order-security lifecycle), and judged severe enough
(a live proof-of-delivery bypass, reachable by any driver with a valid
JWT, not a design gap) to ship immediately rather than wait for the rest
of the 21-section audit to finish.

---

## What was broken

`backend/src/controllers/orderController.js`'s generic driver status
endpoint, `PUT /api/orders/:orderId/status`, already blocked a driver
from setting `status: 'completed'` directly — a prior fix (already on
`main`, documented in its own code comment) forces that transition
through the OTP-based delivery-confirmation flow instead
(`paymentController.confirmCashReceived`), for both cash and card orders.

It had **no equivalent block for `'picked_up'` or `'delivered'`** — both
real, valid `ALLOWED_TRANSITIONS` targets
(`orderStateMachineService.js`: `driver_arrived_store → picked_up`,
`in_transit → delivered`) that are supposed to require a real,
content-type-verified photo first, via the dedicated
`submitPickupPhoto`/`submitDropoffPhoto` endpoints
(`driverRoutes.js`/`driverController.js`).

**Confirmed live against the Docker sandbox, before the fix:** a driver
could call `PUT /api/orders/:orderId/status` directly with
`{ "status": "picked_up" }` or `{ "status": "delivered" }` and the order
advanced with **zero photo evidence** — completely defeating the
"package protection" mechanism those two dedicated endpoints exist for.
This is the exact fraud vector the audit's §2.4 section asks about:
a driver falsely marking an order picked up or delivered, or falsely
claiming a customer received it, with no proof anywhere.

## What changed

One block added to `OrderController.updateOrderStatus`, mirroring the
existing `'completed'` block exactly:

```js
if (['picked_up', 'delivered'].includes(normalizeState(status))) {
  return res.status(409).json({
    error: 'Use the pickup/drop-off photo capture to advance this order.',
  });
}
```

Deliberately **no return-order exception** here (unlike the `'completed'`
block, which return orders are exempt from since there's no OTP
participant on the receiving end) — a return order still needs real
proof it was picked up from the customer and dropped off at Flash's own
store; the photo requirement isn't about the OTP, it's about proof of
physical handling.

One existing test (`tests/integration/productionStateMachine.test.js`)
used `'picked_up'` as an arbitrary example status to verify this
endpoint's HTTP-to-service wiring, predating this fix. Updated to use
`'driver_arrived_store'` instead (still a real, still-unblocked
transition through this endpoint) — preserves that test's actual intent
(does the HTTP layer correctly call `updateOrderStatus` with the right
actor info) without asserting the closed bypass as expected behavior.

## Files changed

- `backend/src/controllers/orderController.js` — the fix itself.
- `backend/tests/unit/orderController.test.js` — new, 7 tests.
- `backend/tests/integration/productionStateMachine.test.js` — one test
  updated (see above).

## Verification

- **Unit tests** (`backend/tests/unit/orderController.test.js`, 7 new):
  both blocked statuses return 409 without calling `updateOrderStatus`;
  the return-order case is still blocked (no exception); the pre-existing
  `'completed'` block and its return-order exception both still pass
  (regression); a still-legitimate transition
  (`driver_assigned → driver_arrived_store`) still passes through
  untouched; ownership check (403 for a non-owning driver) still works.
- **Full suite**, run on this hotfix branch against `main`'s own
  codebase (not the audit branch): 136 passed, 3 failed — the same two
  pre-existing, unrelated failures already present on plain `main`
  independent of this change (`tests/integration/adminCoverage.test.js`
  fails only when run outside the Docker network — a host-connectivity
  artifact, not a code issue; `tests/unit/driverCommission.test.js` has a
  pre-existing mock-assertion mismatch in an untouched service, tracked
  in `docs/audits/OPEN_FOLLOWUPS.md` #3). Neither is caused by or related
  to this fix.
- **Live end-to-end, against the Docker sandbox**, with real HTTP calls
  and a real signed driver JWT:
  - `PUT .../status` with `{status:'picked_up'}` on an order at
    `driver_arrived_store` → **409**, real DB status unchanged.
  - `PUT .../status` with `{status:'delivered'}` on an order at
    `in_transit` → **409**, real DB status unchanged.
  - `PUT .../status` with `{status:'driver_arrived_store'}` on an order
    at `driver_assigned` (still-legitimate transition) → **200**, order
    correctly advanced.

## Deployment

Cherry-picked onto a dedicated `hotfix/order-photo-bypass` branch off
`main` (not merged from `production-readiness-audit` directly — the rest
of that branch's work, including other in-progress §2.1-§2.4 changes,
stays there until the full audit is reviewed and explicitly approved for
merge). Pushed and merged to `main`; Render auto-deploys `main` on every
commit.
