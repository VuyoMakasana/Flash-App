# A1 + A2 — Product Editing and Reactivation

Closes findings **A1** and **A2** of `PAYMENT_MODEL_AND_PORTAL_AUDIT.md` §5.
No money moves, no schema change, no migration.

| # | Finding | Closed by |
|---|---|---|
| A1 | Product price/name/description cannot be edited after creation | `PATCH /api/store-inventory/:productId` + portal Edit Details form |
| A2 | Nothing can be reactivated — no inverse for `deactivateProduct` or `deactivateStaff` | `PATCH .../:productId/reactivate`, `PATCH /api/store-staff/:staffId/reactivate`, + portal buttons |

---

## 1. Why A1 is not cosmetic

`store_commission = subtotal × rate`, stamped at completion (Phase 2b). Subtotal
comes from the product's price at checkout. Until now a price could be **set
once and never corrected** — a store that typed 4500 instead of 450 had no
route to fix it except asking Flash to run SQL, and every order placed in the
meantime stamped a commission off the wrong number.

That is why `price` is parsed and range-checked rather than passed through:

```js
const n = Number(v);
return Number.isFinite(n) && n > 0 && n <= 100000
  ? { ok: true, value: Math.round(n * 100) / 100 }
  : { ok: false, msg: '...' };
```

`> 0` not `>= 0` — a zero-price item would settle a store nothing and hand a
customer free goods. Rounding to whole cents happens here rather than letting
`NUMERIC(10,2)` truncate silently.

The bounds are **deliberately identical to `Order.create`'s**, verified
against the source rather than assumed (`backend/src/models/Order.js:48-58`
rejects `price <= 0` and `price > 100_000`). That gives a property worth
stating: **any price a store can save is a price an order can accept.** Had
this validator been looser, a store could save a product that then threw at
every checkout — a product visible in the catalog and impossible to buy, with
the error surfacing on the customer, not the store that caused it.

**Editing a price does not alter any existing order.** Orders freeze their own
`unit_price` at checkout and completed orders freeze `store_commission`. A
correction applies to future orders only, which is the correct behaviour and
also the reason the audit entry records the *previous* price — reconstructing
"what did this store intend, and when" is otherwise impossible.

## 2. The whitelist is the security boundary

The `SET` list is built from a fixed field map, never from the request body:

```js
for (const [field, validate] of Object.entries(EDITABLE_FIELDS)) {
  if (!Object.prototype.hasOwnProperty.call(req.body, field)) continue;
  ...
}
```

Iterating `EDITABLE_FIELDS` and looking each one up in the body — rather than
iterating the body — means an unknown key cannot reach the SQL at all. The
attack this blocks is `{"store_id": "<other store>"}` or `{"is_active": true}`
on the edit form: moving a product into another tenant, or resurrecting one,
through a field the UI never renders. Six fields are editable:
`product_name`, `price`, `cost_price`, `category`, `brand`, `description`.

Only fields **present in the body** are touched, so a partial PATCH cannot
blank a column the caller never mentioned. The portal relies on this: it sends
only what changed.

## 3. Tenant isolation and locking

`updateProduct` opens a transaction and takes a store-scoped `SELECT ... FOR
UPDATE` before writing, matching `updateStock`. The scoping is in the SQL, not
a prior check, so a mismatched store simply locks nothing and the handler
answers **404, not 403** — a 403 would confirm that another store's product id
exists. The `UPDATE` is scoped again independently.

`reactivateProduct` and `StoreUser.reactivate` mirror their deactivate
counterparts exactly, including the store scoping and the null-return-on-no-
match convention.

### Reactivation deliberately does not re-issue credentials

`StoreUser.reactivate` touches neither `password_hash` nor
`force_password_reset`. Reactivation is "undo the deactivation", not "issue a
new account", and the distinction is asserted by test.

### The self-deactivation guard still stands

`deactivateStaff` still refuses to deactivate the caller. A reactivate
counterpart now exists, but **only an Owner can call it** — so an Owner who
deactivated themselves would still have no self-service way back in. The reason
changed from "nothing can reverse it" to "only you could have reversed it"; the
lockout did not. The stale comment claiming no counterpart exists has been
corrected in both the controller and its test.

## 4. Error shape — a real contract, now pinned

The portal's `api.js` already normalizes `{ errors: [{ path, msg }] }` (express-
validator's shape) into per-field messages. This handler validates by hand, and
first emitted `{ field, msg }` — which that normalizer skips, so the portal
would have rendered an **empty** error. Changed to `path`, so hand-rolled
validation renders next to the offending input for free rather than through a
second code path.

Nothing but a test stops those drifting apart again, so there is one.

## 5. Portal UI — why it is in this PR and not a later one

A1 and A2 are store-owner-facing capabilities. Backend-only would leave two
real, reachable, untested-by-any-user endpoints and a portal where the gap the
audit found is still exactly as visible as before. That is the
"correct-but-unusable" outcome the payout-destination and driver-banking work
already hit twice; this avoids a third.

- **Inventory → Edit Details** — an inline form seeded with current values,
  submitting **only changed fields**. An untouched field is omitted entirely
  rather than re-sent, so a no-op save issues no request and cannot appear in
  the audit trail as a price change.
- **Inventory → Deactivated → Reactivate** — previously a read-only list with
  no action at all.
- **Settings → Deactivated → Reactivate** — same, for staff. No self-guard is
  needed: reaching Settings requires an active session, so a deactivated
  account can never be the one looking at the list.

No new dependency, no new component file, no styling beyond existing classes.

## 6. Testing

