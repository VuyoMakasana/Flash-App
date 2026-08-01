# Flash — Order Authority Matrix

**Scope:** Business-domain analysis only. No code, no schema changes. Precise enough to be handed to a new engineer as the actual specification for order-related authorization code — every real state from `orderStateMachineService.js`'s live `ALLOWED_TRANSITIONS`, every real actor, every real consequence, each grounded in a specific file:line, not a loose description.

**Naming correction, stated once up front:** the founder's own sketch referred to a `ready_for_pickup` state. No such state exists in the real state machine, and none should be added — "ready for pickup" is the correct *business label* for the real state `waiting_for_driver`, reached via the real `markReadyForPickup` action rather than automatically. This matrix uses the real state names throughout, noting the business label wherever it differs, so this document stays a precise specification rather than introducing a naming mismatch of its own.

**Actor legend used throughout:** **Customer** (the order's own `user_id`, JWT role `user`) · **Store** (today: a Flash Administrator acting through the internal AdminJS panel, since no `store_users` exists yet — see the note in §0) · **Driver** (the order's own assigned `driver_id`, JWT role `driver`) · **Flash Admin** (`admins`, platform-wide) · **System** (a cron job or an automated side effect, no human actor).

---

## 0. A real, load-bearing clarification: "Store" actions are Flash-Admin actions today

Every action attributed to "Store" below (Accept, Reject, Mark Ready for Pickup) is, in the real, currently-deployed code, executed by a **Flash Administrator** through the internal AdminJS panel's `acceptOrder`/`rejectOrder`/`markReadyForPickup` custom actions (`backend/src/adminPanel.js`) — because Flash itself is the only real store today (`BUSINESS_DOMAIN_MAP.md` §1). The moment `store_users` and a real, separate Store Admin Portal exist (`FLASH_STORE_ADMIN_DESIGN.md`), these same actions become callable by a genuine Store actor (a `store_users` account, scoped to that order's `store_id`) through the new portal — calling the exact same underlying `orderStateMachineService` functions, per that document's own §0/§6.4. This matrix describes the **business authority** ("Store" is who *should* decide this), not which literal JWT type happens to exercise it today — the distinction matters for anyone reading this as a future authorization spec, so it's stated once here rather than re-caveated at every row.

---

## 1. The full state table

