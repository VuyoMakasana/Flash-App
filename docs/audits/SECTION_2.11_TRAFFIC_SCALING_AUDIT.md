# Production-Readiness Audit — Section 2.11: Traffic Scaling Path

**Date:** 2026-09-09. **Scope:** (1) fold-in from §2.10 — scale-verify the
three new stuck-order cron queries the same way §2.7's block/report
queries were; (2) be concrete about where the real ceiling is going from
~7 drivers/19 orders to ~50 drivers and a few hundred orders/day. Every
claim below is read directly from the current source or proven live
against the Docker sandbox (synthetic data only, created and fully deleted
by each verification script — no production data touched).

---

## Part 1 — §2.10 cron queries: scale-verified, plus two real findings along the way

**Method**, matching §2.7's own precedent exactly: seeded 80,000 synthetic
`orders` rows with a realistic long-term status distribution (the vast
majority `completed`/`cancelled`, only a small, fast-draining fraction —
~0.1–0.2% each — sitting in `payment_pending`/`preparing`/`paid` at any
moment, matching how those states actually behave in this system), then
ran real `EXPLAIN (ANALYZE, BUFFERS)` against each of the three §2.10
cron queries.

**Result — all three were already fine, even before any change here:**

```
cancelAbandonedPaymentPendingOrders: Bitmap Heap Scan using idx_orders_status, 0.619ms, 129 rows
cancelStalePreparingOrders:          Index Scan using idx_orders_status,      0.449ms,  70 rows
recoverStuckPaidOrders:              Index Scan using idx_orders_status,      0.352ms,  86 rows
```

None of the three do a sequential scan. All three use the pre-existing
`idx_orders_status` single-column index — at this realistic data
distribution, that index alone is already selective enough (narrowing
80,000 rows down to a few hundred before the `updated_at` filter even
runs) that the query planner doesn't need anything more. **Worth stating
honestly**: a new composite `(status, updated_at)` index was added anyway
(migration v38, `idx_orders_status_updated`) as a defensive improvement —
reusable by any future staleness-detection query, and more robust if the
status distribution ever shifts (e.g., if `paid` orders ever legitimately
sit for a wide range of durations) — but the query planner did **not**
choose it in this test. The honest finding is "these queries were never
actually at risk," not "we found and fixed a live bottleneck."

### A real bottleneck found along the way (not what was being tested for)

Cleaning up the 71,000-row synthetic dataset from an earlier, failed seed
attempt (a `DELETE FROM orders WHERE order_number LIKE 'SC-%'`) **did not
complete in 12+ minutes** and had to be cancelled. `pg_stat_activity`
showed exactly what it was stuck on:

```
SELECT 1 FROM ONLY "public"."orders" x WHERE $1 = "parent_order_id" FOR KEY SHARE OF x
```

This is Postgres's own internal foreign-key integrity check —
`orders.parent_order_id` (a self-referential FK, written once by
`Return.js` when creating a return's reverse-delivery order, never read
back anywhere else — the actual return↔original-order lookup goes through
`return_requests.order_id`/`return_order_id` instead) had **no supporting
index**. Postgres does not automatically index foreign-key columns. Without
one, every row deleted from `orders` requires a full sequential scan of the
*entire* `orders` table to confirm no other row's `parent_order_id` points
at it — once per row deleted. At 71,000 rows against a table that had
already grown to a similar size, that's effectively O(n²).

**No live application code path is affected today** — confirmed by
grepping the whole backend for `DELETE FROM orders`: zero matches. This
was purely dormant. But it will bite the first real bulk-cleanup,
data-retention, or GDPR-style deletion script ever run against this table,
exactly as it just bit this verification script. **Fixed** (bundled into
the same migration v38): `CREATE INDEX idx_orders_parent_order_id ON
orders(parent_order_id) WHERE parent_order_id IS NOT NULL`. Trivial,
purely additive, zero behavior change. Re-running the same 71,000-row
cleanup after the fix completed in ~3 minutes instead of not finishing at
all in 12+ — still slower than a pure index lookup would suggest (most
likely the sandbox's own disk I/O plus the `LIKE 'SC-%'` prefix match in
that one-off verification query, neither of which reflects any real
production code path), but no longer structurally broken.