| Suite | Before | After |
|---|---|---|
| `storeInventoryController.test.js` | 20 | 45 |
| `storeStaffController.test.js` | 17 | 22 |
| `storeUserModel.test.js` | 13 | 16 |
| `InventoryPage.test.jsx` (portal, new) | — | 9 |

Backend unit total **502 → 535**, 39 suites, all passing.

PR #26's description says 532. That is a **stale** number rather than a
miscount: the full-suite run behind it happened *before* the last two
inventory tests were added, and I confirmed those per-file without re-running
the whole suite. Caught by re-running the suite rather than adding one to the
old figure, and it reconciles exactly — 502 + 24 (inventory) + 5 (staff) +
3 (model) = 534 at commit `b09adcf`, plus the mid-transaction test = 535.

### Mutation testing — 13 mutations, one genuine survivor

(One per row of the table below, so the count is self-checking. Earlier drafts
of this record and PR #26's description said "12"; that was a miscount on my
part — the re-runs of anchor-failed mutations are the same mutations, not
additional ones.)

Every mutation asserts its own anchor count first, because a mutation that
fails to apply is indistinguishable from a passing suite. That check earned its
keep immediately: **five of the first nine anchors matched zero or two times**,
not because the code was right but because the source files are CRLF and my
multi-line anchors used `\n`. Re-run with normalised anchors, all five applied.

| Mutation | Result |
|---|---|
| Locked read not scoped by `store_id` | caught |
| `UPDATE` not scoped by `store_id` | caught |
| Field whitelist bypassed (body keys drive the SET list) | caught (2 tests) |
| Price lower bound `> 0` → `>= 0` | caught (2 tests) |
| `FOR UPDATE` removed | caught (9 tests) |
| Audit metadata drops the previous price | caught |
| `reactivateProduct` not scoped by `store_id` | caught |
| `reactivateProduct` leaves the catalog cache stale | caught |
| `StoreUser.reactivate` not scoped by `store_id` | **SURVIVED** → fixed |
| `StoreUser.reactivate` also clears `force_password_reset` | caught (after fix) |
| `StoreUser.reactivate` sets `is_active = false` | caught (after fix) |
| `updateProduct` catch no longer rolls back | caught |
| `updateProduct` never releases the client (pool leak) | caught |

**The survivor was real and is worth stating plainly.**
`storeStaffController.test.js` mocks `StoreUser` wholesale, so no controller
test could ever see the model's SQL — a tenant-isolation invariant had zero
coverage while looking fully covered. Closed by three tests at the model layer,
where `storeUserModel.test.js` already pins `deactivate` the same way. All
three mutations are caught now.

The last two rows came from a later self-review, not from a failure.
`updateProduct` had no mid-transaction-failure test although `updateStock` has
one for the identical `BEGIN` / `FOR UPDATE` / `COMMIT` shape. The 500 is the
least interesting part of it; what the test actually protects is that a
rolled-back edit leaves behind **neither a cache flush nor an audit entry**. A
stray `product_update` row there would be worse evidence than none — a record
of a price change the database discarded, sitting in the exact table a store
would cite in a commission dispute.

Both mutation rounds verified the source files byte-identical (`md5sum -c`)
after restore.

### An intermittent portal failure, and why the fix is not a band-aid

The first full-portal run after adding `InventoryPage.test.jsx` failed **three
tests in `SetPasswordPage.test.jsx`** — a file this change does not touch. Run
in isolation it passed 9/9; the very next full run passed 49/49 with no code
change between them.

`userEvent` types character by character, so one form fill legitimately costs
2–4 seconds in this environment. A sixth test file raised parallel contention
past the line. Roughly one full run in two went red.

**My first diagnosis was wrong, and the second run proved it.** I attributed it
to testing-library's 1000 ms `waitFor` default and set
`configure({ asyncUtilTimeout: 5000 })`. Three more full runs: still one
failure. The binding constraint is **vitest's own 5 s per-test `testTimeout`**,
which caps `waitFor` regardless of what it is configured to — a test killed at
5 s never gets the longer budget. Fixed properly with `testTimeout: 20000` in
`vite.config.js`. The `asyncUtilTimeout` line stays because it is still
correct and must sit below the test budget to produce a useful error rather
than a bare timeout.

Worth stating plainly: had I stopped at the first fix and re-run once, it would
probably have passed and I would have reported the flake as solved.

**Neither change weakens an assertion.** An expectation that would never become
true still fails, later. What is removed is the failure mode where CI goes red
for reasons unrelated to the change under test — which is exactly how a real
regression later gets dismissed as "probably just flaky".

The fragility pre-existed and was exposed rather than introduced, but the
exposure is mine, so the fix ships here.

## 7. Not verified

- **Nothing has been exercised against production.** No product has been edited
  or reactivated on the live portal; the evidence is unit, component and
  mutation tests only.
- **The portal build was not deployed.** Verified by `vitest` and by the CI
  job added in PR #15, not by a browser against the live backend.
- **No integration test** covers the new routes end-to-end through Express —
  consistent with the existing store-portal route tree, which has none either.
- **The backend integration suite was not run locally.** Docker Desktop will
  not start on this machine ("Docker Desktop is unable to start"), so no
  Postgres was available; `tests/integration/*` needs a live `DATABASE_URL`.
  Only `tests/unit` ran locally (**535 passing**, 39 suites).
  **Since resolved by CI** — `Backend — Lint & Test` passed in 1m2s on run
  `36349384465`, which runs migration + unit + integration against its own
  `postgres:15` service and enforces the coverage thresholds (60% branches /
  70% functions / lines / statements). All four jobs green, including
  `Store Portal — Test & Build` in 20s.
- **Cache invalidation is asserted as a call**, not observed evicting a real
  Redis key.
