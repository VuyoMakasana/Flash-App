# Flash Store Admin Portal — Design Document (v2, corrected)

**Scope:** Design only. No code, no migrations, no changes to any existing Flash file. Nothing here should be implemented without the founder's explicit approval of a specific phase.

## Correction note — read this first

This document originally described the Store Admin as "this same panel, extended" — new AdminJS resources and actions bolted onto the existing internal Flash Admin Panel (`backend/src/adminPanel.js`, mounted at `/admin-panel`). **The founder has explicitly corrected this**: the Store Admin Portal is a genuinely separate system, for partner stores, distinct from the internal panel that serves the Flash team. Every section below has been rewritten against that correction. The internal AdminJS panel is untouched by anything in this document — it keeps doing exactly what it does today (Flash-team-facing operations: drivers, orders, cancellations, returns, SOS, wallets, payments, finance dashboard). Nothing proposed here adds a resource, action, or role to it.

Also corrected: §0 originally *proposed* a `preparing` state as a future design decision. That decision has since been made and fully shipped — `pending_store_acceptance` and `preparing` are both real, live states today, backed by a real Postgres enum (`order_status_enum`) and a 15-minute auto-cancel timeout cron. §0 below now describes what's actually live, not what's proposed.

---

## 0. The order workflow this portal plugs into — confirmed live, not proposed

Directly from `backend/src/services/orderStateMachineService.js` as it stands today:

```
ALLOWED_TRANSITIONS = {
  created:                  ['payment_pending', 'cancelled'],
  payment_pending:          ['paid', 'scheduled_for_morning', 'cancelled'],
  paid:                     ['pending_store_acceptance', 'scheduled_for_morning', 'cancelled'],
  scheduled_for_morning:    ['pending_store_acceptance', 'cancelled'],
  pending_store_acceptance: ['preparing', 'cancelled'],
  preparing:                ['waiting_for_driver', 'cancelled'],
  waiting_for_driver:       ['driver_assigned', 'cancelled'],
  driver_assigned:          ['driver_arrived_store', 'cancelled'],
  driver_arrived_store:     ['picked_up', 'cancelled'],
  picked_up:                ['in_transit'],
  in_transit:               ['delivered'],
  delivered:                ['completed'],
}
```

