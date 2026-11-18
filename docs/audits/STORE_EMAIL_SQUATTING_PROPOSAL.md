# Proposal — releasing a squatted store-owner email

**Status: proposal only. Nothing here is built.** Raised as §6.2 of
`STORE_ONBOARDING_FRONTEND_RECORD.md`.

Per the Architecture Decision Framework in `CLAUDE.md`, the seven questions
are answered explicitly in §5 rather than left implicit.

---

## 1. The problem

`POST /api/store-onboarding/apply` is public and unauthenticated by design.
It creates, in one transaction:

- a `stores` row — `status = 'pending'`, `is_active = false`
- a `store_users` row — `role = 'owner'`, `is_active = false`

Anyone can submit any email address. Nothing verifies that the applicant
controls it.

### Why that is more than cosmetic

Verified directly against production, not inferred:

| Fact | Evidence |
|---|---|
| `store_users.email` is **globally** unique | `store_users_email_key UNIQUE (email)` — unconditional, not per-store, not partial |
| The column is `NOT NULL` | `information_schema.columns` |
| Rejection **keeps** the rows | `StoreOnboardingService.reject()` sets status only; its comment says a delete "would silently free an address" |
| `store_users` has **no admin UI at all** | Not among the 25 registered AdminJS resources; listed in `adminCoverage.js` under `intentionallyExcluded` |
| Deleting the store row won't work either | `store_users_store_id_fkey` has **no `ON DELETE CASCADE`**, so the delete is refused while the owner row exists |

So: a malicious or careless application using `info@realboutique.co.za`
permanently prevents that business from ever onboarding, and **no admin can
currently undo it through any interface Flash owns**. The only remedy today
is a hand-written SQL statement against production.

Rejecting the squatted application does not help — rejection deliberately
preserves the row, and the unique constraint does not care about status.

### The deadlock, stated plainly

The current design has two goals in direct conflict:

1. A rejected applicant should not be able to immediately re-apply → keep
   the row.
2. A squatted business must be able to onboard → free the address.

With one unconditional unique index over all rows regardless of status, you
cannot have both.

### Gmail normalisation widens the blast radius

The route applies `normalizeEmail()`. Verified against the installed
`express-validator@7.3.2`:

| Submitted | Stored |
|---|---|
| `owner+anything@gmail.com` | `owner@gmail.com` |
| `ow.ner@gmail.com` | `owner@gmail.com` |
| `owner+tag@flashdelivery.co.za` | `owner+tag@flashdelivery.co.za` (unchanged) |

Gmail subaddressing and dots are stripped; other domains keep theirs. Two
consequences:

- **Good, and worth keeping:** nobody can farm unlimited store accounts from
  a single Gmail by adding `+1`, `+2`, … Each Gmail identity is one account.
- **Bad, and part of this problem:** squatting `owner@gmail.com` also blocks
  `ow.ner@gmail.com` and every `owner+…@gmail.com` variant. A squatted Gmail
  business cannot even work around it by applying under a tagged address.

It also means **a plus-addressed Gmail cannot be used as a throwaway test
address** — it consumes the real one. Any end-to-end testing must use a
genuinely separate mailbox.

### Severity

**Medium, not critical, today.** The controls that hold the line are the
5/hour/IP rate limit and the fact that a human reviews every application
before anything activates. But the damage is *silent and permanent*: the real
business hits "Application received" (the anti-enumeration response is
identical for a duplicate) and simply never hears back, with nobody at Flash
aware anything went wrong. It is exactly the class of bug that surfaces as
"why did that boutique never sign up?" months later.

---

## 2. Option A — an admin "Release email" action (stopgap)

Add an AdminJS action on the `stores` resource that tombstones the address:

```
  store_users.email  →  released-<store_user_id>@released.invalid
  store_users.is_active → false
  stores.status → 'rejected' (if not already)
```

`NOT NULL` rules out setting it to `NULL`, so the address must be *rewritten*
to something collision-proof. The original is preserved in `admin_actions`
(which already exists and is already admin-scoped) so the decision remains
auditable. `.invalid` is the RFC 2606 reserved TLD — guaranteed never to be a
real deliverable address.

**For:** additive, small, no change to any invariant, ships in hours, works
with the schema exactly as it stands.

**Against:** purely manual — it only helps once somebody at Flash realises a
squat happened, and the squatted business has no way to report it because
their own application looks successful. It treats the symptom. It also leaves
tombstone rows accumulating in the accounts table.

---

## 3. Option B — scope uniqueness by status (partial unique index)

Replace the unconditional index with one that ignores rejected applications.

Attractive at first glance — rejection *becomes* the release mechanism, with
no new admin tooling. But it does not survive contact with the details:

- A partial index cannot reference another table, and status lives on
  `stores`, not `store_users`. It would need a denormalised status column on
  `store_users`, kept in sync — new failure mode.
- It permits two *pending* applications for the same email. The conflict then
  surfaces at **approval** time, inside `StoreOnboardingService.approve()`'s
  transaction, which currently has no handling for it. Approval failing with
  a constraint violation is a worse failure than application failing.
