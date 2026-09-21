# Flash — Store Portal Architecture, Functionality & Scale-Readiness Audit

**Date:** 2026-09-21
**Author:** Claude Code, investigation and documentation only.
**Scope:** read-only. **No code, config, or database changes. No commits to
`admin-platform` or any existing branch.** Everything here is verified by reading real
files (with file/line citations) at their real, current locations, and running
real, read-only git/shell commands whose actual output is quoted. Where something
couldn't be verified live (Supabase's MCP access was disconnected mid-session and
was not restored for this audit — noted explicitly wherever it matters, mainly
row-level-security policy checks), this is stated plainly rather than assumed.

---

## Ground-rule verification, done first, as instructed

**Git state before touching anything** (`git status`, `git branch -a`, current
checkout — run in the main working copy before this audit began):
```
On branch chore/gitignore-flash-store-portal
Your branch is up to date with 'origin/chore/gitignore-flash-store-portal'.
Untracked files: docs/audits/SECURITY_SELF_PENTEST_REPORT.md
```
Clean. No uncommitted work at risk.

**Where the real `flash-store-portal` source actually lives, verified live, not
assumed from a past audit:** confirmed via `git worktree list` that the
`admin-platform` branch is checked out at
`C:\Users\makas\projects\Flash App\.claude\worktrees\agent-a6598502319f8f63f`, and
`find flash-store-portal -maxdepth 1` there shows real source —
`package.json`, `src/`, `vite.config.js`, `index.html` — not the stray build-only
clutter that sits (now gitignored) in the main checkout. This matches the last
audit's finding, re-confirmed live rather than trusted.

**Note on that worktree's own state:** it currently has its own uncommitted changes
(`backend/src/adminPanel.js` modified, a stray `.env` backup file) — leftover from
earlier work in this same worktree during a prior session. **Not touched, not
committed, not disturbed** — this audit only read files there via absolute path,
never ran `git add`/`commit`/`checkout`/`stash` inside it.

**Mechanism used:** direct file reads against the existing worktree path — no new
worktree created, no branch checked out, no risk to any in-progress session using
that worktree. This documentation itself lives on a brand-new branch,
`docs/store-portal-architecture-audit`, branched from latest `origin/main` (not
stacked on `admin-platform`).

---

## Executive summary — plain language, for a founder to read first

The Store Portal is a real, working application — not a scaffold. A boutique owner
or their staff can genuinely log in, add products with photos, adjust stock, and see
their own orders, and none of it is fake or half-wired. It correctly talks to the
same main Flash backend everything else uses — it doesn't have its own database or
its own duplicate business logic.

Three things are worth knowing plainly, up front:

1. **A store's inventory really does reach real customers in `flash-user-app` —
   confirmed by tracing the actual code, not assumed — but every store's products
   currently show up mixed together in one undifferentiated list.** There is no
   "which store is this from" information sent to the customer app at all today.
   Practically: the *write* side of multi-tenancy (a store can only touch its own
   products) is real and enforced. The *read* side a customer actually sees has no
   per-store storefront concept yet — that appears to be exactly what the separate,
   unmerged `multi-tenant-stage7-customer-storefront` branch was building, and it
   was never finished or connected to this actual Store Portal implementation.
2. **Real, role-based permissions exist and are enforced by the backend** — a Sales
   Staff member genuinely cannot touch inventory, an Inventory Staff member
   genuinely cannot see settings. This isn't aspirational; it's built and it's the
   backend, not just the screen, that enforces it.
3. **Nothing watches this app when something goes wrong.** No Sentry, no PostHog —
   confirmed by their total absence from the code, not an assumption. If a store
   owner's upload silently fails, or a customer never sees a new item, there is
   currently no automated way to find out except someone reporting it.

One more finding worth a founder's attention specifically: **the Store Portal you'll
find in `admin-platform` is not the same codebase as the seven `multi-tenant-stageN`
branches already in this repo** — they're two separate, independently-built
implementations of "a store portal," verified by comparing actual git history, not
inferred from branch names. This is explained fully in Section 2 below, and it's the
single most important thing to resolve before investing further here.

Full technical depth, with citations for every claim, follows.

---

## 1. Architecture, end to end

### Stack and maturity

