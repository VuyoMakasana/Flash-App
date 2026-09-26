# Audit — Target Payment Model, Store Portal and Admin Finish Line

**Status: COMPLETE.** Findings only — no code was changed.

## The confirmed target model being audited against

1. **Item price is always paid online by card.** There is no cash option for the
   item itself.
2. **The delivery fee is the customer's choice** — online, or cash to the driver.
3. **Stores only ever receive their item earnings.** Never delivery money, never
   anything a driver physically collected.

This is the spec, not a proposal.

Every finding below is marked **CONFIRMED** (read from code or the live
database, with the source named) or **ASSUMED** (inference, clearly flagged).

---

# 1. Store Portal + Admin — current state and finish line

## 1.1 What the portal actually is today (CONFIRMED)

Verified against the **deployed bundle** (`assets/index-D3d2uaVT.js`) and by
exercising every endpoint with a real owner token, not from the repo alone.

**11 routes deployed.** Public: `/login`, `/forgot-password`, `/reset-password`,
`/apply`, `/set-password`. Authenticated: `/orders`, `/inventory`, `/analytics`,
`/settings`, `/account`, `/not-available`.

| Screen | An owner can |
|---|---|
| Orders | List, **accept**, **reject**, **mark ready** |
| Inventory | List, **add product** (with image), **update stock per size**, **replace image**, **deactivate** |
| Analytics | Order count + item sales, daily breakdown, top 10 products, 7/14/30/90-day range. Read-only |
| Settings | List staff, **create staff**, **deactivate staff**. Owner-only |
| My Account | **Change password** |

Navigation is role-scoped (`roleNav.js`): Owner sees all four; Store Manager
loses Settings; Inventory Staff only Inventory; Sales Staff only Orders; Finance
only Analytics; Marketing has no login and lands on `/not-available`.

**Verdict: a working operational portal.** A store can take orders, manage
stock and staff, and see its sales. It has no money-out surface at all.

## 1.2 Admin panel (CONFIRMED)

**27 AdminJS resources** mounted cleanly as of deploy `dep-dartuuvf3r2c73aduk70`
— including `stores` (with approve/reject/suspend/reactivate actions),
`email_events`, and `commission_rates` (read-only).

## 1.3 What is missing or broken, ordered by what blocks a "done" portal

Each is **CONFIRMED** by reading the routes, controllers and models.

### BLOCKER 1 — A store cannot correct a product's price. (MEDIUM)

`storeInventoryController` exposes exactly: `listProducts`, `getProduct`,
`addProduct`, `updateImage`, `updateStock`, `deactivateProduct`.

**There is no way to edit a product's price, name, size set or description
after creation.** A typo'd price can only be fixed by deactivating the product
and re-adding it — which loses its history and its id. For a marketplace whose
entire commission model is a percentage *of item price*, an uncorrectable price
is the most consequential gap in the portal.

Needs: a `PATCH /:productId` endpoint with field validation, plus an edit form.

### BLOCKER 2 — Nothing can be reactivated. (SMALL)

`deactivateProduct` and `deactivateStaff` exist; **neither has an inverse.**
A product deactivated by mistake is gone from the store's catalogue
permanently, and a staff member deactivated in error cannot be restored —
both require direct database access.

Needs: two `PATCH .../reactivate` endpoints and two buttons. Small, because
the deactivate paths already carry the tenant-scoping and audit patterns to
copy.

### BLOCKER 3 — A store cannot edit its own profile. (MEDIUM)

`stores` carries `name`, `address`, `logo_url`, `banner_url`, `description`, and
these are what the **customer-facing storefront** displays. But every
`UPDATE stores` in `Store.js` is lifecycle only — `approve`, `reject`,
`suspend`, `reactivate` (lines 103, 116, 147, 170). There is **no
self-service profile endpoint and no portal screen.**

A store cannot change its own logo, description, address or trading name. An
admin can (the AdminJS `stores` resource permits edit), so there is a
workaround, but it routes every cosmetic change through Flash.

### NOT A BLOCKER — Payout Details. (deliberately absent)

No route, no nav, by decision. The 2a backend is live but
`GET /api/store-banking/banks` returns **502** on production's `sk_test_` key,
so the form cannot be completed. Reasoning recorded in `roleNav.js`.
Unblocked only by a live Paystack key.

## 1.4 Admin-side gaps

### ADMIN GAP 1 — A commission rate cannot be changed without SQL. (MEDIUM)

`commission_rates` is registered **read-only** (deliberately — §2.4 forbids
in-place edits). But no "add a new rate" action exists either, so changing
the rate that now drives every stamped commission is an ops task requiring
database access. Inserting a second active global also violates the unique
partial index, so the action needs real validation rather than a default form.

