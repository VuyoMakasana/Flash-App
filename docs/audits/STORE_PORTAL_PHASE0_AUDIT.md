# Store Portal — Phase 0 Audit

**Scope:** the Store Admin Portal exactly as it exists on `main` @ `f3579db` (the
commit currently live in production, deploy `dep-daq2d6gu01pc73f57hv0`).
**Status:** audit only. No code changed, no schema changed, nothing deployed.
**Date:** 2026-09-24.

Every claim below was verified directly — against the deployed commit for code,
and against the production database (`ttupbbqbplrhhtuvaaar`) for schema. Where
the test database (`djysoxflenujmoqxttxd`) differs, that is called out as a
finding rather than smoothed over.

---

## 0. Corrections to the prior record

Two things previously stated in this engagement were wrong. Both are corrected
here so the error does not propagate into Phase 1 design.

**`stores.onboarding_verified_by` does not exist in production.** The full
production column list is:

```
id, name, address, lat, lng, service_area_bounds, owner_name, owner_email,
owner_phone, is_active, created_at, updated_at, logo_url, banner_url, description
```

The **test** database *does* have `onboarding_verified_by` and
`onboarding_verified_at`. The claim came from reading the test database and the
model code, and generalising to production. Onboarding must **not** be designed
around those columns — see §9.1.

**`Store.createVerified()` would crash in production if it were ever called.**
It `INSERT`s into `onboarding_verified_by`/`onboarding_verified_at`, which do not
exist there. It is currently dead code (§4.1), so this is latent, not live.

---

## 1. Summary of what exists

| Layer | State |
|---|---|
| Backend routes | 6 route files, 21 endpoints, live |
| Controllers | 5, live |
| Models | 3 (`Store`, `StoreUser`, `StoreAction`), live |
| Core tables | `stores`, `store_users`, `store_password_tokens`, `store_actions` — live and populated |
| Settlement/commission tables | 4 tables exist with sophisticated constraints — **zero code references** |
| Bank/payout storage for stores | **Does not exist** |
| Frontend | Vite + React SPA, 7 routes, deployed as a Render static site |
| Tenant isolation | Enforced, adversarially verified (§7) |
| Self-service onboarding | **Does not exist** (§4.1) |

Production data today: **1 store** ("Flash Closet"), **1 store user** (owner),
16 inventory rows, 19 orders — all attributed to that single store.

---

## 2. Auth and session model

Store auth is a **fully disjoint trust domain** from user/driver and from admin.

- Tokens are signed with `STORE_JWT_SECRET` — never `JWT_SECRET`, never
  `ADMIN_JWT_SECRET`. `authenticateStore` verifies against that secret only,
  with no cross-secret fallback in either direction.
- Token lifetime **8h**, single JWT, no refresh-token flow (deliberate — mirrors
  the admin model, not the user/driver model).
- Claims: `id`, `storeId`, `role`, `jti`.

`authenticateStore` performs, on **every** request:

1. `jti` checked against `revoked_tokens` (logout revocation works).
2. Live `is_active` lookup on `store_users` — a deactivated account is rejected
   immediately, not merely at next login.
3. `password_changed_at` vs the token's `iat` — any token minted before a
   password change is rejected with `401 "Session invalidated by a password
   change"`, despite the 8h lifetime.

`requireStorePasswordCurrent` separately blocks a `force_password_reset` account
from reaching anything except the password-change path.

### Roles

DB-enforced via `store_users_role_check`:
`owner`, `store_manager`, `inventory_staff`, `sales_staff`, `finance`, `marketing`.

`marketing` can authenticate but has **no nav entries** and lands on
`/not-available`; `storeAuthController.login` also rejects it at login with a
403. Note `finance` already exists as a role — relevant to Phase 2, since it is
the natural holder of banking permissions.

---

## 3. Routes and endpoints

All four store-scoped routers apply the same chain at `router.use()` level, so
every route inherits it — no route can accidentally opt out:

```
authenticateStore → requireOwnStore → requireStorePasswordCurrent → requireStoreRole(...)
```

