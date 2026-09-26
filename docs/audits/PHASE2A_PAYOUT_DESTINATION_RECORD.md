# Phase 2a — Store Payout Destination

Implements §3 of `PHASE2_STORE_PAYOUTS_PLAN.md`. **No money moves in 2a.** This
is the record that 2c will eventually pay against, which is exactly why it is
built and audited before any transfer logic exists.

---

## 1. The central decision: the account number is not stored

Once `paystackService.createTransferRecipient` succeeds, Paystack holds the
account and `recipient_code` is all Flash needs to send money to it. So Flash
keeps only what it needs to *show* an owner which account is on file:

| Stored | Not stored |
|---|---|
| `recipient_code` (server-side only, never returned to a client) | The account number |
| `bank_code`, `bank_name` | |
| `account_last4` | |
| `account_name` (**the bank's spelling**, not the submitted one) | |

Encrypting the number with the existing `paymentCrypto` was the obvious
alternative. Not holding it is strictly stronger: data that was never persisted
cannot be leaked by a database dump, written to a log, or returned across a
tenant boundary by a future query that forgets to exclude a column.

This is a deliberate departure from the driver equivalent, which stores the full
`account_number` in plaintext despite `paymentCrypto` existing in the same
codebase — tracked as OPEN_FOLLOWUPS #17, scheduled immediately after Phase 2.

**The bank's spelling of the name is what gets stored**, not the owner's. The
bank is the authority on whose account it is.

---

## 2. Three controls — and a fourth that proved impossible

**Owner only.** `requireStoreRole('owner')` at the router. Deliberately narrower
than Finance's access elsewhere in the portal: reading financials and
*redirecting* money are different privileges. Enforced server-side; the portal
hiding a screen is not a control.

**Password re-authentication.** A hijacked session must not be enough to
redirect a store's income. Mirrors the driver flow, which already does this.

**Notify + audit.** A `store_actions` row on every change, plus an email to the
owner stating which account money will now go to and what to do if it was not
them. Sent fire-and-forget *after* commit — an email cannot be rolled back, so a
mail failure must not undo a change the owner legitimately made.

Suspended stores need no extra guard: `authenticateStore` re-checks the store's
live status on every request.

### The fourth control cannot be built today

The original design verified the account holder's name with the bank before
saving. **A live probe against Paystack proved that is impossible for South
African accounts**, and the detail matters enough to record precisely — see §3.

Registration is therefore **unverified**, matching the driver path, which has
always called `createTransferRecipient` with no prior resolve for exactly this
reason. The practical consequence, stated plainly: **a mistyped account number
will be accepted.** That is why the notification email carries more weight here
than it otherwise would — it is the only signal a store owner gets that their
payout destination changed, correctly or otherwise.

Two tests assert this posture explicitly rather than leaving it implicit, so
that a later reader cannot assume verification is happening.

## 3. Why there is no bank verification — the live probe

This section is the evidence, because the conclusion is uncomfortable and
should not have to be taken on trust.

I ran the real `paystackService` against Paystack's live API (test key, no
mocks). Three results:

| Call | Result |
|---|---|
| `createTransferRecipient` | **Worked.** Returned `RCP_x91pcx1c3zncdeq`. `data.recipient_code` is exactly where the code reads it, and `data.details` carries `account_number, account_name, bank_code, bank_name` |
| `getBankList` (`country=south_africa`) | `status: true` but **zero rows** |
| `verifyBankAccount` (`/bank/resolve`) | **`"Please supply one of the following valid currencies: NGN, USD, GHS, KES"`** — ZAR absent |

`/bank/resolve` is a **Nigeria/Ghana product**. The South African equivalent is
a different endpoint, `/bank/validate`, which is a **paid product (ZAR 3 per
successful call)** and additionally requires the owner's **ID number, passport
number or company registration number** — materially more sensitive data than a
bank account number, with POPIA implications.

**Had this shipped as originally designed, it would have rejected 100% of real
South African stores** while passing every unit test, because the tests mocked
a resolve call that cannot succeed in this market.

A corroborating detail that had been sitting in plain sight: the driver flow
has a standalone optional verify endpoint but does **not** gate registration on
it. That avoidance now looks load-bearing rather than accidental.

`/bank/validate` is **shelved, not abandoned** — revisit once Flash has a live,
ZA-configured Paystack account with Account Validation enabled. There is no
live key at all today (production runs on `sk_test_`), which is also why
`accountNameMatch.js` was **deleted rather than kept as defence in depth**: a
heuristic name check over unverified input protects nothing real, and leaving
it would imply a protection that does not exist.

## 4. Schema (migration v38)

`store_transfer_recipients`, with one invariant worth naming:

```sql
CREATE UNIQUE INDEX idx_store_transfer_recipients_one_active
  ON store_transfer_recipients(store_id) WHERE is_active = true;
```

