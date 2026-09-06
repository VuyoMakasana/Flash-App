# Phase 0.5 Remediation — Branch Record

**Date:** 2026-09-06. **Purpose:** a durable record of what's actually on
`fix/phase0.5-p0-p1-remediation` and `fix/phase0.5-store-inventory-lock` —
what each commit does, how it was verified, and what's deliberately still
open — so this doesn't depend on chat history surviving. Written before
pushing either branch; neither branch is merged into `main` as of this
writing (Render auto-deploys from `main` on every commit — merging is a
separate, not-yet-approved decision, not something pushing a branch does).

This follows on from the Phase 0 pre-implementation audit's P0/P1 findings
(F-01, F-04, F-05).

---

## Branch: `fix/phase0.5-p0-p1-remediation` (based on `main`)

Three commits, in order:

### 1. `e9b4de5` — F-01: redact the leaked Google Maps key from the audit doc

`docs/audits/PRODUCTION_READINESS_AUDIT.md` had the actual live
`GOOGLE_MAPS_API_KEY` value sitting in plaintext in a tracked, committed
file — a live exposure separate from (and worse than) the original
git-history leak both prior audits had already flagged. Replaced with a
placeholder in that file.

**This commit only stopped the file from being a second live copy of the
secret — it never rotated the key itself.** That's a separate, real
action, and (see the Google Maps key section below) it has since actually
happened, directly by the founder, independent of this commit.

### 2. `367bb08` — F-04 (stock reservation release) and F-05 (locked stock writes), platform-wide

**F-04.** `Order.create()` decrements `flash_inventory.stock_by_size` at
order creation, before payment ever clears. There was no release path
anywhere — an abandoned checkout or a declined card permanently lost that
stock. Added `Order.restockItems(orderId, client)`, wired into two places:

- `orderStateMachineService.updateOrderStatus()`, whenever a real
  transition to `cancelled` occurs. This is the one shared path every
  real cancellation already goes through (`cancelOrder`,
  `rejectPendingAcceptance`, the no-driver-timeout cron) — fixed once
  centrally instead of at each call site, and correctly covers cash
  orders too (cash never reaches the refund path a narrower fix might
  have hooked instead).
- `webhookController.handleChargeFailed()`, separately — a failed charge
  never transitions `order.status` at all (only `payment_status`), so it
  never reaches the hook above. Guarded against double-restock from a
  second failure event (e.g. `charge.failed` then `charge.abandoned` for
  the same order) via a tightened `WHERE` clause + `RETURNING` check.

**F-05.** `Inventory.updateStock()` was a bare, non-transactional
`UPDATE` with no lock — unlike `Order.create()`'s own decrement of the
same table. Wrapped in a real transaction with `SELECT ... FOR UPDATE`
first, matching the exact locking primitive already proven correct there.

**Verification (all against a local Docker Postgres sandbox — never
production):**
- Order creation decrements stock correctly.
- A simulated `charge.failed` webhook restocks correctly, and a second
  failure event for the same order does **not** double-restock.
- Cancelling via `updateOrderStatus` restocks correctly, and re-cancelling
  an already-cancelled order does **not** double-restock.
- The happy path (successful payment) does **not** trigger any restock.
- `Inventory.updateStock()` genuinely blocks while a concurrent
  transaction holds the row lock, and applies correctly once that lock
  releases.
- `Inventory.updateStock()` on a nonexistent product returns `null`
  rather than throwing.
- Full backend unit suite re-run clean after these changes (124/125 —
  the one failure is a pre-existing, unrelated issue in
  `driverCommission.test.js`, confirmed present on `main` before any of
  this work).

**Known residual gaps — not fixed, deliberately flagged rather than
silently left implicit:**

- **F-04:** an order that never receives *any* webhook at all (the
  customer abandons checkout before Paystack ever responds, so neither
  `charge.success` nor `charge.failed`/`charge.abandoned` ever fires)
  still has no cleanup path. It sits in `payment_pending` forever with
  its stock never released, and no existing cron targets this specific
  case (the closest one, the 30-minute stuck-`waiting_for_driver` cron,
  only fires for orders that already reached `paid`). A real fix needs a
  new cleanup job for orders stuck in `payment_pending`/`created` past
  some age threshold with no payment ever confirmed.
- **F-05:** both `Inventory.updateStock()` (this branch) and
  `storeInventoryController.updateStock()` (the other branch, below) take
  a **full replacement** of `stock_by_size`, not a per-size delta.
  Locking makes the write atomic and correctly ordered relative to a
  concurrent checkout — it does **not** stop a stale full-object
  submission (built from data read before a concurrent decrement landed)
  from overwriting that decrement's values once the lock is acquired.
  Fully closing this needs either per-size delta semantics or optimistic
  concurrency (reject the write if the row changed since it was read) —
  both real API/UI changes, out of scope for a locking fix.

### 3. `237b906` — DATABASE_URL production guard (founder-flagged, not from the original P0/P1 list)

Separate finding, surfaced while doing the above work: `backend/.env`'s
`DATABASE_URL` is the real production Supabase project, confirmed
directly (a read-only query against it matched real users, drivers, and a
known real order) — with nothing distinguishing local development from
production. Any local run was connecting straight to production with zero
separation or warning.

