# #21 — Product Price Integrity

Closes `OPEN_FOLLOWUPS.md` #21. Prioritised ahead of A3–A6 because it sits in
the commission calculation path, even though today's data is clean.

**Confirmed, not assumed:** `SELECT id, store_id, price FROM flash_inventory
WHERE price <= 0` returned **zero rows** on production (Vuyo, 2026-09-30). The
gap was real and unexploited.

---

## 1. The finding was bigger than "`addProduct` doesn't validate"

There are **four** write paths to `flash_inventory.price`, not one:

| # | Path | Auth | Guard before | Guard after |
|---|---|---|---|---|
| 1 | `storeInventoryController.addProduct` | store portal | **presence only** | shared validator |
| 2 | `storeInventoryController.updateProduct` | store portal | validated (PR #26) | shared validator |
| 3 | `inventoryController.addProduct` → `Inventory.addProduct` | admin REST | **`!price`** — rejects `0`, **accepts `-5`** | shared validator |
| 4 | **AdminJS generic `new`/`edit` form** | admin UI | **none** | **v40 constraint only** |

Path 4 is why this needed a schema change and not only code. `flash_inventory`
is one of only **two** AdminJS resources with `new`/`edit` enabled (drivers is
the other), deliberately, because admins are expected to edit inventory.
AdminJS writes columns directly through its generic form, so **no application
validator can ever reach that path.** The `CHECK` constraint is the only
possible guard on it.

## 2. Why the write path is the only place a bound can live

Nothing downstream re-validates an inventory price. For a Flash inventory item,
`Order.create` reads the row and trusts it (`Order.js:174-176`):

```js
// ── FLASH INVENTORY PATH: use server price, ignore client price ──
serverPrice = parseFloat(invRow.rows[0].price);
```

That is **correct** — the value is server-owned, not client-supplied.
`validateExternalItemPrice`'s bounds (`> 0`, `<= 100_000`) apply only to the
external/partner paths (`Order.js:202`, `:209`), which are disjoint from
inventory items.

So a bad price flows straight into `subtotal` → `total` → `store_commission`
with nothing in between. This correction was first recorded in
`STORE_PRODUCT_EDIT_AND_REACTIVATE_RECORD.md` §1, where an earlier claim had
the relationship backwards.

## 3. The change

**One rule, one home, three call sites.** `validateProductPrice` and
`validateProductCostPrice` live in `src/utils/helpers.js` beside
`computeCommission` — an existing module for pure money functions, not a new
file. Paths 1, 2 and 3 all call them, so they cannot drift.

Bounds match `validateExternalItemPrice`'s, so one business rule is applied
consistently at every entry point. That is **consistency, not defence in
depth**: the two guard disjoint paths and can never disagree.

### `cost_price >= 0`, not `> 0`

Zero-cost stock (donated, gifted, promotional) is real, and unlike `price` it
is never charged to anyone. `NULL` stays allowed and means "not recorded".

### A real bug fixed in the same change

`addProduct` did `cost_price || null`, so a submitted **`0` became `NULL`** —
`0` is falsy. `updateProduct` stored `0` as `0`. The same input therefore meant
"free to us" through one endpoint and "cost unknown" through the other, and
those compute differently in any margin figure. Both now agree, and a test
asserts they agree rather than asserting each separately.

## 4. Migration v40

```sql
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flash_inventory_price_positive'
  ) THEN
    ALTER TABLE flash_inventory
      ADD CONSTRAINT flash_inventory_price_positive CHECK (price > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flash_inventory_cost_price_non_negative'
  ) THEN
    ALTER TABLE flash_inventory
      ADD CONSTRAINT flash_inventory_cost_price_non_negative
        CHECK (cost_price IS NULL OR cost_price >= 0);
  END IF;
END $$;

COMMIT;
```

### Invariant vs policy — founder-confirmed

`price > 0` is in the schema; the **`100000` ceiling deliberately is not.** A
non-positive price is an invariant, never valid under any business model. The
ceiling is policy — a genuinely expensive item is conceivable — so it stays in
the application, where changing it is a deploy rather than a migration. A test
asserts the ceiling is **absent** from v40, so it cannot creep in later.

### Idempotency

`ADD CONSTRAINT` has no `IF NOT EXISTS`, so both are guarded with the
`pg_constraint` pattern already used by v36's `stores_status_check`
(`migrate.js:2338`). `migrate.js` is documented as safe to re-run; without the
guard a second run fails with `42710 duplicate_object`.

### Lock and scan

`ALTER TABLE … ADD CONSTRAINT … CHECK` takes **ACCESS EXCLUSIVE** and performs
a **full table scan** to validate existing rows, blocking all reads and writes
for the duration — and `GET /api/inventory` is the highest-traffic read in the
app. At the current size (~16 rows, Vuyo's figure; not independently verified
here) the scan is sub-millisecond and the endpoint's 60s cache masks it, so the
plain form is correct.

The `NOT VALID` + `VALIDATE CONSTRAINT` split — which takes only
SHARE UPDATE EXCLUSIVE and does not block traffic — starts earning its extra
complexity at tens of thousands of rows upward. Revisit then, not now.

### Failure mode

If any row violated either constraint, `ADD CONSTRAINT` **fails outright** and
the transaction rolls back. No row is altered, coerced or deleted; the
migration throws and stops. Checked beforehand: production has zero violating
rows, `migrate.js` seeds no `flash_inventory` rows, no integration test touches
the table, and `HOW_TO_RUN.md`'s example insert uses `2499.00` — so CI's fresh
database has an empty table and the constraints apply trivially.

### No deploy-ordering hazard

Unlike v36, the two halves are independent: the validators are safe without the
constraints and the constraints are safe without the validators. So
`OPEN_FOLLOWUPS` #16 (Render auto-deploying ahead of manual migrations) does
not bite in either order.

## 5. Why validating path 3 is not redundant with the constraint

Without the validator, a negative price on the legacy admin route reaches
Postgres, raises, and is caught by that controller's generic handler as a
**500** — a client error reported as a server fault, with no indication of
which field was wrong. The validator keeps it a 400. Pinned by test.

## 6. Testing

| Suite | Before | After |
|---|---|---|
| `productPriceValidation.test.js` (new) | — | 39 |
| `storeInventoryController.test.js` | 45 | 58 |
| `inventoryController.test.js` (new) | — | 10 |

Backend unit **535 → 597**, 39 → 41 suites, all passing. Reconciles exactly:
34 validator + 5 migration-shape + 13 + 10 = 62.

### Mutation testing — 13 mutations, 13 caught

All four touched files verified byte-identical (`md5sum -c`) after restore.

| Mutation | Result |
|---|---|
| `price > 0` → `>= 0` | caught (6 + 3) |
| price cap removed | caught (3 + 2 + 1) |
| rounding dropped | caught (4 + 2) |
| `cost_price >= 0` → `> 0` | caught (2 + 2 + 1) |
| `cost_price ''` no longer not-recorded | caught (1 + 1) |
| **addProduct price gate removed (the original bug)** | caught (7) |
| **`cost_price \|\| null` restored (the falsy-zero bug)** | caught (2) |
| raw body price written instead of parsed value | caught (1) |
| legacy admin gate removed (400 → 500) | caught (3) |
| v40 `CHECK (price >= 0)` | caught (1) |
| v40 idempotency guard removed | caught (1) |
| v40 ceiling added to schema | caught (2) |
| v40 `pool.end()` left on v39 too | caught (1) |

### An easy-to-miss wiring bug, caught

`await pool.end()` lived in **v39's** `finally`. Appending v40 after it would
have drained the pool before v40 could connect. Moved to v40's `finally`, with
a test asserting it appears exactly once — that test is what catches the same
mistake at v41.

## 7. Not verified

- **v40 has never been executed.** Docker Desktop will not start on this
  machine, so there is no local Postgres. The five migration tests are
  **source-text assertions** — bounds, both guards, ceiling absent, runner
  wiring, single `pool.end()`. They do not prove the constraints work. CI's
  `postgres:15` run of `npm run migrate` does, and applying to production is
  the real confirmation.
- **The `Order.js` drift guard is also source-text.**
  `validateExternalItemPrice` is module-private and cannot be called from a
  test, so that test asserts only that its literal bounds still read `> 0` /
  `100_000`. It prevents the two halves of one rule silently diverging; it does
  **not** prove the two functions behave identically.
- **The AdminJS path is untested end-to-end.** That a `CHECK` violation surfaces
  in the AdminJS UI as a raw Postgres error rather than a friendly message is
  reasoned, not observed. Ugly but correct, and strictly better than silently
  storing `-5`.
- **No negative-price order has ever been placed**, so the downstream effect on
  `total` and `store_commission` is reasoned from code, not observed.

## 8. Found while building this — NOT fixed here

`migrate().catch(...)` at `migrate.js:1152` runs at **module scope with no
`require.main === module` guard.** Any `require('./src/db/migrate')` — from a
test, a script, a stray import — executes *every* migration against whatever
`DATABASE_URL` is set.

This is why no test has ever imported `migrate.js`, and why v40's coverage here
is text-only rather than behavioural. A one-line guard would fix it and make
migrations genuinely testable.

Deliberately left alone: it is outside #21 and is a change to the migration
runner itself, which deserves its own decision. Raised with the founder.
