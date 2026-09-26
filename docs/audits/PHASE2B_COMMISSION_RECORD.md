# Phase 2b — Store Commission

Implements `FINANCIAL_DOMAIN_SPECIFICATION.md` §2. **No money moves.** After
this, every rand a store is owed is computable and independently auditable,
with nothing yet transferable — deliberately the step before 2c, so settlement's
risk is confined to *moving* an amount that has already been verified rather
than to deciding it and moving it at once.

---

## 1. Schema (migration v39)

Three nullable columns on `orders`, plus one partial index.

| Column | Type | Why |
|---|---|---|
| `store_commission` | `NUMERIC(10,2)` | Matches every other money column, and specifically `store_settlement_line_items.store_commission`, which 2c copies this into — a precision mismatch there would round silently |
| `commission_rate_applied` | `NUMERIC(5,4)` | So `subtotal × rate = commission` is verifiable by inspection, years later |
| `commission_rate_id` | `UUID` → `commission_rates(id)` | *Which* row produced it, and therefore its `created_by` and `reason`. A real FK is safe because that table is append-only by design (§2.4: a rate change is a new row, never an edit) |

A bare amount is not auditable. The rate answers "how", the id answers "on whose
authority" — which is the question a store actually asks when disputing a figure.

### The index

```sql
CREATE INDEX idx_orders_store_commission_pending
  ON orders(store_id, delivered_at)
  WHERE store_commission IS NOT NULL
```

Keyed on **`delivered_at`, not `updated_at`**. `delivered_at` is written exactly
once — `COALESCE`'d in `updateOrderStatus` so no later transition overwrites it —
and is already the immutable anchor the 48-hour returns window uses.
`updated_at` is rewritten on every transition and would silently move an order
between settlement cycles.

There is **no `completed_at` column.** I initially wrote the index against one;
checking the live schema rather than assuming caught it before the migration
was written.

---

## 2. When it is stamped

`orderStateMachineService.updateOrderStatus()`, inside the existing
`targetState === 'completed'` branch — the same block that releases the driver's
pending wallet balance. It is the single choke point every completion passes
through; for cash orders the path is `confirmCashReceived → updateOrderStatus`
inside one transaction, and there is no second route.

The value is written into the **same atomic UPDATE** as the status change. An
order cannot be completed without its commission, or carry a commission without
being completed.

### Idempotency — five layers, four pre-existing

1. `SELECT * FROM orders WHERE id = $1 FOR UPDATE` — concurrent callers serialise
2. `if (currentState === targetState)` returns **before** the branch runs, so a
   repeat `completed → completed` executes nothing
3. `completed: []` — terminal, no path out and back in
4. `order.store_commission == null` — the column is its own guard, so even a
   manual status flip in the database could not restamp
5. `store_commission = COALESCE(store_commission, $6)` — **the existing value
   wins**, making the database the final arbiter rather than trusting the JS
   guard to be the only writer. Same shape as `delivered_at` directly above it

### It never blocks a completion

A thrown resolver or a missing rate is caught and logged; the order still
completes with `NULL` commission. The goods are delivered and the order is real
— an unstamped commission is recoverable afterwards, a failed completion strands
a live delivery.

`NULL`, never `0`. Zero would mean "Flash takes nothing" and would settle the
full item value to the store.

---

## 3. Rate resolution

```sql
SELECT id, rate, scope_type FROM commission_rates
 WHERE is_active = true
   AND (starts_at IS NULL OR starts_at <= NOW())
   AND (ends_at   IS NULL OR ends_at   >= NOW())
   AND (scope_type = 'global'
        OR (scope_type IN ('store','promotional') AND store_id = $1))
 ORDER BY CASE scope_type WHEN 'promotional' THEN 1 WHEN 'store' THEN 2 ELSE 3 END,
          created_at DESC
 LIMIT 1
```

**Only the existing global row applies today** (`0.1000`, seeded by v31,
founder-confirmed). The store and promotional tiers are already in the query, so
adding a per-store override later is an `INSERT`, not a code change — which is
the whole point of §2's design. Nothing per-store is built.

**The rate in effect at completion is the one that applies**, and the date
predicates are what make that true rather than aspirational. A naive
`WHERE is_active = true` returns whichever row is flagged active regardless of
its window, silently applying a promotional rate before it starts or after it
ends. `NOW()` is evaluated inside the completion transaction, so "completion
time" is exact — and the stamp then freezes it permanently.

The resolver takes the transaction client, so the rate is read inside the same
transaction that stamps it and is rolled back with it on failure.