| Router | Mount | Endpoints | Role gate |
|---|---|---|---|
| `storeAuthRoutes` | `/api/store-auth` | login, logout, DELETE account, forgot-password, reset-password, change-password | mixed (see below) |
| `storeOrderRoutes` | `/api/store-orders` | list, get, accept, reject, mark-ready | `ORDER_VISIBLE_ROLES` |
| `storeInventoryRoutes` | `/api/store-inventory` | list, get, add (multipart), update stock, update image, deactivate | `INVENTORY_VISIBLE_ROLES` |
| `storeStaffRoutes` | `/api/store-staff` | list, create, deactivate | **`owner` only** |
| `storeAnalyticsRoutes` | `/api/store-analytics` | get | `ANALYTICS_VISIBLE_ROLES` |
| `storefrontRoutes` | `/api/stores` | list stores, get store | **public, unauthenticated** |

`storeAuthRoutes` is the exception: `login`/`forgot-password`/`reset-password`
are unauthenticated by necessity; `logout`, `change-password` and
`DELETE /account` require `authenticateStore`. `DELETE /account` deliberately has
no `requireStoreRole` gate — every role must be able to self-delete; the
owner-specific restriction is a business rule inside the controller.

### Rate limiting

| Limiter | Window | Max | Applied to |
|---|---|---|---|
| `storeAuthLimiter` (IP) | 15 min | 5 | login |
| `storeAccountLoginLimiter` (per account) | 15 min | 5 | login |
| `storePasswordResetLimiter` | 15 min | 5 | forgot-password |
| `storeWriteLimiter` | 60 s | 60 | every mutating store route |

Login is dual-layered (IP **and** account), matching `/api/admin/login`.

---

## 4. Models

**`Store`** — `getDefaultStoreId()`, `createVerified()`, plus read helpers.
**`StoreUser`** — `findByEmail`, `findById`, `create`, `listByStore`,
`deactivate`, `anonymize`. All multi-row operations are store-scoped in SQL
(`WHERE ... AND store_id = $n`); `findByEmail`/`findById` are intentionally not,
since they identify the user *before* a store scope exists.
**`StoreAction`** — append-only audit log; every mutating controller writes to it.

### 4.1 Dead code

`Store.createVerified()` is **called from nowhere** (`git grep` across
`backend/src` returns only its own definition). It is the only store-creation
path in the codebase, and as noted in §0 it would fail against production's
schema. This is the single biggest gap for Phase 1.

---

## 5. Database

### Core tables (production)

| Table | Constraints | Indexes |
|---|---|---|
| `stores` | **PK only** | **PK only** |
| `store_users` | PK, FK→stores, **UNIQUE(email)**, role CHECK | PK, email unique, `idx_store_users_store_id` |
| `store_password_tokens` | PK, FK→store_users CASCADE, UNIQUE(token) | PK, token unique, `idx_..._store_user_id` |
| `store_actions` | PK, FK→store_users, FK→stores | PK, `idx_..._store_user_id`, `idx_..._store_id` |

Two findings:

- **`stores` has no constraints or indexes beyond its primary key.** No unique
  name, no index on `is_active`. `getDefaultStoreId()` runs
  `SELECT id FROM stores WHERE is_active = true LIMIT 1` — an unindexed scan.
  Irrelevant at 1 row; a Phase 5 concern at scale.
- **`store_users.email` is globally UNIQUE, not per-store.** One email address
  can therefore belong to exactly one store, forever. This is a real constraint
  on Phase 1 onboarding design: a person who owns two stores cannot reuse an
  email, and a rejected applicant's email is occupied until deleted.

### Settlement/commission tables — schema without implementation

All four exist in production with well-designed constraints:

- `commission_rates` — `scope_type ∈ {global, store, promotional}`,
  `rate` bounded `0..1`, scope/store consistency CHECK, promotional windows must
  have both bounds, plus a partial unique index enforcing one active global rate.
- `settlement_config` — `scope_type ∈ {global, store}`, `cycle_days > 0`.
- `store_settlements` — `status ∈ {accruing, under_review, finalized, paid, adjusted}`,
  `cycle_end > cycle_start`.
- `store_settlement_line_items` — **`CHECK (store_earnings = item_value - store_commission)`**,
  i.e. the core money invariant is enforced at the database level.

