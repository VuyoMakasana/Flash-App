# Admin Platform — Phases 2–6 Implementation Report

**Status:** Implemented and tested on `admin-platform`. Nothing pushed, merged, or deployed. Builds on `docs/ADMIN_PLATFORM_PHASE0_ARCHITECTURE_NOTES.md` (current-state findings) and `docs/ADMIN_PLATFORM_PHASE1_STORE_IDENTITY_PROPOSAL.md` (the founder-approved Option C onboarding model) — read those first; this document doesn't re-derive their findings, only references them.

---

## For Vuyo — plain-language summary

> **⚠️ Change your admin password first.** Your Flash Admin login (`makasanaivyson@gmail.com`) currently has the temporary password given to you at the start of this task. It only works to log in and then change itself — every other admin action is blocked until you change it, via `POST /api/admin/change-password` (current password → new one) or the forgot-password flow. Do this before anything else below.

**What this covers:** secure sign-in/sign-out/password-reset for your own Flash Admin account, and a full multi-store "Store Admin Portal" system — partner stores get their own logins, their own roles (Owner/Manager/Inventory/Sales/Finance/Marketing), their own orders/inventory/analytics, completely walled off from each other and from your internal admin panel.

**How a new store gets onboarded:** you (or whoever you designate) verify a prospective store owner off-system — real ID/business documents, a phone call, a real address — the same way you'd vet any real business partner. Only after that, you create the store in your existing admin panel and click one button ("Verify & Activate Onboarding"). That button creates the store's first login and emails the owner a temporary password, which they must change before doing anything else — same structural guarantee as your own account above.

**What was tested:** every new piece was attacked, not just built — a second store's account genuinely cannot see or touch a different store's orders/inventory (tried directly against the API, not just checked in the UI), a lower-permission staff role genuinely cannot reach owner-only actions, and brute-force login attempts are throttled per-account, not just per-address. All of this was run live against a real local copy of the database, not just assumed from reading the code. 284 automated tests pass, including two that only run against a real database.

**What was measured under load:** a repeatable script that simulates real customers and drivers using the real app flows. At modest concurrency everything performed well. At 50+10 simultaneous signups, the *password-hashing itself* (a deliberate security cost, not a bug) became the bottleneck on this shared test machine — worth knowing as you grow, but not something to read as a hard ceiling on your real servers.

**What's still open / needs your input:**
- Change your admin password (see above — this is the important one).
- Decide when to merge `admin-platform` into `main` (nothing is live yet).
- Set two new secret keys before any real deployment (`ADMIN_SESSION_SECRET`, `STORE_JWT_SECRET` — both documented in `backend/.env.example`).
- The store-portal website's look was not checked on an actual phone/tablet screen in this pass (no browser tool was available in this working environment) — worth a quick visual check before a real store owner uses it.
- Re-run the load test on your real (or a dedicated) server before trusting any specific number as your real capacity.

Full detail on all of the above follows below.

---

## 1. What was built

### Phase 2 — Flash Admin sign-in / sign-out / password reset