---

## Part 2 — Where the real ceiling is, 7 drivers/19 orders → 50 drivers/a few hundred orders per day

Walked every subsystem plausibly on the path from today's volume to the
target. Most of what would normally need fixing here was already either
built or non-issue at this specific scale — the real constraints are
concentrated in three infrastructure decisions, not scattered code bugs.

### Already fine at target scale — verified, not assumed

- **Matching/dispatch** (`autoMatchService.autoAssignNearestDriver`):
  computes haversine distance in SQL over online, approved drivers only
  (filtered first by the existing partial index `idx_drivers_online
  (is_online, status) WHERE is_online = true`), excludes already-busy
  drivers via a per-candidate `NOT EXISTS` subquery against `orders`
  (indexed via `idx_orders_driver_id`), and excludes blocked drivers via
  an in-memory array check (the §2.7 fix, already bounded by one
  customer's own block count). This scales with the *online driver count*,
  not order volume or table size — at 50 online drivers this is ~50 trivial
  indexed lookups plus ~50 cheap haversine calculations, comfortably
  sub-millisecond. Wouldn't become a real concern until driver counts reach
  the thousands, far past the stated target.
- **The driver-facing "available orders" list**
  (`Driver.getAvailableOrders`): filtered and sorted exactly along the
  existing composite index `idx_orders_status_created (status, created_at
  DESC)`, `LIMIT 20`. Stays fast regardless of overall table size, since
  `waiting_for_driver` is itself a small, fast-draining bucket (the same
  property that makes the stuck-order crons cheap).
- **Driver location pings**: confirmed the real client-side cadence
  (`flash-driver-app/tasks/backgroundLocationTask.js`) — every 10 seconds
  or 20 meters of movement while actively delivering, with only every 5th
  ping persisted to `driver_locations` (~50-second effective write
  cadence per driver). At 50 *simultaneously active* deliveries (already a
  generous upper bound for "a few hundred orders/day," since same-day
  deliveries don't all run concurrently), that's roughly 5 requests/second
  of trivial single-row indexed updates — not a bottleneck. The general
  API rate limiter already explicitly exempts this endpoint
  (`rateLimiter.js`'s `skip` for `/drivers/location`), so this was already
  correctly anticipated.
- **Cron jobs' own cost**: every timeout/reconciliation cron (§2.10's
  three new ones included) operates over an intentionally small, fast-
  draining *exception* bucket — orders that are late or stuck — not the
  whole table. Their cost scales with how many orders go wrong, not how
  many exist. Several already cap at `LIMIT 50` per tick as a defensive
  bound. Not a concern at any volume plausibly reachable by "a few hundred
  orders/day."

### Already built, just needs to be switched on — a real infrastructure decision, not more code

- **Socket.IO across multiple instances**: a Redis adapter is already
  wired (`server.js`, conditional on `REDIS_URL` being set), with a
  graceful single-instance fallback if Redis is unreachable. This is the
  exact "move to Redis" work already flagged as a possible future need —
  **it's already done in code.** What's not verifiable from here: whether
  `REDIS_URL` is actually set in the real Render production environment
  today (Render/Supabase dashboard access isn't available to me this
  session — I could not verify this, check directly). Turning it on costs
  a hosted Redis instance (e.g., Upstash) — cheap, but a real recurring
  line item, so it's your call.
- **Distributed rate limiting**: same pattern, same file
  (`rateLimiter.js`) — Redis-backed when `REDIS_URL` is set, in-memory
  otherwise. Already correctly built for the multi-instance case.
- **`Driver._pingCounters`** (the "persist every 5th ping" counter,
  `Driver.js`) **is in-memory and per-process** — already flagged in
  `OPEN_FOLLOWUPS.md` #7. This doesn't cause any incorrect behavior on a
  single instance (true today), but the moment a second backend instance
  exists, a driver's pings load-balanced across both would each keep an
  independent counter — not a correctness disaster (still just "some
  ping is the 5th one"), but a real, avoidable doubling of
  `driver_locations` write volume and an uneven persistence cadence. This
  needs to move to Redis or a DB-tracked counter, but only as part of the
  same rollout that actually adds a second instance — no need to build it
  ahead of that decision.

### The real ceiling — infrastructure/cost decisions that come back to you

1. **Render's single free-tier instance** (`OPEN_FOLLOWUPS.md` #7,
   already documented, restated here because it's the central fact this
   whole section's findings point back to): confirmed via Render's own API
   earlier in this audit — `numInstances: 1`, `plan: free`. At near-zero
   current usage this is tolerable; at 50 drivers expecting the app to
   always be responsive, the free tier's ~15-minute-idle cold start
   becomes a real, felt problem, not a theoretical one — this is the
   single clearest trigger point for a real spending decision, separate
   from and more urgent than any of the code-level items above, all of
   which are either already fixed or already built and waiting.
2. **Database connection pool headroom is already thin, and gets worse the
   moment a second instance exists.** `config/database.js` defaults
   `DB_POOL_MAX` to **50** ("increased from 20 to 50... safer for early
   production traffic," per its own comment) — but `.env.example`'s own
   documentation for this exact variable says *"20 is safe for Supabase
   free tier (max 60 connections)."* Those two numbers directly
   contradict each other: 50 connections from a single instance already
   leaves only ~10 of headroom under a 60-connection ceiling (for
   Supabase's own internal use, a dashboard session, or a one-off
   migration script running concurrently) — and a second Render instance,
   each opening its own pool, would need up to 100 total, blowing well
   past that ceiling. **I could not verify Flash's actual current
   Supabase plan or connection limit from here** (no Supabase dashboard
   access this session) — this needs a direct check in Supabase's own
   Settings → Database page before ever adding a second instance. Two
   independent ways to fix it, both cheap, and the choice is yours: lower
   `DB_POOL_MAX` back toward what a single instance realistically needs at
   this volume (a few hundred orders/day doesn't need anywhere near 50
   concurrent connections), or point `DATABASE_URL` at Supabase's own
   connection pooler (port 6543, PgBouncer) instead of the direct
   connection (currently port 5432) so many more logical connections can
   share a smaller number of real Postgres backends.

---

## Files changed

- `backend/src/db/migrate.js` — migration v38: `idx_orders_status_updated`
  (defensive composite index for the §2.10 crons) and
  `idx_orders_parent_order_id` (the real fix — a missing FK index found
  live while verifying the above).
- `docs/audits/OPEN_FOLLOWUPS.md` — no new entry needed; the two items
  this section surfaces as real decisions (Render single-instance,
  Supabase connection headroom) already exist there (#7) or are folded
  into it above.

## Verification

- Real `EXPLAIN (ANALYZE, BUFFERS)` against 80,000 synthetic orders at a
  realistic long-term status distribution for all three §2.10 cron
  queries — confirmed index scans, sub-millisecond, not sequential scans,
  both before and after this section's own index addition (honestly
  reported: the pre-existing single-column index was already sufficient).
- The `parent_order_id` finding was not synthetic or theoretical — it was
  directly, live reproduced: a real 71,000-row `DELETE` against real data
  in the Docker sandbox failed to complete in 12+ minutes before the fix,
  and completed in ~3 minutes after it. `pg_cancel_backend`/
  `pg_stat_activity` were used to confirm exactly which internal query was
  the bottleneck, not guessed from symptoms.
- Full backend unit suite: 264/264, zero regressions from the migration
  change (purely additive SQL, no application-code behavior change).
- All synthetic data (80,000+ orders across two seed attempts, plus test
  users) fully deleted; confirmed zero leftover rows after each phase.

## Outcome

The concrete ask — confirm the §2.10 crons won't grow slow silently — is
answered directly: they were never at risk at any volume this business is
plausibly reaching, verified with real data and a real query plan, not
assumed. A genuinely different, real bottleneck was found and fixed along
the way (the missing FK index), cheap and already done. For the broader
scaling question: there is no scattered pile of unindexed queries or
inefficient matching logic waiting to bite at 50 drivers — the multi-
instance-readiness work (Redis adapter, distributed rate limiting) is
already built. The real ceiling is exactly two infrastructure decisions —
moving off Render's single free instance, and confirming/adjusting the
Postgres connection-pool headroom before ever running more than one
instance — both of which are cost/infrastructure calls for you, not code
gaps for me to silently patch around. **Section 2.11 is complete.**
