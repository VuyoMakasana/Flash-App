# Flash — Critical Flow & Edge Case Production Audit

Branch: `critical-flow-edge-case-audit` (off `main`, which includes the full admin panel build). Nothing pushed to `origin`.

Methodology, held throughout: read the real code first, live-test with real throwaway data (never fabricated results), report findings precisely before building anything — especially anything touching money — and stop after each section for explicit go-ahead. Section 0 (cross-referencing this document's ten items against the seven existing files in `docs/audits/`) was completed before any of the work below began; per its own instruction, this document does not re-list anything already fully covered elsewhere unless a genuine gap was found within it.

---

## §2.1 — Customer's phone dies/app closes after payment, before delivery

**Genuinely new finding, fixed.**

Confirmed live: order progress is entirely server-side. A customer going offline mid-order has no effect on the driver's ability to progress the order through every state, and reconnecting correctly re-hydrates the real current state via a fresh REST fetch — nothing depends on the customer's app having stayed open or connected.

**Real gap found**: once a driver marks an order `delivered`, nothing ever notices if it sits there indefinitely (customer unreachable to confirm, or the confirmation step silently fails) — the driver's payout stays pending forever with no one aware.

**Fix**: a new cron (every 30 min) flags any order stuck at `delivered` for over 2 hours (`stuck_delivery_flagged_at`, migration v23), mirroring the reasoning of the existing 45-minute reassignment cron. Never auto-completes anything — only flags, live-alerts the admin room (`fleet_alert`), and surfaces the flag directly in the Orders admin resource next to `status`.

Two follow-ups were deliberately deferred, not forgotten:
- **(b)** An admin force-complete override for a confirmed-stuck order.
- **(c)** An SMS OTP fallback for delivery confirmation when the app itself is unreachable.

Commit: `b243426`.

---

## §2.2 — Driver's phone dies/loses connectivity mid-delivery

**Genuinely new finding, fixed.**

Confirmed live: the 45-minute reassignment cron only covers `driver_assigned`/`driver_arrived_store` (pre-pickup) — by design, since once `picked_up`, the physical item is with that specific driver and reassignment doesn't make physical sense. Correctly, nothing reassigns post-pickup.

**Real gap found**: nothing detected a driver going silent post-pickup. The customer's tracking screen received a real timestamp on every `driver_location` socket event and discarded it — a stale position rendered identically to a fresh one, with zero indication anything was wrong.

**Fix**: `driver_location_updated_at` added to the order-detail query; the tracking screen now shows "Location last updated Xm ago" and repurposes the Live/Connecting badge to "Connection lost" past a 5-minute threshold. Admin-side: the same flag-for-review pattern as §2.1 (`driver_connection_flagged_at`, migration v24), a new 10-minute cron flagging any `picked_up`/`in_transit` order whose driver hasn't pinged in 25+ minutes.

**Real, separate bug found and fixed along the way**: `drivers.updated_at`/`orders.updated_at`/`created_at` are `timestamp without time zone` columns. A South African user's phone (UTC+2) would misinterpret the offset-less value via standard JS `Date` parsing, silently shifting "last updated Xm ago" by up to 2 hours. Fixed with an explicit `AT TIME ZONE 'UTC'` cast scoped to this one field — the broader schema inconsistency is reported in full in §2.10 below.

Verified live across 8 staleness-threshold cases and a real simulated 25-minute-silent driver. Commit: `4dbaaf8`.

---

## §2.3 — Cancellation policy

**Mostly already covered (pre-pickup split, confirmed working) — one real gap found and fixed.**

Confirmed precisely, as instructed:
- **No "store acceptance" stage exists** — single-vendor architecture, no such step in the state machine.
- **Post-payment/pre-assignment**: full refund. Correct, unaffected.
- **Post-driver-assignment (`driver_assigned`)**: the existing 10%/5%/85%+delivery-fee split — re-confirmed live, unaffected by this pass's changes.
- **Post-pickup** (`picked_up`/`in_transit`/`delivered`/`completed`): cleanly blocked with `409`, by design — matches the state machine, and post-delivery reversal is the separate returns flow.

**Real gap found**: cancelling once the driver had arrived at the store (`driver_arrived_store`) was completely broken, not just under-refunded. The mode string `'store_refund_no_delivery_refund'` (32 chars) exceeded `order_cancellations.refund_mode`'s `VARCHAR(30)`, so the `INSERT` threw, the whole transaction rolled back, and the customer got a bare `400` — a real order at this stage **could not be cancelled at all**. Separately, no refund-attempt branch existed for this mode even if the string had fit, and no driver compensation was credited despite the driver having made the actual trip — worse protection than the earlier `driver_assigned` stage's 5%.

**Fix** (founder-confirmed split, not assumed): 0% to the store, 8% to the driver, 92% of item value + full delivery fee to the customer. Renamed to `store_arrival_split` (fits the column), given its own refund-attempt branch and wallet-credit note.

Verified live for both card and cash orders — real split numbers, real wallet credit, real `order_cancellations` row, no crash. `driver_assigned`'s split integration test still passes unaffected. Commit: `ab3cf0f`.

---

## §2.4 — User/driver logs out during an active order

**Core mechanism confirmed sound — two real, secondary bugs found and fixed along the way.**

Confirmed live: logout is purely a token-revocation operation (`revoked_tokens`/`refresh_tokens`); it never touches order data. Both apps' entire authenticated navigator tree unmounts/remounts on the `isAuthenticated` transition, so re-login always triggers a fresh server fetch — no stale client cache survives a logout/login cycle. An active order reappears correctly, correctly assigned, fully actionable, no duplication — live-verified for both roles.

**Real bug found #1**: `app.use('/api/orders/', orderLimiter)` — meant to rate-limit order *creation* (5/min) — was a path-prefix mount, so it throttled **every** method under `/api/orders/*`: viewing orders, a driver's status updates, cancellation, photos, returns, all sharing the create-order budget, with a misleading "Too many orders created" 429. IP-keyed, so it could block unrelated users sharing an IP. **Fixed**: moved `orderLimiter` onto `POST /api/orders` specifically.

**Real bug found #2**: `drivers.is_online` stayed `true` after logout — a driver who logged out without first going offline stayed eligible for new order assignment while unreachable. **Fixed**: server-side, in `authController.logout()`, reusing the existing `Driver.setOnlineStatus()`.

Verified live: 6 rapid order-related GET/PUT calls all returned 200 (previously would 429 on the 6th); 6 rapid real `POST /api/orders` calls still correctly hit 429 on the 6th, confirming the creation limiter is intact, just correctly scoped. `drivers.is_online` confirmed flipping to `false` immediately on real logout. Commit: `ed678fc`.

---

## §2.5 — Driver payments

**Already extensively built and audited — the one known, real gap, fixed per explicit approval.**

The known bug ("a failed Paystack payout transfer after wallet deduction has no recovery path") was precise-ified via code reading: `finalizeSuccessfulPayout` deducts the wallet the moment Paystack reports transfer `'success'`. If Paystack later reverses that *same* transfer via `transfer.failed`/`transfer.reversed` (e.g. an invalid bank account), the existing `handleFailedPayout` only flipped statuses to `'failed'` — it never checked whether the wallet had already been debited. The driver's balance stayed permanently short even though the money bounced back into Flash's own Paystack balance.

**Fix** (founder-confirmed approach): auto-recredit the exact deducted amount — Paystack's own signed webhook is definitive proof the money never reached the driver, so this corrects a confirmed-wrong deduction, not a new payment decision — with a loud `[CRITICAL]` log line and a real `driver_wallet_ledger` entry (`payout_reversed_recredit`) for admin visibility, rather than requiring manual pre-approval.

Verified live: simulated an inline-success transfer (wallet 500→300), then fired the reversal for the same reference — wallet correctly recredited to 500, real ledger entry recorded, both `payout_transactions` and `driver_payout_requests` correctly flipped to `'failed'`. A transfer that never actually succeeded correctly leaves the wallet untouched. Commit: `922a918`.

---

## §2.6 — Driver availability before ordering

**Genuinely new finding, fixed.**

Confirmed live, definitively: with **zero** approved+online drivers in the entire system, `POST /api/orders` still returned `201`, reaching `payment_pending` with a real total — nothing in the checkout path, client or server, checked driver availability before accepting payment. The only existing safety net was the pre-existing 30-minute no-driver auto-cancel-and-refund cron, so money wasn't lost, but a customer could pay and then wait up to 30 minutes with zero warning before being auto-refunded.

**Fix** (founder-confirmed UX tradeoff): warn, don't hard-block — a brief lull in availability shouldn't cost a sale outright. New `GET /api/drivers/availability` (boolean-only, no PII) checked in real time right before payment; if zero drivers are online, a clear warning is shown with an explicit "Continue Anyway" / "Wait and check later" choice. Skipped for "pick a driver" mode, which already shows the real online driver list inline. A failed check fails open.

Verified live against real driver rows (temporarily toggled, restored in a guaranteed `try/finally`): `{anyOnline: false}` with zero online drivers, `{anyOnline: true}` once one comes online. Commit: `4cc3429`.

---

## §2.7 — Admin synchronization

**Already extensively built — the one requested gap, closed; one nuance deliberately deferred.**

`payments`/`payment_refunds` were previously "dashboard totals only" (`adminCoverage.js`'s own prior description) — real aggregate numbers, but no way to search or click into an individual transaction or refund, unlike driver payouts.

**Built**: both as real, fully read-only AdminJS resources, following the established pattern exactly (chronological sort, sensitive-field stripping, `suppressReference` for `user_id` since `users` can't be a registered resource). Found and fixed two small, real completeness gaps while in this exact code: `payments.status` has a real `pending_cash` value that was missing from the status-badge list (found live, screenshotted, fixed), and two real `driver_wallet_ledger.entry_type` values (one pre-existing, one from this pass's §2.5 fix) were missing from that resource's own badge list.

Verified live: real admin login, both resources return real per-transaction data with no crash and no leaked sensitive fields; a real browser screenshot confirms correct rendering, chronological sort, and status badges. Commit: `1229de1`.

**Deliberately deferred, not forgotten**: showing driver location live on an actual map inside the admin panel (the driver-location-on-map nuance) — a known, lower-priority gap, explicitly not addressed this pass per the founder's instruction.

---

## §2.8 — Driver ratings, abuse/fraud, Trusted Driver metrics

**Duplicate-rating prevention already sufficient; scorecard proposed, confirmed, and built.**

Confirmed: `driver_ratings.order_id` has a real DB-level `UNIQUE` constraint — a second rating attempt for the same order hits a genuine constraint violation, not a silent double-count.

**Proposed real metrics**, all derivable from existing data with no new tracking: average rating + ratings count, completed deliveries, cancellation rate (`cancel_count` vs. total assignments), penalty count/total, confirmed-trust count (`trusted_drivers` where `status='accepted'`), and customer-triggered SOS involvement (with an explicit caveat that this doesn't establish fault by itself). No time-based responsiveness metric — there's no granular per-status-transition timestamp log, so anything like "average pickup time" would conflate driver speed with distance/traffic.

**Founder's decision on placement**: admin panel only — an ops/quality-review tool, not driver-facing gamification.

**Built**: a `trust_scorecard` virtual field on the driver detail page, following the same show-hook pattern already used for the wallet summary. Verified live with real seeded data — every number in the rendered scorecard matched exactly. Commit: `18e9c3b`.

---

## §2.9 — Chat & calling reliability under poor conditions

**Already correctly designed — confirmed live, no fixes needed.**

- **Persistence & offline delivery**: messages are sent via plain REST, persisted to Postgres *before* any socket emit — the socket is a live-push nicety, never the delivery mechanism. Live-verified: a message sent while the recipient's socket was never connected at all is fully retrievable via REST once they check.
- **Read confirmation**: a real `read_at` timestamp is set server-side the moment the recipient fetches the conversation — live-confirmed. One minor, purely cosmetic gap: neither app's UI currently reads `read_at` to show a "seen" indicator to the sender (not a reliability bug — noted for awareness, not fixed).
- **Reconnection**: both apps use socket.io-client's untouched defaults (auto-reconnect enabled), and the chat-room-join logic runs inside the `'connect'` handler, which fires on every reconnection, not just the first.
- **"Calling"**: there is no in-app VoIP/calling feature — it's a plain `tel:` deep link handing off to the device's native dialer (`TrackingScreen.js:98`). Reliability under poor network conditions is the cellular network's responsibility, not something in Flash's own stack.

No commit — confirmation only, nothing needed building.

---

## §2.10 — Broad production-readiness sweep

Genuinely new findings only; nothing below duplicates anything in the other seven `docs/audits/` files.

### Medium — Naive (timezone-less) timestamp columns across 7 tables, 16 columns

Discovered live during §2.2. Full current scope, confirmed via `information_schema.columns`:

| Table | Naive columns |
|---|---|
| `drivers` | `created_at`, `updated_at` |
| `orders` | `created_at`, `updated_at` |
| `payments` | `created_at`, `updated_at` |
| `users` | `created_at`, `updated_at`, `terms_accepted_at` |
| `driver_documents` | `uploaded_at`, `verified_at` |
| `driver_locations` | `recorded_at` |
| `return_requests` | `created_at`, `updated_at`, `picked_up_at`, `pickup_scheduled_at` |

A naive timestamp's digits are correct UTC (the Postgres session timezone is confirmed `UTC`), but a client's JS `Date` constructor parses an offset-less string in *its own* local timezone — a real South African user's phone (SAST, UTC+2) silently misreads such a value by up to 2 hours. Confirmed live-impact on exactly one field this session (`driver_location_updated_at`, derived from `drivers.updated_at`, already fixed in §2.2 with a scoped `AT TIME ZONE 'UTC'` cast). Checked the remaining 15 for current real exposure: `orders`/`users.created_at` are only ever rendered as a date (not a time) in both apps' current screens, so the practical skew is invisible today; `return_requests.picked_up_at`/`pickup_scheduled_at` and all of `driver_documents`' timestamps are never read by either frontend app at all currently (schema-only, unused). None of the remaining 15 have a confirmed *live* misleading-display case the way `driver_location_updated_at` did.

**Recommendation**: a real, deliberate schema migration (`ALTER COLUMN ... TYPE TIMESTAMPTZ`, safe and non-destructive — Postgres correctly reinterprets existing naive UTC digits as UTC on this exact cast, since the session timezone is confirmed UTC) is the correct permanent fix, but this is a schema change affecting 7 tables and requires explicit approval per this project's own rules — not undertaken in this pass. The narrow, scoped-cast pattern used for `driver_location_updated_at` remains the right stopgap for any other field that becomes user-facing-time-sensitive before the migration happens.

### Confirmed negative — checked for the same rate-limiter-scoping bug elsewhere (§2.4)

`orderLimiter`'s bug (a limiter meant for one route mounted as a broad path-prefix, catching every method) was a real, distinct anti-pattern. Checked every other rate limiter in the codebase (`authLimiter`, `adminLimiter`, `otpLimiter`, `paymentLimiter`, `locationLimiter`, `trustRequestLimiter`) — all are applied as route-specific middleware on an exact `router.post`/`router.put`/`router.get` call, not a prefix mount. `authLimiter`'s broad `/api/auth/` mount is intentional, generic brute-force protection across all auth actions (its own comment says "Auth endpoints," not narrowed to one action) — not the same bug. No further instances found.

No commit — reporting only.

---

## Summary

| § | Status | Commit |
|---|---|---|
| 2.1 | Fixed | `b243426` |
| 2.2 | Fixed | `4dbaaf8` |
| 2.3 | Fixed | `ab3cf0f` |
| 2.4 | Fixed | `ed678fc` |
| 2.5 | Fixed | `922a918` |
| 2.6 | Fixed | `4cc3429` |
| 2.7 | Fixed | `1229de1` |
| 2.8 | Fixed | `18e9c3b` |
| 2.9 | Confirmed, no fix needed | — |
| 2.10 | Reported, no fix needed | — |

Deliberately deferred, not forgotten: §2.1's admin force-complete override and SMS OTP fallback; §2.7's driver-location-on-map nuance; §2.10's naive-timestamp migration (needs explicit approval before touching schema).

Every fix above was live-verified with real throwaway data against a running local backend, not asserted from code reading alone. Full jest suite held at 129/132 passing throughout this entire pass — the same 2 pre-existing, environmental failures (DB-pool contention against the live dev server; a wallet-mock ordering issue) reproduce identically whether or not this pass's changes are present, confirmed by stashing them out and re-running.
