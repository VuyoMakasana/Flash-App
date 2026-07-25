# Flash — Admin Panel Audit and Vision

**Date:** 2026-07-25
**Scope:** A precise, evidence-based audit of everything that currently exists under the "admin" umbrella across `backend/` (routes, controllers, models, DB schema) and `backend/public/admin/` (the actual UI), followed by a full gap analysis against every real domain this app has data for, and a phased build recommendation.
**Method:** Direct source reading of every admin-gated route, its controller, and its model — not inference from file names. Every claim about what's "wired up" vs. "backend-only" vs. "doesn't exist at all" is backed by a specific file:line citation below. **One explicit limitation: this session has no admin credentials (`ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_PASSWORD_HASH` are Render-only env vars, never shared in chat), so nothing here was verified by actually logging into the live admin page and clicking through it.** Where that matters, it's called out. Everything else — whether an endpoint is real, whether it's called from the UI, whether the underlying query does what it claims — was verified by reading the actual code and, for a couple of claims about production data shape, live unauthenticated/authenticated API calls against `flash-app-hplc.onrender.com` earlier this engagement (cited where reused). This is a planning document only — nothing described here has been built as part of producing it.

---

## 1. What currently exists, precisely

### 1.1 The UI itself

`backend/public/admin/index.html` + `admin.js` is a single static page, no build step, no framework — vanilla `fetch()` calls against real REST endpoints, token kept in `sessionStorage`. It has exactly **two** features, and both are real, not stubs:

1. **Returns queue** (`admin.js:210-218`, `269-308`) — lists pending/dispatched returns via `GET /api/returns/admin/pending`, with working **Approve** (dispatch), **Reject**, and **Finalize refund** actions that call the real `returnController.js` endpoints already audited earlier this engagement. Confirmed real: these are the same endpoints that create a genuine reverse-delivery order and call `RefundService.refundOrderPayment` — not a fake success toast.
2. **Pre-pickup cancellations view** (`admin.js:220-267`) — read-only table via `GET /api/admin/cancellations`, showing the real store/driver/customer split recorded by tonight's cancellation-split feature. Real, correctly wired, no gap.

That is the entire UI. There is no navigation, no other page, no user list, no driver list, no order list, no stats — despite all of those existing at the backend layer (below).

### 1.2 Backend admin capability that exists but has zero UI

This is the single most important finding in this section: **the backend already has substantially more admin capability than the page exposes.** Specifically, in `adminRoutes.js` + `adminController.js` + `Admin.js`:

| Endpoint | Real? | Called from admin.js? |
|---|---|---|
| `GET /api/admin/drivers` (list, filterable by status) | Yes — real query, `Admin.js:5-12` | **No** |
| `GET /api/admin/drivers/:driverId` (full profile + documents via signed URLs) | Yes — `Admin.js:14-43` | **No** |
| `PUT /api/admin/drivers/:driverId/status` (approve/reject/under_review) | Yes — `Admin.js:45-50` | **No** |
| `GET /api/admin/orders` (last 100, with customer/driver names joined) | Yes — `Admin.js:52-62` | **No** |
| `GET /api/admin/stats` (total users, approved drivers, total orders, total revenue) | Yes — `Admin.js:90-106` | **No** |

The driver-document viewer is a particularly concrete example worth calling out by name, since it's exactly what the founder's earlier engagement fixed: `Admin.getDriverById` (`Admin.js:27-40`) generates fresh, short-lived signed URLs per document at request time — the permanent-URL leak this same engagement closed. **That fix is real and correct at the API layer, but there is no admin-panel screen that calls this endpoint at all.** An admin reviewing a driver's documents today has no way to do it through the panel — only via a raw API call.

### 1.3 Backend admin capability elsewhere in the codebase, also with zero UI

Outside `adminRoutes.js`, there's real, working, admin-role-gated capability the panel never touches:

- **Inventory management** — `POST /api/inventory`, `PATCH /api/inventory/:productId/stock`, `DELETE /api/inventory/:productId` (`inventoryRoutes.js:15-34`), all `requireRole("admin")`, all backed by real, correctly-scoped writes in `Inventory.js`. Zero UI.
- **Flash Fleet demand-clustering** — `GET /api/fleet/clusters`, `POST /api/fleet/run` (`fleetRoutes.js`), a real analytics feature that clusters live `browsing_events` by category/city to find demand hotspots and reports nearby available drivers for each (`fleetIntelligenceService.js:9-40`). Deliberately admin-only, informational-only (never pushes to drivers directly, per its own comment). Zero UI — an admin has no way to see this without calling the API directly.
- **Boost / store-promotions system** — `boostRoutes.js`, `Boost.js`. Confirmed still true, re-verified this pass: `purchaseBoost`/`createPromotion` only insert rows into `store_boosts`/`store_promotions`. Nothing in `Order.js`'s price computation, `inventoryController.js`, or the user app's product listing ever reads `discount_percent` or applies a boost's ranking effect — confirmed by re-reading `Order.create()`'s full server-side pricing logic (no reference to either table). **This remains purely decorative**: money can be recorded as "paid" for a boost or promotion that has zero functional effect on anything a customer sees. This is exactly the kind of gap a real admin panel would surface immediately (a founder looking at "active boosts" next to "search ranking" would notice nothing changes) — flagging it again here because it's still true.

