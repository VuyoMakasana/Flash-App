# Flash — Project State & Launch Readiness

**Date:** 2026-09-21
**Author:** Claude Code. Documentation only — read-only git/file inspection, no code changes, no merges, no deploys.

This is the single authoritative reference for where Flash actually stands today: the real architecture, what's genuinely live vs. built-but-not-deployed, a summary of every prior audit with current (re-checked) status rather than stale conclusions, a full inventory of every branch that exists right now and what's blocking each one, and an honest three-part launch-readiness checklist. Everything here is either re-verified directly against the repository/git history as part of writing this document, or cited to the specific prior audit that verified it live against Render/Supabase/Vercel — never assumed.

---

## 1. Current architecture, plainly explained

Flash runs on **two pieces of infrastructure it actually operates**: one backend server and one database. Everything else — the mobile apps, the admin panel, the store portal — is either a client of that one backend, or not deployed at all yet.

**The backend** (`backend/`) is a single Node.js/Express process on Render (service `Flash-App`, id `srv-d7bn9hidbo4c73eriu0g`, free plan, Oregon region, one instance). It is one process doing several jobs at once, not several separate services: the REST API every client talks to, the Socket.IO real-time layer (driver location, order status, chat), the AdminJS admin panel (mounted at `/admin-panel`), and every scheduled background job (13 `cron.schedule` calls — stock/location pruning, payment reconciliation, stuck-order recovery, refresh-token cleanup) all run inside this one process. There is no separate worker service, no separate cron service — if this one instance is down, none of it runs. It's currently live and healthy, confirmed via `/health` returning `{"status":"ok",...}`.

**The database** is Supabase-managed Postgres (project `flash-db`, id `ttupbbqbplrhhtuvaaar`), free tier, one instance, no read replicas. All application data — orders, users, drivers, stores, everything — lives here. The backend connects to it directly via `pg`; there is no ORM.

**The two mobile apps** (`flash-user-app`, the customer app; `flash-driver-app`, the driver app) are pure React Native/Expo clients with no server component of their own. Both talk to the Render backend over HTTPS and Socket.IO. Push notifications are sent from the Render backend directly to Expo's own hosted push relay — Flash doesn't run its own push infrastructure. Both apps build via EAS Build, Expo's managed cloud build service (also not something Flash operates).

**The admin panel** is not a separate app — it's AdminJS, mounted as a set of routes inside the same backend process, reachable at `/admin-panel` on the same Render service. It's the internal tool Flash staff use to see and manage orders, drivers, users, payments, and (on the still-unmerged `admin-platform` line) stores.

**The store portal (`flash-store-portal/`) is real, working, and tested — and genuinely not deployed anywhere.** This is confirmed, not assumed, two ways: (1) live infrastructure checks against every platform Flash actually uses (Render's and Vercel's full account listings, 2026-09-19) show no service or project named or configured for it anywhere; (2) its source code doesn't exist on `main` at all — it only exists on the unmerged `admin-platform` branch and its descendants (`feature/storefront-port`, `test/close-coverage-gaps`). The `flash-store-portal/` folder visible in the main checkout's working directory today is untracked local clutter (a stray Vite build output, `node_modules`, an `.env` file) — not evidence of a deployment. **This is still accurate as of this document.**

A fifth, separate piece of infrastructure exists but isn't part of the app itself: the **marketing website** (`flashdelivery.co.za`), a static site on Vercel, fully managed and serverless — healthy, live, but outside the scope of "Flash's own servers."

**What doesn't exist yet:** a Redis/cache layer (code is written to use one, conditionally, but none is provisioned — see §5 for exactly when this starts to matter), a staging environment, and any automated uptime monitoring or alerting.

---

## 2. What's genuinely live vs. built-but-not-deployed

**Live and serving real traffic today:**
- The backend API, Socket.IO, admin panel, and all cron jobs (Render, one instance).
- The production database (Supabase, `flash-db`).
- Both mobile apps, as EAS-built binaries customers and drivers actually install.
- The marketing website.