- **Forgot/reset password** (`POST /api/admin/forgot-password`, `POST /api/admin/reset-password`): a cryptographically random, single-use, 1-hour-expiry token in a new `admin_password_tokens` table (migration v34), emailed via a new `sendAdminPasswordResetEmail`. Never reveals whether an email exists — identical `{success:true}` response either way, matching `authController.js`'s user/driver pattern exactly.
- **Change password while logged in** (`POST /api/admin/change-password`): requires the current password, bcrypt cost 12, minimum 10 characters (matching the codebase's existing password policy). Sets `admins.password_changed_at`, which `middleware/auth.js`'s `authenticate()` now checks for admin-role tokens — any token issued before the most recent password change is rejected on its next use, invalidating every other session. The endpoint mints and returns a fresh replacement token so the request that changed the password isn't itself logged out.
- **Force-password-reset structural gate**: `admins.force_password_reset` (migration v34) + `requireAdminPasswordCurrent` middleware, applied to every admin JSON-API route except login/logout/change-password/reset-password. A seeded temporary password can be used for exactly one thing — changing it — nothing else.
- **AdminJS session hardening**: the AdminJS panel's cookie session now signs with a new, independent `ADMIN_SESSION_SECRET` (falls back to `ADMIN_JWT_SECRET` if unset — zero required config change on existing deployments) instead of reusing `ADMIN_JWT_SECRET`, closing the gap Phase 0 flagged. Explicit `httpOnly`/`secure` (production-only)/`sameSite: 'lax'`/8h `maxAge` cookie options — previously all left at express-session's untuned defaults.
- **Per-account brute-force lockout**: `adminAccountLoginLimiter` (email-keyed, 5/15min, `skipSuccessfulRequests`) alongside the existing IP-keyed `adminLimiter` — the same `security-fixes` H-5 pattern, built for admin since this branch was cut from `main`, not `security-fixes`.
- **Founder's account seeded** (migration v35): `makasanaivyson@gmail.com`, bcrypt cost 12, `force_password_reset = true`. **The plaintext password was never written to any file, commit, log, or terminal output beyond what was strictly needed to compute the hash once**, via a throwaway, immediately-deleted local script piped directly into `bcrypt.hash()`.

**Known, honest limitation:** `force_password_reset` is fully enforced on the JSON API. It is **not** enforced as a hard block on the AdminJS browser login itself (AdminJS has no built-in "redirect to change password" concept, and building one would mean writing custom frontend components into a third-party admin framework — a real scope/risk trade-off, not an oversight). Vuyo can still log into the AdminJS panel with the temporary password, but every other admin JSON-API action is blocked until he changes it. **He should change his password via `POST /api/admin/change-password` (or the forgot-password flow) as his very first action.**

### Phase 3 — Store Admin: multi-store, multi-role backend + portal

Reused the prior-art design and implementation on `production-readiness-audit` (`FLASH_STORE_ADMIN_DESIGN.md`, `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md`, `storeAuthController.js`/`storeOrderController.js`/`storeInventoryController.js`/`storeStaffController.js`) as a starting point, per the task's explicit instruction — **every piece was re-read and re-verified, not trusted because it existed** (see §3, adversarial testing).

**Schema** (migrations v36–v39): `stores` (seeded with Flash's own real store — name, address, coordinates from `geoBoundary.js`'s real `FLASH_STORE_LOCATION`/`NMB_BOUNDS`), `stores.onboarding_verified_by`/`_at` (the audit pair the Phase 1 proposal introduced), `store_users`, `store_password_tokens`, `store_actions`, `flash_inventory.store_id` (backfilled to the one real store, FK + index, with a DB-level `DEFAULT` so the internal admin panel's raw AdminJS inserts keep working unchanged), `orders(store_id)` index.

**Onboarding (Option C, exactly as approved):** a new `stores` AdminJS resource in the *existing* internal panel — zero new integrations. A Flash admin creates the row (name/address/coordinates/owner contact) via the plain generic form, after doing the real off-system verification (ID/business-registration document, a callback phone number, a checkable address) themselves — this panel has no way to verify that step, by design. The row starts **inactive** (forced server-side regardless of what the form submits) until a separate **"Verify & Activate Onboarding"** action is deliberately clicked, which sets `onboarding_verified_by`/`_at` from the real, authenticated admin's own id — never client-editable, never the same click as creating the row.

**The same action also creates that store's first Owner account.** This closes a real gap found while building this: `storeStaffController.createStaff` (Owner invites more staff) requires an *already-authenticated* Owner token — which cannot exist yet for a brand-new store. "Verify & Activate Onboarding" now also inserts the first `store_users` row (role `owner`, from the record's own `owner_name`/`owner_email`) with a real, random, one-time temporary password — never displayed or logged, emailed directly to the owner (`sendStoreWelcomeEmail`) — and `force_password_reset = true`, the same structural guarantee as the founder's own seeded account. The action refuses to run (with a clear on-screen message) if `owner_name`/`owner_email` weren't filled in first.

**Tenant isolation — the one property everything else depends on:** a third, fully disjoint JWT/session domain (`STORE_JWT_SECRET`) — `authenticateStore` / `requireStoreRole` / `requireOwnStore` / `requireStorePasswordCurrent` in `backend/src/middleware/auth.js`. `authenticateStore` never falls back to or from `JWT_SECRET`/`ADMIN_JWT_SECRET` in either direction. Every store-scoped controller derives `store_id` from `req.storeId` (set only by `authenticateStore` after verifying the store user's password) — **never** from `req.params`/`req.body`/`req.query`. A cross-store id always returns 404, never 403, matching this codebase's existing anti-enumeration convention (a compromised account shouldn't even learn that an id belongs to a real, just-not-theirs, store). `requireOwnStore` is a defense-in-depth backstop that rejects any request that *does* try to smuggle a different `storeId`.

**Roles** (`store_users.role`, `CHECK` constraint): `owner`, `store_manager`, `inventory_staff`, `sales_staff`, `finance`, `marketing` — matching the existing store-portal frontend's expectations exactly (Phase 0 §1.3). Staff management (`storeStaffController.js`) is Owner-only, enforced at the **route** level (`requireStoreRole('owner')` on the whole `/api/store-staff` tree) — a non-Owner token cannot reach the create/deactivate endpoints at all, regardless of what any client sends. An Owner creating another Owner is not privilege escalation (the top role creating a peer); no route lets any *lower* role create or promote to a higher one.

**Orders, inventory, analytics:** `storeOrderController.js` reuses `orderStateMachineService.js`'s real `acceptOrder`/`rejectPendingAcceptance`/`markReadyForPickup` functions directly — the same functions the internal admin panel's own buttons call — so there is exactly one real state-machine implementation. `storeInventoryController.js` owns its own store-scoped queries against `flash_inventory` (deliberately not reusing the platform-wide `Inventory.js` model, which backs the unscoped `/api/inventory` customer catalog and must keep behaving exactly as it does today). `storeOrderController.getAnalytics` is a new, real, store-scoped aggregate query (order volume, revenue, popular items) — the same shape as `Admin.getDailyTrends`/`getFinancials`, additively `WHERE`-scoped, not a new analytics engine.

**Real-time:** `orderStateMachineService.js`'s `emitOrderUpdate` now also emits to a `store:<id>` room on every order-status transition. `socket/socketServer.js`'s auth middleware gained a `STORE_JWT_SECRET` verification path (same role/secret cross-check discipline as the existing admin path) and auto-joins a connecting store socket to its own `store:<id>` room. **This was necessary, not optional**: without it, the real-time requirement would have been silently unreachable — the same pre-existing gap this file already has for `ADMIN_JWT_SECRET` admin tokens (confirmed, left untouched — out of scope for this task).

**Order attribution:** `orderController.createOrder` now resolves `store_id` via `Store.getDefaultStoreId()` instead of a hardcoded `null` — the real `stores` table exists now, so every new order is attributed to Flash's one real, active store. This is what makes the Store Admin Portal's Orders screen (and its real-time updates) receive real orders at all. A genuine multi-store checkout-selection step is future work; this is exactly the call site the blueprint doc identifies as where it would plug in.

**Scale:** pagination (`page`/`limit`, capped at 100) on every store-scoped list endpoint, `storeWriteLimiter` (60/min) on every write route, indexes on every store-scoped foreign key (`store_users.store_id`, `store_actions.store_id`/`store_user_id`, `flash_inventory.store_id`, `orders.store_id`), reuses the existing pg pool (`DB_POOL_MAX`, unchanged) and the existing Redis-backed rate-limiter infrastructure.

**Frontend:** pulled the real `flash-store-portal` source (read-only `git archive` from `production-readiness-audit` — Phase 0 confirmed this branch's working tree only had stale build output). Kept its existing 5-page structure/RBAC nav/anti-enumeration UX as-is (it already matched this backend's contract per Phase 0 §1.2), and added: `AccountPage.jsx` (every role's own change-password, reachable regardless of role — unlike Settings, which stays Owner-only), `ForgotPasswordPage.jsx`/`ResetPasswordPage.jsx`, `AnalyticsPage.jsx` (Finance's first real screen — previously blocked pending deferred settlement logic that this endpoint doesn't need), and `useStoreSocket.js` + `OrdersPage` wiring for real-time order updates. `npm run build` succeeds cleanly (79 modules, zero errors).

**Honest gap:** the frontend was **not** independently visually verified at multiple viewport widths — no browser/screenshot tool was available in this environment. A few concrete, real CSS gaps were found by re-reading the existing (already-once-live-screenshot-tested) styles and closed on the same reasoning the file's own prior fixes used (`.order-row` had no `flex-wrap`, unlike `.product-row`; a defensive `overflow-x: hidden`; a dedicated `.simple-form` style so the 3-field password form doesn't inherit the multi-column product-form grid). This is a real, acknowledged residual risk, not something to treat as fully verified.

---

## 2. Phase 4 — what was attacked, and what was found

Attacked live, against a real local Docker Postgres sandbox, the same day each piece was built — not saved for the end. 21/21 checks passed on the first live run (details and exact checks in the Phase 4 commit message, `test(admin-platform): Phase 4 adversarial regression tests...`):

- **IDOR** — a second store's real Owner account cannot GET, accept, reject, or read/modify a different store's order or product (404, not 403 — see the anti-enumeration note above).
- **Tenant-isolation bypass** — a spoofed `storeId` in a query string is silently ignored, never honored.
- **Role escalation** — a Sales Staff token gets 403 on every staff-management/inventory/analytics endpoint its role doesn't cover, including a direct attempt to create an `owner` account.
- **Brute-force/enumeration** — a wrong password and a nonexistent account return the identical generic 401; per-account lockout (`storeAccountLoginLimiter`) verified with the same test pattern as the existing `security-fixes` H-5 fix.
- **Admin `force_password_reset` bypass** — the real seeded admin account logs in with its real temporary password, is correctly blocked from every other admin route, can still log out, and `change-password` correctly rejects a wrong current password.

These are now permanent, fast (no live DB needed), CI-running regression tests in `tests/unit/storeAuthMiddleware.test.js` (13 tests) and `tests/unit/storeAccountLoginLockout.test.js`, plus the original live run's evidence recorded here rather than only in a commit message.

**No bugs were found in the tenant-isolation/RBAC design during this pass.** Two real, unrelated things *were* found and fixed while verifying nothing regressed (see the `test(admin-platform): fix broken integration-test mock...` commit): a test-mock wiring gap (an existing integration test's `middleware/auth` mock didn't know about the five new exports) and a genuinely pre-existing, unrelated integration-test bug (an off-by-one in a mocked query queue for the cancellation-split test, confirmed via `git diff` against the pre-Admin-Platform commit to be untouched by this work).

---

## 3. Phase 5 — load testing

**Harness:** `scripts/load-test.js` — reusable, parametrized (`--customers`, `--drivers`, `--duration`, `--base-url`), zero new dependencies (Node 20+ built-ins only). Simulates the real flash-user-app flow (register → browse → checkout with a real in-bounds cash order → confirm cash-on-delivery → track → best-effort rate) and the real flash-driver-app flow (register → go online → location updates → poll for available orders → accept → attempt pickup/dropoff photo → cash-OTP → earnings/wallet). Each virtual user gets a distinct simulated `X-Forwarded-For` so the app's own real, IP-keyed rate limiters see realistic distributed traffic instead of one shared source IP — this is not a bypass of that protection, it's the accurate model of what the limiter actually sees in production behind Render's reverse proxy.

**Environment:** a local Docker sandbox (`docker compose up -d --build` + `migrate.js` — all 39 migrations applied cleanly, including the five new Admin Platform ones), run via an untracked, local-only `docker-compose.override.yml` remapping container names/ports (another session was already running the default stack on this shared machine — this is not part of the deliverable and isn't needed on a clean host).

**Results:**

| Scenario | Result |
|---|---|
| 3–5 customers / 2–3 drivers, 15–20s | 0% error rate on every endpoint except one transient inventory-browse blip; full checkout→cash-payment→tracking flow completed correctly end to end. |
| 50 customers / 10 drivers, 90s | Registration (`user:register`/`driver:register`) error rate rose to ~90–93%; every other already-reached endpoint (browse, checkout, cash-on-delivery, tracking, driver location/earnings/wallet) stayed at 0% errors. |

**Root cause, verified directly, not guessed:** bcrypt password hashing (cost 12, matching this codebase's convention everywhere) took **~2.2 seconds for a single hash** measured directly inside the backend container on this sandbox host (`node -e "bcrypt.hash(...)"`, isolated from any HTTP/network overhead) — 10–20x slower than the ~100–300ms typical of dedicated hardware. Under 60 simultaneous registrations, each independently paying that cost on a CPU-constrained container (this sandbox machine was concurrently running a second, unrelated full Docker stack for another session throughout this test), requests serialize behind available CPU and many exceed a reasonable wait. A single registration immediately before and after the 50/10 burst completed normally (~2.2s, matching the isolated bcrypt measurement) — confirming this is a **real CPU-bound cost under concurrency**, not a bug introduced by this work, and not something that would necessarily reproduce identically on a dedicated host or Flash's real production infrastructure (which has real, own CPU capacity, unlike this shared sandbox). Every other endpoint measured — including real checkout, real payment confirmation, and real driver location updates — showed no degradation at either concurrency level.

**Honest gap:** the driver-side pickup-photo/dropoff-photo upload steps (`s3Service.js` → Cloudinary) cannot succeed in this sandbox with placeholder Cloudinary credentials (a real, expected environmental limitation, not a bug — documented in the script's own header). This means the load test's driver flow was verified through "accept an order," not all the way to "delivered" — a real, acknowledged scope limit of this specific run, not a design flaw in the harness (pointing it at real Cloudinary credentials would exercise the full chain unchanged).

**What Vuyo should take from this:** registration/login throughput is bounded by bcrypt's deliberate CPU cost, which is a *security feature*, not a bug — worth knowing as signup volume grows, and worth re-measuring on Flash's actual production/staging infrastructure (not this shared sandbox) before treating any specific number as a real capacity ceiling. The re-run command is printed at the end of every run (`node scripts/load-test.js --customers=500 --drivers=100 --duration=120`) for exactly this purpose.

---

## 4. Test suite status

Full backend suite, run against a real live Docker Postgres (not just the mocked-pool unit tests): **27 test suites, 284 tests, all passing.** This includes the two integration suites (`adminCoverage.test.js`, `productionStateMachine.test.js`) actually executed against live migrated schema for the first time in this session, not merely assumed passing from the mocked unit-test run.

---

## 5. What Vuyo needs to do next

1. **Change the temporary admin password** (`makasanaivyson@gmail.com` / the password given at the start of this task) via `POST /api/admin/change-password` — every other admin JSON-API action is blocked until this happens. This is the single most important operational item from this work.
2. **Review and decide on merging `admin-platform`** into `main` — nothing has been merged or deployed. Recommend reconciling with `security-fixes` first (per Phase 0's own note — `ADMIN_SESSION_SECRET` was independently added here too, so this isn't a conflict, but the two branches have otherwise diverged).
3. **Set real secrets before any real deployment**: `ADMIN_SESSION_SECRET`, `STORE_JWT_SECRET` (both documented in `backend/.env.example`) need real, independently-generated values in whatever environment this eventually deploys to — never reused from `JWT_SECRET`/`ADMIN_JWT_SECRET`.
4. **Onboard the first real second store** via the new AdminJS `stores` resource, once ready — create the row (filling in `owner_name`/`owner_email` — the action requires them), do the real off-system verification, click "Verify & Activate Onboarding." That single click now also creates the store's first Owner account and emails them a temporary password — no separate manual step needed.
5. **Re-run the load test on real infrastructure** (or a dedicated, non-shared dev box) before drawing any firm capacity conclusions — this sandbox's numbers were measured on a machine that was also running an unrelated concurrent workload the whole time.
6. **Visually verify the store portal** at phone/tablet/desktop widths — this was not independently confirmed in this pass (no browser tool available); the CSS reasoning is sound but unverified.
