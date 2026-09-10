# Production-Readiness Audit — Section 2.13: Full Admin Visibility

**Date:** 2026-09-10. **Scope:** does every business-critical table/action
actually have a real, reachable admin-visibility path today — not just a
documented future intention. Every claim below is read directly from the
current source or proven live against the Docker sandbox (no production
data touched).

---

## Starting point: the existing coverage mechanism is sound

`adminCoverage.js` — a registry requiring every real table to have a
recorded admin-visibility decision (`covered` or `intentionallyExcluded`,
each with a real one-line reason) — already exists, backed by a real
integration test (`adminCoverage.test.js`) that fails the build if a
future migration adds a table nobody decided anything about. Ran it live
against the Docker sandbox's real schema: **all 3 checks pass** — every
table has a decision, no stale entries, nothing double-booked.

## The real finding: "covered" doesn't always mean "browsable today"

The registry's own header is explicit about this: `covered` records a real
*decision*, not necessarily a finished UI. Cross-referencing all 43
`covered` entries against the 18 resources actually registered in
`adminPanel.js` surfaced two tables carrying real, currently-accumulating
financial/dispute data with **no per-row browse path** — visible only as
an aggregate rollup:

- **`driver_commission_debts`** — real money owed to Flash by drivers.
  This is the exact data §2.8's commission-debt audit required querying
  raw SQL directly to investigate (finding and correcting 2 real
  production rows), because no admin UI existed to browse individual
  records — only a driver-page summary total
  (`attachWalletSummary`: "Cash commission owed: RX").