### ADMIN GAP 2 — `store_users` has no admin surface at all. (MEDIUM)

Not an AdminJS resource (`intentionallyExcluded`). An admin therefore cannot
correct a store owner's email address, re-issue access, or release a
squatted address. That last one is the open proposal in **PR #16**, still
unmerged. Combined with BLOCKER 3, an admin cannot fix an owner's login
either.

### ADMIN GAP 3 — Bounce visibility exists; nothing acts on it. (SMALL)

`email_events` records bounces and is browsable, and `store_users` carries
`welcome_email_status`/`reset_email_status`. Nothing alerts anyone — an admin
has to go and look. Deliberate ("visibility first, automation later"), noted
here so it is not mistaken for finished.

---

# 2. Payment model gap

## 2.1 The direct answer: `delivery_payment_*` was NOT built for this split

**CONFIRMED.** The columns exist and their *names* fit the target model
perfectly. Their *semantics* are something else entirely, which is more
dangerous than their not existing — a developer reading
`delivery_payment_method` would reasonably assume it records how the customer
paid for delivery. It does not.

### `delivery_payment_method` — written in exactly one place, always `'cash'`

The only write in the entire codebase is `Payment.js:195`, inside
`Payment.cashOnDelivery`:

```sql
UPDATE orders SET payment_method='cash', payment_status='pending_cash',
  delivery_payment_method='cash', delivery_payment_status='pending_driver',
  is_cash_delivery=true, cash_to_collect=$2, updated_at=NOW()
WHERE id=$1
```

It is set **only in lockstep with `payment_method='cash'`**, never
independently, and **never to `'card'` anywhere**. It is a duplicate of
`payment_method`, not a second axis.

### `delivery_payment_status` — a driver payout lifecycle, not a payment method

Its four values are `pending_driver` → `assigned` → `held` → `released`,
written by the order state machine as a driver is assigned, picks up, and
completes. It tracks **when the driver gets paid**, not how the customer paid.

### `cash_to_collect` is set to `order.total` — the whole order

`$2` above is `order.total`, i.e. **subtotal + delivery_fee**. The existing
model is "cash means the entire order is paid in cash at the door", which is
the opposite of the target's "the item is always card; only the delivery fee
may be cash".

## 2.2 What the customer app offers today (CONFIRMED)

`flash-user-app/screens/PaymentScreen.js`:

```js
const PAYMENT_METHODS = ALL_PAYMENT_METHODS.filter(m => m.id === 'cash');
const [selected, setSelected] = useState('cash');
```

**Card is filtered out of the UI entirely and the default is cash** — because
production runs an `sk_test_` key, so every Paystack call throws and a customer
tapping Card would hit a dead end.

**Production data agrees:** 19 of 19 orders are cash, `store_paid` true on zero,
and no `paystack_reference` exists anywhere. **No card payment has ever been
processed.**

## 2.3 Half-built vs not started

| Target requirement | State |
|---|---|
| A column to record how delivery was paid | **Half-built** — `delivery_payment_method` exists but only ever says `'cash'`, in lockstep with the item |
| A column to record the cash amount the driver collects | **Half-built** — `cash_to_collect` exists but holds `total`, not `delivery_fee` |
| Item always paid by card | **Not started, and currently inverted** — the app offers *only* cash |
| Item and delivery as independent payment axes | **Not started** — one `payment_method` governs both |
| Driver payout lifecycle | **Built** — `delivery_payment_status`, working, unrelated to the split |

## 2.4 The gap, stated plainly

The target model needs **two independent facts** per order: how the item was
paid (always card) and how delivery was paid (card or cash). The schema has two
column *pairs* that look like they provide this, but both describe the same
single decision. Nothing today can represent "item paid by card, delivery paid
in cash" — the one combination the target model expects to be common.

The customer app is not merely missing the card option: it currently offers
**only** the method the target model abolishes.

**Blocking dependency:** none of this can be exercised without a live Paystack
key. With `sk_test_` in production, an always-card item price would mean **no
order could be placed at all**. Card-always must not ship before the key.
---

# 3. Driver payment and `trusted_drivers`

## 3.1 `trusted_drivers` has nothing to do with payment (CONFIRMED)

It is a **customer↔driver relationship table**: `user_id`, `driver_id`,
`status` ∈ `pending|accepted|declined`, `UNIQUE(user_id, driver_id)`. A
customer sends a trust request, the driver accepts or declines, and the
customer can then request that driver by name (`requestedDriverId` is passed
through the checkout flow). Managed by `TrustedDriver.js` —
`sendTrustRequest`, `respondToRequest`, `removeTrustedDriver` and similar.

**It carries no money, no payout routing and no rate.** It affects driver
*selection*, not driver *payment*.

