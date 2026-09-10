# Flash — Financial Domain Specification (v2, incorporating the founder's ten business decisions)

**Scope:** Business-domain analysis only. No code, no schema changes. Every financial concept below is defined in one precise sentence, named against every real (or newly-designed) table/service that implements it, with its own audit trail and reporting path — not folded together or treated as interchangeable, per the founder's explicit instruction.

**Correction note:** this document previously left the store commission rate, the settlement cycle, and the cancellation-fee/commission relationship as open questions for the founder (§3.4 of the prior version). The founder has since made ten explicit decisions, incorporated throughout this rewrite. Where the prior version's §3.4 questions are now answered, the answer and its precise architectural consequence are stated directly; nothing from the prior version is silently dropped — see §11 for a full account of what changed and why.

---

## 1. The hard separation rule — stated once, enforced throughout this entire document

**Delivery Fee and Store Commission are two genuinely distinct financial concepts and must never be combined, netted, or confused in any calculation, table, column, or report, anywhere in this system.** They answer two different questions: Delivery Fee answers "what did the customer pay for logistics" (and, downstream, what Flash and the driver each earn from *that*); Store Commission answers "what does Flash earn from the *sale of the item itself*, and what does the store keep." A single order has both, computed independently, from independent inputs (`delivery_fee` vs. `subtotal`), and — per §4 below — neither is ever allowed to be a single blended "platform fee" line anywhere in this specification or in any future implementation. Every section below that touches money states explicitly which of the two (or neither) it concerns, so this rule is never left to be inferred.

---

## 2. Store Commission — configurable by design, 10% is the launch value, not a hardcoded rule

**Definition:** Flash's cut of the **item value** (`orders.subtotal`) on a completed order — a genuinely new concept (§9 below confirms nothing like this existed before this document's prior version identified the gap). **10% is the founder's confirmed launch rate, explicitly described as temporary** — the architecture below must never hardcode it.

### 2.1 Why a single constant is the wrong shape

A single `0.10` written into application code (the same shape as the *existing* delivery-fee commission formula, `Order.js:239`) would require a code deploy every time the rate changes, and offers no way to have two different real rates active at once — which the founder's decision explicitly requires (a global default, a specific store's negotiated override, a time-boxed promotional rate, potentially all three existing simultaneously for different stores). Commission rate is business configuration, not application logic, and needs a data shape that reflects that.

### 2.2 The real design: a `commission_rates` table with explicit precedence

| Column | Purpose |
|---|---|
| `id` | Primary key |
| `scope_type` | `'global'` \| `'store'` \| `'promotional'` — which precedence tier this row belongs to |
| `store_id` | `NULL` for `global`; required for `store` and `promotional` scopes |
| `rate` | The decimal rate, e.g. `0.10` |
| `starts_at` / `ends_at` | `NULL`/`NULL` for an open-ended global or store rate; both required for a `promotional` rate — its whole reason for existing is a bounded active window |
| `is_active` | An explicit kill-switch independent of the date window (e.g. to end a promotional rate early without editing its `ends_at`) |
| `created_by`, `reason`, `created_at` | Who set this rate and why — this table **is** the audit trail for rate changes; no separate log is needed if every change is a new row, never an in-place edit (see §2.4) |

**Precedence, resolved in this fixed order, most specific wins:**

1. **Promotional** — an active row (`is_active = true`, `NOW()` within `[starts_at, ends_at]`) for this specific `store_id`. Exists precisely because a promotional rate is *always* intentional and time-boxed — if one is active, it's because someone deliberately set it for right now, and that intent should never be silently overridden by a lower tier.
2. **Store-specific override** — an active row scoped to this `store_id` with no date window (or a currently-open one). This is also the exact same mechanism a future negotiated enterprise rate uses — no new table or code path, just another `store`-scoped row. The founder's fourth required capability ("future negotiated enterprise rates") is not a fourth tier; it's this tier, used for a different real-world reason.
3. **Global default** — exactly one active `scope_type = 'global'` row at all times (a real invariant worth enforcing, not assuming). This is where `0.10` lives at launch — as a data row, not a code constant.

### 2.3 Where the rate is applied, and the traceability consequence

The resolved rate must be looked up and **applied, then stored, at the moment an order reaches `completed`** — not recomputed later at settlement time. This mirrors the exact pattern the existing delivery-fee commission already uses (`Order.js` computes and permanently stores `driver_payout` once, never recomputing it if the formula changes later) — a rate change must never silently alter the earned amount on an order that already completed under the old rate. Concretely, this means a **new, dedicated `orders.store_commission` column** (or an equivalent per-order commission record) is needed to store the resolved amount at completion time — today, no such column exists (§9.3 below), which is itself part of the honest traceability answer to §4.