React 18 + Vite + `react-router-dom` + `socket.io-client`
(`flash-store-portal/package.json`, admin-platform, read live). No state-management
library beyond React's own Context API — matches the mobile apps' own
`FlashContext.js`/`DriverContext.js` convention by explicit design (comment in
`StoreAuthContext.jsx:4-5`: *"matching the existing mobile apps' own... convention
(CLAUDE.md)"*).

This is a **real, working application, not a scaffold** — 17 source files under
`src/`, covering login/forgot-password/reset-password, a role-aware nav shell, and
five real functional pages (Orders, Inventory, Analytics, Settings, Account), each
backed by real API calls and real error/loading states — confirmed by reading every
page file, not just listing them.

### Backend: shared, not separate

**No API layer of its own.** `services/api.js:4` points `BASE_URL` at
`VITE_API_BASE_URL || 'http://localhost:3000'` — the same main Flash backend
(`backend/`) the mobile apps use. Every call in the `storeApi` object
(`api.js:29-62`) hits a `/api/store-*` route on that same backend
(`storeAuthRoutes.js`, `storeInventoryRoutes.js`, `storeOrderRoutes.js`,
`storeStaffRoutes.js`, `storeAnalyticsRoutes.js` — all confirmed present in
`backend/src/routes/`). There is no separate store-portal backend service, no
separate deployment — this matches the prior `SERVER_INVENTORY_AUDIT.md`'s own
finding that no such service exists anywhere on Render or Vercel.

### Database: shared `flash-db`, with real (application-level) tenant isolation

Same Supabase database everything else uses — `flash_inventory`, `store_users`,
`store_actions`, `orders`, etc. all live in `flash-db`. **Tenant isolation is real
and enforced, verified by reading the actual queries, not assumed because "the main
backend handles it elsewhere":**

- Every store-scoped controller derives the store from `req.storeId` (set by the
  `authenticateStore` middleware from the JWT), **never** from client-supplied
  params/body/query — confirmed directly in `storeInventoryController.js`'s own
  header comment (lines 9-11): *"every handler derives store scope from
  req.storeId... never from req.params/body/query."*
- Every read/write query that touches a specific row double-checks store ownership
  in the query itself: `getProduct` (`storeInventoryController.js:41-45`) explicitly
  compares `String(product.store_id) !== String(req.storeId)` and returns **404**,
  not 403, on a mismatch — a deliberate anti-enumeration choice (a wrong store can't
  even learn the record exists). `updateStock`, `updateImage`, and
  `deactivateProduct` all scope their `WHERE ... AND store_id = $N` clause the same
  way (`storeInventoryController.js:150-155`, `:120-124`, `:181-185`).

**Important nuance, not glossed over:** this is **application-level** isolation —
every query is correctly scoped today, but there is no independent, database-level
backstop (Postgres Row-Level Security) verified in this audit. **Not verified live**
— Supabase's own MCP query access disconnected mid-session and wasn't available for
this specific audit, so this audit could not directly query
`pg_policies`/`pg_tables.rowsecurity` to confirm whether RLS is enabled on
`flash_inventory`/`store_users`/`store_actions` at the database level. What *is*
confirmed by reading `backend/src/db/migrate.js`'s full table-creation history: no
`CREATE POLICY` or `ENABLE ROW LEVEL SECURITY` statement exists anywhere in that
file for any store-related table. **If RLS is not separately enabled in the Supabase
dashboard (not verified either way here), tenant isolation today depends entirely on
every single controller consistently remembering to filter by `store_id` — which is
true of every controller checked in this audit, but is a discipline, not a
structural guarantee.** A single future endpoint that forgets this one `WHERE`
clause would be a full cross-tenant data leak with nothing at the database level to
catch it. This is the single highest-leverage, cheapest structural hardening
available here, and it's a config-only Supabase dashboard action, not a code
rewrite.

---

## 2. Relationship to the multi-tenant-stageN work already in progress

**Traced via actual git history and tree-content comparison, not inferred from
branch names, per the explicit instruction not to assume.**

`flash-store-portal` does **not** exist at all on `multi-tenant-stage1-schema` or
`multi-tenant-stage2-store-auth` (`git ls-tree -d <branch> -- flash-store-portal`
returns nothing for both). It first appears on `multi-tenant-stage3-store-portal`,
and its tree hash **changes at every subsequent stage** — a real, evolving
implementation, not a placeholder:

| Branch | `flash-store-portal` tree hash |
|---|---|
| `multi-tenant-stage3-store-portal` | `dce7dc7...` |
| `multi-tenant-stage4-store-inventory` | `d486d98...` (changed) |
| `multi-tenant-stage5-store-staff` | `d9fce2e...` (changed) |
| `multi-tenant-stage6-portal-polish` | `c1eadc6...` (changed) |
| `multi-tenant-stage7-customer-storefront` | `c1eadc6...` (unchanged from stage 6 — consistent with that stage's name being about the *customer* side, not the portal itself) |
| **`admin-platform` (the one actually being audited)** | **`1be1116b...` — matches none of the above** |

**`git merge-base admin-platform multi-tenant-stage7-customer-storefront`** resolves
to commit `b1b535c`, and `git ls-tree -d b1b535c -- flash-store-portal` returns
**nothing** — the common ancestor of these two branches predates `flash-store-portal`
existing on *either* of them. **This proves they are two independent, parallel
implementations, not one branching from or merging into the other.** File-count
comparison confirms real divergence in substance, not just cosmetic: `admin-platform`
has 19 files under `flash-store-portal/src`; the multi-tenant lineage's final state
(stage 6/7) has 14.

**Precise answer to the question asked:** the Store Portal in `admin-platform` is
**neither** "the frontend for the multi-tenant-stageN effort" **nor** something
wholly unrelated in spirit — it's a **separately-built, independent second attempt at
the same goal**, sharing the same name and the same general purpose (a store-facing
portal), built without git history connecting it to the other one. Section 1's
finding that customer-facing reads have no per-store storefront concept is
consistent with this: `multi-tenant-stage7-customer-storefront` — the branch whose
name suggests it solves exactly that gap — was never connected to the
implementation actually being audited here.

**This audit does not know why two implementations exist** (parallel exploration,
an abandoned first attempt, a deliberate restart) — that context isn't recoverable
from git alone, and this audit says so rather than speculating.

---

## 3. Who actually uses it, and how the UI differs per role

**Real, built, backend-enforced — not aspirational.** Five roles exist:
`owner`, `store_manager`, `inventory_staff`, `sales_staff`, `finance`
(`flash-store-portal/src/utils/roleNav.js:16-37`).

| Role | Sees in nav | Backend-enforced access (route-level middleware) |
|---|---|---|
| `owner` | Orders, Inventory, Analytics, Settings | All of it, plus Settings (staff management) — `storeStaffRoutes.js`'s own comment: *"managing store_users is Owner-only, no Store Manager exception"* |
| `store_manager` | Orders, Inventory, Analytics | Same as owner minus Settings |
| `inventory_staff` | Inventory only | `INVENTORY_VISIBLE_ROLES = ['owner','store_manager','inventory_staff']` (`storeInventoryRoutes.js`) — Sales/Finance get a real 403 |
| `sales_staff` | Orders only | Analogous role list on `storeOrderRoutes.js` (not separately re-quoted here; confirmed present by the same `requireStoreRole(...)` pattern) |
| `finance` | Analytics only | Read-only financial view |

**Where enforcement actually lives — checked precisely, not assumed:** every route
in `App.jsx:32-79` (`/orders`, `/inventory`, `/analytics`, `/settings`) is wrapped
**only** in `ProtectedRoute` — a login/force-password-reset check, with **no
role-specific guard at the React Router level at all**. A Sales Staff member typing
`/settings` directly into the browser bar would have the React page component
attempt to render. **This is not a bug** — `PortalLayout.jsx`'s own comment says so
explicitly: *"the API layer underneath is what actually enforces this... this is the
UX layer on top of it, not instead of it."* Confirmed in practice:
`InventoryPage.jsx:20-33` explicitly handles a `403` from the backend by showing
*"Your role doesn't have inventory access"* rather than an empty/broken list. The
real boundary is the backend; the frontend is UX-only, and gracefully degrades when
bypassed — a correct, deliberate "server is the boundary" pattern, matching how the
rest of this codebase is built.

---

## 4. The core workflow: inventory upload → visible in `flash-user-app`

Traced completely, end to end, with every step cited.

### 4.1 The actual upload flow

**Form-based, single item, single size per submission — there is no bulk-upload
path anywhere in this codebase**, confirmed by reading the entire `AddProductForm`
component (`InventoryPage.jsx:204-246`): `product_name`, `price` (both
`required` on the HTML input), optional `category`/`brand`, exactly one size chosen
from a dropdown, one initial stock count for that size, one optional image. This
directly and completely answers "is there a bulk upload" — no.

### 4.2 Server-side validation, real not cosmetic

`storeInventoryController.js:76-79`: `product_name` and `price` are re-validated
server-side (`400` if missing) — the client's `required` attribute is not the real
gate. **Image validation is genuinely real, not just a client-side accept hint:**
`detectRealMimeType(req.file.buffer)` checks the file's actual magic bytes, not the
client-declared MIME type (`storeInventoryController.js:87-90`) — the same
discipline already used for driver documents/order photos elsewhere in this
codebase, and the route-level `multer` config's own comment confirms why:
*"multer's fileFilter only sees the client-declared mimetype (trivially
spoofable)"* (`storeInventoryRoutes.js:13-14`).

### 4.3 What gets written, and the real image pipeline

A valid image goes through `s3Service.uploadPublicFile(req.file, "flash-product-images")`
(`storeInventoryController.js:91`) before the database row is written — the same
Cloudinary-backed upload service used elsewhere in this codebase (confirmed by name;
`s3Service.js` is this repo's existing Cloudinary wrapper, not a new integration).
The `INSERT INTO flash_inventory` (`storeInventoryController.js:96-102`) is a plain,
single-statement write — no separate draft/review table, no staging step.

### 4.4 Does it require a review/approval step before going live?

**No — confirmed directly, not assumed absent.** There is no approval workflow, no
second-person sign-off, and no draft state anywhere in `addProduct`. The row is
inserted directly; visibility is governed only by `is_active` (defaults to whatever
`migrate.js`'s table definition sets — a plain boolean, not a review-gated state).
**Any role with inventory access — including the most junior, `inventory_staff` —
can single-handedly publish a new product that real customers can buy, instantly.**

### 4.5 How it actually reaches `flash-user-app` — and the real caching finding

`addProduct`, `updateImage`, `updateStock`, and `deactivateProduct` **all**
explicitly call `await clearCache("cache:*/inventory*")`
(`storeInventoryController.js:105, 141, 172, 190`) immediately after their write —
with the comment: *"The public customer catalog (GET /api/inventory) caches this
same table for 60s — a store-created product/stock change must not be invisible...
for up to a minute."* This is genuinely careful engineering.

**But tracing the actual cache implementation reveals something the comment doesn't
say: the cache is currently a complete no-op in production.** `backend/src/
middleware/cache.js:12-15`: the `cache()` middleware's very first line is
`if (!redisClient || ...) { return next(); }` — and `redisClient` is only created
when `REDIS_URL` is set (`cache.js:5`). **`REDIS_URL=disabled` has been confirmed
live, repeatedly, throughout this project's recent work** (most recently via the
running backend's own `/health` endpoint reporting `"redis":"not_configured"`).
**This means: today, `GET /api/inventory` is never actually cached at all — every
customer request hits the database live, every time.** Practically, this means
inventory changes are genuinely real-time today — but this is an *accidental*
side effect of Redis being absent for an unrelated reason (documented in the
project's own scaling audit), not a deliberate freshness guarantee. **The moment
Redis is provisioned** (which the project's own prior audit identifies as
necessary once a second backend instance is ever added — see
`SCALING_RESILIENCE_AND_DISASTER_RECOVERY_AUDIT.md`), this cache activates, and the
`clearCache` calls found here become genuinely load-bearing for freshness. They're
already correctly in place for that day — a good example of code written ahead of
an infrastructure change that hasn't happened yet.

### 4.6 Confirmed: it reaches customers, but with zero store differentiation

`GET /api/inventory` → `InventoryController.getProducts`
(`backend/src/controllers/inventoryController.js:7-16`) → `Inventory.getProducts()`
(`backend/src/models/Inventory.js:12-29`). The **actual SQL** run for every customer
catalog page load: `SELECT ${PUBLIC_COLUMNS} FROM flash_inventory WHERE
is_active=true ... ORDER BY ...` — **no `store_id` filter anywhere in this query.**
The response also includes `storeId: FLASH_STORE_ID`
(`inventoryController.js:4,11`), but `FLASH_STORE_ID = "flash_closet"` is a **static
string constant**, not derived from the row's actual `store_id` — it does not filter
anything.

**Confirmed further: `store_id` is not even among the columns customers receive.**
`PUBLIC_COLUMNS` (`Inventory.js:8-9`): `id, product_name, category, brand, price,
sizes, stock_by_size, image_url, description, is_active, created_at, updated_at` —
no `store_id`, no store name, nothing.

**Precise, evidence-based conclusion:** a new store's inventory, once added via the
Store Portal, **does genuinely reach real customers in `flash-user-app`** — the
write-to-read pipeline is real and functional end to end, confirmed by tracing every
step. But it arrives in one single, flat, undifferentiated list mixed with every
other store's (and Flash's own original) products, with **no data field present, even
internally, for a future UI to tell them apart.** There is no "storefront" concept
on the customer side today — matching Section 2's finding that the
customer-storefront work was never connected here.

### 4.7 The real race condition — confirmed by the code's own comment, not inferred

`updateStock` (`storeInventoryController.js:143-176`) does use a real transaction
with `SELECT ... FOR UPDATE` (line 156-158) — this correctly serializes two
*simultaneous* writes to the same row so they don't corrupt each other at the SQL
level. **But the function's own header comment states the real, remaining gap
directly:** *"this still takes a full stock_by_size replacement, not a per-size
delta, so a stale Store Portal submission can still overwrite a concurrent decrement
once the lock is acquired — flagged, not silently solved"* (lines 137-140).

Concretely, tracing the client code that produces this: `InventoryPage.jsx:48-51`
builds `updatedStock` by spreading the **locally-cached** `product.stock_by_size`
(from the last `loadProducts()` call) and only overwriting the one size actually
being edited — then sends that **entire merged object** to the backend. If a
customer buys the last unit of a different size in between the staff member's page
load and their stock edit, the staff member's submission still carries the *old,
pre-sale* count for that size — and their update will silently revert it, undoing
the sale's stock decrement. **This is real, currently possible, and honestly flagged
in the code itself — not a hidden bug this audit discovered, but a known, accepted
limitation.** The same limitation exists in the platform-wide (non-store-portal)
`Inventory.updateStock()` too, per that comment's own reference — so it isn't unique
to the Store Portal, but the Store Portal doesn't fix it either.

### 4.8 Every point in the pipeline where something could go wrong, concretely

1. **Missing required field:** caught server-side (`product_name`/`price`), `400`
   returned — handled correctly.
2. **Bad/spoofed image type:** caught by real magic-byte detection, `400` returned —
   handled correctly.
3. **A store accidentally publishing an item that isn't actually available:** **not
   prevented anywhere.** There's no draft state, no confirmation step beyond the
   browser's own form submit — `is_active` defaults to visible immediately (Section
   4.4). This is a real, plain gap.
4. **Two staff editing the same item / a customer purchase racing a stock edit:**
   real, code-acknowledged limitation (Section 4.7).
5. **A store's own products bleeding into another store's view:** not observed —
   write-side isolation is real and consistently applied (Section 1).
6. **Stale data shown to a customer:** not currently possible in practice (cache is
   inactive), but latent — will resurface the moment Redis is provisioned, unless
   the existing `clearCache` calls are kept intact.

---

## 5. Scale and growth readiness

**Where this design strains first, cited against real code, not general scaling
platitudes:**

1. **The `store_id`-less customer read query is the actual ceiling, not raw
   performance.** As stores grow from a handful to many, `SELECT ... FROM
   flash_inventory WHERE is_active=true` (Section 4.6) returns *every* active
   product from *every* store in one list, with pagination (`LIMIT`/`OFFSET`,
   `Inventory.js:26`) but no store-based filtering at all. This isn't a
   performance problem yet at low volume — it's a **product/architecture** problem:
   there is currently no way for a customer to browse "this specific store," and
   every new store's catalog just dilutes one shared, undifferentiated feed. This
   is the thing that will "break" first in a business sense, well before anything
   breaks technically.
2. **Image storage/delivery:** uploads go through the existing Cloudinary-backed
   `s3Service`, the same path already used elsewhere in this codebase — this scales
   the way Cloudinary scales generally (a managed CDN), and this audit found no
   store-portal-specific bottleneck here beyond what any high-volume image upload
   path would face. **Not independently load-tested** — consistent with the
   project's own scaling audit finding that no real load test has ever been run
   against this backend.
3. **Query patterns as product/store counts grow:** `listProducts`
   (`storeInventoryController.js:23-32`) is correctly paginated and scoped by
   `store_id` with a real index available (`flash_inventory.store_id`, added in an
   earlier migration per this project's own audit history) — this specific query
   is in reasonable shape. The customer-facing `getProducts` query (Section 4.6),
   however, has **no index-assisted store filter to eventually add even if one
   were needed**, since the column isn't selected or filtered at all today — this
   would need real design work, not just an index, if per-store storefronts are
   ever built.
4. **Was this built with multiple tenants in mind from the start, or retrofitted?**
   The *write* side (Store Portal → `flash_inventory`) was clearly designed for
   multi-tenancy from the start — consistent `store_id` scoping, dedicated
   `store_users`/`store_actions` tables, role-based access. The *read* side
   (`flash-user-app` ← `flash_inventory`) was **not** — `FLASH_STORE_ID =
   "flash_closet"` (Section 4.6) is a leftover from when Flash had exactly one
   store, never updated when the Store Portal's write side was built. This is the
   clearest single piece of evidence that these were built at different times, by
   different efforts, without being reconciled.
5. **Concurrent staff usage:** the one real concurrency gap found (Section 4.7) gets
   more likely, not less, as more staff and more customer traffic operate on the
   same store's catalog simultaneously — worth fixing before real multi-staff usage
   at volume, not urgent at a handful of pilot stores.

---

## 6. Observability — Sentry and PostHog

**Both are completely absent from `flash-store-portal` — confirmed by direct
search, not inference from "it exists elsewhere in the project."**

- `flash-store-portal/package.json` lists exactly four dependencies:
  `react`, `react-dom`, `react-router-dom`, `socket.io-client` — no `@sentry/*`, no
  `posthog-*`, of any kind.
- `grep -rl "sentry\|posthog" flash-store-portal/src flash-store-portal/*.js
  flash-store-portal/*.json` returns **zero matches**.

**This means:** if a store owner's browser throws an error, if an upload silently
fails in a way the UI doesn't surface, or if a staff member's session behaves
unexpectedly, **none of it is currently visible anywhere** — not inherited from the
backend's own Sentry setup (that only captures *backend* errors the store-portal's
API calls happen to trigger, via the shared `errorHandler.js`; a pure frontend
error — a React render crash, a network failure the UI swallows — reaches nothing).

**What should actually be instrumented, concretely, for real visibility once this is
live — not a generic "add monitoring" suggestion:**
1. **Sentry for the frontend** — `@sentry/react`, initialized in `main.jsx`, would
   catch real render crashes and unhandled promise rejections in the portal itself,
   consistent with how both mobile apps already use `@sentry/react-native`.
2. **PostHog for real store-owner behavior**, mirroring the mobile apps' own
   `services/analytics.js` pattern (a thin wrapper, named functions only, no
   generic escape hatch) — specifically: `productAdded`, `stockUpdated`,
   `imageUpdated`, `productDeactivated`, `staffInvited`, `staffLoggedIn`. This
   directly answers "is every meaningful store action visible" — today, the only
   record of these actions is the backend's own `store_actions` audit table
   (Section 7 below), which is written correctly but has no dashboard, alerting,
   or aggregate view — PostHog would be the actual visibility layer, not just a
   database row nobody looks at.
3. **Given `store_actions` already exists and is already correctly populated**
   (Section 7), the cheapest first step, before adding any new dependency, is
   simply **surfacing that existing data** — e.g., in the Flash Admin (AdminJS)
   panel, or a simple "recent activity" view in Settings for store owners
   themselves. This is free (no new instrumentation needed) and was not found to be
   done anywhere today (Section 7).

---

## 7. Additional questions this review covers

### 7.1 Is there an audit trail of who changed what and when?

**Yes, real and consistently wired — but not surfaced anywhere in the UI.**
`StoreAction.log(storeUserId, storeId, actionType, targetTable, targetId, metadata)`
(`backend/src/models/StoreAction.js:9-18`) writes to a dedicated `store_actions`
table, and is called on **every** inventory mutation checked in this audit:
`product_create`, `product_update_image`, `product_update_stock`,
`product_deactivate` (`storeInventoryController.js:106, 142, 173, 191`). A real
`getRecent(storeId, limit)` query already exists to read it back
(`StoreAction.js:20-28`), joined to the acting user's name/email. **Confirmed by
searching the entire portal source (`grep -rl "getStoreActions|store_actions|
getRecent|auditLog"` across `flash-store-portal/src`) that nothing in the portal
UI actually calls this** — the data exists, correctly, and is currently invisible
to the people it's about.

### 7.2 Is there a review/approval step before a listing goes live?

Answered fully in Section 4.4: **no.** Any role with inventory access publishes
instantly.

### 7.3 What happens if a bulk import fails partway through?

**Not applicable — there is no bulk import path at all** (Section 4.1). Every
product is created one at a time, in its own single request/transaction, so there
is no "partial batch" failure mode to design around today.

### 7.4 How are store credentials/logins secured?

`StoreAuthContext.jsx:9-26` stores the JWT and user object in `localStorage` —
standard SPA practice, matching the mobile apps' own convention exactly (same file
header comment). The actual security work (bcrypt hashing, forced password reset on
a seeded/temporary password, per-account login rate limiting, a real
forgot/reset-password flow) lives on the backend and was independently verified
working earlier in this project's own history (`storeAuthController.js`,
`storeAccountLoginLimiter`) — not re-verified fresh in this specific audit since it
was already directly tested end-to-end in prior session work. Nothing found here
raises a new concern.

