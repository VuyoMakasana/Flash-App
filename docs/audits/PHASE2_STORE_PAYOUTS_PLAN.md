# Phase 2 — Store Payouts: Verified State and Implementation Plan

Companion to `FINANCIAL_DOMAIN_SPECIFICATION.md`, which remains the
authoritative design. This document records what is **actually true in
production today** (verified by direct query, not inferred from the migration
files, which have drifted before), the agreed phasing, and two corrections to
an earlier verbal audit of mine that was wrong.

---

## 1. Two corrections to my earlier audit

### 1.1 I said "no rate table exists". That was wrong.

`commission_rates` exists in production and **already holds a founder-confirmed
rate**, seeded by migration v31:

| Field | Value |
|---|---|
| `scope_type` | `global` |
| `store_id` | `NULL` (open-ended global, exactly as §2.2 specifies) |
| `rate` | `0.1000` |
| `starts_at` / `ends_at` | `NULL` / `NULL` |
| `is_active` | `true` |
| `reason` | "Launch commission rate (founder-confirmed, temporary) -- seeded by migration v31" |
| `created_at` | 2026-08-01 |

`store_settlements` and `store_settlement_line_items` also already exist, both
empty. Their columns match §3.3's design, including line items carrying
`item_value`, `store_commission` and `store_earnings` as three separate
columns — the "never a single opaque lump sum" requirement is already satisfied
at the schema level.

**Why I got it wrong:** I searched `src/` for code references and found none,
then reported "no rate table". Nothing in the application reads any of these
three tables, so a code search genuinely returns nothing — but the schema was
there the whole time. The correct statement is **"the rate table and a
founder-confirmed rate exist; no computation reads them yet."** The lesson is
the same one that caught the `stores.status` and `idx_orders_store_id` errors
earlier in this engagement: for questions about what exists, query the database,
do not infer from code or migrations.

**Consequence for the plan:** 2b is substantially smaller than I estimated. It
is mostly *logic*, not schema — a resolver, a column on `orders`, a stamp at
completion, and admin visibility.