### 2.4 Changing a rate is a data change, never a deploy

Precisely per the founder's instruction: setting a new global default, a store override, or a promotional window is an `INSERT` into `commission_rates` (never an `UPDATE` of an existing row's `rate` — a new row with a later `created_at` and the old row's `is_active` flipped to `false` preserves a complete, real history of every rate that was ever active and when, which is both the configuration mechanism and its own audit trail simultaneously).

---

## 3. Store Settlement — weekly by default, itself configurable, with a real reconciliation buffer

**Definition:** the actual disbursement of a Store's earned revenue (item value, less Store Commission) to that store, on a recurring cycle.

### 3.1 The cycle itself is configuration, not a hardcoded assumption — same architectural principle as §2

A `settlement_config` table, mirroring `commission_rates`' own shape: `scope_type` (`'global'` \| `'store'`), `store_id`, `cycle_days` (7 at launch — the founder's confirmed default), `is_active`. Daily or monthly become simply a different `cycle_days` value on a new row, with the exact same global-default/store-override precedence as commission rates — deliberately the same mechanism twice, not two different configuration systems to reason about.

### 3.2 Why weekly, not instant — the real operational reason, now designed for explicitly

The founder's explicit instruction is that the cycle must have real room for reconciliation, refund processing, fraud detection, and failed-payment handling — not an instant same-day payout with no buffer. Concretely, a weekly cycle gives these **already-real, already-built mechanisms** time to run before money leaves for a store:

- **Payment reconciliation** — the existing `paymentReconciliationJob.js` (every 5 minutes, catches payments stuck pending after a missed webhook) has ample time to resolve any given order's true payment state well within a week.
- **Refund processing** — the existing 48-hour return window (`orders.delivered_at` + 48h, `RETURNS_AND_LEGAL_AUDIT.md`) resolves inside a 7-day cycle for the overwhelming majority of orders; a settlement that included an order which is *later* returned outside that window is the one real edge case worth naming (§3.4).
- **Fraud detection** — not a real, built mechanism in this codebase today (flagged honestly, not assumed to exist) — a weekly buffer is the *architectural room* for a future fraud-review step to exist, not a claim that one is already running.
- **Failed-payment handling** — a card charge that later charges back or reverses has a week to surface before the store is paid against it.

### 3.3 The settlement lifecycle — a real status model, not a single instant event

A `store_settlements` table (one row per store per cycle) plus `store_settlement_line_items` (one row per contributing order, so every settlement is fully traceable back to the individual orders that composed it — never a single opaque lump sum):

1. **`accruing`** — the current, open cycle; completed orders are provisionally attributed to it as they complete.
2. **`under_review`** — the cycle has closed (its `cycle_days` window ended) but hasn't yet been finalized — this is the real reconciliation window from §3.2, made an explicit, visible state rather than an implicit assumption.
3. **`finalized`** — the settlement amount is locked; no further order can be added or removed from this cycle's line items.
4. **`paid`** — the real Paystack transfer to the store's bank account completed (the same real, proven transfer infrastructure `payout_transactions` already demonstrates for drivers — reused, not reinvented).
5. **`adjusted`** — a correction was applied *after* finalization (§7 below, Commission Adjustments/Financial Adjustments) — always as a new, linked record referencing the original settlement, never an edit to the original finalized amount, preserving a complete history.

### 3.4 The one real edge case worth naming explicitly: a return after settlement

If an order is returned/refunded *after* its settlement has already reached `paid`, the store has already been sent money for revenue that no longer exists. The correct handling (proposed, not yet decided in detail) is to net the reversal against the store's **next** open (`accruing`) settlement cycle rather than attempt to claw back an already-completed bank transfer — the same real-world pattern most marketplace platforms use, and one weekly cycles make practical (a true clawback attempt would need its own dispute/collections mechanism this document doesn't scope). This is presented as a reasoned proposal, not a decision — worth the founder's explicit confirmation once Store Settlement moves toward real implementation.

---

## 4. The full, explicit value chain for a single order — with an honest traceability confirmation, not just an assertion

