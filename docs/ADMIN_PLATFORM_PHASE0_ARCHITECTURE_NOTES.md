# Admin Platform — Phase 0 Architecture Notes

**Branch:** `admin-platform` (created off `main` at the security-remediation-reconciled tip, verified to include the OAuth age-gate fix `c9534f0` and the Google Maps key redaction `2e704b5`).
**Purpose:** Read-only mapping exercise before proposing a store-account identity model (Phase 1). No code, no migrations, no routes were written for this document — everything below is either a direct read of files on `main`/`admin-platform`, or a direct read (via `git show`/`git archive`, never merged) of files that exist only on the unmerged `production-readiness-audit` branch, clearly labeled as such throughout.

---

## 1. The store-portal frontend's expectations (`flash-store-portal`, source pulled from `production-readiness-audit`)

The `flash-store-portal/` directory sitting untracked in the working tree on this branch is stale build output only (`dist/`, `node_modules/`, `.env`) — no real source. The actual React/Vite source lives only on `production-readiness-audit`. It was extracted read-only via `git archive production-readiness-audit -- flash-store-portal | tar -x` into a scratch directory for this mapping; nothing was merged or copied into this branch's working tree.

It is a small, complete app: `App.jsx`, `StoreAuthContext.jsx`, `ProtectedRoute.jsx`, `PortalLayout.jsx`, 5 pages (Login, Orders, Inventory, Settings, NotAvailable), `services/api.js`, plus `roleNav.js`/`orderStatus.js` utilities. It was previously confirmed to run locally (`npm run dev`, serves on :5173, `VITE_API_BASE_URL` defaulting to `http://localhost:3000`) — its expectations below are a real constraint, not speculative.

### 1.1 Base URL / auth
- `VITE_API_BASE_URL` env var, default `http://localhost:3000` (`.env.example`).
- Token stored in `localStorage` under `flash_store_token`; sent as `Authorization: Bearer <token>` on every request (`services/api.js`).
- User object cached in `localStorage` under `flash_store_user`.
- A `FormData` body (image uploads) never gets a manual `Content-Type` — left to `fetch` for correct multipart boundaries.

### 1.2 Endpoints it calls (all under `storeApi` in `services/api.js`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/store-auth/login` | `{email, password}` → `{token, storeUser}` |
| POST | `/api/store-auth/logout` | best-effort, client clears session regardless |
| DELETE | `/api/store-auth/account` | self-service account deletion (non-Owner only) |
| GET | `/api/store-orders[?status=]` | `{orders: [...]}` |
| GET | `/api/store-orders/:id` | single order |
| POST | `/api/store-orders/:id/accept` | `pending_store_acceptance` → `preparing` |
| POST | `/api/store-orders/:id/reject` | `pending_store_acceptance` → `cancelled` |
| POST | `/api/store-orders/:id/mark-ready` | `preparing` → `waiting_for_driver` |
| GET | `/api/store-inventory` | `{products: [...]}` |
| GET | `/api/store-inventory/:id` | single product |
| POST | `/api/store-inventory` | add product (multipart, `product_name`, `price`, `category`, `brand`, `sizes`, `stock_by_size`, optional `image`) |
| PATCH | `/api/store-inventory/:id/stock` | `{stock_by_size}` |
| PATCH | `/api/store-inventory/:id/image` | multipart `image` |
| PATCH | `/api/store-inventory/:id/deactivate` | soft-deactivate |
| GET | `/api/store-staff` | `{staff: [...]}` — Owner only per backend, frontend renders an access-denied state on 403 |
| POST | `/api/store-staff` | `{name, email, password, role}` |
| PATCH | `/api/store-staff/:id/deactivate` | soft-deactivate a staff account |

### 1.3 Login/role flow
- Plain email+password form. On 401 → "Invalid email or password." On 403 → shows the backend's own message verbatim (used for the Marketing-role-not-yet-supported block). On 429 → rate-limit message. Network-level failure (no HTTP response at all — server down or CORS misconfiguration) is shown as a distinct "Could not reach the server" message, deliberately never conflated with "wrong password."
- After login, navigates to `getDefaultRouteForRole(user.role)` (`utils/roleNav.js`).
- Six roles hardcoded client-side: `owner`, `store_manager`, `inventory_staff`, `sales_staff`, `finance`, `marketing`. Nav visibility per role:
  - `owner`: Orders, Inventory, Settings
  - `store_manager`: Orders, Inventory
  - `inventory_staff`: Inventory only
  - `sales_staff`: Orders only
  - `finance`: no screen yet (`/not-available` — an honest "not built yet" state, not empty/broken)
  - `marketing`: not in the nav map at all — matches the backend explicitly blocking marketing login (see §2 note in Phase 1 doc).
