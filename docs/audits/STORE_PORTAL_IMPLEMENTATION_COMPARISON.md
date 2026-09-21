# Flash — Store Portal: Which Implementation to Keep

**Date:** 2026-09-21
**Author:** Claude Code, investigation and documentation only.
**Scope:** read-only, no changes anywhere, same ground rules as every prior audit.
Every claim cites a real file/line or a real git command's actual output.

**The two implementations compared, exactly as asked:**
- **"Admin-platform"** — the `flash-store-portal` + backend store-admin code living
  on the `admin-platform` branch (the one covered in the prior architecture audit).
- **"The stage line"** — the same-purpose code built incrementally across
  `multi-tenant-stage3-store-portal` through `multi-tenant-stage7-customer-storefront`.
  Its final, most-complete state is `multi-tenant-stage7-customer-storefront`'s tip,
  which is what "the stage line" refers to throughout this document.

**One thing found while investigating that's outside the two asked about, flagged
honestly rather than silently expanded into:** a **third**, independent
implementation of this same backend layer also exists, on the separate
`production-readiness-audit` branch — confirmed by a distinct blob hash for
`storeInventoryController.js` there, and by `origin/main`'s own `migrate.js`
containing a comment explicitly describing it: *"v30-v36 were multi-tenant Store
Admin schema migrations... deliberately NOT part of this reconciliation."* This
document does not compare that third one in depth — it wasn't asked for — but Vuyo
should know it exists before treating this as a two-way decision.

---

## Executive summary — plain language, for a founder to read first

Both are real, working implementations of the same idea, built independently,
sharing almost no code. Neither is connected to what's actually live on `main`
today — **that's true for both, equally**, so "which one is easier to plug in" isn't
the deciding factor it might seem to be.

The honest short version:

- **The stage line has the one feature admin-platform is completely missing: a real,
  working, reachable customer-facing storefront** — a customer can actually browse a
  directory of stores and view one store's page in the mobile app, backed by real
  backend endpoints. Confirmed by tracing the code all the way through: backend
  routes → API service → real screens → registered in navigation. Admin-platform has
  none of this.
- **Admin-platform has more of everything else** — a forgot/reset-password flow, an
  account/self-deletion page, a real analytics page, live real-time order updates via
  Socket.IO, and (from the prior audit) real, careful attention to security details
  like magic-byte image validation. The stage line's portal is missing all five of
  these.
- **The good news for combining the best of both:** their database schemas are
  almost identical — genuinely close enough that porting the stage line's storefront
  feature onto admin-platform's database would very likely need only two small,
  additive columns, not a redesign. This isn't a forced choice between throwing one
  away entirely.

**This document's recommendation, stated plainly as an opinion, not a decision
already made:** admin-platform is the stronger base to build forward from, and the
stage line's storefront feature is specifically worth porting into it rather than
picking the stage line as the base. The reasoning is laid out in full below — Vuyo
should read it and decide, not just take the conclusion.

**On urgency:** there's no ticking clock from a technical-conflict standpoint
(neither is merged, so neither can collide with the other or with `main`) — but
every week both stay alive is a week of real risk that new work lands on the wrong
one, or on both, by accident. That's explained precisely in the final section.

---

## 1. What's actually built and working — feature by feature

Every row below was independently verified in each branch's own code, not assumed
from one side's presence implying the other's.