**Is `0.10` stale?** No. Two independent sources agree: the seed row says
"founder-confirmed", and §2 of the specification independently states 10% as the
launch value. 2b uses the existing row rather than asking for a rate to be set
again. Note the seed's own word "temporary" — it is the launch rate, and §2.4's
mechanism (INSERT a new row, flip the old one's `is_active`) is how it changes,
never an in-place edit.

### 1.2 I said `store_paid` "already reads true for every paid order". Also wrong.

It is set `true` at exactly three sites, and **all three are card-payment
paths**:

| Site | Why it is card-only |
|---|---|
| `webhookController.js:172` | Paystack webhook; matches `WHERE id = $1 AND paystack_reference = $2`, sets `payment_method = 'card'` |
| `Payment.js:83` | Sets `payment_method = 'card'` |
| `paymentReconciliationJob.js:29` | Only iterates orders that have a `paystack_reference` |

A cash order never touches any of them, so `store_paid` stays `false` forever.

Verified against production: **19 orders, `store_paid` true on zero of them, and
zero `paystack_reference` values anywhere.** The only two completed/paid orders
are cash. So **no card payment has ever been processed in this database.**

The correct characterisation is **intended-but-unexercised**, not observed. And
the hazard is arguably *worse* stated that way: because every row reads `false`
today, the column looks like an unused flag that is free to adopt. The moment a
single card order completes it flips to `true`, and any settlement logic that
had adopted it would immediately conclude that store had been paid.

**The recommendation is unchanged: do not reuse it.** Tracked separately as a
naming/annotation fix (OPEN_FOLLOWUPS #18).

### 1.3 A third thing this surfaced, worth stating plainly

**The card payment path has never run end to end in production.** Commission and
settlement are overwhelmingly about card orders — a cash order collects at the
door, and `computeCancellationSplit` already treats cash as having nothing to
withhold. Phase 2 will therefore be built on, and must be tested against, a
payment path that has no production track record. That is not a blocker, but it
means 2c's adversarial testing cannot lean on "card payments already work in
production", because there is no evidence for that yet.

---

## 2. Agreed phasing — money moves only in the last step

| Phase | Contents | Money moves? |
|---|---|---|
| **2a** | Store payout destination (bank details) | No |
| **2b** | Commission: rate resolver, `orders.store_commission` stamped at completion, admin visibility | No |
| **2c** | Settlement: cycle job, line items, lifecycle, real Paystack transfers | **Yes** |

The ordering is the point. By the end of 2b every rand a store is owed is
computable and auditable, with nothing yet transferable — so 2c's risk is
confined to moving an amount that has already been independently verified,
rather than to deciding what that amount is *and* moving it in the same step.

---

## 3. Phase 2a design (approved)

**Do not store the account number.** After `paystackService.createTransferRecipient`
succeeds, Paystack holds the account. Flash needs `recipient_code` to pay, plus
`bank_name`, `account_last4` and `account_name` to display. Encryption would be
the fallback; not holding the data is strictly stronger — it cannot be leaked,
logged, or mis-scoped if it was never persisted.

This is a deliberate departure from the driver precedent, which stores the full
`account_number` in plaintext (see §5).

**Verify ownership before saving.** `paystackService.verifyBankAccount` resolves
the account holder's name from the bank. Compare it against the submitted name
and reject a mismatch, so a typo'd or someone else's account cannot silently
become a payout destination.

**Re-authenticate with the password** before any change. Drivers already do
this, and changing a payout destination is the highest-value action in the
store portal.

**Owner only** (founder decision). Not Finance, despite Finance seeing
financials generally — reading money and redirecting it are different
privileges.

**Notify on change**, with a `store_actions` audit row, so a real owner has an
immediate signal if it was not them.

Suspended stores are already blocked by `authenticateStore`'s live store-status
check, so no additional guard is needed there.

---

## 4. Decisions recorded

1. **Who may change the payout destination:** Owner only.
2. **Analytics revenue figure:** fixed immediately as its own PR, independent of
   2a/2b. Reported R649.00 against R379.00 of real item sales for the live
   store — a 71% overstatement.
3. **Return after settlement (§3.4):** net against the next cycle, **not** a
   clawback. **Open sub-question to document before 2c:** what happens when
   there is no next cycle to net against, because the store was suspended or
   closed in the interim. Suspension is now a real, reachable state, so this is
   not hypothetical.
4. **Driver plaintext bank numbers:** tracked remediation, scheduled
   immediately after Phase 2 wraps — not open-ended.

5. **A real card payment must run through production before 2c goes live.**
   Not a blocker for 2a or 2b. Confirmed platform-wide, not just for one store:
   **zero orders have ever had a `paystack_reference` or
   `payment_method = 'card'` — all 19 to date are cash.** So the entire card
   pipeline (checkout → Paystack webhook → `store_paid` → reconciliation) has
   no production track record whatsoever, and commission and settlement are
   almost entirely *about* card orders.

   This is a hard gate on 2c, held to the same standard as the onboarding
   email and the bounce webhook: verified live, not merely tested. What must be
   observed end to end, not inferred:
   - a real checkout reaching Paystack and returning a `paystack_reference`
   - the **webhook** arriving and being signature-verified (the only production
     evidence so far is that the *Resend* webhook works; Paystack's has never
     fired here)
   - `payment_status` reaching `'paid'` and `payment_method` becoming `'card'`
   - `store_paid` flipping to `true` — the first time it will ever have done so
     in this database, which is also the live confirmation of correction §1.2
   - `paymentReconciliationJob` leaving an already-settled order alone rather
     than double-processing it

   Note the ordering benefit: doing this before 2c means the first card order
   in Flash's history is a deliberate test with someone watching, rather than a
   real customer's purchase that settlement logic then has to reason about.

---

## 5. Carried into the follow-ups list

- **#17** — driver bank account numbers stored in plaintext.
- **#18** — `orders.store_paid` is a misleading name for "the customer paid by
  card", and a latent trap for settlement work.
- **#19** — `order_cancellation_store_shares` is write-only: money owed to
  stores from cancellations is recorded and never paid.