- Every page treats an empty list arriving after a **403** as a distinct "access denied" state, never conflated with a genuinely empty "no orders/products/staff yet" list.
- `ProtectedRoute` only checks "is there a `storeUser` in context" — it does **not** independently re-verify the token; a stale/expired token would only surface as 401s on the first real API call. This is a client-side UX nicety only; nothing about the frontend can be a security boundary on its own, matching every other Flash client app's convention.

### 1.4 What none of this frontend code proves
It proves the shape of the API contract the frontend author designed against — it proves **nothing** about whether that backend contract exists, was ever implemented correctly, or was ever adversarially tested on `production-readiness-audit`. Whether to trust that prior implementation as-is or re-derive/re-review it is a Phase 2+ question, not resolved here.

---

## 2. Flash admin dashboard (AdminJS) auth — current state on `main`/`admin-platform`

Read directly from `backend/src/adminPanel.js`, `backend/src/controllers/adminController.js`, `backend/src/models/Admin.js`, and `backend/src/db/migrate.js` (migration v18) **as they exist on this branch** (not `security-fixes`, which has since diverged further — see the note in §2.3).

### 2.1 Identity store
- Real, individual `admins` table (migration v18, comment: *"Admin panel Phase 0 ... Replaces the single shared `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH` identity with real rows, same shape as users/drivers (id, name, email UNIQUE, password_hash, phone nullable, created_at/updated_at). `role` exists from day one ... every row defaults to `'admin'` today."*).
- `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH` env vars still appear in `.env.example`/`emailService.js` grep hits, but the live login path (`adminController.js`, `adminPanel.js`'s `authenticate()`) reads from the `admins` table via `Admin.findByEmail` + `bcrypt.compare`, not from those env vars. (CLAUDE.md's description of a "single-credential" model is stale on this specific point — flagging per CLAUDE.md's own "treat specifics as possibly stale" instruction.)

### 2.2 Two auth surfaces, one identity check, two token mechanisms
- **JSON API** (`/api/admin/*`, `adminController.js`): `POST /api/admin/login` → `Admin.findByEmail` + `bcrypt.compare` → JWT signed with `ADMIN_JWT_SECRET`, payload `{id, role, jti}`, 8h expiry. Verified per-request by `middleware/auth.js`.
- **AdminJS server-rendered UI** (mounted at `/admin-panel`, `adminPanel.js`): its own `authenticate(email, password)` function calls the *exact same* `Admin.findByEmail` + `bcrypt.compare` check (explicit comment: *"one source of truth for admin credentials, not a second parallel login"*), but the session mechanism is `@adminjs/express`'s own cookie session (`buildAuthenticatedRouter`), not the bearer JWT.
- **On this branch specifically**, the AdminJS cookie session's `cookiePassword`/session `secret` both reuse `process.env.ADMIN_JWT_SECRET` directly — flagged in the code itself as a `PROTOTYPE NOTE`: *"reusing ADMIN_JWT_SECRET as the session-cookie signing secret for now ... Worth its own dedicated secret once Phase 1 is fully built out, not before."* A dedicated `ADMIN_SESSION_SECRET` fix for exactly this (`M-2` in the security self-pentest) **exists on `security-fixes`, not on `main`/`admin-platform`** — this branch was deliberately cut from `main`, not `security-fixes`, per the task's own instructions, so it does not carry that fix yet. Worth remembering if/when `security-fixes` merges to `main` later and this branch rebases.

### 2.3 Relationship to the main `middleware/auth.js` JWT system
Confirmed via direct read: `middleware/auth.js`'s `authenticate()` tries `JWT_SECRET` (users/drivers) first, and on a signature mismatch falls back to trying `ADMIN_JWT_SECRET`, then cross-checks that a token claiming `role: 'admin'` was actually signed with `ADMIN_JWT_SECRET` (not just carrying that claim while verified against the other secret) — closing an earlier real gap where a wrong-secret-but-admin-claiming token would have been silently accepted. So: **two disjoint secret domains today** (`JWT_SECRET` for users/drivers, `ADMIN_JWT_SECRET` for admins), sharing only the `revoked_tokens`/`jti` revocation mechanism and the same `authenticate()` entry point. There is **no third (store) secret domain on this branch** — `STORE_JWT_SECRET`, `authenticateStore`, `requireStoreRole`, `requireOwnStore` are all design-only, described in `FLASH_STORE_ADMIN_DESIGN.md` §3 on `production-readiness-audit`, and not implemented anywhere on `main`/`admin-platform`.

### 2.4 Audit trail
`admin_actions` table (migration v18) logs internal-admin actions only. No equivalent `store_actions` table exists on this branch (it's design-only on `production-readiness-audit`, §5.4 of `FLASH_STORE_ADMIN_DESIGN.md`).

**Conclusion: the AdminJS/admin dashboard is fully separate infrastructure from any future store-admin system** — separate table, was already isolated from `users`/`drivers` before this task started, and (per the design doc read in §4 below) was explicitly designed to stay that way rather than be extended.

---

## 3. Current data model for "a store" — the single most important finding

**On `main`/`admin-platform` today, Flash has no per-store/per-boutique data model at all.** This was verified three independent ways:

1. **No `stores` table exists.** `grep -n "CREATE TABLE IF NOT EXISTS stores"` against `backend/src/db/migrate.js` on this branch returns nothing. The `stores` table (with `owner_name`/`owner_email`/`owner_phone` contact columns, `is_active`, seeded with exactly one row — "Flash Closet") is migration **v29**, and **v29 only exists on `production-readiness-audit`**, not on this branch.

2. **`orders.store_id` is a real UUID column, but it is hardcoded to `null` by the backend, never trusted from the client.** Migration v27 (present on this branch) changed `orders.store_id` from a free-text `VARCHAR(100)` to `UUID` for type-consistency reasons only — the migration's own comment states plainly: *"this codebase is genuinely single-vendor (no `stores` table; store_id is a free-text tag, always 'flash_closet')"* (pre-v27 state) and *"no real client anywhere in either app ever actually populates that field."* `orderController.js` (current, line ~149) explicitly sets `store_id: null` on every order it creates, with an inline comment: *"there is no multi-vendor 'stores' concept yet, so a client-sent store_id has nothing real to validate against ... Explicit null until a real stores table + checkout store-selection step exists."*

3. **`flash_inventory` (the real, live product catalog) has no `store_id` column at all.** Its schema (migrate.js, the original table-creation block) has no tenant/store foreign key of any kind — every product in the live system implicitly belongs to the one and only real store, "Flash Closet" (a.k.a. the legacy free-text tag `"flash_closet"` seen elsewhere, e.g. `store_boosts`).

**In plain terms: Flash today is a single-store business at the data-model level.** There is exactly one real store — Flash itself/"Flash Closet" — with no boutique-level distinction anywhere in the live schema, no way today to represent a second real store's orders or inventory as separately owned, and the one column that was clearly intended as the future multi-store foreign key (`orders.store_id`) is deliberately never populated.

### 3.1 What exists only on the unmerged `production-readiness-audit` branch (read via `git show`, not merged)
A substantial, already-written multi-tenant foundation exists there but nowhere on `main`/`admin-platform`:
- `stores` table (migration v29): `id, name, address, lat, lng, service_area_bounds, owner_name, owner_email, owner_phone, is_active, created_at, updated_at`. Only one row seeded ("Flash Closet", Flash's own real address/coordinates). `owner_email` is explicitly commented as the field meant to "identify who the store's real owner/contact is, distinct from Flash's own admin account" — deliberately deferring banking/settlement data to a later, separate design.
- `store_users` table + `Store`/`StoreUser` models, `storeAuthController.js` (a `STORE_JWT_SECRET`-signed, 8h-expiry JWT login, structurally mirroring `adminController.js`'s pattern; Marketing role explicitly blocked from login post-credential-check to avoid email-enumeration; self-delete blocked for Owner role), `storeInventoryController.js`, `storeOrderController.js`, `storeStaffController.js`, `storefrontController.js`, and their route files — a working (never merged, never adversarially re-tested on this branch) implementation of the exact API surface the store-portal frontend expects (§1.2 above matches these route paths one-to-one).
- `Store.getDefaultStoreId()` — a deliberately-named "default, not only" helper used everywhere a real `store_id` is needed today but there's no multi-store selection step yet; named specifically so a future real second store is "a search for this one method, not a hunt through call sites."
- Design docs: `FLASH_STORE_ADMIN_DESIGN.md`, `DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md`, `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md`, `FINANCIAL_DOMAIN_SPECIFICATION.md` — all `production-readiness-audit`-only.

None of this was merged, copied, or otherwise brought onto `admin-platform` by this task — it is described here strictly as prior-art context per the task's instructions.

---

## 4. Why this was deliberately left unmerged (prior reasoning, read from existing docs)

Two sources, both read directly, confirm this was a considered decision, not an oversight:

- **`SECURITY_REMEDIATION_LOG.md`'s Phase 0** (exists on `security-fixes`, not yet on `main` — read via `git show security-fixes:...`, not merged): during the recent security-remediation branch reconciliation, the author explicitly identified that `production-readiness-audit` "is not purely security/reliability fixes. It also carries the full multi-tenant 'Store Admin' initiative ... That is exactly the kind of decision `CLAUDE.md`'s Architecture Decision Framework exists for ... Nothing in this session's history shows that framework was ever run for landing multi-tenant work on `main`, and merging 4,000+ lines of new schema/routes/a whole new frontend onto the branch Render auto-deploys, as a side effect of a security-fix task, would itself have been a significant unreviewed architectural decision made silently. I did not do that." Only the ~30 non-multi-tenant commits were cherry-picked onto the reconciled `main` this branch is built from.

- **`FLASH_STORE_ADMIN_DESIGN.md` §7 ("What's explicitly out of scope")**, on `production-readiness-audit` itself: *"Store onboarding/self-signup flow — this document assumes `store_users` and `stores` rows are created by Flash (an internal, manual or admin-panel-driven process), not a public self-service signup — a real product decision the founder hasn't been asked yet and isn't decided here."* `DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md` independently confirms the same gap: *"Can approve: Flash Administrators approve a Store's existence (onboarding a new store is an internal Flash decision ... no self-service signup exists or is designed)"* and separately flags store-onboarding audit logging itself as *"Not yet designed."*

**This is precisely the open gap this task's Phase 1 exists to close**: even the most detailed prior design work on `production-readiness-audit` explicitly declined to design how Flash verifies that whoever sets up the first `store_users` row for a given `stores` row is actually authorized to represent that real store — it assumed "Flash does it manually" without specifying the mechanism that prevents impersonation.

---

## 5. Ambiguities / things flagged rather than guessed at

None of these block Phase 1, but are worth surfacing explicitly per the task's Phase 0 step 5:

1. **CLAUDE.md's admin-auth description is stale**, per CLAUDE.md's own disclaimer that docs can drift — it describes a single-shared-credential (`ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`) model; the real, current model (migration v18 onward) is a real multi-row `admins` table. Not a blocker, just noted so Phase 1/2 don't design against the stale description.
2. **`ADMIN_SESSION_SECRET` (the AdminJS cookie-secret isolation fix) exists on `security-fixes` but not on this branch.** This branch was deliberately cut from `main`, per the task's explicit instruction, so it doesn't have it. Not a blocker for Phase 0/1 (no admin-auth code is being touched), but worth remembering before `admin-platform` eventually reconciles with `security-fixes`/`main` again.
3. **The store-portal frontend's RBAC assumptions (§1.3) and `production-readiness-audit`'s backend RBAC design (§5.3 of `FLASH_STORE_ADMIN_DESIGN.md`) match exactly** — six roles, same names, same nav gating, same Marketing-login-blocked/Finance-not-built-yet states. This is good news for Phase 2+ (the frontend and the most detailed prior backend design agree), but it also means Phase 2+ would either need to re-implement that backend surface faithfully or explicitly decide to diverge from it — not something to silently assume either way.
4. **No verification was attempted of whether `production-readiness-audit`'s store-scoped backend code (`storeOrderController.js` etc.) actually enforces tenant isolation correctly** (i.e., whether `requireOwnStore` genuinely prevents Store B from reading Store A's data). `FLASH_STORE_ADMIN_DESIGN.md` §5.1 itself flags this as needing live adversarial verification "before this portal ships a second real store" — that verification was never claimed as done anywhere in the docs read for this task. Treat any reuse of that code as unverified until it is actually attacked, not just read.