`orders.status` is a real Postgres `order_status_enum` type (migration v28), not a free-text column — a bad status string is now rejected at the database layer, not just the application layer. Three real store-facing actions already exist and are live in production today, currently exposed only through the *internal* AdminJS panel (`backend/src/adminPanel.js`'s `acceptOrder`/`rejectOrder`/`markReadyForPickup` custom actions, calling `orderStateMachineService.acceptOrder`/`rejectPendingAcceptance`/`markReadyForPickup`):

- **Accept** (`pending_store_acceptance` → `preparing`)
- **Reject** (`pending_store_acceptance` → `cancelled`, full refund, `cancelled_by_role` recorded)
- **Mark Ready for Pickup** (`preparing` → `waiting_for_driver`, driver matching begins)

A 15-minute timeout cron (`backend/src/server.js`) auto-cancels-and-refunds any order left unaccepted, reusing `rejectPendingAcceptance` with `cancelledByRole: 'system'`.

**This is the exact, real integration point for the Store Admin Portal**: the portal's own Orders screen calls the *same* `orderStateMachineService` functions — a real partner store's Accept/Reject/Mark-Ready button is a call to the identical backend function the founder's own Accept/Reject/Mark-Ready button in the internal panel already calls today. Nothing about the state machine changes for this portal to exist; only *who* is allowed to call these functions, and *how* they authenticate to do so, changes — which is precisely what §3 below designs.

---

## 1. What "genuinely separate" means, concretely

| | Internal Flash Admin Panel (existing, unchanged) | Store Admin Portal (new) |
|---|---|---|
| **Who uses it** | Flash's own team (today: just the founder) | Partner store staff (Owner, Store Manager, Inventory Staff, Sales Staff, Finance, Marketing) |
| **Where it lives** | `backend/src/adminPanel.js`, mounted at `/admin-panel` on the existing backend | A new, separate frontend application (§6) — its own deployment, its own URL |
| **Auth system** | AdminJS's own cookie session (`admins`/`admin_actions` tables, `ADMIN_JWT_SECRET`-signed session cookie) *and*, separately, JWT bearer tokens for `/api/admin/*` (also `admins` table, `requireRole('admin')`) | A new, dedicated auth system entirely (§3) — new table, new JWT secret, new middleware. **Never** the `admins` table. |
| **Scope** | Sees everything, every store, platform-wide | Scoped to exactly one store (or, for a future Flash-employee "platform support" use case, explicitly flagged as out of scope here — see §7) |
| **Resources it manages** | Drivers, all orders, cancellations, returns, SOS, wallets, payouts, payments/refunds, finance dashboard | One store's own orders, inventory, customers (read-only), analytics, settings |
| **What changes to build this** | Nothing. Zero new resources, actions, or roles added to `adminPanel.js`. | Everything described in §3–§6 below, entirely new. |

The two systems share exactly one thing: the underlying `orderStateMachineService.js` functions, because that's the real, single source of truth for order state — sharing business logic across two front doors is the correct kind of reuse (same principle `SALEOR_ARCHITECTURE_STUDY.md` §1.1 confirms Saleor itself follows: domain logic never depends on which API/UI called it). They share **no** auth, session, table, or admin-facing UI code.

---

## 2. Why the earlier draft got this wrong, named honestly

The earlier version reasoned from "AdminJS already has `isAccessible`/role-based conditions, so extending it is the path of least new code" — true as far as it goes, but it optimized for engineering convenience over the actual trust boundary being drawn. A partner store's staff account is a fundamentally different trust level than a Flash employee's: a compromised or malicious store account should never be able to reach a code path, session mechanism, or database table that a Flash-internal admin account can reach, even in principle. Bolting store accounts onto the `admins` table with a role check is the same *shape* of mistake as giving a customer support rep a full production database login instead of a scoped read replica — it works today, and is a real liability the day it doesn't. A genuinely separate system removes the entire class of "did we forget an `isAccessible` check somewhere" risk for this specific boundary, rather than relying on getting every check right forever.

---

## 3. Store-scoped authentication — a genuinely separate system

### 3.1 The real precedent already in this codebase

Flash already runs **two** independent JWT-secret domains for exactly this reason — confirmed by direct read of `backend/src/middleware/auth.js`: user/driver tokens are signed with `JWT_SECRET`; admin tokens are signed with a separate `ADMIN_JWT_SECRET`. `authenticate()` tries `JWT_SECRET` first, falls back to `ADMIN_JWT_SECRET` only on a signature mismatch, and — critically — cross-checks that a token claiming `role: 'admin'` was *actually* verified with `ADMIN_JWT_SECRET`, and vice versa (`middleware/auth.js:68-73`). This exists specifically because an earlier security pass found that a token signed with the wrong secret but carrying an admin role claim would otherwise be silently accepted. **This is the exact, proven pattern to extend a third time**, not a new architecture to invent: a third secret (`STORE_JWT_SECRET`), a third verification branch, the same secret-matches-claimed-role cross-check.

### 3.2 New table, new claims, new middleware

- **New table: `store_users`** — `id UUID`, `store_id UUID REFERENCES stores(id)` (the real `stores` table from `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §2), `name`, `email`, `password_hash`, `role` (one of the six roles in §5's RBAC table), `is_active`, `created_at`, `updated_at`. Deliberately **not** a new column on `admins` — a structurally separate table, so there is no query shape that could accidentally join across the two.
- **New JWT payload shape**: `{ id: storeUserId, storeId, role, jti }` — `storeId` is the load-bearing claim this whole design exists to introduce. Signed with `STORE_JWT_SECRET` (a new, dedicated env var — never reused from `ADMIN_JWT_SECRET` or `JWT_SECRET`).
- **New middleware, `authenticateStore`** — a sibling to `authenticate()` in `middleware/auth.js`, verifying only against `STORE_JWT_SECRET`, populating `req.storeUserId`, `req.storeId`, `req.storeRole`. It does **not** fall back to `JWT_SECRET`/`ADMIN_JWT_SECRET`, and `authenticate()` does not fall back to `STORE_JWT_SECRET` — three fully disjoint verification paths, so a token minted for one system is cryptographically meaningless to the other two, not just logically gated by a role check.
- **New role guard, `requireStoreRole(...roles)`** — the same shape as `requireRole()`, checking `req.storeRole`.
- **New tenant guard, `requireOwnStore`** — checks that any `:storeId`/`storeId` referenced in a request path or body matches `req.storeId` from the verified token, never a client-suppliable override. This is the single most important piece of new middleware in this entire document — see §5's security review for exactly why.
- **New login endpoint**, e.g. `POST /api/store-auth/login` — `store_users.findByEmail` + `bcrypt.compare`, mints a `STORE_JWT_SECRET`-signed token. Structurally identical to the existing `Admin.findByEmail`/`bcrypt.compare` pattern (`adminPanel.js`'s `authenticate` function, and the real `/api/admin/login` route it's documented as sharing logic with) — proven, boring, correct, just pointed at the new table and secret.
- **Refresh/session handling**: reuse the existing `refresh_tokens`/`revoked_tokens` table *shape* (a new `store_refresh_tokens` table, same columns, same purge-cron pattern already in `server.js`) rather than inventing a new session mechanism — same reasoning as reusing the JWT-secret-isolation pattern: proven, not novel.

### 3.3 What does *not* need to change

`users`, `drivers`, and `admins` tables, their JWTs, and their middleware are untouched. `requireApprovedDriver`, `requireRole`, and every existing route using them are unaffected — this is a purely additive third auth domain, not a modification of the existing two.

---

## 4. The order workflow screen (unchanged in spirit from the original draft, now correctly hosted)

### 4.1 List view

A quick-scan status indicator (one color per state) per Saleor's real two-tier pattern (`SALEOR_ARCHITECTURE_STUDY.md` §2.3) — order number, customer name, status dot + plain-language label (never a raw `pending_store_acceptance` verbatim), item count, total, time since creation, assigned driver once one exists. Every query scoped `WHERE store_id = $storeIdFromToken` — never a client-suppliable value (§5).

**New Orders is its own always-visible top section** — every order in `pending_store_acceptance` shown with Accept/Reject inline, no click-through, since store response time is the real new latency this workflow introduces (the 15-minute timeout cron is the backstop, not the target response time).

### 4.2 Detail view

A real, date-bucketed chronological timeline (directly borrowed from Saleor's real `OrderHistory.tsx` pattern, confirmed component, `SALEOR_ARCHITECTURE_STUDY.md` §2.3) — created, paid, accepted/rejected (by whom), driver assigned, arrived, picked up, in transit, delivered, completed. Every timestamp already exists in Flash's real data (`orders.created_at`, the state-transition log already written by `orderStateMachineService.js`'s `logTransition`) — a presentation layer on data that already exists, nothing new to track.

### 4.3 Actions

**Accept**, **Reject**, **Mark Ready for Pickup** are the three real actions (§0) — each its own single-purpose endpoint/button, never a generic "change status" control, matching both Saleor's real granular-mutation discipline (`SALEOR_ARCHITECTURE_STUDY.md` §1.2) and Flash's own existing `ALLOWED_TRANSITIONS` discipline. Each independently permissioned by role (§5.3) — critically, unlike Saleor's own confirmed pattern (§5.2 below), this portal enforces at the action-button layer *and* the API layer, not just page-level + API, since a store's own staff hierarchy (Sales Staff who can Accept/Reject but never see Finance) is exactly the kind of boundary worth the extra layer.

---

## 5. Security review — tenant isolation and RBAC

*Treated with the same severity discipline as every real security audit this engagement has produced (`ACCESS_SECURITY_AUDIT.md`, `RETURNS_AND_LEGAL_AUDIT.md`). This is the single highest-stakes section of this whole document set.*

### 5.1 CRITICAL — every store-scoped query must derive `store_id` from the verified token, never from the request

This is structurally the exact same bug class as a missing ownership check (`Payment.getSavedCardById(cardId, userId)`'s `WHERE id=$1 AND user_id=$2` pattern, already proven throughout this codebase) — just at the tenant grain instead of the user grain. Concretely, for every new Store Admin Portal endpoint:

- **Wrong** (the vulnerability this section exists to prevent): `SELECT * FROM orders WHERE id = $1 AND store_id = $2` where `$2` comes from a request body/query param/route param. A malicious or compromised Store B account sends Store A's real `store_id` and reads Store A's orders.
- **Right**: `SELECT * FROM orders WHERE id = $1 AND store_id = $2` where `$2` is **always** `req.storeId` from `authenticateStore` (§3.2) — a value the client cannot influence, because it was cryptographically bound into a token this backend itself signed after verifying the store user's password.
- **Enforcement mechanism, concretely**: `requireOwnStore` (§3.2) as a mandatory middleware on every store-scoped route, plus a code-review-time rule (and, once built, a real automated test) that no controller in the new Store Admin route tree ever reads `store_id`/`storeId` from `req.body`/`req.query`/`req.params` — only ever from `req.storeId`.
- **This must be verified live, adversarially, before this portal ships a second real store** — create two real store accounts, authenticate as Store A, attempt to read/modify/cancel a Store B order, confirm clean rejection at every one of: orders list, order detail, Accept/Reject/Mark-Ready actions, inventory, analytics. The same standard already applied to every ownership check this engagement has shipped (e.g. tonight's subscription-cancellation ownership tests) — this is not optional hardening, it blocks shipping a second store the same way a missed ownership check would block shipping any other feature.

### 5.2 HIGH — RBAC must be enforced at all three layers, not assumed from one

Directly informed by the Saleor findings above: Saleor's real, confirmed pattern is **page-level** (client-side, proactive — `useMenuStructure.tsx`'s `isMenuItemPermitted`, an any-of match against the user's granted permissions, hiding entire sections the user can't reach) **plus API-level** (server-side, authoritative — `permissions = (OrderPermissions.MANAGE_ORDERS,)` declared once on each mutation class) — but Saleor does **not** appear to independently re-gate individual action buttons *within* an already-accessible page by permission (confirmed: no `hasPermission`/`userPermissions` check found in `OrderDetailsPage.tsx` or its action-bar components; button availability there is driven by order *status*, not by a redundant client-side permission recheck — the actual authorization boundary for a specific mutation is enforced server-side).

Flash's Store Admin Portal should do all three layers, not two, given the six-role model (§5.3) has meaningfully different staff (Sales Staff vs. Finance) sharing the same pages in a way Saleor's page-per-permission-group model doesn't need to:

1. **Page/navigation layer** (client, proactive UX) — a Finance user's sidebar never shows an Accept/Reject button at all.
2. **Action layer** (client, proactive UX) — even within the Orders page, a role without order-action permission sees the order list read-only, no buttons rendered.
3. **API layer** (server, authoritative — the only layer that actually matters for security, since 1 and 2 are UX conveniences, not boundaries) — `requireStoreRole(...)` on every route that mutates state, checked server-side regardless of what the client rendered. **A client-side hide is never a substitute for this** — the same "never trust the client" discipline already applied everywhere else in this codebase (e.g. `orderController.js` never trusting a client-supplied pickup coordinate).

### 5.3 RBAC roles — real, store-scoped, not borrowed from `admins.role`

| Role | Sees | Can do |
|---|---|---|
| **Owner** | Everything for their own store | Everything, including managing other `store_users` for their store |
| **Store Manager** | Their store's orders, inventory, financials | Accept/Reject/Mark-Ready/Cancel orders; everything Inventory Staff and Sales Staff can do |
| **Inventory Staff** | Their store's inventory | Add/edit/deactivate products, adjust stock — no order actions, no financials |
| **Sales Staff** | Order list/detail, New Orders queue | Accept/Reject/Mark-Ready — no financials, no inventory management |
| **Finance** | Financial/analytics screens only, including their own store's applicable commission rate and their own settlement history (`commission_rates`, `store_settlements`/`store_settlement_line_items` — `FINANCIAL_DOMAIN_SPECIFICATION.md` §2-3) | Read-only — no order-state actions, no inventory actions, and no ability to set or negotiate their own commission rate (that's a Flash-side-only action, `DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md` §8a) |
| **Marketing** | Promotions/boosts scoped to their store | Create/edit promotions — no order, financial, or inventory visibility beyond product names/prices needed for a promotion |

Every row is a `store_users.role` string plus `requireStoreRole` conditions on the new route tree — no dependency on, or interaction with, the existing `admins.role` column at all (correcting the earlier draft's §4, which proposed reusing it).

### 5.4 MEDIUM — audit logging must capture the store, not just the actor

The existing `admin_actions` audit log (Phase 0 of the internal panel) stays exactly as it is, logging only internal-admin actions. The Store Admin Portal needs its **own** audit table, `store_actions` (`store_user_id`, `store_id`, `action_type`, `target_table`, `target_id`, `metadata`, `created_at`) — a structurally separate log, both because the actor identity space is disjoint (`store_users.id`, not `admins.id`) and because a future dispute ("did this Store Manager touch an order that wasn't theirs") needs to be answerable from a log that itself proves the store scope at the time of the action, not just the actor.

### 5.5 LOW — rate limiting and lockout on the new login endpoint

`POST /api/store-auth/login` needs the same `authLimiter`-style protection already applied to `/api/auth/*` (`middleware/rateLimiter.js`) — a new, dedicated limiter instance, not a shared counter with user/driver/admin login (a credential-stuffing attempt against one store's login shouldn't be able to exhaust the rate-limit budget for a different store's legitimate login attempts, or for the internal admin panel's).

---

## 6. Store Admin Portal blueprint — the actual application

### 6.1 Tech stack recommendation — reasoned, not defaulted to the biggest option

**Recommendation: reuse Flash's existing Express/Postgres backend (new route tree, new tables, new middleware — all additive, per §3), paired with a genuinely new, separate frontend application.** Not a new backend service.

Reasoning:
- **Against a fully separate service (its own backend + database):** Flash's real data (orders, order state, inventory) already lives in one Postgres database, and the Store Admin Portal's entire purpose is to read and act on that same data in near-real-time (a new order must appear in the New Orders queue within seconds of `pending_store_acceptance`). A separate service would need its own replication/sync mechanism to that data, or would call back into the main backend anyway — introducing a second service buys isolation this application doesn't need (the backend already has a proven tenant-isolation pattern to extend, §3) at the cost of a second deployment, a second on-call surface, and a real data-consistency problem this repo doesn't have today. This is the same "don't default to the biggest option" discipline the founder explicitly asked for.
- **For a new frontend, not a new AdminJS-resource set on the existing frontend:** AdminJS is designed around one authenticated principal type per mounted instance (confirmed by direct read of `adminPanel.js`'s `buildAuthenticatedRouter` setup) — retrofitting a second, tenant-scoped principal type into the same AdminJS mount is fighting the framework, not using it as intended, and is exactly the "bolted on" pattern §2 above explains as the wrong call. A new, purpose-built React frontend (matching the two existing mobile apps' React-family precedent, though this would be the repo's first React *web* app — a genuinely new but small addition, not a new ecosystem) talking to the new `/api/store-*` route tree via plain REST (matching the existing backend's own REST-not-GraphQL choice, `CLAUDE.md`) is the right-sized answer: new UI code, same battle-tested backend/database/deployment.
- **Framework specifics** (a real, concrete recommendation, not left open): React + Vite (fast local dev, no framework-level opinions Flash doesn't need — Flash's backend already owns routing/auth/business logic, so a full meta-framework like Next.js would mostly add unused server-rendering machinery), React Router for the deep-linkable per-action routes Saleor's real pattern justifies (§6.3), a lightweight design system rather than a heavy component library, given this portal's actual page count (5-6 screens, §6.2) doesn't justify the overhead Flash's own AdminJS/macaw-ui-scale tooling exists for.
- **Deployment**: a second Render static site or web service, same provider/region as the existing backend (Cape Town `af-south-1`, per `HOW_TO_RUN.md`) for latency, calling the existing backend's API over HTTPS — no new infrastructure category to operate.

### 6.2 Core screens

Directly informed by Saleor's real, confirmed domain-folder navigation (`src/orders`, `src/products`, `src/customers`, `src/discounts`, `SALEOR_ARCHITECTURE_STUDY.md` §2.4), scaled down to Flash's actual six-role model and actual business shape (same-day clothing delivery, not general e-commerce):

- **Orders** (home screen, per §4) — New Orders queue + full order list/detail/history.
- **Inventory** — the store's `flash_inventory` products (Phase 4 of the internal admin panel already has the backend CRUD built, UI not yet built — this portal's Inventory screen and any eventual internal-panel Inventory UI would call the same underlying model, matching §0's "share logic, not auth" principle).
- **Customers** — read-only order-history-by-customer view (no customer PII editing — customers remain Flash's own `users` table, not owned by any store; a store sees only what it needs to fulfill orders, not a full CRM).
- **Analytics** — store-scoped version of the existing `Admin.getDailyTrends()`/`Admin.getFinancials()` real aggregate queries (`MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §1.3), filtered by the store's own `store_id` — the same underlying SQL, additively `WHERE`/`GROUP BY`-scoped, not a new analytics engine.
- **Settings** — store profile (name, address, operating hours), and (Owner role only) managing other `store_users` for that store.

Sidebar navigation groups these five, matching Saleor's real per-domain sidebar organization (`SALEOR_ARCHITECTURE_STUDY.md` §2.4) rather than one dense, all-at-once dashboard — Orders first and always visible above the fold (§4.1's New Orders queue is the single most time-sensitive thing a non-technical store owner needs to see in the first five seconds of logging in).

### 6.3 Deep-linkable routes

Per Saleor's real, confirmed pattern (`orderPath(id)`, `orderFulfillPath`, etc., `SALEOR_ARCHITECTURE_STUDY.md` §2.1) — every action reachable at its own real URL (`/orders/:id`, `/orders/:id/accept`, `/inventory/:productId`) so a stuck-order alert email (the real, already-proven SOS-alert-style notification pattern) can link directly to the exact order needing attention, not just to a generic dashboard.

### 6.4 Connection to the existing order-acceptance workflow

No new workflow to design — §0 already confirmed the real, live states this portal drives. The portal's Accept/Reject/Mark-Ready buttons call the same `orderStateMachineService.acceptOrder`/`rejectPendingAcceptance`/`markReadyForPickup` functions the internal panel's buttons already call, through a new `/api/store-orders/:id/accept` (etc.) route guarded by `authenticateStore` + `requireOwnStore` + `requireStoreRole('owner', 'store_manager', 'sales_staff')` instead of the internal panel's AdminJS action wiring.

---

## 7. What's explicitly out of scope for this design

- **A Flash-employee "support views into any store" mode** — a real, plausible future need (Flash support staff troubleshooting a store's issue) but not designed here, since it would need its own careful cross-boundary permission model (an internal admin temporarily impersonating/viewing a store's scope) that deserves its own explicit design and approval, not a default assumption folded into this document.
- **Store onboarding/self-signup flow** — this document assumes `store_users` and `stores` rows are created by Flash (an internal, manual or admin-panel-driven process), not a public self-service signup — a real product decision the founder hasn't been asked yet and isn't decided here.
- **Merchant payouts / independent third-party store financial settlement** — **resolved, no longer conditional**: the founder has explicitly confirmed independent merchants are the primary, default case, not a hypothetical. The real settlement/commission architecture is now designed in `FINANCIAL_DOMAIN_SPECIFICATION.md` §2-3 (a configurable `commission_rates` table, a weekly-by-default `store_settlements` lifecycle) — not scoped in *this* document specifically because it's a financial-domain concern owned by that document, not because it's an uncertain future.

---

## What this document is not

Design only. No code was written, no migration was created, no existing Flash file was modified. Everything in §3, §5, and §6 requires the founder's explicit approval before any implementation begins — per the founder's own instruction, this is architecture first, engineering second, and this document is the "architecture first" deliverable, not a green light to start building.