| State | Who can act | Available actions | Real consequence |
|---|---|---|---|
| **`created`** | System (automatic, at order creation) | — (transient; a real row exists only briefly before `payment_pending`) | `Order.create()` inserts the row; stock is decremented at this point (`Order.js:142-212`), before payment is even confirmed — a real, deliberate design choice worth naming: Flash reserves stock optimistically at order creation, not at payment confirmation. |
| **`payment_pending`** | Customer (submits payment); System (webhook/reconciliation) | Pay via card (Paystack), pay via cash-on-delivery election, or abandon (no explicit cancel needed — see `cancelOrder`'s own real gate below) | Card: Paystack webhook (`webhookController.handleChargeSuccess`) → `paid`. Cash: `paymentController.cashOnDelivery` → `paid`. Customer **can** call `cancelOrder` here — `orderController.js:368`'s real gate includes `payment_pending` in the full-refund set, though nothing was charged yet for either path at this exact point, so "refund" is moot until payment actually clears. |
| **`paid`** | System (automatic, immediately) | None — no human decision point exists here; this state exists for a real instant, not as a queue anyone acts on | Immediately routes to either `pending_store_acceptance` (normal hours) or `scheduled_for_morning` (outside operating hours, `isClosedNow()` check) — confirmed in `webhookController.js`/`paymentController.js`'s own real branching logic. |
| **`scheduled_for_morning`** | System (07:00 SAST cron, `server.js`'s `cron.schedule('0 5 * * *', ...)`) | Customer can still `cancelOrder` (full refund, per the same gate) | The cron releases every order in this state into `pending_store_acceptance` at store-open time — an overnight order gets no free pass past the store's own accept/reject gate just because of when it was placed (`FLASH_STORE_ADMIN_DESIGN.md` §0's own original reasoning, now live). |
| **`pending_store_acceptance`** | **Store** (Accept/Reject); Customer (cancel); System (15-minute timeout) | **Accept** → `preparing` (`orderStateMachineService.acceptOrder`). **Reject** → `cancelled`, full refund, `cancelled_by_role: 'store'` (`rejectPendingAcceptance`). Customer **Cancel** → `cancelled`, full refund, `cancelled_by_role: 'user'` (`orderController.cancelOrder`, same full-refund gate). | This is the single most time-sensitive queue in the whole workflow (`FLASH_STORE_ADMIN_DESIGN.md` §4.1) — the 15-minute timeout cron (`server.js`) auto-cancels-and-refunds via the identical `rejectPendingAcceptance` function with `cancelledByRole: 'system'`, so an unaccepted order never traps a customer's money indefinitely. |
| **`preparing`** | **Store** (Mark Ready for Pickup); Customer (cancel) | **Mark Ready for Pickup** → `waiting_for_driver` (`markReadyForPickup` — this is the real state behind the business label "ready for pickup," see the naming note above). Customer **Cancel** → `cancelled`, full refund (same gate — a customer can still cancel while the store is actively preparing their order, full refund, no penalty to the customer for the store's own preparation time). | `markReadyForPickup` is the real handoff point to driver matching — it triggers the same auto-match/preferred-driver-notification logic previously fired automatically on payment, now consolidated into this one explicit, store-triggered function (`orderStateMachineService.js`'s own documented consolidation). |
| **`waiting_for_driver`** (business label: "Ready for pickup") | Driver (accept the job); Customer (select a specific trusted driver, or cancel); System (30-minute no-driver timeout) | Driver **Accept** → `driver_assigned` (`DriverController.acceptOrder`). Customer **Select Driver** → the same transition, driver-initiated acceptance short-circuited by a specific trusted-driver choice (`OrderController.selectDriver`). Customer **Cancel** → `cancelled`, full refund (no driver assigned yet, nothing to compensate). | The existing, separate 30-minute-stuck / 15-minute-check no-driver auto-cancel cron (`server.js`) — full refund, `reason: 'no_driver_available_timeout'` — the precedent the new `pending_store_acceptance` timeout cron was deliberately built to match in cadence. |
| **`driver_assigned`** | Driver (arrive, or self-cancel pre-pickup); Customer (cancel, now with a real split); Flash Admin (reassign) | Driver arrival → `driver_arrived_store` (`PUT /api/orders/:orderId/status`, the generic driver endpoint, `OrderController.updateOrderStatus`). Customer **Cancel** → `cancelled`, **pre-pickup split**: 10% item value to store, 5% to driver, remainder + full delivery fee to customer (`computeCancellationSplit`, default percentages). Driver can request a **requeue** (`requeueOrderForDriverSearch`) if they can no longer fulfill it. | `DriverWallet.addPending` credits the driver's pending balance the moment assignment happens (`updateOrderStatus`'s own `driver_assigned` branch) — real money is already provisionally committed to the driver here, which is *why* a customer cancellation from this state onward triggers driver compensation, not just a full refund. |
| **`driver_arrived_store`** | Driver (submit pickup photo); Customer (cancel, harsher split) | Driver **submits a real photo** → `picked_up` (`submitPickupPhoto`, package-protection requirement — no photo, no transition). Customer **Cancel** → `cancelled`, **store-arrival split**: 0% to store (nothing left the premises), 8% to driver (higher than pre-arrival, for the completed trip to the store), 92% + full delivery fee to customer. | This is the harshest-for-the-store, most-generous-to-the-driver cancellation tier — a deliberate, founder-confirmed reflection of the driver having already made the real trip. |
| **`picked_up`** | Driver (begin transit) | Driver → `in_transit` (`PUT /api/orders/:orderId/status`, the generic endpoint again — no photo required for this specific transition). **No cancellation path exists from here onward** — `orderController.js:338`'s explicit gate (`['picked_up', 'in_transit', 'delivered', 'completed']`) returns `409 Order cannot be cancelled at this stage`. | This is the real, hard authority boundary: once the item has left the store, cancellation authority ends entirely for the customer — matched by the returns flow (post-delivery remedy) being the only path left. |
| **`in_transit`** | Driver (submit dropoff photo) | Driver **submits a real photo** → `delivered` (`submitDropoffPhoto`, same package-protection requirement). | Sets `delivered_at` for the first and only time (`COALESCE(delivered_at, ...)` in `updateOrderStatus` — immutable once set, the anchor the 48-hour return-eligibility window is computed from). |
| **`delivered`** | Driver (request delivery confirmation, jointly with the Customer) | Driver requests/receives an OTP from the customer and submits it → `completed` (`paymentController`'s cash-and-card-shared OTP confirmation flow). **The generic driver status endpoint explicitly refuses to set `completed` directly** (`OrderController.updateOrderStatus:305-309`) — a real, confirmed anti-fraud gate closing a self-completion bypass that existed before tonight's package-protection work. | This is a genuinely **joint** authority, not solely the driver's: the literal DB actor is the driver (`actorRole: 'driver'`), but the real-world authorization requires the customer's own OTP as a co-signature — worth stating precisely since a naive reading of `actorRole` alone would miss the customer's real role here. |
| **`completed`** | System (automatic, at OTP confirmation) | Terminal for the delivery workflow; **Return** request becomes available to the Customer for 48 hours from `delivered_at` (`OrderController.requestReturn`) | Card: driver's pending wallet balance is released (`DriverWallet.releasePending`, `driver_paid: true` — confirmed exactly-once via the same field). Cash: requires `payment_status === 'paid'` already set (via the OTP flow's own cash-commission recording, `recordCashCommission`) or the transition itself throws. |
| **`cancelled`** (terminal) | — | None — terminal state, no further transitions defined anywhere in `ALLOWED_TRANSITIONS` | A real `order_cancellations` row always exists for a cancellation reached through `cancelOrder`/`rejectPendingAcceptance` (never through the generic driver status endpoint, which has no path to `cancelled` at all for a driver past `picked_up`, per the same-role restriction in `updateOrderStatus:194-196`: *"Cannot cancel after pickup without admin override"*). |

---

## 2. Full per-state expansion — view / modify / cancel / approve / reject / override / system / notifications

The table in §1 is the narrative specification (real actors, real functions, real consequences). This section is its schematic complement, precise enough to drive backend authorization, frontend button visibility, and notification wiring directly — every state answers the same eight questions, cross-checked against `orderStateMachineService.js`'s live `ALLOWED_TRANSITIONS` and `notificationService.js`'s real `statusMessages` map. "N/A" means the action genuinely has no meaning at that state (not merely "nobody happens to do it") — stated explicitly per row rather than left blank, since a blank cell is ambiguous between "nobody" and "not asked yet."

### `created`
| | |
|---|---|
| Can view | Customer (own order); Flash Admin |
| Can modify | N/A — no order-content editing exists anywhere in this codebase, at any state (`DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md` §6) |
| Can cancel | N/A — the state is real but transient; no request can land while it's current |
| Can approve | N/A |
| Can reject | N/A |
| Can override | N/A |
| System actions | `Order.create()` inserts the row and decrements stock immediately (`Order.js:142-212`) — before payment confirmation |
| Notifications | None — falls through to the generic `Order status updated: created` fallback (`notificationService.js:139`); no dedicated message exists |

### `payment_pending`
| | |
|---|---|
| Can view | Customer (own); Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — `cancelOrder`'s full-refund gate includes this state, though nothing has been charged yet for either payment path |
| Can approve | N/A |
| Can reject | N/A |
| Can override | N/A |
| System actions | Card webhook (`handleChargeSuccess`) or cash election (`cashOnDelivery`) advances to `paid` |
| Notifications | None dedicated — generic fallback |

### `paid`
| | |
|---|---|
| Can view | Customer (own); Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — technically included in the full-refund gate, though the state is real for only an instant in practice |
| Can approve | N/A |
| Can reject | N/A |
| Can override | N/A |
| System actions | Immediately routes to `pending_store_acceptance` or `scheduled_for_morning` based on `isClosedNow()` |
| Notifications | None dedicated — generic fallback |

### `scheduled_for_morning`
| | |
|---|---|
| Can view | Customer (own); Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — full refund |
| Can approve | N/A |
| Can reject | N/A |
| Can override | N/A |
| System actions | 07:00 SAST cron releases every order in this state into `pending_store_acceptance` |
| Notifications | None dedicated — generic fallback (worth flagging as a real, plausible gap: a customer whose order sat overnight gets no distinct "we'll start on this in the morning" message today) |

### `pending_store_acceptance`
| | |
|---|---|
| Can view | Customer (own); **Store** (per §0's clarification); Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — full refund |
| Can approve | **Store** — Accept, → `preparing` |
| Can reject | **Store** — Reject, → `cancelled`, full refund, `cancelled_by_role: 'store'` |
| Can override | Flash Admin, at any time, via the same Accept/Reject actions (§0) |
| System actions | 15-minute timeout cron auto-rejects (→ `cancelled`, full refund, `cancelled_by_role: 'system'`) |
| Notifications | Customer: *"We've received your order — the store is reviewing it now."* |

### `preparing`
| | |
|---|---|
| Can view | Customer (own); Store; Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — full refund (no penalty for the store's own prep time) |
| Can approve | **Store** — Mark Ready for Pickup, → `waiting_for_driver` |
| Can reject | N/A — Reject is only meaningful from `pending_store_acceptance`; a store cannot "reject" an order it already accepted, only cancel it via the same customer-facing cancellation path is not available to a store either — there is genuinely no store-initiated cancel-from-`preparing` action today, worth flagging as a real, plausible gap (what if a store realizes mid-prep it can't actually fulfill the order?) |
| Can override | Flash Admin, via the internal panel's `markReadyForPickup` action |
| System actions | None — no timeout exists for `preparing` itself (only for `pending_store_acceptance` and `waiting_for_driver`); a store could in principle leave an order in `preparing` indefinitely today, a real, plausible gap worth the founder's attention alongside the one above |
| Notifications | Customer: *"Your order is being prepared!"* |

### `waiting_for_driver` (business label: "Ready for pickup")
| | |
|---|---|
| Can view | Customer (own); Store; Driver (before assignment: visible in the available-orders pool); Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — full refund (no driver assigned yet) |
| Can approve | Driver — accepting the job (`DriverController.acceptOrder`), or Customer selecting a specific trusted driver (`selectDriver`) |
| Can reject | N/A (a driver declining simply doesn't accept — there's no explicit driver-facing "reject" action at this state) |
| Can override | Flash Admin |
| System actions | No-driver timeout cron (30-minute stuck threshold, 15-minute check interval) auto-cancels, full refund |
| Notifications | Customer: *"Your order is ready — looking for a nearby driver."* |

### `driver_assigned`
| | |
|---|---|
| Can view | Customer (own); Store; the assigned Driver; Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — **pre-pickup split** (10% store / 5% driver / 85%+delivery fee customer, default percentages); Driver — cannot cancel outright, but can request a **requeue** (`requeueOrderForDriverSearch`), clearing the assignment and returning the order to `waiting_for_driver` |
| Can approve | Driver — arriving at the store advances the order (via the generic status endpoint) |
| Can reject | N/A |
| Can override | Flash Admin — reassignment (the existing 45-minute stuck-assignment cron is itself a real, automated override, not a human one) |
| System actions | `DriverWallet.addPending` credits the driver's pending balance immediately on assignment; the 45-minute stuck-reassignment cron |
| Notifications | Customer: *"Your driver has been assigned!"*; Driver: real-time assignment push (confirmed pattern, exact copy not re-verified here) |

### `driver_arrived_store`
| | |
|---|---|
| Can view | Customer (own); Store; the assigned Driver; Flash Admin |
| Can modify | N/A |
| Can cancel | Customer — **store-arrival split** (0% store / 8% driver / 92%+delivery fee customer) |
| Can approve | Driver — submitting a real pickup photo (`submitPickupPhoto`), the only way to advance; no photo, no transition |
| Can reject | N/A |
| Can override | Flash Admin |
| System actions | None specific to this state beyond the general stuck-assignment cron's window (`driver_assigned`/`driver_arrived_store` share the same 45-minute reassignment check) |
| Notifications | Customer: *"Your driver is at the store."* |

### `picked_up`
| | |
|---|---|
| Can view | Customer (own); Store; the assigned Driver; Flash Admin |
| Can modify | N/A |
| Can cancel | **Nobody** — `orderController.js:338`'s explicit gate returns `409` for any cancellation attempt from here onward; this is the hard authority boundary named in §1 |
| Can approve | Driver — advancing to `in_transit` via the generic status endpoint (no photo required for this specific step) |
| Can reject | N/A |
| Can override | Flash Admin — an explicit, admin-only force-cancel would be the only path past the `409` gate; no dedicated admin action for this was found in `adminPanel.js` (worth flagging: "Flash Admin can override" is a stated authority-matrix principle, not a confirmed, already-built button at this specific state) |
| System actions | None |
| Notifications | Customer: *"Your order has been picked up."* |

### `in_transit`
| | |
|---|---|
| Can view | Customer (own); Store; the assigned Driver; Flash Admin |
| Can modify | N/A |
| Can cancel | Nobody (same gate as `picked_up`) |
| Can approve | Driver — submitting a real dropoff photo (`submitDropoffPhoto`) advances to `delivered` |
| Can reject | N/A |
| Can override | Flash Admin (same caveat as `picked_up` — no dedicated force-transition action confirmed built) |
| System actions | None |
| Notifications | Customer: *"Your order is on the way to you!"* |

### `delivered`
| | |
|---|---|
| Can view | Customer (own); Store; the assigned Driver; Flash Admin |
| Can modify | N/A |
| Can cancel | Nobody |
| Can approve | **Jointly** Driver + Customer — the driver requests/submits an OTP the customer provides in person; `completed` is reached only through this joint action (§1) |
| Can reject | N/A |
| Can override | Flash Admin (same caveat as above) |
| System actions | The stuck-at-`delivered`-for-2-hours detection cron flags (not auto-completes) an order stuck here, for admin review — a real, existing, already-built monitoring mechanism worth naming precisely here since it's the one system action at this state |
| Notifications | Customer: *"Your order has been delivered."*; Flash Admin: a flag/alert if stuck here past the 2-hour threshold |

### `completed`
| | |
|---|---|
| Can view | Customer (own); Store; the assigned Driver; Flash Admin |
| Can modify | N/A |
| Can cancel | N/A — terminal for the delivery workflow; the **Return** flow (a separate, real mechanism, `RETURNS_AND_LEGAL_AUDIT.md`) is the only post-completion remedy, available to the Customer for 48 hours from `delivered_at` |
| Can approve | N/A |
| Can reject | N/A |
| Can override | N/A — nothing to override once genuinely terminal |
| System actions | Card: `DriverWallet.releasePending` releases the driver's held balance, `driver_paid: true`. Cash: requires `payment_status === 'paid'` already set via the OTP flow's own cash-commission recording, or the transition throws |
| Notifications | Customer: *"Delivery complete. Thanks for using Flash!"* |

### `cancelled` (terminal)
| | |
|---|---|
| Can view | Customer (own); Store; Flash Admin |
| Can modify | N/A |
| Can cancel | N/A — already terminal |
| Can approve | N/A |
| Can reject | N/A |
| Can override | N/A |
| System actions | A real `order_cancellations` row always exists for a cancellation reached through `cancelOrder`/`rejectPendingAcceptance` |
| Notifications | Customer: *"Your order has been cancelled."* |

---

## 3. Cross-cutting authority rules (apply across every state above)

- **A driver can never cancel an order after `picked_up`** without an explicit Flash Admin override (`orderStateMachineService.js:194-196`, `updateOrderStatus`'s own real, hardcoded check) — this is the one place the state machine itself enforces an authority rule inline, rather than leaving it to the calling controller.
- **A driver can only ever act on their own assigned order** (`String(order.driver_id) !== String(actorId)` throughout `driverController.js`/`orderStateMachineService.js`) — confirmed, consistent, real ownership check at every driver-facing transition.
- **A customer can only ever act on their own order** (`WHERE id = $1 AND user_id = $2`, `orderController.js:328` and equivalent throughout) — the same discipline, customer side.
- **Flash Administrators can act on any order, at any state, through the internal panel's own actions** — genuinely platform-wide, by design (`BUSINESS_DOMAIN_MAP.md` §5) — though today the internal panel's specific custom actions (`acceptOrder`/`rejectOrder`/`markReadyForPickup`) are still gated by the order's *current status* via `isAccessible` (e.g. `acceptOrder` only shows when `status === 'pending_store_acceptance'`), not a blanket "admin can force any transition" button — worth naming precisely, since "Flash Admin can override" (§0) doesn't currently mean "a single unconstrained status-setter exists" for every state; it means the same granular, one-action-per-transition actions exist for Flash Admin's use as would exist for a real Store's use once the portal exists.
- **System/cron actions never require a human actor, and always run under `actorRole: 'system'`** (confirmed: the no-driver timeout, the store-acceptance timeout, and the stuck-`driver_assigned` reassignment cron all pass this literal string) — a real, consistent convention worth preserving in any future authorization code that needs to distinguish "a human did this" from "the system did this automatically."

---

## What this document is not

Business-domain analysis only. No code was written, no schema was changed. §0's clarification (Store authority is exercised via Flash Admin today, pending the Store Admin Portal) is the one piece of this document that describes a temporary, known-to-change reality rather than a permanent rule — worth re-reading once `store_users` and the new portal actually exist, to confirm this matrix's "Store" rows transfer cleanly to the new actor type without any hidden Flash-Admin-specific assumption smuggled in.