### 1.4 Capability that doesn't exist at all — not backend, not UI

- **SOS alert visibility.** `sosController.trigger` (`sosController.js`) inserts a real row into `sos_alerts` and emits a live Socket.io event to an `'admin'` room — but `SosAlert.js` (`SosAlert.js:1-17`) has **exactly one method: `create`.** There is no `getAll`, no `acknowledge`, no route anywhere to list or acknowledge alerts. The schema clearly anticipated this being built — `sos_alerts.acknowledged_at`/`acknowledged_by` columns exist, and there's even a purpose-built partial index (`idx_sos_alerts_unacknowledged ... WHERE acknowledged_at IS NULL`, `migrate.js:981`) sitting unused. **In practice: if an admin isn't watching a live Socket.io connection to the `'admin'` room at the exact moment an SOS fires, that alert is gone from any accessible UI or API forever** — still in the DB, but nothing can read it back out. This is the single most safety-relevant gap in this whole audit.
- **Driver wallet/payout visibility for admin.** `DriverWallet.js` has real methods (`getWalletWithDebt`, `createPayoutRequest`, etc.) but every one of them is scoped to the calling driver's own `req.userId` — there is no admin-facing endpoint to see any driver's wallet balance, pending vs. released amounts, or payout request history. An admin can currently only find this out by querying the database directly.
- **User lookup.** No endpoint anywhere lets an admin look up a specific user's profile, order history, saved addresses, trusted-driver relationships, or flags (`flagged_for_cash_abuse`, `cash_refusal_count` — both real columns on `users`, `migrate.js:613-614`). `getStats` gives a total count and nothing else.
- **Order photo review in a dispute UI.** `GET /api/orders/:orderId/photos` (`orderController.js:169-207`) has no explicit admin-role check — but since neither of its two `if` guards (`userRole === 'user'`, `userRole === 'driver'`) matches `'admin'`, an admin token silently passes through and gets the photos anyway (this is by omission, not by design — worth being deliberate about if this becomes a real feature). Regardless: **there is no admin UI screen that calls this at all today.**
- **Financial trend data.** `getStats` is the entirety of financial visibility: 4 numbers, no history, no day-over-day, no driver-payout breakdown, no refund total, no commission-collected figure.

### 1.5 Auth model — still adequate, with one real caveat now worth naming

Confirmed by direct code read (`adminController.js:19-119`): a single, config-driven admin identity (`ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`, no `admins` table), bcrypt-verified in production, JWT with 8h expiry and `jti`-based revocation (fixed earlier this engagement — H7), rate-limited login (`adminLimiter`, 5/15min). This is still perfectly adequate **for a single founder-operator** — there's no multi-admin, no roles-within-admin, no audit log of *which* admin action was taken (moot today since there's only one identity, but it stops being moot the moment a second person — a support hire, a co-founder — needs their own login). **The real limitation isn't security, it's that the admin surface has grown enough in scope (returns, cancellations, and now everything described in §2 below) that "one shared password, no audit trail of who did what" will become a real operational problem the moment more than one person touches this panel.** Worth deciding now, before it's retrofitted under pressure: a real `admins` table with per-person credentials and an `admin_actions` audit log is a small, well-understood piece of schema work, not a big lift, whenever the panel outgrows a single operator.

### 1.6 Architecture — is static-page-plus-REST still the right call?

For exactly two features, yes — it was the right, minimal choice, and `admin.js`'s own comment says so explicitly ("no framework, no build step... this is an internal tool"). **That reasoning stops holding once the panel needs the ~8-10 real screens described in §2** — a driver list with filtering, a driver detail/document view, an order list with real filters, a stats dashboard, an SOS queue, a user lookup, an inventory manager. Hand-writing each as more vanilla `innerHTML` string-templating (the exact pattern `renderReturns`/`renderCancellations` already use, and would have to be copy-pasted for every new table) is the point where a plain static page becomes a maintenance liability rather than a convenience. §3 below makes a specific recommendation.

---

## 2. Gap analysis by domain

**Users** — *Mostly missing.* Only a total count exists (`getStats`). No individual lookup, no order-history-per-user view, no visibility into saved addresses, trusted-driver relationships, or the two real fraud-signal columns (`flagged_for_cash_abuse`, `cash_refusal_count`) that already exist in the schema and are already being written to by real code (`driverCommissionService.js` and cash-order flows) but are never surfaced anywhere for a human to act on.

**Drivers** — *Partially covered, entirely at the wrong layer.* Every piece the document asked about — status breakdown, document review via signed URLs, wallet/payout history, penalty/cancellation history, online status — has real backing data and, for status/documents, a real backend endpoint (§1.2). None of it has a UI. Wallet and payout history specifically have no admin endpoint at all yet (§1.4).

**Orders** — *Partially covered.* `GET /api/admin/orders` is real but capped at the last 100 rows with no filtering (no status, date, customer, or driver params) and no UI. Cancellations and returns — the two things this engagement built deliberately with admin visibility in mind — are the *only* fully-covered pieces in this entire audit. A live "how many orders are in each state right now" operational view does not exist; it would need one new, cheap aggregation query (`GROUP BY status`) plus a UI.