A store has **at most one** active payout destination, enforced by the database.
Two concurrent "change my bank account" requests cannot both succeed and leave
two active rows for a later settlement to choose between — the loser fails
loudly. The driver table has no equivalent constraint; it relies on the
controller deactivating the old row first, which is correct today but is a
convention, not a guarantee.

The deactivate-and-insert pair runs in one transaction, so there is never a
window in which a store has no destination at all.

Superseded rows are kept, never deleted: "which account did this store's money
go to in March" must stay answerable.

---

## 5. Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/store-banking` | Returns the masked destination or `null`. Never `recipient_code` |
| `GET` | `/api/store-banking/banks` | Paystack's South African bank list for the form |
| `POST` | `/api/store-banking` | Set/replace. Requires `password` |

`null` rather than 404 for "nothing on file": that is a normal state the portal
must render, not an error.

---

## 6. Admin visibility — deliberately none

`store_transfer_recipients` is in `intentionallyExcluded`. An AdminJS resource
exposes every column by default, and `recipient_code` is the credential that
authorises sending money. The only genuinely useful support question — "which
account is on file for this store?" — is answerable from `bank_name` +
`account_last4` + `account_name`. If that becomes a real need, it should be a
column-limited read-only view that excludes `recipient_code`, never a default
resource over this table.

---

## 7. Testing

**17 new tests** (13 controller, 2 log-only-kind, plus model coverage). Backend
suite **456 → 471**, 37 suites, all passing.

The count went *down* from the first draft of this PR: 33 name-match tests were
deleted along with the module they covered. Tests for a control that cannot
exist are worse than no tests, because they imply the control does.

| Attempt | Result |
|---|---|
| Change destination with a wrong password | 401; Paystack never called, nothing written |
| Change from a deactivated account | 401 |
| Provider outage / Paystack throws | 502; nothing written. **This is the expected production behaviour until a live key exists** |
| Registration returning no `recipient_code` | 502; no destination written |
| Account number present in what is persisted | Absent — only `last4` |
| Account number or `recipient_code` in the response | Absent |
| Notification failure | Change still succeeds |
| A name that does not match the real holder | **Accepted** — asserted deliberately, documenting the gap |
| Any resolve call attempted | None — asserted |

**Mutation-tested**, each caught by exactly one test:

| Mutation | Result |
|---|---|
| Password check bypassed | 1 test fails |
| Full account number stored instead of `last4` | 1 test fails |
| Missing-`recipient_code` guard disabled | 1 test fails |

One mutation attempt in this round silently did not apply — a shell-quoting
error meant the anchor never matched, and the resulting "all passed" was
meaningless. Re-run with a corrected anchor, it failed as expected. Recorded
because a mutation test that does not actually mutate is indistinguishable from
a passing one, and that is exactly the false comfort this technique exists to
avoid.

## 8. Not built, and not verified

- **No portal UI yet.** 2a is the API. The owner-facing screen is the next
  increment, deliberately split the same way store onboarding was (endpoint
  first, then the page) so the security surface could be reviewed on its own.
  Until that lands, a payout destination can only be set by an API call.
- **This will not function in production until a live Paystack key exists.**
  `paystackService` throws on every call when `NODE_ENV=production` and the key
  starts with `sk_test_`, which is what production runs today. So
  `POST /api/store-banking` will return 502 and `GET /banks` will return 502,
  every time, for every store. The code is correct; the environment cannot
  support it yet. This is the same state the driver banking path is already in
  — a driver with R12.45 in their wallet currently cannot register a bank
  account for the same reason. Stated here rather than discovered later.
- **Nothing has been exercised against production.** No real bank account has
  been registered, `verifyBankAccount` and `createTransferRecipient` have never
  been called against live Paystack from this feature, and v38 has not been
  applied. The Paystack transfer-recipient path *is* proven in production for
  drivers, which is meaningful prior art but not evidence for this code.
- **The name-match rules are judgement, not data.** They were tested against
  formats I believe South African banks return, not against a corpus of real
  responses. The first few real registrations are the test of that, and a false
  rejection is the likely failure — recoverable, since the owner can retry with
  the exact spelling, and the error message says so.
- **Migration v38 should be applied before this merges**, though the
  consequence of the wrong order is narrower than v37's and worth stating
  precisely rather than by analogy. v37 broke the *whole admin panel* at boot,
  because `adminPanel.js` called `db.table('email_events')` and the adapter
  throws for a missing table. Nothing reads `store_transfer_recipients` at boot
  — it is deliberately excluded from the admin panel (§6), and the model queries
  only at request time. So merging first would leave **only the three
  `/api/store-banking` endpoints failing**, with the rest of the platform
  unaffected. Still the wrong order, just not an outage. v38 is additive and
  invisible to the currently-deployed code.