The single payment-adjacent link: a driver blocked for commission debt cannot
accept a **new trust request**, which exists only so a customer is not left
believing they have a trusted driver who cannot actually take their orders.
Order acceptance is independently gated. That is the whole of the
relationship.

## 3.2 Driver EARNINGS already assume drivers never earn from store money (CONFIRMED)

`utils/helpers.js:43`:

```js
const computeCommission = (deliveryFee) => {
  const flashCommission = Math.max(10, Math.round(fee * 0.25 * 100) / 100);
  const driverPayout    = Math.round((fee - flashCommission) * 100) / 100;
};
```

Driver pay is **derived purely from `delivery_fee`** and never references
`subtotal`. Flash takes `max(R10, 25%)` of the delivery fee; the driver gets the
remainder. This is computed once at order creation and frozen into
`orders.driver_payout`.

**So the earnings model already matches the target exactly.** No change needed.

## 3.3 But driver CUSTODY does not (CONFIRMED — and this is the real issue)

Earning from delivery money and *physically holding* only delivery money are
different things, and today only the first is true.

`Payment.cashOnDelivery` sets `cash_to_collect = order.total` — **subtotal plus
delivery fee**. On a cash order the driver collects the store's item money at
the door. `recordCashCommission` then records that the driver owes Flash the
*delivery* commission, and **nothing records the subtotal**.

So under the *current* model a driver routinely takes custody of store money
that no system tracks. That is OPEN_FOLLOWUPS #20.

## 3.4 What the target model changes

| Concern | Today | Under the target |
|---|---|---|
| Driver earnings basis | `delivery_fee` only | **Unchanged** — already correct |
| Driver cash custody | `order.total` (item + delivery) | **`delivery_fee` only** |
| Store money touched by driver | Yes, untracked | **Never** |
| `recordCashCommission` basis | `delivery_fee` | **Unchanged** — already correct |

The single concrete code change this implies is that `cash_to_collect` must
become `delivery_fee` rather than `order.total`. Everything else about driver
payment is already shaped the way the target model requires.

## 3.5 A knock-on the target model breaks (CONFIRMED)

`computeCancellationSplit` in `orderController.js` currently reads:

```js
const storeAmount        = isCash ? 0 : Math.round(itemValue * storePct * 100) / 100;
const customerItemRefund = isCash ? 0 : ...
```

with the comment *"Cash orders haven't collected any payment yet (that happens
at delivery), so there is nothing to withhold from the store or refund to the
customer."*

**That reasoning stops being true under the target model.** The item is always
paid upfront by card, so an order whose *delivery fee* is cash still has fully
collected item money. The `isCash` branch would then wrongly award the store
zero and refund the customer nothing on a cancellation where real item money
was, in fact, taken.

This is a live financial-logic bug that the model change *creates*. The
condition must key on whether the **item** was paid, not on
`payment_method === 'cash'`. Flagged here because it is easy to miss: the code
is correct today and becomes incorrect the moment the model changes.
---

# 4. Store settlement (2c) implications

## 4.1 Yes — this removes the cash-settlement problem entirely

**CONFIRMED as a logical consequence of the target model**, not as observed
behaviour (nothing has run this way yet).

OPEN_FOLLOWUPS #20 said: on a cash order the driver collects
`subtotal + delivery_fee` at the door, Flash never receives the item money, and
so Flash cannot settle it to the store. Settlement could not be designed
without first deciding whether the driver hands item value to the store or
Flash collects it from the driver.

**The target model dissolves that question rather than answering it.** If the
item price is always paid online, then Flash *always* receives the store's
money directly from Paystack, on every single order, with no exceptions. The
delivery fee's payment method becomes irrelevant to settlement, because
delivery money was never the store's.

The two candidate resolutions in #20 — "driver hands cash to the store" versus
"Flash collects from the driver and settles" — are both moot. Neither is
needed.

## 4.2 How much this simplifies 2c

Substantially, and in a specific way: **2c no longer needs to branch on
`payment_method` at all.**

| 2c design question | Before | Under the target |
|---|---|---|
| Does settlement differ for cash vs card orders? | Yes — fundamentally | **No. One path** |
| Can Flash always pay what it owes a store? | No — it never held cash item money | **Yes, always** |
| Does the driver hold store funds? | Yes, untracked | **Never** |
| Is a driver-to-store reconciliation mechanism needed? | Probably | **No** |
| Is a business decision needed before scoping? | **Yes — blocking** | **No longer blocking** |

`store_settlement_line_items` can therefore be a straight aggregation of
completed orders' stamped `store_commission`, with no payment-method
discrimination and no separate cash reconciliation path. That is a materially
smaller and safer 2c than the one #20 implied.

## 4.3 What it does NOT resolve