**Financials** — *Mostly missing.* Total revenue exists as one lifetime number. Commission collected, driver payouts (pending vs. released — real data in `driver_wallets`/`driver_payout_requests`, just never queried for admin use), refunds issued, and the pre-pickup cancellation split totals (recorded correctly, per §1.1, but only viewable per-row, never summed) are all either unqueried or unsummarized. No day-over-day/week-over-week view exists; the raw `created_at` timestamps needed to build one are already on every relevant table.

**Trust & safety** — *Mostly missing, and the most consequential gap.* SOS alerts have no durable admin visibility at all (§1.4). Pickup/dropoff photos exist and are technically admin-reachable by omission but have no UI. Driver rating trends and flagged-account review don't exist anywhere.

**Store/inventory** — *Backend complete, UI missing; boost/promotions still decorative.* Inventory CRUD is real and correctly gated (§1.3) — this is the cheapest, highest-confidence UI to add of everything in this document, since zero new backend work is needed. Boost/promotions remain non-functional in pricing, confirmed again this pass (§1.3) — this is a product decision (build the real effect, or retire the feature) as much as an admin-panel gap, and shouldn't be silently absorbed into "just add a UI for it."

**System health** — *Not the app's job to unify, but currently fully scattered.* Render (deploy status), Sentry (error rates), Supabase (DB health/advisors), the production secrets checklist (`PRODUCTION_SECRETS_CHECKLIST.md`, this engagement) — none of these are connected to anything, and building real integrations to pull them into this admin panel would be a substantial, ongoing-maintenance undertaking for what a solo founder actually needs day-to-day. The pragmatic fix is cheap and is proposed in §3, not skipped.

---

## 3. Phased build plan

### Architecture recommendation

**Keep the existing Express app and Postgres schema exactly as they are — don't rebuild anything underneath — but stop hand-writing every screen as vanilla `innerHTML` templating.** Two real options, in order of fit for a solo founder who needs this to stay maintainable without a frontend team:

1. **AdminJS** (`adminjs` on npm) — my primary recommendation. It mounts directly into an existing Express app (`app.use('/admin', AdminJS.express.router(...))`), auto-generates real CRUD list/detail/edit screens directly from your existing Postgres tables (via its Sequelize or plain-SQL adapter) with almost no per-screen code, and supports custom "resource actions" for exactly the workflow this panel already has (Approve/Reject/Finalize-refund on returns, Approve/Reject on driver status, Acknowledge on SOS alerts). No separate service to host, no separate build pipeline the founder has to maintain, free and open-source at the core. The trade-off: it's an added dependency with its own upgrade cadence, and the generated UI is more "admin tool" than "polished product" — which is exactly right for an internal ops panel.
2. **Retool or self-hosted Appsmith** — worth naming as the alternative if the founder would rather not write any more admin code at all. Both connect straight to the existing Postgres database and let you drag-and-drop tables, filters, and charts (this would make the financial day-over-day view in Phase 2 trivial — a chart with zero chart code). Appsmith self-hosted is free; Retool has a usable free tier but becomes a paid, ongoing cost as usage grows. The real trade-off versus AdminJS: it's a second service to run and keep available (self-hosted) or a third-party dependency for a business's operational core (cloud), and the "approve return → create a real reverse-delivery order → call RefundService" custom workflow logic is more naturally expressed in code (AdminJS) than in a low-code tool's action builder.