- **`driver_penalties`** — the record of driver auto-suspensions and
  fraud/reliability flags, including the detailed reason text §2.10's
  stuck-order cron writes (e.g. "Auto-suspended by system: cancel_count
  reached..."). Visible only as an aggregate count + total
  (`attachTrustedDriverScorecard`: "Penalties: 2 (R40.00 total)") — the
  actual reason for any individual penalty was invisible anywhere in the
  panel.

Both directly work against the "admin must be able to reconstruct exactly
what happened" principle this audit has enforced everywhere else (§2.4,
and this section's own name).

Two further items came up in the same pass, both correctly built (given
the founder's explicit direction toward comprehensive coverage):

- **`admin_actions`** — the admin panel's *own* audit log had no browse UI
  at all (`AdminAction.log()` writes to it from every custom action in
  this file; `AdminAction.getRecent()` was a real backend read path, never
  wired to a screen).
- **`driver_subscriptions`/`premium_subscriptions`** — real recurring
  revenue, already well served by platform-wide dashboard aggregates
  (`Admin.getFinancials()`'s totals/active-counts/revenue-trend chart),
  but no way to look up one driver's or customer's own subscription
  status/history.

---

## The fix: five real, read-only AdminJS resources, one list-column addition

All five follow the exact same established pattern already used
throughout `adminPanel.js` for every other read-only event-log resource
(`driver_wallet_ledger`, `driver_payout_requests`, `payout_transactions`)
— no new mechanism invented:

- **`driver_commission_debts`** — driver, order, amount, status
  (`outstanding`/`collected_wallet`/`collected_payout`/`waived`, a real
  badge via `availableValues`, confirmed against the actual `CHECK`
  constraint), created/settled dates.
- **`driver_penalties`** — driver, order, amount, the actual reason text,
  status, date.
- **`admin_actions`** — action type, admin, target table/id, date. Titled
  on `action_type` rather than `admin_id` (`admins` isn't itself a
  registered resource yet, so `admin_id` can't resolve to a readable name
  the way `driver_id` does elsewhere).
- **`driver_subscriptions`** — driver, plan, price, status, deliveries
  used/limit, expiry.
- **`premium_subscriptions`** — customer (via the same `attachUserNames`
  treatment every other `user_id` column in this file already uses, since
  `users` can't be a registered resource), price, status, dates.

All five: read-only (`new`/`edit`/`delete`/`bulkDelete` all
`isAccessible: false` — these are records of what already happened,
mutated only through their real application flows, never a raw admin
edit), run through `withChronologicalDefaults` with a real, correct
timestamp column (`created_at` for the three event logs;  `updated_at`
for the two subscription tables, which renew via UPSERT on the same row
rather than a new row per period — confirmed directly from
`Admin.getFinancials()`'s own comment on this exact point, same reasoning
already applied to `driver_wallets`).

**Plus**: `commission_blocked` added to the `drivers` list view — previously
only visible by opening a driver's own detail page, now impossible to miss
while scanning the list, the same "impossible to miss while scanning"
placement principle the orders list already uses for its own flag columns.

## Built for scale, not just for today

Per the explicit instruction to build this properly rather than just make
it work at today's volume: each of the five tables already had indexes
scoped to a specific driver/admin (`driver_id, status`, `admin_id,
created_at DESC`, etc.) but **none had a plain index on the column the new
resource's default global sort actually needs** — confirmed by checking
each table's real index list, not assumed. A resource's default
"most-recent-first" list view has no `WHERE driver_id = X` filter; without
a matching plain index, that sort would degrade to a full-table sort as
each table grows. Migration v40 adds the five missing indexes.

## Files changed

- `backend/src/db/migrate.js` — migration v40, five chronological-sort
  indexes.
- `backend/src/config/adminResourceDefaults.js` — the five new tables
  added to `RESOURCE_TIMESTAMP_COLUMNS`.
- `backend/src/config/adminCoverage.js` — the five entries' descriptions
  updated to reflect they're now real, built, browsable resources, not
  just scheduled decisions.
- `backend/src/adminPanel.js` — five new resource registrations,
  `commission_blocked` added to the drivers list view, a new
  `DRIVER_COMMISSION_DEBT_STATUS_VALUES` constant. Also: the
  `[AdminPanel] Mounted at ...` startup log line was a hardcoded string
  that had already drifted stale before this section (missing the
  marketing_* resources, added in an earlier pass) — found while doing
  this section's own live verification. Changed to build the list
  dynamically from the real registered resources (`resources.map((r) =>
  r.resource.tableName)`) instead of a hand-maintained string, so it can
  never drift again for this or any future resource addition — directly
  in scope for a "full admin visibility" section, and a one-line, zero-risk
  fix.

## Verification

- **`adminCoverage.test.js`** (integration, run inside the Docker
  container against the live schema, migration v40 applied): all 3 checks
  pass.
- **`adminChronologicalSort.test.js`** (unit): confirms every one of the
  five new resources has a real, correct default sort matching
  `RESOURCE_TIMESTAMP_COLUMNS` — this is the same enforcement mechanism
  that would fail the build had any of the five been registered without
  going through `withChronologicalDefaults`.
- Full backend unit suite: 276/276, zero regressions (this section adds no
  new *unit* tests of its own — AdminJS resource configuration in this
  codebase is verified by the two meta-tests above plus live verification,
  the same pattern already established for every prior resource addition
  in this file, not per-resource unit tests).
- **Live, against the Docker sandbox** (image rebuilt from the fixed
  source, migration v40 applied): the backend started cleanly with no
  crash, and the corrected startup log confirmed all five new resources
  genuinely mounted — `admin_actions`, `driver_commission_debts`,
  `driver_penalties`, `driver_subscriptions`, `premium_subscriptions` all
  present alongside the pre-existing 19 (24 total, up from 19). Ran real
  `EXPLAIN (ANALYZE, BUFFERS)` against each new resource's actual default
  list-view query (`ORDER BY <the real RESOURCE_TIMESTAMP_COLUMNS column>
  DESC LIMIT 10`, no filter — exactly what AdminJS itself runs): 4 of 5
  already use their new index at today's real (near-zero) row counts;
  `driver_commission_debts` (currently empty in the sandbox) correctly
  chose a sequential scan instead — the right, cost-based choice for a
  near-empty table, not a problem, and consistent with the real-scale
  index behavior already proven directly in §2.11 (the same index shape,
  verified against 80,000 real rows there). Confirmed all five new
  indexes exist via `pg_indexes` directly, not inferred from query plans
  alone.
- **Noted for the record**: Docker Desktop's engine went genuinely
  unresponsive partway through this section's live verification (confirmed
  independently via `docker version`/`docker buildx ls` all timing out with
  `context deadline exceeded`, while the underlying Docker Desktop
  processes were still running — a stuck internal state, not something
  these changes caused). Work paused rather than proceeding on unverified
  claims; resumed once the engine recovered on its own. No code was
  committed during the outage.

## Outcome

The existing table-coverage registry and its enforcement test were already
sound — no new tables were slipping through undecided. The real gap was
between "a real decision was recorded" and "an admin can actually browse
this today": two tables carrying real, currently-accumulating financial
and dispute data (`driver_commission_debts`, `driver_penalties`) were
aggregate-only, and two more (`admin_actions`,
`driver_subscriptions`/`premium_subscriptions`) had no per-row view at
all. All five are now real, read-only, chronologically-sorted, properly-
indexed AdminJS resources, verified live end-to-end — server startup, the
real resource list, and real query plans against the new indexes, not
just configuration asserted in isolation. **Section 2.13 is complete.**