**Built, real, tested — and not live anywhere:**
- **The entire store portal + multi-tenant store-admin backend.** This is the single biggest thing in this category, worth being explicit about since it's easy to undersell: a store owner can genuinely log in, add products with photos, adjust stock, see their own orders, and manage staff, and none of it is fake or half-wired — role-based permissions are real and backend-enforced, not just hidden UI. This lives on the `admin-platform` branch and everything built on top of it. **It has never been merged into `main`, and it is not deployed anywhere** — not on Render, not on Vercel, nowhere. `main` today has no store-portal code, no multi-tenant store schema awareness in its own AdminJS setup, none of it.
- **The customer-facing storefront** (a real store directory + individual store pages in `flash-user-app`, backed by real `/api/stores` endpoints) — this was a separate, previously-unfinished feature (built on the now-superseded `multi-tenant-stage7-customer-storefront` line) that has since been **ported into `admin-platform`'s own lineage**, on the branch `feature/storefront-port`. This is the one correction worth being precise about: **`feature/storefront-port` was branched from `admin-platform`, not merged into it.** `admin-platform` itself still has none of the storefront feature — the port lives one branch further out, on `feature/storefront-port` and its descendant `test/close-coverage-gaps`, neither of which has been merged back into `admin-platform`, let alone `main`. (See §4 for the exact git relationships, verified directly.)
- **A large body of real fixes and features from the `preserve/oauth-age-gate-and-ios-compliance` lineage** — OAuth age-gate bypass closure, Apple App Store compliance fixes (hiding iOS driver-subscription IAP), commission-debt fixes, several real concurrency-race closures, PostHog analytics, admin visibility improvements. This entire body of work is already fully contained inside `admin-platform` (confirmed: it's a direct ancestor), so it isn't a separate thing waiting on its own decision — it's already part of whatever `admin-platform`'s own merge decision covers.
- **A real, tested, currently-unapplied fix for a latent AdminJS bug** (`fix/adminjs-sql-schema-collision`) — see §3 and §4.
- **A comprehensive backend + admin-panel + store-portal test suite** (451 backend tests, 34 tests across the three frontend apps' first-ever test infrastructure) — real, passing, and living only on `test/close-coverage-gaps`, not yet part of any merged branch.

---

## 3. Full audit trail — summarized, not duplicated

Each of the following is a real, prior, independently-run audit. Read the original for full depth and citations; what's below is a compressed summary plus, where relevant, a status check re-verified for *this* document rather than trusted as still current.

**`SERVER_INVENTORY_AUDIT.md`** (2026-09-19, branch `docs/server-inventory-audit`) — a live, read-only inventory of every piece of infrastructure Flash actually operates, checked directly against Render's, Supabase's, and Vercel's own APIs plus direct HTTP/SQL checks, not inferred from config files. Its headline finding — "Flash currently runs 2 servers" (one Render backend, one Supabase database), everything else being either fully managed, a third-party service, or not deployed — is the factual basis for §1 above, and remains accurate: re-confirmed for this document that `flash-store-portal` still isn't deployed anywhere and no new Render/Vercel services have appeared.

**`SCALING_RESILIENCE_AND_DISASTER_RECOVERY_AUDIT.md`** (2026-09-20, branch `docs/scaling-resilience-audit`) — a principal-level reliability review covering server capacity, database capacity, incident diagnosis, crash recovery, and Redis. Its core, load-bearing findings — the backend has no monitoring/alerting today, the database has zero automatic backups on the free tier (Supabase's own documented policy, not a Flash misconfiguration), and Redis is unnecessary right now but becomes non-optional the instant a second backend instance is ever added (a binary threshold, not a traffic curve) — are carried into §5's Operational checklist below directly, since nothing has changed on any of these fronts since it was written.

**`STORE_PORTAL_ARCHITECTURE_AND_SCALE_AUDIT.md`** (2026-09-21, written this engagement, not yet committed anywhere — see §4's note on this) — a deep, code-level trace of the store portal as it exists on `admin-platform`: real role-based permissions enforced by the backend (not just hidden UI), no monitoring (no Sentry, no PostHog on this app), and its own headline caveat — a store's inventory does reach real customers, but without any "which store is this from" information, since at the time this was written the customer-storefront feature didn't exist on this line yet. **Status update:** that specific gap is now closed — the storefront port (§2 above) added exactly that missing piece, on `feature/storefront-port`, though still not merged anywhere live.

**`STORE_PORTAL_IMPLEMENTATION_COMPARISON.md`** (2026-09-21, same engagement, also not yet committed — see §4) — a side-by-side comparison of two independently-built store-portal implementations: `admin-platform`'s (stronger as a staff tool — password recovery, analytics, live updates, account self-service) versus the `multi-tenant-stageN` line's (the only one with a working customer-facing storefront). Its recommendation — keep `admin-platform` as the base, port the stage line's storefront feature into it rather than switching base branches — is exactly what happened next: that's what `feature/storefront-port` is. **This decision has since been acted on**, not left as an open recommendation.

**`TEST_COVERAGE_REMEDIATION_REPORT.md`** (2026-09-21, branch `test/close-coverage-gaps`) — documents a six-phase effort closing real, previously-untested gaps across the full customer and driver journeys, the store-portal backend, and all three frontend apps. Found and fixed four real application bugs along the way (a crash on certain order-creation input, a driver-rating validation bug, a crash on malformed order-history pagination, and a completely non-functional store product-image upload — the last one proven fixed with a real, unauthenticated `fetch()` against a real uploaded image, not just a passing mock). Final state: 451 backend tests / 0 failed, plus the first-ever 34 tests across the three frontend apps, zero regressions across twelve commits. Still sitting on `test/close-coverage-gaps` only — see §4.

**`OPEN_FOLLOWUPS.md`** (main copy has 12 items; items #13 and #14 exist only on the separate `docs/open-followups-admin-incident` branch, added 2026-09-19 after a real admin-panel outage) — a living list of real, deliberately-deferred items. Items #13 and #14, re-checked specifically for this document rather than trusted at their original written status:

- **#13 — `@adminjs/sql`'s cross-schema foreign-key introspection collision.** Originally: "fix already written and verified, waiting on go-ahead to open a PR," sitting on `fix/adminjs-sql-schema-collision` (commit `599aed5`). **Re-checked now: still exactly that — no progress since 2026-09-19.** One thing worth adding that the original write-up didn't need to address: this fix was written against `main`'s lineage and has **not** been ported to `admin-platform` either, confirmed directly (`admin-platform`'s `adminPanel.js` has neither the `schema: 'public'` option nor the patch script). Since `admin-platform` is the actively-developed line where new AdminJS resources keep getting added, it carries the same latent exposure `main` does — not fixed on either lineage today.
- **#14 — Render auto-deploys ahead of pending migrations, no pre-deploy migration gate.** Originally: "recommended fix identified, not built" — a Render dashboard/Blueprint change (a pre-deploy `npm run migrate` command), not a code change. **This is a live Render service setting outside version control — it cannot be re-verified by reading the repository, and no evidence either way was found in this pass.** Status should be confirmed directly with Vuyo rather than assumed unchanged.

---

## 4. Every branch that exists right now, and what's blocking it

Verified with real `git branch -a`, `git merge-base`, `git rev-list --left-right --count`, and `git log` commands run against a fresh `git fetch`, not from memory or prior documentation. Five `worktree-agent-*` branches are Claude Code's own internal per-session tooling artifacts, not real project branches — excluded below, safe to ignore or delete at any time.

### The five named branches, in detail

**`admin-platform`** — 39 commits ahead of `main`, 30 behind (main and this branch diverged from a shared point and both moved forward independently since). **Not pushed to `origin` at all.** Contains: the entire multi-tenant store-admin platform (backend + `flash-store-portal`), plus the full `preserve/oauth-age-gate-and-ios-compliance` body of work (confirmed a direct ancestor — see below). **Blocking decision:** whether and when to merge this whole multi-tenant initiative into `main` — a large, deliberate business/architecture decision, not a technical blocker. Being local-only on one machine is itself a real risk independent of that decision (see §5).

**`feature/storefront-port`** — branched from `admin-platform`, exactly 2 commits ahead of it, 0 behind. **Correction worth flagging plainly: this is branched *from* `admin-platform`, not merged *into* it** — `admin-platform` itself still has zero storefront code. Pushed to `origin`. Contains: the customer-facing storefront port described in §2. **Blocking decision:** the same `admin-platform` merge decision, plus its own (much smaller) review — it was explicitly scoped as "make admin-platform a complete superset," not a decision to merge admin-platform itself.

**`test/close-coverage-gaps`** — branched from `feature/storefront-port`, 13 commits ahead, 0 behind (contains all of it). Pushed to `origin`. Contains: the entire test-coverage remediation effort (§3), including four real bug fixes found and fixed along the way. **Blocking decision:** same chain — waits on `feature/storefront-port`, which waits on `admin-platform`.

**`fix/adminjs-sql-schema-collision`** — branched directly from `main`'s current tip, exactly 1 commit ahead. **Local only — never pushed to `origin`.** Contains a small, real, tested, currently-unmerged fix (§3, item #13). **Blocking decision:** explicitly waiting on Vuyo's go-ahead to open a PR — the fix itself is done, reviewed, and verified; nothing technical is blocking it, only a decision to act. Being unpushed means it currently exists on exactly one machine.

**`preserve/oauth-age-gate-and-ios-compliance`** — **this is the finding most worth flagging: it is not a separate, independent branch needing its own decision.** It points to the exact same commit as `main-reconciled` (`d3efbd1`, confirmed via `git rev-parse` — two different local branch names, one identical commit), and that commit is a **direct ancestor of `admin-platform`** — meaning `admin-platform` already contains 100% of this branch's work, plus 7 more commits on top. Both `preserve/oauth-age-gate-and-ios-compliance` and `main-reconciled` are local-only, unpushed, and safe to treat as obsolete pointers into `admin-platform`'s own history rather than as a live, independent decision point. **No separate blocking decision exists for this branch specifically** — whatever happens to `admin-platform` already carries this work forward.

### Everything else that turned up, grouped

**Already fully absorbed into `admin-platform`** (safe to archive/delete as standalone names, their content isn't independent): `admin-platform-phase1`, `critical-flow-edge-case-audit`, `multi-tester-readiness`, `store-accept-reject-preparing`, `hotfix/order-photo-bypass`, `feature/marketing-site-integration`.

**Already merged into `main`:** `release/safe-audit-fixes` (via PR #10, confirmed).

**A real, separate, earlier audit lineage, apparently superseded but not exhaustively content-diffed:** `production-readiness-audit` and `security-audit-do-not-merge` are the same commit (`01858b2`) — another duplicate-name pair. This lineage reached a similar point to `preserve/`'s independently (its own final commit has the identical message "route DRIVER_TEST_MODE's subscription grant through the real activation path," but a different hash, meaning the same fix was made twice on two diverging lines). It is **not** an ancestor of `admin-platform`. It appears superseded by the `admin-platform` lineage's own equivalent work, but this document did not do an exhaustive line-by-line content comparison to prove full equivalence — recommend confirming before deleting, not assuming.

**Docs-only branches, each adding exactly one real document, none merged:** `docs/server-inventory-audit`, `docs/scaling-resilience-audit` (both pushed), `docs/infrastructure-scaling-audit`, `docs/open-followups-admin-incident`, `docs/store-portal-architecture-audit`, `docs/store-portal-implementation-comparison` (none of these last four pushed — and notably, the last two are based directly on `main`'s current tip with **zero new commits**, because the two documents they were meant to hold were never actually committed — see the callout below). Blocking decision for all of these: simply whether to merge each doc into `main`'s `docs/audits/` — no code risk, pure documentation, should be low-friction whenever Vuyo wants them in.

**A genuinely different, much older, large historical lineage, seemingly unrelated to current work:** `fix/driver-commisions`, `fix/phase0.5-p0-p1-remediation`, `fix/phase0.5-store-inventory-lock`, `fix/production-audit-remediation`, `fix/production-ready`, `production-hardening-final`, `expo-go-testing` — all diverge from `main` by hundreds of commits in one direction (e.g. `fix/driver-commisions` is 378 behind, 102 ahead), suggesting a very old base or a squash/rebase somewhere in this repo's history. Not investigated further in this pass — flagged for Vuyo to confirm whether these are still relevant at all, or safe archive candidates from a much earlier phase of the project.

**A real, separate, small feature branch, not evaluated for conflicts:** `chore/gitignore-flash-store-portal` — 1 commit ahead of `main`, pushed, adds a `.gitignore` entry for `flash-store-portal`'s stray local build artifacts (the same clutter described in §1). Small, low-risk, no blocking decision beyond a routine merge.

### One thing found that doesn't match this task's own framing

The two most recently-written audits this document summarizes in §3 — `STORE_PORTAL_ARCHITECTURE_AND_SCALE_AUDIT.md` and `STORE_PORTAL_IMPLEMENTATION_COMPARISON.md` — **exist only as untracked files in the main checkout's working directory. They are not committed to any branch, anywhere, including the branches named after them** (`docs/store-portal-architecture-audit` and `docs/store-portal-implementation-comparison` both sit at `main`'s exact tip with no new commits). If either of those two documents is meant to be part of "the full audit trail," they need to actually be committed somewhere first — right now they only exist as local files.

---

## 5. Launch-readiness checklist

### Technical (code / infrastructure)

| Item | Status | Why it matters |
|---|---|---|
| Backend API, real-time layer, cron jobs | ✅ Live, healthy, verified | This is the whole system's beating heart |
| Core transactional logic (payments, cancellations, refunds, order state machine) | ✅ Verified carefully written — real transactions, real row-locking, real duplicate-event protection (per the resilience audit's own independent review) | The one thing that must never silently corrupt is money and order state |
| Backend automated test coverage | ✅ 451 tests, 0 failing — but only on `test/close-coverage-gaps`, not yet on `main` | A merged, tested `main` is what CI actually protects going forward |
| Frontend automated test coverage | ⚠️ Real infrastructure now exists in all three apps (first time ever), but only 34 tests total — explicitly a start, not comprehensive coverage | Was zero before this engagement; still far from comprehensive |
| Store portal + multi-tenant admin | ✅ Built and tested, ❌ not deployed, not merged anywhere | See §2 — this is real, sellable functionality sitting idle |
| Customer storefront (store directory/pages) | ✅ Built and tested, ❌ not deployed, not merged anywhere | Same |
| Known application bugs found this engagement | ✅ All 4 found, fixed, and proven fixed (§3) | Real defects, none reachable from the currently-shipped apps today, but real code |
| AdminJS cross-schema collision (#13) | ⚠️ Fix ready, unmerged, unpushed | Currently non-fatal by accident; becomes a real admin-panel outage the moment an affected table is ever registered as a resource |
| Uptime monitoring / alerting | ❌ Does not exist | If the backend goes down, currently no one is told |
| Database backups | ❌ None exist (free-tier limitation, not a misconfiguration) | Data loss today would be unrecoverable |
| Load testing | ❌ Never done against production-shaped traffic | Every capacity number in the resilience audit is reasoned, not measured |
| Redis | ❌ Not provisioned — correctly, per the resilience audit's own direct recommendation (not needed until a second backend instance exists) | See the roadmap below for the exact trigger point |
| Pre-deploy migration gate (#14) | ⚠️ Root cause of a real, already-happened outage; fix identified, not built | Render config change, not code |

### Business & Legal — status to be confirmed by Vuyo, not guessed here

| Item | Why it matters |
|---|---|
| Paystack going fully live (vs. test mode) | Real payments can't process until this is done |
| GitHub Actions billing lock | CI (`ci.yml`, confirmed present and wired to run on every push/PR to `main`) stops running the moment this happens, silently removing the test-coverage safety net documented in §3 |
| POPIA compliance filing | South Africa's data-protection law — a legal requirement for handling customer data, not optional |
| App Store / Play Store compliance filing | Required before either mobile app can be publicly listed |
| Formal business registration | Underlies contracts, payment processing, and legal standing generally |

### Operational

| Item | Status | Why it matters |
|---|---|---|
| Redis-at-scale trigger point | Not needed today; becomes **non-optional the instant a second backend instance is ever added** — a binary threshold, not a gradual scaling curve. Without it, live order/location updates silently fail to reach some customers, and the rate limiter can be bypassed, the moment there are two instances. | Prevents a real, silent, hard-to-diagnose bug class the day horizontal scaling starts |
| DB backup gap on the free tier | Supabase's own documented policy — automatic daily backups only start on paid plans. Zero backups exist today. | One manual `supabase db dump`, stored safely off-platform, closes this for the cost of one command — doesn't require a plan upgrade |
| Local-machine risk for unmerged work | `admin-platform` and several other branches carrying real, substantial work exist **only on one local machine**, never pushed to `origin` (§4) | One disk failure away from losing real, working code with no remote copy |
| Rollback runbook | Doesn't exist | Render supports rolling back a bad deploy, but no one has documented or tested the actual steps for this project |
| No staging environment | Confirmed absent | Every deploy to `main` goes straight to the only environment that exists |

---

## 6. Prioritized roadmap — what actually blocks going public vs. what can wait

**Blocks going public, in order:**

1. **Business & Legal items (§5)** — nothing else here matters if payments can't legally process or the app can't be listed. Genuinely gating, and entirely outside this document's ability to verify — needs Vuyo's direct confirmation on each.
2. **Decide `admin-platform`'s fate.** Every real, substantial gap this document documents — the store portal, the customer storefront, the real bug fixes, the 451+34 tests — is stuck behind this one decision. It doesn't need to be merged today, but it needs an explicit decision (merge, or a defined path to merge later), not indefinite limbo.
3. **Push `admin-platform` to `origin`.** Independent of the merge decision — this is purely "stop risking losing it." Costs nothing, changes no behavior, removes the single-machine risk.
4. **Free, minutes-of-effort operational items:** uptime monitoring with a real alert to Vuyo's phone, and one manual database backup stored off-platform. Both directly named in the resilience audit as the highest-leverage, lowest-cost items available, and both remain undone.

**Real, but can wait:**

5. Open the `fix/adminjs-sql-schema-collision` PR (#13) — small, ready, low-risk, but only urgent the moment a colliding table gets registered as an AdminJS resource, which hasn't happened yet on either lineage.
6. Set the Render `healthCheckPath` and build the pre-deploy migration gate (#14) — both are dashboard-only changes with a clear recommended fix already written, waiting on a deliberate window to apply them.
7. A documented, once-tested rollback runbook.
8. Expand frontend test coverage beyond the one critical path per app (explicitly scoped as a starting point, not a finish line, in the coverage remediation work).
9. A real, isolated-database load test — the one piece of data that would replace every "reasoned from near-zero traffic" estimate in this document with a real number.
10. Provision Redis — **only** at the exact moment a second backend instance is added, not before; doing it earlier adds real operational surface for zero benefit today.
11. Vertical scaling (Render Starter-plan upgrade) and the missing FK indexes found in the resilience audit — real, cheap, but not urgent at current traffic.
12. Resolve the remaining branch cleanup from §4 (archiving fully-absorbed and likely-superseded branches) — pure housekeeping, zero functional risk either way.
