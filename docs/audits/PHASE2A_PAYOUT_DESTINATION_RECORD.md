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

## 2. Four controls, each for a different failure

**Owner only.** `requireStoreRole('owner')` at the router. Deliberately narrower
than Finance's access elsewhere in the portal: reading financials and
*redirecting* money are different privileges. Enforced server-side; the portal
hiding a screen is not a control.

**Password re-authentication.** A hijacked session must not be enough to
redirect a store's income. Mirrors the driver flow, which already does this.

**Bank name verification.** `verifyBankAccount` resolves the holder's name from
the bank and it is compared against the submitted name, so a mistyped digit
cannot silently point settlement at a stranger's account. See §3.

**Notify + audit.** A `store_actions` row on every change, plus an email to the
owner stating which account money will now go to and what to do if it was not
them. Sent fire-and-forget *after* commit — an email cannot be rolled back, so a
mail failure must not undo a change the owner legitimately made.

Suspended stores need no extra guard: `authenticateStore` re-checks the store's
live status on every request, so a suspended store cannot reach any of this.

---

## 3. The name check, and why it is its own tested function

`utils/accountNameMatch.js`. Neither extreme was acceptable:

- **Exact equality** rejects most real accounts. South African banks return
  whatever form they hold: `MR JOHN DOE`, `DOE JOHN`, `J DOE`, `JOHN M DOE`. An
  owner typing "John Doe" would be refused their own account.
- **No check** means a mistyped digit sends settlement money to a stranger,
  discovered only when the store asks where its money went.

So it is lenient about form and strict about substance. Titles (`MR`, `DR`) and
company noise (`PTY`, `LTD`, `THE`) are stripped; apostrophes are removed so
`O'Brien` becomes `OBRIEN` rather than splitting into fragments; hyphens
separate. Then:

- **At least two components must line up**, so a shared first name alone is
  never sufficient — `John Doe` vs `JOHN` is rejected.
- **At least one must be a full exact match**, so a string of initials cannot
  pass — `J M D` vs `JOHN MICHAEL DOE` is rejected.
- **A single-token name** (a business whose name reduces to `THREADS` once
  `PTY LTD` is stripped) is accepted only when both normalized names are
  *identical* — the strongest evidence rather than the weakest.

Both bypasses were found by writing the tests first and watching them fail; the
initial implementation accepted both.

### The lookup-oracle problem

**The bank-held name is never echoed back on mismatch.** Returning it would turn
"set my payout account" into an account-holder lookup: submit any account number
with a deliberately wrong name and read the real holder's name out of the error
message. Paystack's resolve endpoint *is* such an oracle; Flash must not
re-expose it to a store-portal session. The match function therefore returns a
boolean, never a diff, and there is a test asserting the rejected name does not
appear anywhere in the response body.

---

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

**50 new tests** (33 name-match, 15 controller, 2 log-only-kind). Backend suite **456 → 506**, 38 suites, all passing.

Adversarial results:

| Attempt | Result |
|---|---|
| Change destination with a wrong password | 401; Paystack never called, nothing written |
| Change from a deactivated account | 401 |
| Account number that does not resolve | 400; nothing written |
| Real account, **different holder** (mistyped digit) | 400; nothing written |
| Read the bank-held name out of the mismatch error | Not present in the response |
| Legitimate bank formatting (`MR N DLAMINI` vs `Nomsa Dlamini`) | Succeeds |
| Provider outage | 502, never a silent success |
| Recipient registration returning no code | 502; no destination written |
| Account number present in what is persisted | Absent — only `last4` |
| Account number or `recipient_code` in the response | Absent |
| Notification failure | Change still succeeds |

**Mutation-tested** — each caught by exactly one test:

| Mutation | Result |
|---|---|
| Password check bypassed | 1 test fails |
| Name match bypassed | 1 test fails |
| Full account number stored instead of `last4` | 1 test fails |
| Bank-held name echoed back on mismatch | 1 test fails |

The bounce-visibility **drift guard also fired during this work**, which is
worth recording as evidence it does its job: adding
`STORE_PAYOUT_DESTINATION_CHANGED` to `EMAIL_SUBJECTS` without a
`TRACKED_EMAIL_KINDS` entry failed the test immediately. That prompted the right
question rather than a mechanical fix — this is the *most* important email to
bounce-track, because if it fails an owner never learns their payout account was
redirected. It is now tracked as a **log-only** kind: recorded in `email_events`
and visible in the admin Email Events list, without a third pair of
`store_users` columns that would establish a pattern that does not scale.

---

## 8. Not built, and not verified

- **No portal UI yet.** 2a is the API. The owner-facing screen is the next
  increment, deliberately split the same way store onboarding was (endpoint
  first, then the page) so the security surface could be reviewed on its own.
  Until that lands, a payout destination can only be set by an API call.
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