### 7.5 Is there a staging or preview mode before something goes live to customers?

**No.** Confirmed by the complete absence of any draft/staging table, flag, or UI
state anywhere in the inventory-write path (Section 4.4). Combined with Section 6's
finding that the cache is currently inactive, a new product is visible to real
paying customers within, at most, the time it takes the browser to submit the form
and the customer's next page load — there is no gap to preview anything in.

---

## 8. Keeping it simple — a direct, prioritized recommendation

**What's already more complex than Flash needs right now:** the two-independent-
implementations situation (Section 2) is the one piece of unnecessary complexity
this audit found — not because either implementation is over-engineered internally
(both are lean, sensible React/Vite apps), but because *maintaining two of them* is
pure waste. This needs a decision, not more building: pick one (this audit's own
reading suggests `admin-platform`'s version is the more current and complete of the
two — 19 files vs. 14, and it's the one actually being used/tested in this project's
recent sessions — but that's an observation, not this audit's decision to make), and
either formally retire the other or fold its useful pieces (the customer-storefront
work, specifically) into the one being kept.

**What's real and necessary, in order:**

1. **Decide which Store Portal implementation is the real one, and stop
   parallel-maintaining two.** Free, immediate, purely a decision.
2. **Fix the customer-facing store-attribution gap** (Section 4.6/5) — add
   `store_id` to `PUBLIC_COLUMNS` and to the `getProducts`/`getProduct` queries at
   minimum, even before building any real "storefront" UI. This is a small,
   additive change that unblocks everything downstream (filtering, display,
   analytics) without yet committing to a full storefront redesign.
3. **Add a lightweight instant win using data that already exists:** surface
   `store_actions` somewhere a human can see it (Section 6/7.1) — no new
   dependency, no new instrumentation, just a read of an already-correct table.
4. **Add frontend Sentry** (Section 6) — small, standard, matches the mobile apps'
   own pattern exactly, closes the "a store owner's browser crashed and no one
   knew" gap.
5. **Only once real multi-store, multi-staff usage exists:** revisit the stock-edit
   race condition (Section 4.7) and the RLS question (Section 1) — both are real,
   but neither is urgent at pilot scale, and both were explicitly flagged rather
   than silently fixed or silently ignored, consistent with this codebase's own
   established practice of surfacing exactly this kind of trade-off rather than
   deciding it unilaterally.

**What this audit would explicitly recommend against doing right now:** building a
full per-store storefront UI, a bulk-import tool, or a review/approval workflow
before step 1 above is resolved. All three are real, legitimate future needs — none
of them are worth building twice, which is exactly the risk while two independent
Store Portal implementations both exist.