---

## 4. No historical backfill

**Scope decision for 2b.** The two already-completed orders keep `NULL`, which
reads correctly as "completed before commission was computed".

This is a scope call, not a claim that backfilling was impossible. One of the
two (`FLASH-MRNL4I6J-6BF9`, delivered 2026-07-16) completed two weeks before the
global rate row existed, so any value there would have been invented — but the
other (`FLASH-MSC1WOTA-FB1D`, delivered 2026-08-02) completed a day *after* the
rate was created and could in principle have been backfilled. The decision
covers both regardless.

---

## 5. Post-completion reversal — deferred to 2c

Worth correcting a common assumption: **a post-completion cancellation is
impossible.** `completed: []` is terminal and `updateOrderStatus` throws on an
illegal transition, so `order_cancellation_store_shares` can never be written
against a completed order.

The real post-completion reversal is a **return** (48-hour window). A refunded
order has `payment_status = 'refunded'` while `status` stays `completed`, so a
stamped commission survives against money that was returned.

**Explicitly 2c's problem**, consistent with the founder decision already
recorded (§3.4): net the reversal against the next settlement cycle rather than
clawing back. 2b must therefore **not** clear a stamp on refund — the stamp
records what was earned at completion, and adjusting it would destroy the audit
trail the netting depends on.

---

## 6. The cash finding — OPEN_FOLLOWUPS #20, blocker for 2c

Commission is stamped on cash orders too: the arithmetic is identical, since
Flash earns its share of item value however the customer paid.

**Settling it is not identical**, and this is the significant finding from 2b's
research. On a cash order the driver collects `subtotal + delivery_fee` at the
door. `recordCashCommission` records that the driver owes Flash the *delivery*
commission — and **nothing records the `subtotal`**, which is the store's money,
physically with the driver. Flash cannot settle money it never received.

Every completed order in production history is cash (2 of 2; 19 of 19 overall),
so a settlement run built on the card assumption would either pay stores money
Flash does not hold, or skip every order that exists. Tracked as
OPEN_FOLLOWUPS #20 and flagged as a **blocker for 2c scoping**. It does not
affect 2b: `orders.payment_method` is already on the row, so 2c can branch
without another column.

---

## 7. Testing

**31 new tests** (21 resolver/arithmetic, 10 stamping). Backend **471 → 502**,
39 suites.

| Property | Covered |
|---|---|
| Date window genuinely enforced | Asserts both `starts_at` and `ends_at` predicates are in the SQL |
| Precedence order | Asserts the `CASE` ranking, so store overrides will outrank global |
| No rate → `null`, never `0` | Asserted |
| Rounding to whole cents | Asserted, including a half-cent case |
| Resolver joins the caller's transaction | Asserts the passed client is used, not the pool |
| Stamped exactly once | Already-stamped, repeat transition, no-store, non-completion |
| Never blocks completion | Thrown resolver and missing rate both complete with `NULL` |
| **Columns reach the SQL** | Asserts the UPDATE names all three |

**Mutation-tested**, each caught:

| Mutation | Result |
|---|---|
| Drop `store_commission` from the UPDATE column list | 1 test fails |
| Remove the already-stamped guard | 1 test fails |
| Reverse `COALESCE` so a new value overwrites a stamp | 2 tests fail |

The first of those is not hypothetical — **I wrote that bug.** The UPDATE uses
an explicit column list rather than iterating `updates`, so setting
`updates.store_commission` without naming the column in the SQL drops it
silently: no error, no value, and the gap would surface only at settlement.
Caught by reading how `updates` is applied rather than assuming it was generic.

---

## 8. Also in this PR

The store portal's **Payout Details screen is deliberately absent** — no route,
no nav entry — with the reasoning recorded in `roleNav.js`. The Phase 2a backend
is live, but `GET /api/store-banking/banks` returns 502 on production's
`sk_test_` key, so the bank dropdown a payout form needs has nothing to fill it.
Same treatment and same reasoning as the customer app hiding the Card option: an
owner tapping it would hit a genuine dead end.

---

## 9. Not verified

- **v39 not yet applied** to production.
- **Nothing has been stamped in production.** No order has completed since this
  was written, and none can be made to complete without placing a real order.
  The logic is verified by unit and mutation tests only.
- **The global rate has never been exercised by real code** — `commission_rates`
  has been read by nothing until now.
- **Behaviour under a real promotional window is untested against live data**,
  since no promotional row has ever existed. The date predicates are asserted in
  SQL, not observed resolving a real overlapping window.