**None of these four tables is referenced by a single line of backend code.**
They are schema-only. There is no settlement service, no commission resolution
logic, no accrual job, and nothing that reads or writes them.

`order_cancellation_store_shares` is the exception — it *is* used (4 files).

### Test/production divergence

`stores` differs between environments (§0). This is the third instance in this
engagement of test/prod schema drift causing a wrong conclusion. **Any Phase 1–5
schema claim must be verified against production specifically.**

---

## 6. Order attribution, end to end

1. `orderController.createOrder` calls `resolveDefaultStoreId()`.
2. That wraps `Store.getDefaultStoreId()` in try/catch: returns the first
   `is_active` store's id; returns `null` if none exists; on **any** thrown error
   logs `[orders] Could not resolve default store_id…` and returns `null`.
   It cannot throw into the checkout path.
3. The value is written to `orders.store_id` (real FK → `stores.id`).
4. `storeOrderController` reads `WHERE o.store_id = $1` using the token's
   `req.storeId`.

**Architectural limit:** attribution is *"the first active store"*, not a real
selection. With one store this is correct by definition. With two or more it is
**wrong** — every order would be attributed to whichever store sorts first. There
is no checkout store-selection step, and no product→store resolution at order
time even though `flash_inventory.store_id` exists. This is a hard blocker for
genuine multi-store operation and must be resolved before or alongside Phase 1.

Indexes supporting this: `idx_orders_store_id` (single-column, pre-existing) and
`idx_orders_store_id_created_at` (composite, added Stage 0).

---

## 7. Tenant isolation

`requireOwnStore` rejects any `storeId` supplied in params, body or query that
does not match the token's `storeId` (403). It does **not** cover routes keyed by
`:orderId`/`:productId`/`:staffId` — for those, isolation comes from the
controllers, each of which scopes by `req.storeId` derived from the JWT:

- List/analytics queries: `WHERE store_id = $1`.
- Id-keyed reads: fetch, then explicitly compare `store_id` and 404 on mismatch.
- Id-keyed writes: `WHERE id = $n AND store_id = $m` (stock updates additionally
  take `FOR UPDATE`).

**Adversarially verified** on a two-store database running this exact commit,
logged in as Store A and targeting Store B:

| Attack | Result |
|---|---|
| Read B's order by id | 404 |
| Accept / reject / mark-ready B's order | 404 / 404 / 404 |
| `?storeId=<B>` on orders, inventory, analytics | 403 ×3 |
| `storeId: <B>` in staff-create body | 403 |
| Cross-tenant stock update / deactivate | 404 / 404 |
| B's order present in A's list | absent (`{"orders":[]}`) |
| JWT payload tampered to claim B | 401 |
| `alg: none` forged token | 401 |

No endpoint failed. The public `/api/stores` endpoint exposes only
`id, name, logo_url, banner_url, description, address` — no owner PII.

**Caveat:** production has one store, so isolation is untestable there until a
second exists. Enforcement is in code rather than data, so the result carries
over — but Phase 1 must re-run this suite once a second real store exists.

---

## 8. Frontend

Vite + React SPA (`react-router-dom`), deployed as Render static site
`srv-dapr7e3bc2fs73bp0nj0` → **https://flash-store-portal.onrender.com**,
with an SPA rewrite (`/*` → `/index.html`) confirmed working.

Routes: `/login`, `/forgot-password`, `/reset-password`, `/orders`,
`/inventory`, `/analytics`, `/settings`, `/account`, `/not-available`.
`ProtectedRoute` guards the authenticated set; `roleNav.js` drives per-role
navigation and the post-login landing route.

Token is held in `StoreAuthContext`; `services/api.js` attaches
`Authorization: Bearer` and sets `Content-Type` only for non-FormData requests.

**Build config note:** `VITE_API_BASE_URL` is a *build-time* constant baked into
the bundle. Changing the backend URL requires a rebuild, not a restart.

**Deployment note:** the static site tracks branch
`feature/store-portal-minimal`, not `main`. It currently serves identical code,
but future `main` changes will not reach it until the branch is repointed.

---

## 9. Known issues carried into Phase 1

### 9.1 Forgot-password email copy bug *(known, to fix in Phase 1)*