Recommendation: **AdminJS**, because everything non-trivial this panel needs to do (approve a return, finalize a refund, acknowledge an SOS alert, update a driver's status) is custom business logic that already lives in real backend services — a code-first tool that can call that logic directly is a better fit than a low-code tool that would have to re-implement or wrap it.

### Phases — ranked by what the founder actually needs day-to-day, not by build order

**Phase 1 — Operational visibility (highest value, mostly quick).** A real dashboard home replacing the two-feature page: the existing `getStats` numbers, a live active-orders-by-status view (one new `GROUP BY status` query), a real driver list with status filter and the document-review screen (`getDrivers`/`getDriverById` already exist — this phase is almost entirely UI work), and a real order list with filtering (needs the one piece of new backend work in this phase: pagination + status/date/customer/driver query params on `Admin.getOrders`). This phase is where AdminJS earns its keep fastest — drivers and orders are exactly the kind of table-with-filters screens it generates for free.

**Phase 2 — Financial and dispute visibility.** Driver wallet/payout admin view (genuinely new backend: read-only endpoints over `driver_wallets`/`driver_payout_requests`, no new tables needed), commission-collected and refunds-issued totals (new aggregation queries, same shape as `getStats`), a day-over-day/week-over-week revenue view (new query grouped by date — the data already exists, this is purely a query + a chart), and wiring the already-built `GET /api/orders/:orderId/photos` into a real dispute-review screen (zero new backend — reuse as-is).

**Phase 3 — Trust and safety.** The one gap in this whole document worth treating with real urgency: give `SosAlert.js` a `getAll`/`acknowledge` pair (small, well-scoped new backend work — the schema and even the index are already there) and a real admin queue UI for it, since right now a triggered SOS alert that isn't caught live is unrecoverable from any UI. Alongside it: a flagged-accounts view (`flagged_for_cash_abuse`, `cash_refusal_count` — trivial new query) and driver-rating trends (aggregation query over existing `rating` data).

**Phase 4 — Rounding out.** Individual user lookup (moderate new backend work — it touches orders, addresses, trusted-drivers, several tables at once, so this is the most involved single item in this plan), the inventory management screen (zero new backend, already fully built — cheap, just lower day-to-day urgency than Phases 1-3), the Flash Fleet demand-cluster view (zero new backend, same reasoning), and a decision on boost/promotions — either build the real pricing/ranking effect or retire the feature, as its own conversation rather than folding it silently into "add a UI."

**System health — don't build it into the app.** Instead: a single short internal runbook (or a simple "links" section on the admin dashboard home) pointing to Render, Sentry, Supabase, and this engagement's own `PRODUCTION_SECRETS_CHECKLIST.md` — enough to stop it being scattered with nothing unifying it, without taking on the much larger cost of real API integrations into each of those tools for what would mostly just restate what they already show.

---

## Addendum (2026-07-25, same day) — Durability, full financial picture, and accuracy

This addendum was requested as an explicit, permanent design requirement, not one more phase item: **the admin side must be able to see everything that happens across `flash-user-app`, `flash-driver-app`, and the backend, and this must remain true as both apps keep gaining features over time.** Everything below was produced by the same method as §1-§3 — direct reads of `migrate.js`'s actual table definitions and the services that write to them, with file:line citations — plus the same explicit limitation: no admin credentials this session, so nothing was click-through-verified in the live panel.

### 4.1 Coverage today — what this pass found that §2 didn't already name

Re-auditing specifically for anything not already listed in §2:

- **Ratings, both directions.** `driver_ratings` (one row per completed order, `UNIQUE(order_id)`, backs the driver's recomputed aggregate rating — `migrate.js:918-928`) and `app_ratings` (rating Flash itself, no uniqueness constraint by design — `migrate.js:938-945`) are both real, written-to tables via `POST /orders/:orderId/rate-driver` and `POST /users/app-rating`. Neither has any admin visibility.
- **Size profiles and brand-size mappings.** `size_profiles` (one per user, real anthropometric data — height/weight/chest/waist/hips/shoulder/inseam, `migrate.js:432-441`) and `brand_size_mappings` (per-store size-chart data, `migrate.js:443-452`) are real tables backing the sizing-guide feature (`Sizing.js`, `sizingRoutes.js`). No admin visibility into usage or data quality.
- **A real social feed feature, not previously named at all.** `feed_posts`, `feed_post_products`, `feed_likes`, `feed_comments` (`migrate.js:454-483`) back a genuine user-generated-content feature (`Feed.js`, `feedRoutes.js`) — posts with tagged products, likes, comments. This has **zero admin moderation visibility** — no way to see, review, or remove a post or comment through any admin surface. Worth naming as its own category (content moderation), distinct from financial or trust-and-safety.
- **Two subscription products**, not one: `driver_subscriptions` (per-plan price, real `paystack_reference`, `migrate.js:417-430`) and `premium_subscriptions` (flat R99/user, real `paystack_reference`, `migrate.js:501-508`). Both real, both invisible to admin today.
- **Every financial transaction type, enumerated precisely** (this feeds directly into §4.2 below): `payments` (the core transaction ledger, `type` column defaulting to `'store'` — `migrate.js:253-267`), `payment_refunds` (a dedicated refund ledger, separate from `order_cancellations` — `migrate.js:340-352`), `driver_commission_debts` (R20-per-cash-delivery ledger, status-tracked `outstanding`/`collected_wallet`/`collected_payout`/`waived` — `migrate.js:88-97`), `driver_wallet_ledger` (append-only, one row per credit/debit — `migrate.js:387-395`), `driver_penalties`, `order_cancellations` + `order_cancellation_store_shares`, `driver_payout_requests` + `payout_transactions`. All real, all currently admin-invisible except cancellations.
- **Login/session events are not tracked at all** — confirmed by exhaustive search of `migrate.js`, no `login_history`/`audit_log`/session table exists anywhere. This is fine for a v1 business-visibility panel (it's not something a founder needs to run the business day-to-day) but is worth naming honestly as absent, and it's a *security/fraud-monitoring* gap more than a business one — it connects to the fraud-signal logging gap already named in tonight's earlier AppSec sweep, not to this document's scope.
- **Two dead tables, found this pass, that must be flagged before anything is built on top of them** — covered in full in §4.3, since they're an accuracy risk, not just a coverage gap: `store_credits` and `driver_payouts`.

### 4.2 The mechanism for staying current — one primary recommendation, not a menu

Of the three approaches worth naming, only one is both concrete and honest about what this codebase can actually do:

- **A documented `CLAUDE.md` convention** ("any feature that writes to the DB, moves money, or represents a user/driver action needs an admin-visibility plan as part of its definition of done") is good practice, but it's an honor system. It's exactly the kind of rule that was presumably already the intent behind building `sos_alerts.acknowledged_at` and its purpose-built partial index (§1.4) — and the admin-visibility half of that feature still never got built. A rule with no enforcement doesn't fix the failure mode that produced tonight's gaps; it just re-describes it.
- **AdminJS auto-generating a baseline view for any new table by default** sounds like it would make falling behind structurally harder — but it doesn't apply cleanly here. AdminJS's auto-discovery works off an ORM's model layer (Sequelize/TypeORM/Mongoose); every model in this codebase (`BaseModel` subclasses) is hand-written raw SQL against `pg` directly, with no ORM anywhere. Getting real auto-discovery would mean adopting an ORM specifically so AdminJS can introspect it — a much bigger architectural decision than this document should smuggle in as a side effect of an admin-coverage mechanism. Recommending this as the primary answer would be recommending something that isn't actually free here.
- **A CI check that fails loudly when a new table has no corresponding admin-visibility decision** is the one that's both concrete and buildable today, regardless of whether AdminJS ends up being adopted. **This is the recommended primary mechanism.** Concretely: a test (fits naturally alongside the existing Jest suite and `.github/workflows/ci.yml` backend job) that queries `information_schema.tables` for every real table, and diffs that list against a small, hand-maintained file — e.g. `backend/src/config/adminCoverage.js` — with exactly two buckets: `covered` (tables with a real admin-visible query, listing which endpoint/screen) and `intentionallyExcluded` (tables that genuinely don't need admin visibility — `webhook_events`, `refresh_tokens`, `revoked_tokens` — each entry requiring a one-line reason, so an exclusion can't be silently rubber-stamped). **Any table found in neither bucket fails the build.** This means the day a new migration adds a table, CI fails until someone consciously decides which bucket it belongs in — the exact "fails loudly rather than nothing at all" standard asked for, and it doesn't depend on anyone remembering a written rule under deadline pressure. The `CLAUDE.md` convention is still worth adding — not as a competing mechanism, but as the one-sentence explanation of *why* this check exists, for whoever next reads it.

### 4.3 Money — the full picture, and which numbers are real

**Revenue Flash actually earns:**

| Line | Source | Real money? |
|---|---|---|
| Card-order delivery commission | `Order.create()`: `max(10, delivery_fee × 0.25)` — netted out as `delivery_fee - driver_payout` per order | Yes, but **not stored as its own ledger line** — only derivable by subtracting two columns on `orders`. No table sums this today. |
| Cash-order commission (R20/delivery) | `driver_commission_debts`, explicit status-tracked ledger | Yes — real, explicit, already the best-instrumented revenue line in the system. |
| Driver subscriptions | `driver_subscriptions.price`, tied to real `paystack_reference` | Yes. |
| User "Premium" subscriptions | `premium_subscriptions.price` (flat R99), real `paystack_reference` | Yes. |
| Pre-pickup cancellation store-share (10% of item value) | `order_cancellations.store_amount` / `order_cancellation_store_shares` | Yes, **today** — Flash is currently the only store (`FLASH_STORE_LOCATION`, no multi-vendor stores exist), so this is effectively Flash's own money. The moment a real third-party store exists, this same column becomes genuine pass-through revenue Flash *facilitates* but doesn't keep. The schema already anticipated this (`order_cancellation_store_shares` is explicitly a multi-store extension point) — the admin dashboard needs to be built with that distinction in mind now, not retrofitted later. |
| Boost / promotion `price_paid` | `store_boosts.price_paid`, `store_promotions` | **No — confirmed not real.** Re-read `boostController.purchaseBoost`/`createPromotion` this pass: neither calls Paystack or any payment service. It's a plain DB insert with a number in it, on an admin-only route (`requireRole("admin")` — not even self-service). **This must never be included in a revenue total** until it's tied to an actual verified charge. |

**Costs Flash actually pays:**

| Line | Source | Real money? |
|---|---|---|
| Driver payouts for completed deliveries | `orders.driver_payout` → `driver_wallets` → `driver_payout_requests` → `payout_transactions` → real Paystack transfer | Yes, and this is the one cost line with a genuinely real, auditable multi-table trail already. |
| Driver pre-pickup-cancellation compensation (5% of item value) | `DriverWallet.creditAvailable`, both cash and card orders (tonight's cash-order addition included) | Yes. |
| Refunds issued | `payment_refunds` + real Paystack refund calls via `RefundService` | Yes. |
| Driver penalties (R20, cancel-before-pickup) | `driver_penalties` | This is technically a cost *offset*, not a cost — money taken **from** a driver, reducing what Flash pays out. Precision matters here: it should net against payouts, not be double-counted as a separate cost. |
| Infrastructure (Cloudinary, Resend, Render, Supabase, Paystack's own transaction fees) | Not tracked in-app anywhere | Real money, but **recommend tracking these externally, not in this panel** — they're a handful of slow-changing figures billed monthly by each provider directly, not transactional data generated by this app. Building API integrations to pull each provider's billing numbers into this dashboard is disproportionate effort for what a solo founder can get by checking 4-5 dashboards once a month. Same reasoning as §3's "system health" recommendation — external links, not rebuilt integrations. |

**A real "net position" view, buildable entirely from data that already exists:** `(card commission + cash commission + subscriptions) − (driver payouts + cancellation compensation + refunds) + driver penalties collected`, over a real time window (day/week/month), computed from `orders`, `driver_commission_debts`, `driver_subscriptions`, `premium_subscriptions`, `payment_refunds`, `driver_wallet_ledger`. No new tracking needs inventing — every input already exists. Two things this view must do to stay honest: **exclude** boost/promotion `price_paid` (not real revenue, per above) and **label explicitly**, on the dashboard itself, that it excludes external infra costs — so it's never mistaken for a complete P&L.

### 4.4 Accuracy — what's already at risk of being wrong, and a real reconciliation approach

**Two dead tables, found this pass, that would silently corrupt any dashboard built naively on top of them:**

- **`store_credits`** — has a real read path (`Return.getCredits`, `GET /api/returns/credits`) but **is never written to anywhere in the current codebase.** It's a remnant of the old store-credit return model, explicitly superseded (`returnRoutes.js`'s own comment: "the old store-credit, driver-claims-instantly model... has been removed"). Any admin dashboard showing "outstanding store credit liability" today would truthfully report zero, always — not because there's no liability, but because the write path was removed and nobody removed the read path or the table with it.
- **`driver_payouts`** — created by a migration, confirmed by search to be referenced nowhere else in the entire backend. A second, fully dead table. (The real, actively-used pair for payouts is `driver_payout_requests` + `payout_transactions`.)

Both need a decision — retire the dead table/endpoint, or explicitly document why it's kept — **before** either is allowed anywhere near a founder-facing number.

**One existing number that's already misleading if shown without correction:** `Admin.getStats().totalRevenue` sums `orders.total` where `payment_status='paid'` — that's **gross order value processed** (item price + delivery fee, the customer's full payment), not Flash's actual revenue share. If this number is carried forward into the Phase 1/2 dashboard without relabeling, a founder could read "R50,000 total revenue" and believe that's money Flash keeps, when the real figure (commission + subscriptions, per §4.3) is a small fraction of it. This needs relabeling to "gross order value" and a separate, correctly-scoped "Flash revenue" figure built alongside it, not instead of it.

**A concrete, lightweight reconciliation check, matching the standard already set elsewhere in this system (the existing cron jobs in `src/server.js`, all wrapped in their own try/catch, all logging loudly on failure):** a new scheduled job, same convention, that periodically asserts totals match across tables that should agree — e.g., a driver's `driver_wallets.wallet_balance` should equal the sum of their `driver_wallet_ledger` entries minus what's already been paid out; `payment_refunds` rows marked `completed` should be spot-checked against Paystack's own refund records (via the same API `RefundService` already calls) rather than trusted purely on the local row's status. On a mismatch: log loudly and raise a Sentry event (the same channel already used for `refund_failed` alerts to the admin room, per `webhookController.handleRefundFailed`) — never fail silently, and never let a display-layer bug go unnoticed for weeks because nothing was watching for it. This is new, small, well-scoped backend work (one job, a handful of `SUM()`/comparison queries) — not a redesign of anything.

---

## Addendum 2 (2026-07-25, same day) — Order detail, mobile management, real auth/notifications, live analytics

### 0. Is building this inside the same repo/backend service architecturally sound?

**Yes.** Stated plainly, on its own, before anything else, as asked.

The real question behind "should this be a separate service" is whether running admin and consumer-facing code in the same process creates a genuine security-isolation or scaling problem. Neither applies here:

- **Isolation.** Admin routes already sit behind their own distinct auth path (`POST /api/admin/login`, a JWT carrying `role: 'admin'`, re-checked by `requireRole('admin')` on every single admin request) — this is a real boundary today, not shared session state. Splitting into a second service wouldn't meaningfully improve this: both services would still connect to the **same** Postgres database with essentially the same level of access, so the blast radius of a real compromise (a SQL injection, a leaked DB credential) is identical either way. The one place isolation is *actually* thinner than it looks: admin JWTs are signed with the exact same `JWT_SECRET` as every user/driver token (`adminController.js`: `getRequired('JWT_SECRET', 'admin-auth')`). That's a real, cheap improvement worth doing regardless of the service question — a separate `ADMIN_JWT_SECRET` — but it's an env-var change, not an architecture change.
- **Scaling.** Admin traffic is, and will remain, negligible next to consumer traffic — one founder checking a dashboard a few times a day, not a second product with its own load profile. There's no scaling argument for splitting.
- **Cost/complexity.** A second service means a second Render deployment, a second set of secrets, a second thing to monitor — real, ongoing overhead for a solo founder, for no corresponding real benefit today.

**What would change this answer:** if the admin panel later needs to handle something meaningfully more sensitive than what it handles today (e.g. its own separately-regulated data class), or if it grows a genuinely heavy workload of its own (bulk exports, long-running reports) that could starve the consumer API's connection pool — worth revisiting then, not now. Continuing in the same repo and service, as already started, is the right call.

### 1. Full order/return/cancellation detail — what's real, what needs new work

Checked each requirement against the actual schema and controllers, not assumed:

| Requirement | Status |
|---|---|
| Customer identity (name, contact) | **Data exists, join is currently too narrow.** `Admin.getOrders()` today joins only `u.name as user_name` — real, but the requirement asks for contact too. `users.phone`/`users.email` are real columns; this is a one-line addition to an existing query, not new backend work. |
| Pickup point, multi-store-ready | **Partially ready — a real nuance to flag.** `orders.store_id` already exists as a column (used, always `null` today since there's only one store) — so an order-detail view *can* be built to key off `store_id` now, future-proofing the field itself. But **there is no `stores` table anywhere in this schema** — confirmed by direct search. So "ready for multi-store" is only half true: the column is there, but there's nothing to join it against yet for a store's name/address. A real multi-store admin view still needs a `stores` table built first; today, pickup point is correctly just the one fixed `FLASH_STORE_LOCATION`. |
| Delivery address | **Fully real.** `dropoff_address`, `dropoff_lat`/`dropoff_lng` — real, already present, no gap. |
| Driver assigned, at-a-glance detail | **Data exists, join is currently too narrow, same shape as customer identity.** `Admin.getOrders()` joins `d.name as driver_name` only. `drivers.phone`, `vehicle_type`, `vehicle_plate` are all real columns — same one-line-join fix. |
| Exact timestamp | **Already real — this is a display choice, not a backend gap.** `orders.created_at` is a real `TIMESTAMPTZ`, always precise. "2 hours ago" is a front-end formatting decision; the detail view just needs to show the real value (or both — relative for the list, precise on the detail screen), nothing to build. |
| Returns — full detail, not siloed | **Confirmed: the underlying data is real (§1.1 above), but "not siloed" is a real, valid design correction.** Today a return can only be found via the separate returns-queue table, disconnected from that order's own record. The order-detail view being planned should show a return's status/reason/split inline when one exists on that order, rather than requiring a switch to a different screen to discover it. |
| Cancellation reason | **Confirmed genuinely captured — re-verified this pass, not assumed.** `orderController.cancelOrder` reads `req.body?.reason || null` and writes it straight into `order_cancellations.reason` in the same transaction as the status change. `CancelOrderScreen.js` (user app) already sends a real `reason` field. Nothing missing here — the data exists and just needs to be shown. |
| Cancellation financial split | **Fully real**, already covered in §1.1/§2/§4.3 — store/driver/customer breakdown, correctly computed, correctly persisted. |

**Net effect for planning:** most of this section is a UI/query-shape problem, not new backend work — the two joins (customer contact, driver contact) are trivial additions to an existing query, and a unified order-detail view (order + its return, if any + its cancellation, if any, in one screen) is a design decision more than an engineering one. The one genuinely new piece of backend work is a `stores` table, and that's only needed the day real multi-store data shows up — not before.

### 2. Mobile management — responsive web, not a second app

**Recommended: responsive web design of the same admin panel, viewable in any phone browser.** This is the right scope, not the cautious-default one:

- Everything the founder needs from a phone — checking counts, reviewing a return, approving a driver, seeing an SOS alert — is reading data and tapping a handful of buttons. None of that needs anything a phone browser can't do.
- A second native app means a second codebase, its own build/release process, and (even for an internal tool) real ongoing maintenance — for a solo founder, that's a second thing competing for the same time this whole engagement has been trying to save.
- AdminJS (the framework recommended earlier this document) already ships a responsive layout by default — this isn't extra work on top of the Phase 1 recommendation, it's already included in it.
- The one thing a native app would add that a browser genuinely can't: OS-level push notifications without email/SMS. §4 below recommends email as the primary notification channel specifically *because* it works identically and reliably on any phone without building a native app or a push-capable PWA to get it — so this gap doesn't end up mattering in practice.

A real reason to revisit this would be if the founder specifically wants OS-native push notifications independent of email — worth naming honestly: that's achievable without a native app via a installable PWA + Web Push (iOS Safari has supported this since 16.4), but it's real added complexity (service worker, push subscription management) that isn't justified today against a working email channel.

### 3. Real admin authentication — individual accounts, right-sized for today

This directly replaces the single-shared-credential model flagged as a real limitation in §1.5.

**New schema needed** (small, well-understood, same shape as `users`/`drivers`): a real `admins` table — `id`, `name`, `email` (unique), `password_hash`, `phone` (nullable, see below), `created_at` — plus the same JWT-issuance pattern already used everywhere else in this codebase (bcrypt-verified login, short-lived access token, the existing `revoked_tokens`/`jti` revocation mechanism this app already has). This is the natural, and only real, fix for "a second admin would have to share my password" — each person gets their own row, their own credential, their own login history.

**Sign in with Apple for web — confirmed feasible, but correctly scoped as a later addition, not day one.** Apple does support "Sign in with Apple for the Web" (a JS SDK + a REST token-exchange endpoint, distinct from the native `expo-apple-authentication` flow already built for the consumer apps) — this is real and reasonable *in principle*. But for exactly one admin user today, it adds a second, entirely separate auth integration (Apple's own web SDK, a services-ID + private-key setup in Apple's developer portal, a new callback endpoint) for a problem email+password already solves completely. **Recommendation: ship email+password first** (it's the same pattern already proven everywhere else in this codebase, zero new integration risk), and treat Apple Sign-In as a real, named future addition — worth doing once there's more than one admin and "one more login option" starts actually mattering, not before.

**Phone number — collect it, but don't gate anything on verifying it yet, and here's the honest reason why:** the original ask assumed existing SMS infrastructure could be reused for verification. **That assumption doesn't hold — checked directly, and it's worth correcting rather than quietly building around:** there is no SMS-sending integration anywhere in this backend today. The cash-OTP system (`cashOtpService.js`) generates a code shown *in the app itself* for the driver to read, not one sent via SMS — and a comment in `driverController.js` states this outright: *"there's no reliable SMS/OTP delivery infrastructure wired up yet."* So phone-number verification would mean standing up a real SMS provider integration from scratch (e.g. Twilio, or whichever provider), which is a genuine, separate piece of new infrastructure — not a "reuse what's already there" task. Given §4 below recommends **email**, not SMS, as the actual notification channel, there's no urgency to build SMS just for phone verification either. Collect the phone number as a plain, unverified profile field for now (useful to have on file); revisit real SMS verification only if a real need for SMS specifically (not just notifications) shows up later.

### 4. Notifications — tiered, and correcting a premise before recommending a mechanism

**First, the same correction as §3: there is no existing SMS infrastructure to wire this into.** What *is* already real and proven in this codebase is email — `emailService.js` already has a working generic `sendEmail()` helper and a real precedent for exactly this use case: `sendReturnAwaitingReviewEmail()` already emails `ADMIN_EMAIL` today whenever a return needs final review, with a real HTML template. **Recommendation: email is the primary notification mechanism, full stop — not one option among several.** It's already wired, already proven, requires zero new provider integration, and reaches a phone identically to SMS (as a push-style notification from the Mail app) without needing a native app or a PWA. SMS is a real future upgrade *if* a specific channel-diversity need shows up (e.g. wanting a notification to arrive even if email is delayed) — but that's optional hardening on top of a working system, not a prerequisite for having one.

**Tiered list — what actually deserves an immediate email vs. dashboard-only:**

*Immediate (send an email the moment it happens):*
- **SOS alert** — ties directly to the urgent gap already flagged in §1.4. This is the single most important item to wire up first: today an SOS alert only reaches a live Socket.io connection to the `'admin'` room, meaning it's missed entirely if nobody has the panel open at that exact moment. An email fires regardless of whether anyone's looking at anything.
- A new return request awaiting review (already has a working precedent — `sendReturnAwaitingReviewEmail` — just needs to also fire on the *initial* request, not only once it's back at the store awaiting final review).
- A pre-pickup cancellation (real money moving in a way that deviates from the normal flow).
- Any single transaction above a reasonable financial threshold (a specific refund, payout, or order value — a concrete number is a founder call, not a technical one, but the mechanism is identical to the above).

*Dashboard-only (no notification — just visible next time the panel is opened):*
- Routine order creation and routine status progressions (`waiting_for_driver` → `driver_assigned` → ... → `delivered`) — this is the exact "notifying on every order would be unusable noise within a day" case named in the request, and it's correct.
- New user/driver signups (visible as a count/trend, not a per-signup alert).
- Routine ratings and app-ratings submissions.

### 5. Real-time analytics — what "real-time" should actually mean here

**Graphs to build, all buildable entirely from data that already exists:** user signups over time (`users.created_at`), driver signups over time (`drivers.created_at`), order volume over time (`orders.created_at`), and revenue over time — using the **corrected** revenue definition from Addendum 1 (commission + subscriptions, not the misleading raw `orders.total` sum) grouped by day/week. Every one of these is a `GROUP BY DATE_TRUNC(...)` query against a table that already has the timestamp it needs — no new tracking to invent.

**"Real-time" — the honest, proportionate answer is a periodic refresh, not WebSockets.** For a solo founder checking a dashboard a few times a day, sub-second live-updating charts solve a problem that doesn't exist here, at real added cost: a WebSocket-driven dashboard means maintaining live subscriptions, handling reconnects, and keeping chart state in sync with a push stream, for data that fundamentally doesn't change fast enough to need it (a day-over-day order-volume graph doesn't need a per-second tick). **Recommendation: fetch on page load, plus a simple 30-60 second auto-refresh while the tab is open.** That's it — proportionate to how this will actually be used.

One useful distinction this makes clean: **analytics (this section) and notifications (§4) have different, correctly-different mechanisms.** Notifications are event-driven and already have a real push channel to build on (email, and the existing `io.to('admin')` Socket.io room already used for SOS/fleet-intelligence alerts, which could carry live *event* pushes like "a new SOS just fired" straight to an open dashboard tab as a nice-to-have on top of the email). Analytics are aggregate and time-windowed, and a periodic pull is the honest fit — building WebSocket infrastructure for the charts specifically would be solving the wrong problem.

---

## What this document is not

This is investigation and planning only, per the instruction it was written against. Nothing described in §3 has been built. The next step is the founder reviewing this and deciding which phase — if any — to start on.