- It quietly weakens an invariant other code may already assume
  ("one account per email, full stop").

**Not recommended.** It trades a visible problem for a subtler one.

---

## 4. Option C — separate `store_applications` from accounts (recommended)

### The actual root cause

`/apply` writes real `stores` and `store_users` rows for something that **is
not yet a store and has no account**. Squatting is a symptom of that
conflation, not an independent bug. An application is a *request*; an account
is a *grant*. Giving a request the uniqueness semantics of a grant is what
creates the deadlock in §1.

### Shape

A new `store_applications` table holding what the form collects
(`store_name`, `owner_name`, `owner_email`, `owner_phone`, `address`,
`status`, `reviewed_by`, `reviewed_at`, `rejection_reason`, `created_at`).

- `owner_email` carries **no global unique constraint** — at most a partial
  one over `status = 'pending'` to collapse accidental double-submits.
- `/apply` writes only here. It creates no store and no account, so it
  cannot consume an address.
- **Approval** creates the real `stores` + `store_users` rows in one
  transaction. Uniqueness is enforced there, against real accounts only,
  where it actually means something — and where a human is present to see a
  genuine conflict.
- **Rejection** is a status change. It blocks nothing and frees nothing,
  because nothing was ever reserved.

Squatting becomes harmless: a squatted application is a row in a review
queue, not a claim on an identity.

### What it costs

`stores` keeps its review columns (v36) for stores that predate this;
`StoreOnboardingService.approve()` moves from "flip flags" to "create rows";
the AdminJS review queue points at the new table. Real work, but bounded and
all in code paths written this week.

### Why now specifically

Production currently holds **1 store, 1 store_user, 0 pending applications**
(verified). There is no data to migrate. Every application accepted between
now and whenever this is done adds migration cost and, worse, adds real
addresses that may need releasing by hand. **This is the cheapest this change
will ever be, and it gets monotonically more expensive.**

---

## 5. The seven questions (Option C)

**1. What business problem does this actually solve?**
A real Gqeberha boutique being permanently unable to join Flash because
somebody else typed their email into a public form — silently, with no error
anyone sees and no way for Flash to fix it without hand-written SQL.

**2. Why is this better than extending the current design?**
Extending it means Option A: a manual lever that only works once someone
notices, for a failure specifically designed to be invisible. Option C
removes the possibility instead of adding a remedy. The unique constraint
stops being wrong because it stops being applied to the wrong thing.

**3. What trade-offs does it introduce?**
More code and one more table now. Two places describe a prospective store
during the transition (`stores` rows from before, `store_applications`
after), which must not drift. Approval becomes a creating operation rather
than a flag flip, so its transaction gets slightly more to do — though it
already runs in one and already handles partial-failure correctly.

**4. How does it behave at two stores?**
Identically to now. Neither store can see the other's applications;
applications aren't store-scoped data at all. No new tenant-isolation
surface.

**5. How does it scale to thousands?**
Better than the current design. Applications become an append-only queue
indexed on `(status, created_at)` — the same shape as `idx_stores_status_created`
— and reviewing them stops competing for rows in the live `stores` table that
serves the customer storefront. Under the current design, every unreviewed
application is a row in the table `/api/stores` reads on every request.

**6. How hard would it be to migrate away from later?**
Easy, and easier than the reverse. `store_applications` is additive; the
accounts tables keep their present shape. Abandoning it means stopping
writing to it — approved stores already live in `stores`/`store_users`
exactly as they do today. Nothing downstream (orders, payments, payouts)
references applications.

**7. Does it make the system easier or harder for future developers?**
Easier. "An application is not an account" is a sentence a new developer
understands immediately, and it makes the uniqueness rule obvious rather than
a trap. The present design requires knowing that a pending store is a real
`stores` row, that rejection keeps it, and that this silently consumes a
globally unique address — three non-obvious facts that must be held
simultaneously to avoid writing a bug.

---

## 6. Recommendation

1. **Do Option C.** It is the correct model, and the migration cost is
   effectively zero *today* and never lower again.
2. **Hold Option A in reserve.** If a squat is reported before C ships, the
   tombstone action is a few hours' work and buys time. Don't build it
   speculatively — it is a manual lever for an invisible failure.
3. **Independently of either**, consider whether the applicant should get an
   immediate acknowledgement email. It would let a squatted business discover
   the problem ("I never applied for this") instead of the current silence.
   Note the tension: sending mail from an unauthenticated public endpoint is
   an email-bombing vector, which is exactly why it isn't done today. Any
   such mail would need its own per-address throttle, separate from the
   per-IP one.

**This is a business-shaped call as much as a technical one** — how much
engineering to spend now against a risk that is currently theoretical — so
per `CLAUDE.md` it goes to the founder rather than being decided here.

---

## 7. Not verified

- No squat has been attempted against production, deliberately. Every
  assertion above about constraint behaviour comes from reading the live
  schema (`pg_constraint`, `pg_indexes`, `information_schema.columns`)
  directly, not from provoking a real collision.
- The claim that a `stores` delete is refused while an owner row exists is
  read from the FK definition having no `ON DELETE` clause. It has not been
  executed against production, and should not be.