`sendStorePasswordResetEmail` instructs the recipient to
*"Submit it with a POST request to /api/store-auth/reset-password"*. It was
written before the UI existed. A store owner cannot act on that. It should link
to `https://flash-store-portal.onrender.com/reset-password`. The backend flow and
the paste-the-code UI are both correct and complete — only the email copy is wrong.

### 9.2 SMTP path never exercised in production *(known, to verify in Phase 1)*

`store_password_tokens` has **0 rows** — no reset has ever been issued. The send
is fire-and-forget (`.catch()` logs, after the response is already returned), so
if SMTP is down or misconfigured the user sees *"a reset code has been sent"*,
a token is written, and **no email arrives** — with only a log line recording it.
If SMTP is not configured at all, `sendEmail` silently falls back to dev-mode
console logging and still reports success. This is the single highest-value
thing to test for real in Phase 1.

### 9.3 Other findings from this audit

| # | Finding | Impact |
|---|---|---|
| 1 | `Store.createVerified()` is dead **and** would crash in production (§0) | Blocks Phase 1 |
| 2 | No self-service onboarding of any kind — no signup/invite/approval route or table | Phase 1 scope |
| 3 | Order attribution is "first active store" — wrong for ≥2 stores (§6) | Blocks real multi-store |
| 4 | Settlement/commission schema exists but has zero implementation (§5) | Phase 2 foundation |
| 5 | No storage for store bank details at all | Phase 2 scope |
| 6 | `store_users.email` globally unique — constrains onboarding design | Phase 1 design |
| 7 | `stores` table has no indexes or constraints beyond PK | Phase 5 (scale) |
| 8 | Test/prod schema drift on `stores` | Process — verify against prod |
| 9 | Static site tracks a feature branch, not `main` | Operational |
| 10 | `sendStoreWelcomeEmail` exists but is never called | Phase 1 decision |

---

## 10. Groundwork available for later phases

**Phase 2 (payouts).** Paystack already implements the full *transfer* path and it
is proven in production for driver payouts: `createTransferRecipient`,
`verifyBankAccount` (name match), `getBankList` (South Africa),
`initiateTransfer`, `verifyTransfer`, `getBalance`. **Subaccounts / split
payments are not integrated at all (0 references).** `payoutService` already
demonstrates the safe pattern: `BEGIN` + `FOR UPDATE` row locks, an idempotent
per-attempt `reference`, and a compensating re-credit with `[CRITICAL]` logging
when a transfer fails after the balance was debited. The precedent therefore
points at **manual settlement + transfer**, reusing this machinery, rather than a
new subaccount-based path.

Two cautions:
- Driver bank details live in `transfer_recipients` with `account_number` stored
  **in plaintext**. Stores are required to be encrypted at rest, so the store
  implementation should *not* copy that precedent — and the driver table is worth
  revisiting separately.
- `utils/paymentCrypto.js` already provides AES-256-GCM `encrypt`/`decrypt` keyed
  by `PAYMENT_METHOD_ENCRYPTION_KEY`, deliberately separate from `JWT_SECRET`.
  This is the right existing tool for store bank details.

**Phase 3 (refunds).** `refundService` (`refundOrderPayment`, `finalizeRefund`),
`models/Return.js` and `returnController.js` all exist and are live, alongside
`return_requests` and `payment_refunds`. Phase 3 must begin by auditing that
end-to-end flow before designing the store-facing surface.

**Phase 4 (notifications).** `notificationService` is **Expo push only** — it
targets `ExponentPushToken` values from `drivers.push_token`/users. The store
portal is a **web** app, so this cannot be reused directly. The realistic shared
components are the existing nodemailer/SMTP transport for email and a new
DB-backed in-app notification table. Phase 4 should not build a fourth push
system, but it also cannot simply reuse the third.

---

## 11. Recommended sequencing note

§6 (order attribution) is not listed in the directive's phases, but it is a
prerequisite for Phase 1 being *meaningful*: onboarding a second store while
attribution is "first active store" would immediately misroute that store's
orders — and, once Phase 2 exists, misroute its money. Recommend it is resolved
as part of Phase 1 rather than deferred.

---

*Phase 0 complete. No code, schema or deployment was changed in producing this
document.*