Being precise, because "simpler" is not "solved":

- **The live Paystack key is now a hard prerequisite for the whole platform,
  not just for payouts.** If the item must always be card and the key is
  `sk_test_`, **no order can be placed at all**. Today's cash-only flow is the
  only reason orders work.
- **`order_cancellation_store_shares` is still write-only** (#19). Money owed
  to stores from cancellations is recorded and never paid, independent of
  payment model.
- **Returns after settlement** still need the agreed netting (§3.4 of the
  financial spec), unchanged.
- **`computeCancellationSplit` becomes wrong** (see §3.5) and must be fixed as
  part of the model change, not after.
- **OPEN_FOLLOWUPS #20 should be re-scoped rather than closed** — the
  settlement half is resolved; the observation that nothing currently tracks
  driver cash custody remains true until `cash_to_collect` changes.

---

# 5. Ranked findings

## A. Blocking the store portal / admin finish line

| # | Finding | Size | Status |
|---|---|---|---|
| A1 | **Product price/name/description cannot be edited** after creation. Only stock, image and deactivate exist. Uncorrectable prices in a percentage-commission marketplace | MEDIUM | CONFIRMED |
| A2 | **Nothing can be reactivated** — no inverse for `deactivateProduct` or `deactivateStaff`. A mistake is permanent without database access | SMALL | CONFIRMED |
| A3 | **A store cannot edit its own profile** (name, address, logo, banner, description) — every `UPDATE stores` is lifecycle only. Admin can, so there is a workaround | MEDIUM | CONFIRMED |
| A4 | **Commission rate cannot be changed without SQL** — `commission_rates` is read-only by design and no "add rate" action exists | MEDIUM | CONFIRMED |
| A5 | **`store_users` has no admin surface** — an admin cannot correct an owner's email, re-issue access, or release a squatted address (PR #16 still open) | MEDIUM | CONFIRMED |
| A6 | **Bounce visibility has no alerting** — deliberate, recorded so it is not mistaken for finished | SMALL | CONFIRMED |

## B. Genuine gaps in the payment model

| # | Finding | Size | Status |
|---|---|---|---|
| B1 | **The customer app offers only cash** — the exact method the target abolishes. Card is filtered out of the UI | SMALL (UI) / BLOCKED (key) | CONFIRMED |
| B2 | **No live Paystack key.** Card-always cannot ship before this, or no order can be placed at all | BLOCKER | CONFIRMED |
| B3 | **Item and delivery are one payment decision.** `delivery_payment_method` only ever says `'cash'`, in lockstep with `payment_method`; it is a duplicate, not a second axis | MEDIUM | CONFIRMED |
| B4 | **`cash_to_collect` holds `order.total`**, so drivers take custody of store money. Must become `delivery_fee` | SMALL | CONFIRMED |
| B5 | **`computeCancellationSplit` becomes financially wrong** under the new model — its `isCash` branch assumes no item money was collected | MEDIUM | CONFIRMED |
| B6 | **`delivery_payment_status` is a driver-payout lifecycle**, not a payment method, despite the name. Rename or document before anyone builds on the assumption | SMALL | CONFIRMED |

## C. Longer-term, can wait

| # | Finding | Size | Status |
|---|---|---|---|
| C1 | `order_cancellation_store_shares` write-only (#19) | MEDIUM | CONFIRMED |
| C2 | Driver bank numbers stored in plaintext (#17) | MEDIUM | CONFIRMED |
| C3 | `orders.store_paid` misleading name (#18) | SMALL | CONFIRMED |
| C4 | No `updated_at` trigger; 35 of 149 `UPDATE`s set it by hand | SMALL | CONFIRMED |
| C5 | Render auto-deploys ahead of migrations (#16 in list) | MEDIUM | CONFIRMED |
| C6 | Payout Details UI — hidden pending a live key | MEDIUM | CONFIRMED |

## 6. The one thing to take away

**B2 gates the entire target model.** Everything else in section B is small to
medium work, but none of it can be exercised — or even safely shipped — while
production runs an `sk_test_` key. Under the target model an item that must be
paid by card, on a key where every Paystack call throws, means **zero orders
can be placed**. Today's cash-only checkout is the only reason the platform
functions at all.

The portal/admin items in section A are entirely independent of that and can be
finished now.

## 7. Explicitly not verified

- Nothing here was fixed or changed; this is findings only.
- The target model has **never been exercised** — no card payment has ever been
  processed in production (0 of 19 orders).
- Section 4's conclusions are logical consequences of the stated model, not
  observations of running code.
- Portal screens were inventoried from the deployed bundle, the source, and
  live API calls with a real owner token — **not from viewing rendered pages**
  (no browser available). Layout and visual state are unverified.