Added a startup guard in `config/database.js`: if `DATABASE_URL` matches
the known production Supabase project ref
(`env.js`'s `isKnownProductionDatabaseUrl` — keyed on the project ref
specifically, not the full connection string, so it survives password
rotation and isn't itself a secret) **and** this process isn't genuinely
running on Render, refuse to open the pool at all. Override via
`I_UNDERSTAND_THIS_CONNECTS_TO_PRODUCTION=true` for a real, deliberate
exception (a one-off admin/migration script) — named to require typing
out what's being done, not a flag set by habit.

**Why `process.env.RENDER`, specifically, and not `NODE_ENV`:** the first
attempt at this guard checked `NODE_ENV !== 'production'`, which looked
right — Render's real deployment does set `NODE_ENV=production`, so a
genuine production process would never trip it. But testing against the
actual, unmodified `backend/.env` showed it **also** has
`NODE_ENV=production` set, for local development. A `NODE_ENV`-based
check would have silently done nothing for exactly the environment it
most needed to catch. `process.env.RENDER` is different: Render sets it
to `"true"` automatically on every deployed service, with no
configuration required
(confirmed against Render's own docs: https://render.com/docs/environment-variables)
— nobody sets it by hand, and nothing to accidentally copy into a local
`.env` the way `NODE_ENV=production` evidently already was. It's a real
"am I actually on Render" signal instead of a self-reported flag that
had already proven unreliable in this exact codebase.

**Verification, all 5 cases, against a local Docker Postgres sandbox:**
1. A normal (non-production) `DATABASE_URL` loads untouched.
2. The production URL with no `RENDER` var set → throws.
3. The production URL with `RENDER=true` (the real Render shape) → loads
   with zero interference — confirms this can never block a genuine
   production deployment.
4. The production URL with the override flag set → warns, then loads.
5. **The actual, real, unmodified `backend/.env` loaded via `dotenv`**,
   with `RENDER` unset → throws. This is the case that matters: the exact
   file everyone's local machine already has correctly gets blocked.

Full unit suite re-run clean after this change too (same 124/125
baseline).

A second, separate dev/staging Supabase project (the founder's own
follow-up, not blocking this guard) removes the need for the guard to
ever actually fire in normal day-to-day use — this guard is the backstop
for if that never gets set up, or gets missed later.

---

## Branch: `fix/phase0.5-store-inventory-lock` (based on `multi-tenant-stage7-customer-storefront`)

One commit:

### `7e5e579` — F-05, Store Portal's equivalent write path

`storeInventoryController.updateStock()` — the Store Admin Portal's own
stock-edit endpoint — doesn't exist on `main` at all; it only exists on
the unmerged `multi-tenant-stage*` branches, so this couldn't be fixed
alongside the platform-wide version above and needed its own branch off
the active multi-tenant tip.

Same fix, same reasoning as the platform-wide version: was a bare,
non-transactional `UPDATE` with no lock; wrapped in a real transaction
with `SELECT ... FOR UPDATE` first, matching `Order.create()`'s locking
primitive.

**Verification**, live, through the real HTTP endpoint with real store
auth (against the local Docker sandbox, using the `ADV-TEST` stores/
products already seeded there from earlier multi-tenant testing — never
production):
- The endpoint genuinely blocks while a concurrent transaction holds the
  row lock, and applies correctly once released.
- Cross-store isolation still returns 404 (not 403) for a mismatched
  store, unaffected by the locking change.
- A nonexistent product still 404s correctly.

**Same residual gap as the platform-wide fix**, not solved here either:
full-object-replacement `stock_by_size`, not a per-size delta — see the
F-05 gap description above; it applies identically to this endpoint.

---

## Google Maps API key (F-01) — current real state, not the state at commit time

The `e9b4de5` commit above only redacted the leaked key from the audit
doc. Separately, and after that commit, the founder has since actually
rotated the key:

- Two new keys generated directly in Google Cloud Console (6 Sept 2026):
  "Flash User App - Android" and "Flash Driver App - Android", each
  restricted identically to the originals they replace (Maps SDK for
  Android only, same package name + SHA-1 fingerprint per app).
- Both new key values pushed to EAS (`eas env:update production
  --variable-name GOOGLE_MAPS_API_KEY`) for `flash-user-app` and
  `flash-driver-app` respectively, run directly by the founder (never
  passed through an assistant, by design).
- New Android builds completed successfully for both apps with the new
  keys — both `production` profile (app bundles) and `preview` profile
  (directly installable APKs, for on-device testing) — see
  `OPEN_FOLLOWUPS.md` for the one thing that had to change to get
  `flash-user-app`'s production build working (`SENTRY_DISABLE_AUTO_UPLOAD`,
  an unrelated pre-existing gap found along the way).
- iOS builds for both apps are still pending — blocked on a one-time
  interactive Distribution Certificate validation only the founder can
  do (`eas build --platform ios ...` run directly, not through an
  assistant).

**The two original keys ("Flash User App - Android" from 4 Jul, "Flash
Driver App - Android" from 5 Jul) are intentionally still active in
Google Cloud Console — not deleted, not further restricted.** This is
deliberate: any already-installed app build still depends on the old key
working. They stay active until the founder has confirmed, on a real
device, that the new preview builds' Maps functionality actually works —
only then do the old keys get deleted, closing F-01 for real.

---

## Cross-reference

Two unrelated items found while doing the Maps-key build work are tracked
separately in `docs/audits/OPEN_FOLLOWUPS.md`, not here: the temporary
`SENTRY_DISABLE_AUTO_UPLOAD` flag on `flash-user-app`'s production build
profile, and `flash-driver-app` never having `@sentry/react-native`
registered as an Expo plugin at all.