| Feature | Admin-platform | The stage line |
|---|---|---|
| Login / session | Real, JWT + `localStorage`, force-password-reset flow | Real, same pattern |
| Forgot / reset password | **Yes** — `ForgotPasswordPage.jsx`, `ResetPasswordPage.jsx`, real backend routes (verified in the prior audit) | **No** — these files don't exist in the stage line's `flash-store-portal/src/pages/` at all (`git ls-tree`, confirmed) |
| Role-based nav/permissions (5 roles) | Real, backend-enforced (`roleNav.js`, `requireStoreRole`) | Real — `roleNav.js` exists there too; the backend role-gating pattern (`requireStoreRole`) is present in its own `storeInventoryRoutes.js`/`storeOrderRoutes.js` |
| Inventory CRUD (add/edit stock/image/deactivate) | Real, verified end to end in the prior audit, including real magic-byte image validation | Present — same general shape (`storeInventoryController.js` exists with its own distinct implementation) — **not independently re-verified line-by-line in this pass**, since the prior audit's deep trace was specifically of admin-platform; flagged rather than assumed identical |
| Staff management (invite/deactivate) | Real — `SettingsPage.jsx`, `storeStaffController.js`, Owner-only per backend | Present — `storeStaffController.js` exists on this line too, same general role |
| Orders view | Real — `OrdersPage.jsx`, `storeOrderController.js` | Present — same files exist by name |
| Analytics page | **Yes** — `AnalyticsPage.jsx`, dedicated `storeAnalyticsRoutes.js` | **No** — no `AnalyticsPage.jsx`, no dedicated analytics route file in this line's backend file list |
| Account / self-delete | **Yes** — `AccountPage.jsx` | **No** — doesn't exist |
| Live real-time updates | **Yes** — `useStoreSocket.js` (Socket.IO client hook) | **No** — no equivalent hook exists in this line's `src/` |
| **Customer-facing storefront** | **No** — confirmed absent: no `storefrontController.js`/`storefrontRoutes.js` anywhere in admin-platform's backend | **Yes — real and complete.** Backend: `storefrontController.js` (`listStores`/`getStore`, public-safe column allowlist), `storefrontRoutes.js`, mounted at `/api/stores` in `server.js:206`. Frontend: `flash-user-app/services/api.js`'s `stores.getAll`/`getById` (correctly prefixed through the shared `request()` helper, confirmed by reading `request()`'s own implementation, not assumed from the call site alone) → real screens `StoreDirectoryScreen.js`/`StoreScreen.js` → **registered in navigation** (`App.js:109-110`, confirmed reachable, not an orphaned file) |

**On the storefront specifically, since it was asked about by name:** this isn't a
half-built stub. The public customer-facing inventory query on this line
(`Inventory.js`, stage line) was rewritten to actually `JOIN stores` and select
`flash_inventory.store_id, stores.name AS store_name` — exactly the gap the prior
architecture audit flagged as admin-platform's single biggest weakness. The stage
line **solved it**; admin-platform never did.

---

## 2. Which is more complete / closer to production-ready

**Neither is "more complete" in a simple, single-axis way — they're complete in
different, non-overlapping directions**, which is precisely why this is a real
decision and not an obvious one:

- **Admin-platform is more complete as a *store-staff tool*** — password recovery,
  account self-service, analytics, and live updates are all real, working, and
  entirely absent from the stage line.
- **The stage line is more complete as a *customer-facing multi-tenant platform*** —
  it solved the exact problem (customers can't tell stores apart) that this audit's
  prior report identified as the single most consequential gap in admin-platform.

**If forced to pick a single "closer to production-ready" axis:** for the specific
job of "a boutique owner logs in and manages their store day to day," admin-platform
is closer — a real staff member would hit a missing forgot-password page or a
missing analytics tab on the stage line within their first week of real use.
For "a customer can actually shop a specific store," the stage line is not just
closer — it's the *only* one of the two that works at all.

---

## 3. Integration with what's actually on `origin/main` today

**The single most important finding for this specific question, verified directly:
neither implementation's backend exists on `origin/main` at all, in any form.**

```
$ git ls-tree -r origin/main --name-only | grep -i store
backend/tests/unit/storeMissedOrderNotifications.test.js
docs/audits/FLASH_STORE_ADMIN_DESIGN.md
docs/audits/SECTION_2.12_STORE_MISSED_ORDER_RELIABILITY_AUDIT.md
flash-user-app/screens/StoreCreditsScreen.js
```
No `storeAuthRoutes.js`, no `storeInventoryController.js`, no `stores`/`store_users`
table, nothing. `origin/main`'s own `migrate.js` explicitly documents why, in a
comment at its v30 migration: multi-tenant Store Admin schema work exists on
unmerged lines and was *"deliberately NOT part of"* what became `main`.

**This means the premise "does choosing one avoid backend work" doesn't apply —
choosing *either* one requires the same category of work: merging an entire
store-admin backend layer (schema + routes + controllers + models) into `main` that
isn't there today.** The real, useful comparison is therefore *how much work each
one's backend needs*, and *how compatible they are with each other*, not "which one
needs zero work."

**Schema compatibility, checked directly, not assumed:** the two lines' `stores`
table definitions are nearly identical:

```
admin-platform:                          stage line:
id, name, address, lat, lng,             id, name, address, lat, lng,
service_area_bounds, owner_name,         service_area_bounds, owner_name,
owner_email, owner_phone, is_active,     owner_email, owner_phone, is_active,
onboarding_verified_by, onboarding_      created_at, updated_at
verified_at, created_at, updated_at
```
Admin-platform's version has **two extra columns** (`onboarding_verified_by`,
`onboarding_verified_at` — the real AdminJS "Verify & Activate Onboarding" audit
trail, independently verified working in earlier session work) that the stage line
doesn't have. The stage line has **two extra columns admin-platform lacks**
(`logo_url`, `banner_url` — added via a clean, additive
`ALTER TABLE stores ADD COLUMN IF NOT EXISTS` in its own migration v35).

**Concretely, if Vuyo chose admin-platform as the base and wanted the stage line's
storefront feature too**, this audit's read of the schema is that it would need:
1. Two new nullable columns on admin-platform's existing `stores` table
   (`logo_url`, `banner_url`) — a one-line additive migration, the same pattern this
   codebase already uses everywhere else.
2. Porting `storefrontController.js`/`storefrontRoutes.js`/the relevant `Store.js`
   methods (`listActive`, `findPublicById`) — small, self-contained files with no
   deep entanglement with the rest of that line's code.
3. Updating admin-platform's own `Inventory.js`/`inventoryController.js` to select
   and expose `store_id`/store name, the same way the stage line's version already
   does — this is a rewrite of one existing query, not new infrastructure, since
   **admin-platform's database already has the `flash_inventory.store_id` column**
   (added with a real FK and backfill in its own migration v38 — confirmed directly:
   `ALTER TABLE flash_inventory ADD COLUMN IF NOT EXISTS store_id UUID` followed by
   `SET NOT NULL` and a real foreign key constraint). **The gap is in the query, not
   the schema** — a materially smaller fix than building multi-tenancy from scratch.
4. Porting the two customer-app screens (`StoreDirectoryScreen.js`, `StoreScreen.js`)
   and their navigation registration.

None of this is trivial, but none of it is a schema redesign either — the two lines
were clearly built from a shared original design document
(`MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md`, referenced by both), which is exactly why
they're this compatible despite having no shared git history.

---

## 4. Code quality and maintainability

**Roughly equivalent effort to build on, with different strengths — not a lopsided
call.**

- **Test coverage, measured directly, not assumed:** admin-platform has three
  store-related backend test files (`storeAccountLoginLockout.test.js`, 62 lines;
  `storeAuthMiddleware.test.js`, 167 lines; `storeMissedOrderNotifications.test.js`,
  166 lines — 395 lines total, spread across three focused files). The stage line has
  one (`storeAuth.test.js`, 342 lines — comparable total volume, concentrated
  differently). **Neither line has a dedicated test file for its inventory
  controller** — a shared gap, not a point in either one's favor.
- **Code discipline:** both lines show the same careful, well-commented style this
  entire codebase consistently uses elsewhere (explaining *why*, citing design
  docs, flagging known limitations honestly in comments rather than hiding them —
  the prior audit found this exact quality in admin-platform's `updateStock`
  comment; the stage line's `Store.js`/`storefrontController.js` show the identical
  discipline, e.g. explicitly documenting why owner contact info is excluded from
  public columns, citing `DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md §1`).
- **Maintainability going forward:** admin-platform's larger frontend (19 files vs.
  14) and broader feature set means more surface area to maintain, but also means
  less has to be *built* from nothing. The stage line's narrower frontend is smaller
  to reason about today but has five real, expected features missing that would need
  building regardless of which is chosen.