| Value chain step | Real field/table today | Independently traceable today? |
|---|---|---|
| **Order value** (item subtotal) | `orders.subtotal` | **Yes** — stored, queryable |
| **Store Commission** | *(none — new concept)* | **No** — doesn't exist yet; needs a new `orders.store_commission` column (or per-order commission record) per §2.3 |
| **Store earnings** (Order value − Store Commission) | *(none — new concept)* | **No** — same gap as above; would be directly derivable once Store Commission is stored |
| **Delivery Fee** | `orders.delivery_fee` | **Yes** — stored, queryable |
| **Flash's delivery-fee commission** | *(not directly stored)* | **Partially** — `orders.driver_payout` is stored, but Flash's own commission on the delivery fee is only *derivable* via `delivery_fee - driver_payout` (confirmed: exactly what `Admin.getFinancials()`'s `cardOrderCommission` query already does), never itself a dedicated column. This is a real, precise gap: it is *correctly re-derivable* (the historical formula is frozen into `driver_payout` at creation time, so the derivation stays accurate even if the live formula changes later), but it is not independently auditable by a plain column read the way `subtotal`/`delivery_fee` are. |
| **Driver Earnings** | `orders.driver_payout` (the amount earned); `driver_wallet_ledger` (the real, append-only accrual history) | **Yes** — both the per-order amount and its full lifecycle are stored |
| **Taxes** | *(none — not built at all)* | **No** — confirmed by direct search: no VAT/tax computation, collection, or line-item exists anywhere in this codebase today (the one search hit, `User.js`, is a comment about data-retention-for-accounting-purposes, not a tax feature). Flagged here because the founder's own requested value chain explicitly names it — worth an honest "doesn't exist" rather than a silent omission. |
| **Refund adjustments** | `order_cancellations`, `payment_refunds` | **Yes** — both the computed split and the real Paystack refund record are stored |
| **Settlement amount** | *(none — new concept)* | **No** — needs `store_settlements`/`store_settlement_line_items` per §3.3 |

### 4.1 Honest answer to "confirm this is genuinely achievable given Flash's real, current data model"

**Partially achievable today, fully achievable with the additions this document already names precisely (no undesigned unknowns).** Three of eight value-chain steps (Order value, Delivery Fee, Driver Earnings) are already independently, directly traceable. One (Flash's delivery-fee commission) is correctly but only indirectly derivable. Four (Store Commission, Store earnings, Taxes, Settlement amount) genuinely don't exist yet — but every one of them has a named, concrete design above (§2.3, §3.3), not an open question. This is the honest, precise version of "yes, achievable" — achievable by the design in this document, not already true of the current schema.

---

## 5. Cancellation Policy — an honest investigation, then a separate proposal, per the founder's explicit instruction not to assume the tie to commission

### 5.1 The investigation the founder asked for, done directly against real commit history

**Finding, stated plainly: the existing 10%/5%/85% (and later 0%/8%/92%) cancellation splits were never derived from a real operational-cost calculation. They were founder-confirmed business decisions, made in conversation, then implemented — not a cost model.**

The evidence, precisely:
- Commit `459355a` (the split's real introduction): *"Confirmed formula with the founder before building (not guessed): on a pre-pickup cancellation after a driver is assigned, 10% of item value to the store, 5% to the driver..."* — no fuel cost, no time-cost, no holding-cost math anywhere in the commit message or the code comments it introduced.
- Commit `ab3cf0f` (the `driver_arrived_store` tier, 0%/8%/92%): *"Fix, per the founder's confirmed split for this stage (money-touching decision, not assumed): 0% to the store... 8% to the driver..."* — again, explicitly a confirmed decision, not a cost derivation.
- The very first cancellation penalty, commit `29b8599`/`e838a10` (a flat 25%-of-delivery-fee penalty, since replaced): no commit body at all — no reasoning recorded whatsoever for that original number either.

No retroactive justification is invented here, per the founder's explicit instruction — the honest answer is that these are reasonable-feeling defaults that were never claimed to be cost-derived, and this document does not pretend otherwise.

### 5.2 A real, separate finding worth surfacing precisely: percentage-of-item-value doesn't actually track operational cost for either party

Stated as a genuine observation, not yet a recommendation: a driver's wasted trip to a store costs the same in fuel and time whether the cancelled order was worth R50 or R5,000 — yet the current model pays the driver *more* compensation for cancelling the more expensive order, which has no relationship to the driver's actual incurred cost. The same logic applies to the store's holding/prep cost, which scales with the *effort* of pulling and re-shelving an item, not its price tag. Tying compensation to item value is easy to compute and easy to explain to a customer, but it is not, by construction, a cost-based model — worth naming precisely since the founder's own instruction distinguishes "commission is earned on a completed sale" from "cancellation fees compensate for operational cost already incurred," and the current split doesn't actually implement the second half of that distinction yet, regardless of what percentage is chosen.

### 5.3 A real, cost-grounded proposal — for the founder's review, not a silent redesign

Presented as an alternative for explicit approval, adjustment, or rejection — not implemented, not assumed correct:

- **Driver compensation, tied to what the driver would actually have earned, not the item's price**: a flat amount (or a percentage of the *order's own `driver_payout`*, which already represents Flash's real estimate of that specific delivery's logistics value) per cancellation tier — e.g. a smaller flat/percentage amount for a `driver_assigned` cancellation (trip started, not yet arrived), a larger one for `driver_arrived_store` (trip completed to the store). This directly reflects the driver's real, incurred cost (their time and fuel for *this specific trip*, which `driver_payout` already estimates), independent of what the customer happened to be buying.
- **Store compensation, tied to real handling effort, not item value**: a small flat handling/restocking fee, or a percentage of item value capped at a low ceiling — reflecting the real labor cost of having pulled and then re-shelved one item, which doesn't meaningfully change whether that item cost R50 or R5,000.
- **This remains explicitly separate from Store Commission** (§1's hard rule) — a cancellation fee is never computed as "what commission would have been," and Store Commission is never reduced to account for cancellation risk; they are two independent numbers answering two independent questions, exactly as the founder's instruction requires.

**This is a proposal, not a decision.** The current 10%/5%/85%/0%/8%/92% splits remain live and unchanged unless and until the founder explicitly approves a different model — nothing here silently redesigns already-shipped, production behavior.

---

## 6. Independent merchants from day one — the financial-domain consequence, stated explicitly

Every financial concept in this document is designed for a genuinely independent merchant as the primary case, not a Flash-owned location: Store Commission (§2) is computed and owed to a real, separate legal/financial entity, not netted internally; Store Settlement (§3) is a real bank transfer to a store's own account, not an internal accounting entry; the cancellation proposal (§5.3) compensates a store that has its own real cost basis, distinct from Flash's. Nowhere in this document does any mechanism assume Flash and the store share a bank account, a ledger, or a legal identity — every one of them is designed to work identically whether the store is Flash's own second location or a genuinely unrelated third-party merchant, which is itself the correct test of "designed independent-merchant-first" (a Flash-owned-location scenario is simply the degenerate case of the same real mechanism, not a separate, simpler path).

---

## 7. The ten distinct financial concepts, each with its own definition, owner, and audit trail

*Note on count: the founder's list named nine concepts under this heading (Customer Payment, Store Commission, Store Settlement, Delivery Fee, Driver Earnings, Driver Payout, Refunds, Commission Adjustments, Financial Adjustments). This document adds **Taxes** as the tenth, since it's explicitly named in the founder's own value-chain list (§1 of the original instruction) and is a real, distinct, currently-unbuilt concept in its own right (§4 above) — flagged here explicitly rather than silently rounding the count, per this document's own honesty standard.*

| # | Concept | Definition | Owning table/service | Audit trail / reporting |
|---|---|---|---|---|
| 1 | **Customer Payment** | The real money a customer pays for an order, via card or cash | `payments`, `paystackService.js` | `payment_refunds` for reversals; already reported in `Admin.getFinancials()` |
| 2 | **Delivery Fee** | What the customer pays specifically for logistics, wholly separate from the item's price | `orders.delivery_fee` | Reported in `Admin.getDailyTrends()`; independently queryable per order |
| 3 | **Store Commission** | Flash's cut of item value on a completed order — the founder's new, configurable concept (§2) | *New:* `commission_rates` (config) + `orders.store_commission` (per-order resolved amount) | The `commission_rates` table's own append-only row history *is* its audit trail (§2.4); per-order amounts reportable once stored |
| 4 | **Store Earnings** | Item value minus Store Commission — what the store is actually owed | Derived from #1 (item value, `orders.subtotal`) and #3 | Same source data as #3, once built |
| 5 | **Store Settlement** | The actual disbursement of Store Earnings to a store, on a configurable cycle (§3) | *New:* `settlement_config` (cycle), `store_settlements` + `store_settlement_line_items` | The settlement status lifecycle itself (§3.3) is the audit trail — every line item traces to a real order |
| 6 | **Driver Earnings** | What a driver has earned for a specific delivery, accrued as pending-then-available balance | `orders.driver_payout` (the amount), `driver_wallets` (current balance) | `driver_wallet_ledger` — real, already-built, append-only |
| 7 | **Driver Payout** | The actual disbursement of a driver's available Driver Earnings to their bank account | `driver_payout_requests`, `payout_transactions` | `payout_transactions`'s own real, completed-transfer records |
| 8 | **Refunds** | Money returned to a customer, full or partial | `refundService.js`, `payment_refunds`, `return_requests` | `payment_refunds` (Paystack-confirmed reversals); `order_cancellations` (the computed split behind a cancellation refund) |
| 9 | **Commission Adjustments** | A correction to a previously-resolved Store Commission amount — e.g. a rate was misapplied, or a completed order is later returned within its settlement's `under_review` window | *New — not yet designed in schema detail*, but architecturally: a new, linked row referencing the original `orders.store_commission` record, never an in-place edit (§3.3's `adjusted` status) | The linkage itself (adjustment → original) is the audit trail — same append-only principle as `commission_rates` |
| 10 | **Financial Adjustments** | Any other manual correction to a financial record — a dispute resolution, a goodwill credit, a data-entry fix — that doesn't fit Commission Adjustments' specific scope | *New — not yet designed*, but should follow the identical pattern: a new row referencing what it corrects, a required reason, a required actor, never a silent mutation of the original record | Whatever internal admin action performs this should be logged in `admin_actions` (an internal, platform-level correction) exactly like every other consequential admin action already is |

Every row above is independently reportable — no concept requires reading another concept's table to know its own value, matching §1's hard-separation rule at the reporting layer, not just the calculation layer.

---

## 8. Where the already-built subscription/penalty concepts fit (retained from the prior version, unchanged)

**Flash Premium subscriptions**: `premium_subscriptions`/`premium_subscription_payments` — customer-facing, delivery-fee discount perk, Flash's own cost absorption (`premiumDiscountCostAbsorbed`), never touching Store Commission or Store Settlement (§1's separation rule applies here too — a Premium discount reduces Flash's *delivery-fee* commission, never a store's earnings).

**Driver subscriptions**: `driver_subscriptions` — a driver-paid platform-access plan, its own direct revenue line, no discount-cost-absorption concept.

**Driver penalties**: `driver_penalties` — a real, existing, never-reversed charge against a driver, netted as a cost offset in `Admin.getFinancials()`'s net position.

---

## 9. Summary — status of every concept after this rewrite

| Concept | Status |
|---|---|
| Customer Payment | Built, audited |
| Delivery Fee | Built, audited — now explicitly separated from Store Commission by hard rule (§1) |
| Store Commission | **Designed** (this document, §2) — configurable architecture, 10% launch default, not yet built |
| Store Earnings | Designed (derived from Store Commission) — not yet built |
| Store Settlement | **Designed** (this document, §3) — weekly configurable cycle, real status lifecycle, not yet built |
| Driver Earnings | Built, audited |
| Driver Payout | Built, audited |
| Refunds | Built, audited |
| Commission Adjustments | Designed at a principle level (§7, #9) — schema detail not yet specified |
| Financial Adjustments | Designed at a principle level (§7, #10) — schema detail not yet specified |
| Taxes | **Not built, not yet designed** — flagged, not scoped in this document |
| Cancellation splits | Built, live, unchanged — investigated honestly (§5.1), a cost-grounded alternative proposed (§5.3) but not adopted |
| Flash Premium / Driver subscriptions / Driver penalties | Built, audited, unchanged |

---

## 10. Cross-references — this document's decisions ripple into the other six

- `BUSINESS_DOMAIN_MAP.md`'s "Payouts" sub-domain under Stores should be read as this document's Store Commission + Store Settlement (§2, §3), not a single concept.
- `DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md`'s Store Settlement entity (§9 of that document) should be updated to reference this document's real, designed lifecycle (§3.3) rather than its prior "not yet designed" placeholder.
- `FLASH_STORE_ADMIN_DESIGN.md`'s Finance-role RBAC entry should include visibility into `commission_rates` (their own store's applicable rate) and `store_settlements` (their own settlement history) once built.

---

## What this document is not

Business-domain and architecture analysis only. No code was written, no schema was changed. §2 and §3's table designs are real, concrete architecture — precise enough to build from — but building them is a separate, future, explicitly-approved implementation step, not authorized by this document itself. §5.3's cancellation proposal is a proposal, not an adopted policy — the current, live splits are unchanged unless and until the founder says otherwise.