**Neither codebase shows a quality red flag that should drive this decision on its
own** — this is genuinely a completeness-and-direction question, not a "one of
these is sloppy" question.

---

## 5. Recommendation — stated as an opinion, not a decision already made

**If this were my call: keep admin-platform as the base, and port the stage line's
storefront feature into it, rather than picking the stage line and rebuilding
admin-platform's missing five features on top of it.**

Why, concretely:
- Porting *one well-defined, self-contained feature* (storefront: 2 columns, 2
  small backend files, 2 screens, one query rewrite — Section 3) is a smaller,
  more boundable piece of work than rebuilding *five* separate features
  (forgot-password, account page, analytics, real-time updates, plus re-verifying
  inventory/staff/orders all work the same way) on top of the stage line.
- Admin-platform's extra `stores` columns (`onboarding_verified_by`/`_at`) represent
  real, already-working, already-verified functionality (the AdminJS onboarding
  flow) — choosing the stage line as the base would mean either losing that or
  re-adding it, whereas choosing admin-platform and adding the stage line's two
  columns loses nothing.
- The storefront feature is well-isolated in the stage line's own code (a
  controller, a route file, two model methods, two screens) — it wasn't
  entangled with the rest of that line's inventory/staff/order code in a way that
  would make extraction hard, based on what was read in this audit.

**This is a recommendation, not a verdict** — it rests on the two implementations
being as schema-compatible as this audit found them to be (Section 3), and on the
storefront feature being as cleanly separable as it appeared when read. Vuyo may
weigh the five missing stage-line features differently, or decide the customer
storefront is important enough to build the base around it — that's a real,
legitimate call this document doesn't get to make for him.

---

## 6. Is there real risk in leaving both alone a little longer?

**Asked for directly, answered directly: yes, a real one, though not a hard
technical deadline.**

- **No migration/schema conflict exists today** — neither branch is merged, so
  neither can collide with `main` or with each other automatically. Nothing breaks
  by simply waiting.
- **The real risk is compounding confusion and duplicated effort, not a technical
  collision.** Concretely: any future session (including this one, on a different
  day, without this document) that goes looking for "the store portal" has a
  roughly even chance of finding either one first and building on it — exactly
  what already happened once, silently, to produce this exact two-implementation
  situation in the first place. Every week both remain undecided is another chance
  for a third round of parallel work to start on top of one of them without anyone
  choosing to build a third — not because anyone would deliberately duplicate
  effort, but because nothing in the repo currently marks either one as "the real
  one" or "abandoned."
- **This is a soft, growing-cost risk, not a ticking clock.** It doesn't need to be
  resolved *today* to prevent an outage or a data-loss event — but it should be
  resolved before any *new* work is deliberately started on the store portal,
  since starting new work without deciding first is exactly how the second
  implementation came to exist alongside the first.
